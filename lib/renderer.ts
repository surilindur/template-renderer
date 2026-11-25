import type * as RDF from "@rdfjs/types";
import MurmurHash3 from "imurmurhash";
import { LRUCache } from "lru-cache";
import { DataFactory } from "rdf-data-factory";
import { QueryEngine } from "@comunica/query-sparql";
import type { IQueryEngine, QuerySourceUnidentified } from "@comunica/types";
import { SparqlEndpointFetcher } from "fetch-sparql-endpoint";
import type { ISparqlEndpointFetcherArgs, IBindings } from "fetch-sparql-endpoint";
import type { Algebra } from "@traqula/algebra-transformations-1-2";
import { AlgebraFactory, algebraUtils } from "@traqula/algebra-transformations-1-2";
import { Generator } from "@traqula/generator-sparql-1-2";
import { Parser } from "@traqula/parser-sparql-1-2";
import { toAlgebra, toAst } from "@traqula/algebra-sparql-1-2";
import { Eta, type EtaConfig } from "eta";
import type {
  ITemplateRenderer,
  ITemplateContext,
  ITemplate,
  QueryBatch,
  QueryBuffer,
} from "./types";

const templateQuery = `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <https://schema.org/>

SELECT DISTINCT ?template ?target ?targetProduct ?pattern ?text WHERE {
  ?template a schema:SoftwareSourceCode .
  ?template schema:programmingLanguage "Eta" .
  ?template schema:target ?target .
  ?template schema:targetProduct ?targetProduct .
  ?template schema:pattern ?pattern .
  ?template schema:text ?text .
  ?template schema:position ?position .
} ORDER BY DESC(?position)` as const;

class TemplateRenderer implements ITemplateRenderer {
  protected readonly eta: Eta;
  protected readonly cache: LRUCache<string, Promise<string>>;
  protected readonly queryEngine: IQueryEngine;
  protected readonly endpointFetcher: SparqlEndpointFetcher;
  protected readonly dataFactory: DataFactory;
  protected readonly algebraFactory: AlgebraFactory;

  public readonly templates: Map<ITemplate["termType"], ITemplate[]>;

  protected readonly selectBuffer: QueryBuffer<IBindings[]>;
  protected readonly askBuffer: QueryBuffer<boolean>;
  protected readonly batchWindowMilliseconds: number;
  protected readonly queryIdentifierVariable: RDF.Variable;

  protected readonly sparqlParser: Parser;
  protected readonly sparqlGenerator: Generator;

  public constructor(options: ITemplateRendererOptions) {
    this.eta = new Eta(options.etaOptions ?? { useWith: true, cache: true });
    this.cache = new LRUCache<string, Promise<string>>({ max: options.cacheSize ?? 1_000 });
    this.dataFactory = options.dataFactory ?? new DataFactory();
    this.algebraFactory = options.algebraFactory ?? new AlgebraFactory(this.dataFactory);
    this.queryEngine = options.queryEngine ?? new QueryEngine();
    this.sparqlGenerator = options.sparqlGenerator ?? new Generator();
    this.sparqlParser = options.sparqlParser ?? new Parser();
    this.endpointFetcher = new SparqlEndpointFetcher({
      ...options.endpointFetcherOptions,
      dataFactory: options.endpointFetcherOptions?.dataFactory ?? this.dataFactory,
      sparqlQueryParser: options.endpointFetcherOptions?.sparqlQueryParser ?? this.sparqlParser,
    });
    this.templates = new Map();
    this.selectBuffer = {};
    this.askBuffer = {};
    this.batchWindowMilliseconds = options.queryBatchWindow ?? 500;
    this.queryIdentifierVariable = this.dataFactory.variable(
      options.queryIdentifierVariable ?? "query",
    );
  }

