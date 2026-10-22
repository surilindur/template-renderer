import type * as RDF from "@rdfjs/types";
import MurmurHash3 from "imurmurhash";
import { DataFactory } from "rdf-data-factory";
import type { IQueryEngine, QuerySourceUnidentified } from "@comunica/types";
import type { Algebra } from "@traqula/algebra-transformations-1-2";
import { AlgebraFactory, algebraUtils } from "@traqula/algebra-transformations-1-2";
import { Generator } from "@traqula/generator-sparql-1-2";
import { Parser } from "@traqula/parser-sparql-1-2";
import { toAlgebra, toAst } from "@traqula/algebra-sparql-1-2";
import { Eta, type EtaConfig } from "eta";
import { ITemplate } from "./Template";
import type { ITemplateContext } from "./TemplateContext";

type QueryBatch<T> = {
  query: string;
  sources: string[];
  bindings: Record<string, RDF.NamedNode | RDF.Literal>[];
  resolutions: Record<string, ((value: T) => void)[]>;
  rejections: Record<string, ((error: unknown) => void)[]>;
};

type QueryBuffer<T> = Record<string, QueryBatch<T>>;

interface ITemplateRenderer {
  loadTemplates: (sources: QuerySourceUnidentified[]) => Promise<void>;
  visualiseTerm: (term: RDF.Term) => Promise<string>;
}

class TemplateRenderer implements ITemplateRenderer {
  public readonly eta: Eta;
  public readonly queryEngine: IQueryEngine;
  public readonly dataFactory: DataFactory;
  public readonly algebraFactory: AlgebraFactory;

  public readonly templates: Map<string, ITemplate>;
  public readonly selectBuffer: QueryBuffer<RDF.Bindings[]>;
  public readonly askBuffer: QueryBuffer<boolean>;
  public readonly batchWindowMilliseconds: number;
  public readonly queryIdentifierVariable: RDF.Variable;

  public static readonly sparqlParser = new Parser();
  public static readonly sparqlGenerator = new Generator();

  public constructor(options: ITemplateRendererOptions) {
    this.eta = new Eta(options.etaOptions ?? { useWith: true });
    this.queryEngine = options.queryEngine;
    this.dataFactory = new DataFactory();
    this.algebraFactory = new AlgebraFactory(this.dataFactory);
    this.templates = new Map();
    this.selectBuffer = {};
    this.askBuffer = {};
    this.batchWindowMilliseconds = options.queryBatchWindow;
    this.queryIdentifierVariable = this.dataFactory.variable(options.queryIdentifierVariable);
  }

  /**
   * Collects all templates from the specified sources.
   * @param sources The sources to query.
   */
  public async loadTemplates(sources: QuerySourceUnidentified[]): Promise<void> {
    this.templates.clear();
    const templateQuery = `PREFIX schema: <https://schema.org/>

SELECT DISTINCT ?template ?priority ?text ?pattern ?target WHERE {
    ?template a schema:SoftwareSourceCode .
    ?template schema:codeSampleType ?type .
    ?template schema:text ?text .
    ?template schema:pattern ?pattern .
    ?template schema:target ?target .

    OPTIONAL { ?template schema:order ?order . }

    BIND(COALESCE(?order, 0) AS ?priority)
} ORDER BY DESC(?priority)`;
    const bindingsStream = await this.queryEngine.queryBindings(templateQuery, { sources });
    for await (const bindings of bindingsStream) {
      const template = (bindings.get("template") as RDF.NamedNode | RDF.BlankNode).value;
      if (!this.templates.has(template)) {
        this.templates.set(template, {
          content: (bindings.get("text") as RDF.Literal).value,
          pattern: new RegExp((bindings.get("pattern") as RDF.Literal).value, "u"),
          target: (bindings.get("target") as RDF.NamedNode).value,
        });
      }
    }
  }

  /**
   * Finds all applicable templates for the specified term.
   * @param term The term to find templates for.
   * @returns The templates, sorted by relevance.
   */
  public findTemplates(term: RDF.Term): ITemplate[] {
    const templatesWithRelevance: { template: ITemplate; relevance: number }[] = [];
    for (const template of this.templates.values()) {
      const relevance = TemplateRenderer.calculateRelevance(template, term);
      if (relevance >= 0) {
        templatesWithRelevance.push({ template, relevance });
      }
    }
    return templatesWithRelevance.sort((a, b) => b.relevance - a.relevance).map((t) => t.template);
  }