  /**
   * Collect all templates from the specified sources, and load them into the Eta cache.
   * Previously collected templates are erased before new ones are loaded.
   * @param sources The sources to query for templates.
   * @param signal Optional signal to stop template loading.
   */
  public async loadTemplates(
    sources: QuerySourceUnidentified[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.cache.clear();
    this.eta.templatesAsync.reset();
    this.templates.clear();
    if (sources.length > 0) {
      const processedTemplates = new Set<string>();
      const bindingsStream = await this.queryEngine.queryBindings(templateQuery, { sources });
      const abortListener = () => bindingsStream.destroy();
      signal?.addEventListener("abort", abortListener, { once: true });
      for await (const bindings of bindingsStream) {
        const etaName = `@${(bindings.get("template") as RDF.NamedNode | RDF.BlankNode).value}`;
        if (!processedTemplates.has(etaName)) {
          processedTemplates.add(etaName);
          const text = (bindings.get("text") as RDF.Literal).value;
          const pattern = (bindings.get("pattern") as RDF.Literal).value;
          const target = bindings.get("target") as RDF.Term;
          const targetProduct = (bindings.get("targetProduct") as RDF.NamedNode).value;
          const termType = this.determineTemplateTermType(target);
          this.eta.loadTemplate(etaName, text, { async: true });
          const template: ITemplate = {
            etaName,
            valuePattern: new RegExp(pattern, "u"),
            sparqlEndpoint: targetProduct,
            termType,
          };
          let templateArray = this.templates.get(template.termType);
          if (templateArray !== undefined) {
            templateArray.push(template);
          } else {
            this.templates.set(template.termType, [template]);
          }
        }
      }
      signal?.removeEventListener("abort", abortListener);
    }
  }

  protected determineTemplateTermType(target: RDF.Term): RDF.Term["termType"] {
    if (target.termType === "NamedNode") {
      switch (target.value) {
        case "http://www.w3.org/ns/shacl#Literal":
          return "Literal";
        case "http://www.w3.org/ns/shacl#BlankNode":
          return "BlankNode";
        case "http://www.w3.org/ns/shacl#IRI":
          return "NamedNode";
      }
    }
    throw new Error(`Unsupported template target ${JSON.stringify(target)}`);
  }

  /**
   * Finds all applicable templates for the specified term.
   * @param term The term to find templates for.
   * @returns The templates, sorted by relevance.
   */
  protected findTemplates(term: RDF.Term | undefined): ITemplate[] {
    const templatesWithRelevance: { template: ITemplate; relevance: number }[] = [];
    if (term) {
      const templates = this.templates.get(term.termType);
      if (templates) {
        for (const template of templates) {
          const relevance = this.calculateRelevance(template, term);
          if (relevance >= 0) {
            templatesWithRelevance.push({ template, relevance });
          }
        }
        templatesWithRelevance.sort((a, b) => b.relevance - a.relevance);
      }
    }
    return templatesWithRelevance.map((t) => t.template);
  }

  /**
   * Calculate the relevance score for this template against the specified RDF term.
   * The relevance is based on regex match length, with longer match being more relevant.
   * @param term The RDF term to calculate relevance for.
   * @returns The relevance as a numeric value, where higher is more relevant.
   */
  protected calculateRelevance(template: ITemplate, term: RDF.Term): number {
    if (term.termType === template.termType) {
      const match = template.valuePattern.exec(term.value);
      if (match) {
        return match[0].length;
      }
    }
    return Number.NEGATIVE_INFINITY;
  }

  protected parseOperation(op: string): Algebra.Operation {
    return toAlgebra(this.sparqlParser.parse(op));
  }

  protected serializeOperation(operation: Algebra.Operation): string {
    return this.sparqlGenerator.generate(toAst(operation));
  }

  protected async renderWithTemplate(term: RDF.Term, template: ITemplate): Promise<string> {
    const cacheKey = this.hashObject({ term, template: template.etaName });
    let renderResult = this.cache.get(cacheKey);
    if (renderResult === undefined) {
      const context: ITemplateContext = {
        term,
        queryAsk: (query, bindings) => {
          return this.askBatched(query, template.sparqlEndpoint, bindings ?? []);
        },
        querySelect: async (query, bindings) => {
          const allBindings = await this.selectBatched(
            query,
            template.sparqlEndpoint,
            bindings ?? [],
          );
          return allBindings.at(0);
        },
        querySelectAll: (query, bindings) => {
          return this.selectBatched(query, template.sparqlEndpoint, bindings ?? []);
        },
        visualiseTerm: (term) => {
          return this.render(term);
        },
      };
      renderResult = new Promise<string>((resolve) =>
        this.eta
          .renderAsync(template.etaName, context)
          .then((html) => resolve(html))
          .catch((ex: unknown) => resolve(`<pre class="error">${ex}</pre>`)),
      );
      this.cache.set(cacheKey, renderResult);
    }
    return renderResult;
  }

  public async render(term: RDF.Term | undefined): Promise<string> {
    const template = this.findTemplates(term).at(0);
    return term && template
      ? this.renderWithTemplate(term, template)
      : `<pre class="error">${JSON.stringify(term, undefined, 2)}</pre>`;
  }

  public async renderAll(term: RDF.Term | undefined): Promise<string[]> {
    if (term) {
      const renderPromises: Promise<string>[] = [];
      for (const template of this.findTemplates(term)) {
        renderPromises.push(this.renderWithTemplate(term, template));
      }
      return await Promise.all(renderPromises);
    }
    return [`<pre class="error">${JSON.stringify(term)}</pre>`];
  }

  protected bindingsToValues(bindings: IBindings[]): Algebra.Values {
    return this.algebraFactory.createValues(
      [...new Set(bindings.flatMap((b) => Object.keys(b)))].map((s) =>
        this.dataFactory.variable(s),
      ),
      bindings as Record<string, RDF.NamedNode | RDF.Literal>[],
    );
  }

  /**
   * Calculate the hash of the given object's JSON representation.
   */
  protected hashObject(input: unknown): string {
    return MurmurHash3(JSON.stringify(input)).result().toString(16);
  }

  /**
   * Sort the keys of the object.
   */
  protected sortObjectKeys(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).sort((t1, t2) => t1[0].localeCompare(t2[0])));
  }

  /**
   * Sort the objects based on their JSON representation.
   */
  protected sortObjects(input: unknown[]): unknown[] {
    return input
      .map((o) => ({ o, s: JSON.stringify(o) }))
      .sort((o1, o2) => o1.s.localeCompare(o2.s))
      .map((o) => o.o);
  }

  /**
   * Generate a query identifier that takes into account also the binding values.
   * The bindings values have their keys sorted, and then the bindings themselves
   * are also sorted, to ensure the same query with the same bindings gets the same
   * identifier, regardless of the original order of bindings or their keys.
   */
  protected generateQueryIdentifier(
    query: string,
    endpoint: string,
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): RDF.NamedNode {
    const value = JSON.stringify({
      query,
      endpoint,
      // Ensure the binding objects always sorted identically
      bindings: this.sortObjects(bindings.map((b) => this.sortObjectKeys(b))),
    });
    const hash = this.hashObject(value);
    return this.dataFactory.namedNode(`urn:query:${hash}`);
  }

  /**
   * Generate a query batch identifier, to allow grouping together identical queries
   * to a single source. The batch considers the query, as well as the total set of
   * bindings keys (bound variables), but ignores the values. The values will only be
   * used for grouping identical queries together.
   */
  protected generateQueryBatchIdentifier(
    query: string,
    endpoint: string,
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): RDF.NamedNode {
    const value = JSON.stringify({
      query,
      endpoint,
      bindings: [...new Set(bindings.flatMap((b) => Object.keys(b)))].sort(),
    });
    const hash = this.hashObject(value);
    return this.dataFactory.namedNode(`urn:batch:${hash}`);
  }

  /**
   * Helper function to push executions into buffers based on identifiers.
   */
  protected async executeBatched<T>(
    query: string,
    endpoint: string,
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    buffer: QueryBuffer<T>,
    executor: (batchIdentifier: RDF.NamedNode) => Promise<void>,
  ): Promise<T> {
    const queryIdentifier = this.generateQueryIdentifier(query, endpoint, bindings);
    const batchIdentifier = this.generateQueryBatchIdentifier(query, endpoint, bindings);

    // Add the current query identifier to the bindings
    bindings = bindings.map((b) => ({
      ...b,
      [this.queryIdentifierVariable.value]: queryIdentifier,
    }));

    return new Promise<T>((resolve, reject) => {
      if (buffer[batchIdentifier.value]) {
        const batch = buffer[batchIdentifier.value];
        if (batch.resolutions[queryIdentifier.value]) {
          batch.resolutions[queryIdentifier.value].push(resolve);
          batch.rejections[queryIdentifier.value].push(reject);
        } else {
          // When an identical query has not been included in the batch yet, that is,
          // the bindings are different, and thus the query identifier is different,
          // the bindings must be added into tbe batch.
          batch.bindings.push(...bindings);
          batch.resolutions[queryIdentifier.value] = [resolve];
          batch.rejections[queryIdentifier.value] = [reject];
        }
      } else {
        buffer[batchIdentifier.value] = {
          query,
          endpoint,
          bindings,
          resolutions: { [queryIdentifier.value]: [resolve] },
          rejections: { [queryIdentifier.value]: [reject] },
        };
        // The timeout is set when the first entry is added into the buffer.
        // This ensures only one timeout is created per-buffer, and the countdown
        // begins when the buffer is created, without further updates to it.
        setTimeout(() => executor(batchIdentifier), this.batchWindowMilliseconds);
      }
    });
  }

  protected async selectAll(query: string, endpoint: string): Promise<IBindings[]> {
    return new Promise<IBindings[]>((resolve, reject) => {
      const output: IBindings[] = [];
      this.endpointFetcher
        .fetchBindings(endpoint, query)
        .then((bindingsStream) => {
          bindingsStream
            .on("data", (bindings: IBindings) => {
              output.push(bindings);
            })
            .on("end", () => {
              resolve(output);
            })
            .on("error", reject);
        })
        .catch(reject);
    });
  }

  protected async executeAsk(
    buffer: QueryBuffer<boolean>,
    batchIdentifier: RDF.NamedNode,
  ): Promise<void> {
    const batch = buffer[batchIdentifier.value];
    delete buffer[batchIdentifier.value];

    try {
      const askOperation = this.parseOperation(batch.query);

      const selectOperation = algebraUtils.mapOperation(askOperation, {
        ask: {
          preVisitor: () => ({ shortcut: true, copy: false }),
          transform: (_, op) =>
            this.algebraFactory.createProject(
              this.algebraFactory.createFilter(
                this.bindingsToValues(batch.bindings),
                this.algebraFactory.createExistenceExpression(false, op.input),
              ),
              [this.queryIdentifierVariable],
            ),
        },
      }) as Algebra.Operation;

      const queryString = this.serializeOperation(selectOperation);
      const bindingsArray = await this.selectAll(queryString, batch.endpoint);

      // Report existence to their corresponding queries
      for (const bindings of bindingsArray) {
        const queryIdentifier = (bindings[this.queryIdentifierVariable.value] as RDF.NamedNode)
          .value;
        for (const resolution of batch.resolutions[queryIdentifier]) {
          resolution(true);
        }
        delete batch.resolutions[queryIdentifier];
      }

      // Report non-existence to all other queries
      for (const resolutions of Object.values(batch.resolutions)) {
        for (const resolution of resolutions) {
          resolution(false);
        }
      }
    } catch (error: unknown) {
      // Send the error to all queries
      for (const rejections of Object.values(batch.rejections)) {
        for (const rejection of rejections) {
          rejection(error);
        }
      }
    }
  }

  protected async executeSelect(
    buffer: QueryBuffer<IBindings[]>,
    batchIdentifier: RDF.NamedNode,
  ): Promise<void> {
    const batch = buffer[batchIdentifier.value];
    delete buffer[batchIdentifier.value];

    try {
      const selectOperationOriginal = this.parseOperation(batch.query);

      const selectOperation = algebraUtils.mapOperation(selectOperationOriginal, {
        project: {
          preVisitor: () => ({ shortcut: true, copy: false }),
          transform: (_copy, op) =>
            this.algebraFactory.createProject(
              this.algebraFactory.createJoin([op.input, this.bindingsToValues(batch.bindings)]),
              [...op.variables, this.queryIdentifierVariable],
            ),
        },
      }) as Algebra.Operation;

      const queryString = this.serializeOperation(selectOperation);
      const bindingsArray = await this.selectAll(queryString, batch.endpoint);
      const bindingsByQuery: Record<string, IBindings[]> = {};

      for (const bindings of bindingsArray) {
        const queryIdentifier = (bindings[this.queryIdentifierVariable.value] as RDF.NamedNode)
          .value;
        if (bindingsByQuery[queryIdentifier]) {
          bindingsByQuery[queryIdentifier].push(bindings);
        } else {
          bindingsByQuery[queryIdentifier] = [bindings];
        }
      }

      // Forward bindings to their respective resolution functions
      for (const [identifier, bindings] of Object.entries(bindingsByQuery)) {
        for (const resolution of batch.resolutions[identifier]) {
          resolution(bindings);
        }
        delete batch.resolutions[identifier];
      }

      // Mark all remaining queries without bindings as finished
      for (const resolutions of Object.values(batch.resolutions)) {
        for (const resolution of resolutions) {
          resolution([]);
        }
      }
    } catch (error: unknown) {
      // Send the error to all queries
      for (const rejections of Object.values(batch.rejections)) {
        for (const rejection of rejections) {
          rejection(error);
        }
      }
    }
  }

  protected async askBatched(
    query: string,
    endpoint: string,
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): Promise<boolean> {
    return this.executeBatched<boolean>(query, endpoint, bindings, this.askBuffer, (batch) =>
      this.executeAsk(this.askBuffer, batch),
    );
  }

  protected async selectBatched(
    query: string,
    endpoint: string,
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): Promise<IBindings[]> {
    return this.executeBatched<IBindings[]>(query, endpoint, bindings, this.selectBuffer, (batch) =>
      this.executeSelect(this.selectBuffer, batch),
    );
  }
}