  /**
   * Calculate the relevance score for this template against the specified RDF term.
   * The relevance is based on regex match length, with longer match being more relevant.
   * @param term The RDF term to calculate relevance for.
   * @returns The relevance as a numeric value, where higher is more relevant.
   */
  public static calculateRelevance(template: ITemplate, term: RDF.Term): number {
    const match = template.pattern.exec(term.value);
    return match?.[0].length ?? Number.NEGATIVE_INFINITY;
  }

  public static parseOperation(op: string): Algebra.Operation {
    return toAlgebra(TemplateRenderer.sparqlParser.parse(op));
  }

  public static serializeOperation(operation: Algebra.Operation): string {
    return TemplateRenderer.sparqlGenerator.generate(toAst(operation));
  }

  public async visualiseTerm(term: RDF.Term): Promise<string> {
    const template = this.findTemplates(term).at(0);
    if (template) {
      const templateContext: ITemplateContext = {
        term,
        queryAsk: (query, bindings) => this.askBatched(query, [template.target], bindings ?? []),
        querySelect: async (query, bindings) => {
          const outputBindings = await this.selectBatched(query, [template.target], bindings ?? []);
          const outputRecords = TemplateRenderer.bindingsToRecords(outputBindings);
          return outputRecords.at(0);
        },
        querySelectAll: async (query, bindings) => {
          const outputBindings = await this.selectBatched(query, [template.target], bindings ?? []);
          const outputRecords = TemplateRenderer.bindingsToRecords(outputBindings);
          return outputRecords;
        },
        visualiseTerm: (term) => this.visualiseTerm(term),
      };
      try {
        return await this.eta.renderStringAsync(template.content, templateContext);
      } catch (error: unknown) {
        return `<pre class="error">${error}</pre>`;
      }
    }
    return `<pre class="error">${JSON.stringify(term, undefined, 2)}</pre>`;
  }

  public static bindingsToRecords(bindings: RDF.Bindings[]): Record<string, RDF.Term>[] {
    const output: Record<string, RDF.Term>[] = [];
    for (const mapping of bindings) {
      const record: Record<string, RDF.Term> = {};
      for (const [key, value] of mapping) {
        record[key.value] = value;
      }
      output.push(record);
    }
    return output;
  }

  public bindingsToValues(bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): Algebra.Values {
    return this.algebraFactory.createValues(
      [...new Set(bindings.flatMap((b) => Object.keys(b)))].map((s) =>
        this.dataFactory.variable(s),
      ),
      bindings,
    );
  }

  /**
   * Generate a query identifier that takes into account also the binding values.
   * The bindings values have their keys sorted, and then the bindings themselves
   * are also sorted, to ensure the same query with the same bindings gets the same
   * identifier, regardless of the original order of bindings or their keys.
   */
  public generateQueryIdentifier(
    query: string,
    sources: string[],
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): RDF.NamedNode {
    const value = JSON.stringify({
      query,
      sources: [...sources].sort(),
      // Ensure the binding objects always sorted identically
      bindings: bindings
        .map((b) =>
          Object.fromEntries(Object.entries(b).sort((t1, t2) => t1[0].localeCompare(t2[0]))),
        )
        .sort((b1, b2) => JSON.stringify(b1).localeCompare(JSON.stringify(b2))),
    });
    const hash = MurmurHash3(value).result().toString(16);
    return this.dataFactory.namedNode(`urn:query:${hash}`);
  }

  /**
   * Generate a query batch identifier, to allow grouping together identical queries
   * to a single source. The batch considers the query, as well as the total set of
   * bindings keys (bound variables), but ignores the values. The values will only be
   * used for grouping identical queries together.
   */
  public generateQueryBatchIdentifier(
    query: string,
    sources: string[],
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): RDF.NamedNode {
    const value = JSON.stringify({
      query,
      sources: [...sources].sort(),
      bindings: [...new Set(bindings.flatMap((b) => Object.keys(b)))].sort(),
    });
    const hash = MurmurHash3(value).result().toString(16);
    return this.dataFactory.namedNode(`urn:batch:${hash}`);
  }

  /**
   * Helper function to push executions into buffers based on identifiers.
   */
  public async executeBatched<T>(
    query: string,
    sources: string[],
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    buffer: QueryBuffer<T>,
    executor: (batchIdentifier: RDF.NamedNode) => Promise<void>,
  ): Promise<T> {
    const queryIdentifier = this.generateQueryIdentifier(query, sources, bindings);
    const batchIdentifier = this.generateQueryBatchIdentifier(query, sources, bindings);

    // Add the current query identifier to the bindings
    bindings = bindings.map((b) => ({
      ...b,
      [this.queryIdentifierVariable.value]: queryIdentifier,
    }));

    return new Promise<T>((resolve, reject) => {
      if (buffer[batchIdentifier.value]) {
        if (
          buffer[batchIdentifier.value].resolutions[queryIdentifier.value] &&
          buffer[batchIdentifier.value].rejections[queryIdentifier.value]
        ) {
          buffer[batchIdentifier.value].resolutions[queryIdentifier.value].push(resolve);
          buffer[batchIdentifier.value].rejections[queryIdentifier.value].push(reject);
        } else {
          buffer[batchIdentifier.value].bindings.push(...bindings);
          buffer[batchIdentifier.value].resolutions[queryIdentifier.value] = [resolve];
          buffer[batchIdentifier.value].rejections[queryIdentifier.value] = [reject];
        }
      } else {
        buffer[batchIdentifier.value] = {
          query,
          sources,
          bindings,
          resolutions: { [queryIdentifier.value]: [resolve] },
          rejections: { [queryIdentifier.value]: [reject] },
        };
        setTimeout(() => executor(batchIdentifier), this.batchWindowMilliseconds);
      }
    });
  }

  public async selectAll(query: string, sources: string[]): Promise<RDF.Bindings[]> {
    const bindingsStream = await this.queryEngine.queryBindings(query, { sources, lenient: true });
    return bindingsStream.toArray();
  }

  public async executeAsk(
    buffer: QueryBuffer<boolean>,
    batchIdentifier: RDF.NamedNode,
  ): Promise<void> {
    const batch = buffer[batchIdentifier.value];
    delete buffer[batchIdentifier.value];

    const askOperation = TemplateRenderer.parseOperation(batch.query);

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

    try {
      const queryString = TemplateRenderer.serializeOperation(selectOperation);
      const bindingsArray = await this.selectAll(queryString, batch.sources);

      // Report existence to their corresponding queries
      for (const bindings of bindingsArray) {
        const queryIdentifier = (bindings.get(this.queryIdentifierVariable.value) as RDF.NamedNode)
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
      // Raise the error so it gets propagated
      throw error;
    }
  }

  public async executeSelect(
    buffer: QueryBuffer<RDF.Bindings[]>,
    batchIdentifier: RDF.NamedNode,
  ): Promise<void> {
    const batch = buffer[batchIdentifier.value];
    delete buffer[batchIdentifier.value];

    const selectOperationOriginal = TemplateRenderer.parseOperation(batch.query);

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

    try {
      const queryString = TemplateRenderer.serializeOperation(selectOperation);
      const bindingsArray = await this.selectAll(queryString, batch.sources);
      const bindingsByQuery: Record<string, RDF.Bindings[]> = {};

      for (const bindings of bindingsArray) {
        const queryIdentifier = (bindings.get(this.queryIdentifierVariable.value) as RDF.NamedNode)
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
      // Raise the error so it gets propagated
      throw error;
    }
  }

  public async askBatched(
    query: string,
    sources: string[],
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): Promise<boolean> {
    return this.executeBatched<boolean>(query, sources, bindings, this.askBuffer, (batch) =>
      this.executeAsk(this.askBuffer, batch),
    );
  }

  public async selectBatched(
    query: string,
    sources: string[],
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
  ): Promise<RDF.Bindings[]> {
    return this.executeBatched<RDF.Bindings[]>(
      query,
      sources,
      bindings,
      this.selectBuffer,
      (batch) => this.executeSelect(this.selectBuffer, batch),
    );
  }
}

interface ITemplateRendererOptions {
  /**
   * The query engine to use for template retrieval, as well as
   * the queries within the templates themselves.
   */
  queryEngine: IQueryEngine;
  /**
   * The window in milliseconds for every query batch.
   */
  queryBatchWindow: number;
  /**
   * The variable name to use for mapping solutions back to the original query in batches.
   * This is added to each query that is sent to the server, so ensure it does not conflict
   * with existing variables in queries, including the queries within templates.
   */
  queryIdentifierVariable: string;
  /**
   * Optional confgiguration for the Eta template engine.
   * Use of with for async is always required.
   */
  etaOptions?: Partial<EtaConfig> & { useWith: true };
}

export {
  TemplateRenderer,
  type ITemplateRenderer,
  type ITemplateRendererOptions,
  type QueryBatch,
  type QueryBuffer,
};