interface ITemplateRendererOptions {
  /**
   * The size of the render output cache, that attempts to avoid repeated rendering
   * of the same term by caching the results. This is an LRU cache.
   * @default {1000}
   */
  cacheSize?: number;
  /**
   * The window in milliseconds for every query batch.
   */
  queryBatchWindow?: number;
  /**
   * The variable name to use for mapping solutions back to the original query in batches.
   * This is added to each query that is sent to the server, so ensure it does not conflict
   * with existing variables in queries, including the queries within templates.
   */
  queryIdentifierVariable?: string;
  /**
   * Oprional query engine instance to use for retrieving templates.
   * When omitted, a default engine instance will be created.
   */
  queryEngine?: IQueryEngine;
  /**
   * Optional SPARQL parser to use.
   */
  sparqlParser?: Parser;
  /**
   * Optional SPARQL generator to use.
   */
  sparqlGenerator?: Generator;
  /**
   * Optional RDF data factory to use.
   */
  dataFactory?: DataFactory;
  /**
   * Optional algebra factory to use.
   */
  algebraFactory?: AlgebraFactory;
  /**
   * Optional configuration for the SPARQL endpoint fetcher,
   * that will be used within the templates themselves to exeute SPARQL queries.
   */
  endpointFetcherOptions?: Partial<ISparqlEndpointFetcherArgs>;
  /**
   * Optional confgiguration for the Eta template engine.
   * Use of with for async is always required.
   */
  etaOptions?: Partial<EtaConfig> & { useWith: true; cache: true };
}

export {
  TemplateRenderer,
  type ITemplateRenderer,
  type ITemplateRendererOptions,
  type QueryBatch,
  type QueryBuffer,
};
