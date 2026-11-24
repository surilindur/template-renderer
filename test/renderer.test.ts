import type * as RDF from "@rdfjs/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArrayIterator } from "asynciterator";
import { DataFactory } from "rdf-data-factory";
import type { BindingsStream, IQueryEngine } from "@comunica/types";
import type { Algebra } from "@traqula/algebra-transformations-1-2";
import { AlgebraFactory } from "@traqula/algebra-transformations-1-2";
import { TemplateRenderer } from "../lib/renderer";
import type { ITemplate, ITemplateContext, QueryBuffer } from "../lib/types";
import type { Eta, TemplateFunction } from "eta";
import type { IBindings } from "fetch-sparql-endpoint";

describe("TemplateRenderer", () => {
  type TestTemplateRenderer = TemplateRenderer & {
    readonly eta: Eta;
    calculateRelevance(template: ITemplate, term: RDF.Term): number;
    determineTemplateTermType(target: RDF.Term): RDF.Term["termType"];
    parseOperation(op: string): Algebra.Operation;
    serializeOperation(operation: Algebra.Operation): string;
    bindingsToValues(bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): Algebra.Values;
    findTemplates: (term: RDF.Term) => ITemplate[];
    generateQueryIdentifier(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    ): RDF.NamedNode;
    generateQueryBatchIdentifier(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    ): RDF.NamedNode;
    executeBatched<T>(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
      buffer: QueryBuffer<T>,
      executor: (batchIdentifier: RDF.NamedNode) => Promise<void>,
    ): Promise<T>;
    selectAll(query: string, endpoint: string): Promise<IBindings[]>;
    executeAsk(buffer: QueryBuffer<boolean>, batchIdentifier: RDF.NamedNode): Promise<void>;
    executeSelect(buffer: QueryBuffer<IBindings[]>, batchIdentifier: RDF.NamedNode): Promise<void>;
    askBatched(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    ): Promise<boolean>;
    selectBatched(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    ): Promise<IBindings[]>;
    readonly askBuffer: QueryBuffer<boolean>;
    readonly selectBuffer: QueryBuffer<IBindings[]>;
    readonly endpointFetcher: {
      fetchBindings(endpoint: string, query: string): unknown;
    };
  };

  let renderer: TestTemplateRenderer;

  let queryEngine: IQueryEngine;

  const dataFactory = new DataFactory();
  const algebraFactory = new AlgebraFactory(dataFactory);

  beforeEach(() => {
    queryEngine = {
      queryBindings: vi.fn().mockResolvedValue(
        new ArrayIterator([
          new Map<string, RDF.Term>([
            ["template", dataFactory.namedNode("urn:template")],
            ["pattern", dataFactory.literal(".*")],
            ["text", dataFactory.literal("<p>example</p>")],
            ["target", dataFactory.namedNode("http://www.w3.org/ns/shacl#Literal")],
            ["targetProduct", dataFactory.namedNode("urn:endpoint")],
          ]),
          // A NamedNode-typed template, exercising the IRI target branch
          new Map<string, RDF.Term>([
            ["template", dataFactory.namedNode("urn:other")],
            ["pattern", dataFactory.literal(".*")],
            ["text", dataFactory.literal("<p>named</p>")],
            ["target", dataFactory.namedNode("http://www.w3.org/ns/shacl#IRI")],
            ["targetProduct", dataFactory.namedNode("urn:endpoint")],
          ]),
          // Another NamedNode-typed template, exercising the append-to-existing branch
          new Map<string, RDF.Term>([
            ["template", dataFactory.namedNode("urn:more")],
            ["pattern", dataFactory.literal("^b")],
            ["text", dataFactory.literal("<p>another named</p>")],
            ["target", dataFactory.namedNode("http://www.w3.org/ns/shacl#IRI")],
            ["targetProduct", dataFactory.namedNode("urn:endpoint")],
          ]),
          // A BlankNode-typed template, exercising the BlankNode target branch
          new Map<string, RDF.Term>([
            ["template", dataFactory.namedNode("urn:blank")],
            ["pattern", dataFactory.literal(".*")],
            ["text", dataFactory.literal("<p>blank</p>")],
            ["target", dataFactory.namedNode("http://www.w3.org/ns/shacl#BlankNode")],
            ["targetProduct", dataFactory.namedNode("urn:endpoint")],
          ]),
          // A duplicate with the same template name, to exercise deduplication
          new Map<string, RDF.Term>([
            ["template", dataFactory.namedNode("urn:template")],
            ["pattern", dataFactory.literal(".*")],
            ["text", dataFactory.literal("<p>duplicate</p>")],
            ["target", dataFactory.namedNode("http://www.w3.org/ns/shacl#Literal")],
            ["targetProduct", dataFactory.namedNode("urn:endpoint")],
          ]),
        ]),
      ),
    } as unknown as IQueryEngine;
    renderer = new TemplateRenderer({
      queryEngine,
      queryBatchWindow: 200,
      queryIdentifierVariable: "query",
    }) as unknown as typeof renderer;
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("constructors defaults", () => {
    it("applies default options when none are provided", async () => {
      const defaultRenderer: TestTemplateRenderer = new TemplateRenderer(
        {},
      ) as unknown as TestTemplateRenderer;
      // JSON.stringify(undefined) serializes to the string "undefined"
      await expect(defaultRenderer.render(undefined)).resolves.toBe(
        `<pre class="error">${JSON.stringify(undefined)}</pre>`,
      );
      expect(defaultRenderer.findTemplates(dataFactory.namedNode("abc"))).toEqual([]);
    });
  });

  describe("loadTemplates", () => {
    it("retrieves templates using the query engine when sources are given", async () => {
      await expect(renderer.loadTemplates(["https://localhost/sparql"])).resolves.not.toThrow();
      expect(queryEngine.queryBindings).toHaveBeenCalledOnce();
      // The templates map is keyed by the term type of the templates.
      const [template] = renderer.templates.get("Literal")!;
      // The template is loaded into the Eta cache under a name derived from its URI.
      expect(template.etaName).toBe("@urn:template");
      // The shacl#Literal target maps to the "Literal" term type,
      // and the value pattern is built from the pattern binding.
      expect(template.termType).toBe("Literal");
      expect(template.valuePattern.source).toBe(".*");
      // The endpoint comes from the value of the targetProduct binding.
      expect(template.sparqlEndpoint).toBe("urn:endpoint");
      // The shacl#IRI target maps to the "NamedNode" term type, and both IRI
      // templates share the same map entry.
      const [otherTemplate, moreTemplate] = renderer.templates.get("NamedNode")!;
      expect(otherTemplate.termType).toBe("NamedNode");
      expect(otherTemplate.sparqlEndpoint).toBe("urn:endpoint");
      expect(moreTemplate.etaName).toBe("@urn:more");
      // The shacl#BlankNode target maps to the "BlankNode" term type.
      const [blankTemplate] = renderer.templates.get("BlankNode")!;
      expect(blankTemplate.termType).toBe("BlankNode");
      // Duplicates with an already-seen template name are ignored.
      expect(renderer.templates.size).toBe(3);
    });

    it("returns no templates when no sources are given", async () => {
      await expect(renderer.loadTemplates([])).resolves.not.toThrow();
      expect(queryEngine.queryBindings).not.toHaveBeenCalled();
      expect(renderer.templates.size).toBe(0);
    });

    it("forwards errors from the query engine", async () => {
      vi.spyOn(queryEngine, "queryBindings").mockRejectedValue(
        new Error("Error from query engine"),
      );
      await expect(renderer.loadTemplates(["https://localhost/sparql"])).rejects.toThrow(
        "Error from query engine",
      );
    });

    it("stops loading templates when the abort signal fires", async () => {
      const controller = new AbortController();
      // The stream stalls until destroy() is called, so the abort listener has
      // not yet been removed when the signal fires.
      let resolveDestroyed!: () => void;
      const destroyed = new Promise<void>((resolve) => (resolveDestroyed = resolve));
      const bindingsStream = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<RDF.Bindings> {
          await destroyed;
        },
        destroy: vi.fn(resolveDestroyed),
      };
      vi.spyOn(queryEngine, "queryBindings").mockResolvedValue(
        bindingsStream as unknown as BindingsStream,
      );
      const promise = renderer.loadTemplates(["https://localhost/sparql"], controller.signal);
      // The abort listener is registered after the query engine resolves its stream
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      expect(bindingsStream.destroy).toHaveBeenCalledOnce();
      await expect(promise).resolves.not.toThrow();
      expect(renderer.templates.size).toBe(0);
    });
  });

  describe("determineTemplateTermType", () => {
    it("throws for targets that are not a recognized shacl term type", () => {
      expect(() =>
        renderer.determineTemplateTermType(dataFactory.namedNode("http://www.w3.org/1999-02-22-rdf-syntax-ns#type")),
      ).toThrow(/Unsupported template target/);
    });

    it("throws for non-NamedNode targets", () => {
      expect(() =>
        renderer.determineTemplateTermType(dataFactory.blankNode("b1")),
      ).toThrow(/Unsupported template target/);
    });
  });

  describe("findTemplates", () => {
    it("returns the applicable templates sorted by relevance", () => {
      const template1: ITemplate = {
        etaName: "@t1",
        valuePattern: /^ab/,
        sparqlEndpoint: "https://query.wikidata.org/sparql1",
        termType: "NamedNode",
      };
      const template2: ITemplate = {
        etaName: "@t2",
        valuePattern: /^abc/,
        sparqlEndpoint: "https://query.wikidata.org/sparql2",
        termType: "NamedNode",
      };
      const template3: ITemplate = {
        etaName: "@t3",
        valuePattern: /^xyz$/,
        sparqlEndpoint: "https://query.wikidata.org/sparql3",
        termType: "NamedNode",
      };
      // The templates map is keyed by term type.
      renderer.templates.set("NamedNode", [template1, template2, template3]);
      expect(renderer.findTemplates(dataFactory.namedNode("abc"))).toEqual([template2, template1]);
    });
  });

  describe("calculateRelevance", () => {
    it("returns the length of the regex match for applicable templates", () => {
      const template: ITemplate = {
        etaName: "@t1",
        valuePattern: /^ab/,
        sparqlEndpoint: "https://query.wikidata.org/sparql",
        termType: "NamedNode",
      };
      expect(renderer.calculateRelevance(template, dataFactory.namedNode("abcdef"))).toBe(2);
    });

    it("returns negative infinity when the term types do not match", () => {
      const template: ITemplate = {
        etaName: "@t1",
        valuePattern: /^ab/,
        sparqlEndpoint: "https://query.wikidata.org/sparql",
        termType: "Literal",
      };
      expect(renderer.calculateRelevance(template, dataFactory.namedNode("abcdef"))).toBe(
        Number.NEGATIVE_INFINITY,
      );
    });

    it("returns negative infinity when the pattern does not match", () => {
      const template: ITemplate = {
        etaName: "@t1",
        valuePattern: /^xyz/,
        sparqlEndpoint: "https://query.wikidata.org/sparql",
        termType: "NamedNode",
      };
      expect(renderer.calculateRelevance(template, dataFactory.namedNode("abc"))).toBe(
        Number.NEGATIVE_INFINITY,
      );
    });
  });

  describe("bindingsToValues", () => {
    it("converts a bindings array to a values clause using the union of keys", () => {
      const bindings: IBindings[] = [
        { var1: dataFactory.literal("value1") },
        { var2: dataFactory.literal("value2") },
      ];
      expect(renderer.bindingsToValues(bindings)).toEqual(
        algebraFactory.createValues(
          [dataFactory.variable("var1"), dataFactory.variable("var2")],
          bindings as Record<string, RDF.Literal | RDF.NamedNode>[],
        ),
      );
    });
  });

  describe("parseOperation", () => {
    it("parses an operation", () => {
      expect(renderer.parseOperation("")).toEqual({ type: "nop" });
    });
  });

  describe("serializeOperation", () => {
    it("serializes an operation", () => {
      expect(renderer.serializeOperation(algebraFactory.createNop())).toBe("");
    });
  });

  describe("render and renderAll", () => {
    it("returns direct serialization without applicable templates", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([]);
      await expect(renderer.render({ value: "abc" } as unknown as RDF.Term)).resolves.toBe(
        `<pre class="error">${JSON.stringify({ value: "abc" }, undefined, 2)}</pre>`,
      );
    });

    it("renderAll returns an empty array without applicable templates", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([]);
      await renderer.loadTemplates([]);
      await expect(renderer.renderAll(dataFactory.namedNode("no match"))).resolves.toEqual([]);
    });

    it("renderAll falls back to serialization for undefined terms", async () => {
      // JSON.stringify(undefined) returns undefined, which stringifies as "undefined" in the template literal
      await expect(renderer.renderAll(undefined)).resolves.toEqual([
        `<pre class="error">${String(JSON.stringify(undefined))}</pre>`,
      ]);
    });

    it("visualises the term recursively", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([
        {
          etaName: "template content",
          valuePattern: /^.*/,
          sparqlEndpoint: "https://query.wikidata.org/sparql",
          termType: "NamedNode",
        } as ITemplate,
      ]);
      vi.spyOn(renderer, "askBatched").mockResolvedValue(true);
      vi.spyOn(renderer, "selectBatched").mockResolvedValue([] as Record<string, RDF.Term>[]);
      await renderer.loadTemplates([]);
      vi.spyOn(renderer.eta, "renderAsync").mockImplementation(
        async (template: string | TemplateFunction, data: object): Promise<string> => {
          const context = data as ITemplateContext;
          expect(template).toBe("template content");
          if ((context.term as unknown as RDF.NamedNode).value === "term to visualise") {
            // Exercise both the provided and default bindings paths for each query function
            await expect(context.queryAsk("", [])).resolves.toBe(true);
            await expect(context.queryAsk("")).resolves.toBe(true);
            await expect(context.querySelect("", [])).resolves.toBeUndefined();
            await expect(context.querySelect("")).resolves.toBeUndefined();
            await expect(context.querySelectAll("", [])).resolves.toEqual([]);
            await expect(context.querySelectAll("")).resolves.toEqual([]);
            // Recursion: visualiseTerm is called with a new term
            return context.visualiseTerm(dataFactory.namedNode("recursive term"));
          }
          return "recursive output html";
        },
      );
      await expect(renderer.render(dataFactory.namedNode("term to visualise"))).resolves.toBe(
        "recursive output html",
      );
    });

    it("renderAll renders every applicable template and swallows rendering errors", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([
        {
          etaName: "first",
          valuePattern: /^.*/,
          sparqlEndpoint: "https://query.wikidata.org/sparql1",
          termType: "NamedNode",
        },
        {
          etaName: "second",
          valuePattern: /^.*/,
          sparqlEndpoint: "https://query.wikidata.org/sparql2",
          termType: "NamedNode",
        } satisfies ITemplate,
      ]);
      await renderer.loadTemplates([]);
      const error = new Error("Template rendering error");
      const renderSpy = vi
        .spyOn(renderer.eta, "renderAsync")
        .mockImplementation(async (template) => {
          if (template === "first") {
            throw error;
          }
          return "<p>second</p>";
        });
      await expect(
        renderer.renderAll(dataFactory.namedNode("term to visualise")),
      ).resolves.toEqual([`<pre class="error">${String(error)}</pre>`, "<p>second</p>"]);
      // Render results are cached per term and template: a re-render of the same term
      // resolves from the cache without invoking Eta again.
      await expect(
        renderer.renderAll(dataFactory.namedNode("term to visualise")),
      ).resolves.toEqual([`<pre class="error">${String(error)}</pre>`, "<p>second</p>"]);
      expect(renderSpy).toHaveBeenCalledTimes(2);
      // A new term misses the cache, so both templates are rendered fresh.
      await expect(renderer.renderAll(dataFactory.namedNode("other term"))).resolves.toEqual([
        `<pre class="error">${String(error)}</pre>`,
        "<p>second</p>",
      ]);
      expect(renderSpy).toHaveBeenCalledTimes(4);
    });

    it("visualises errors during template rendering", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([
        {
          etaName: "template content",
          valuePattern: /^.*/,
          sparqlEndpoint: "https://query.wikidata.org/sparql",
          termType: "NamedNode",
        } as ITemplate,
      ]);
      await renderer.loadTemplates([]);
      const error = new Error("Template rendering error");
      vi.spyOn(renderer.eta, "renderAsync").mockRejectedValue(error);
      await expect(renderer.render(dataFactory.namedNode("term to visualise"))).resolves.toBe(
        `<pre class="error">${String(error)}</pre>`,
      );
    });
  });

  describe("generateQueryIdentifier", () => {
    it("returns identical identifiers for identical queries, endpoints and bindings", () => {
      const bindings = [
        {
          var1: dataFactory.literal("value1"),
          var2: dataFactory.literal("value2"),
        },
      ];
      expect(
        renderer.generateQueryIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://query.wikidata.org/sparql",
          bindings,
        ),
      ).toEqual(
        renderer.generateQueryIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://query.wikidata.org/sparql",
          bindings,
        ),
      );
    });

    it("returns different identifiers for any difference in query, endpoint or binding values", () => {
      const identifier = renderer.generateQueryIdentifier(
        "ASK WHERE { ?s a <http://example.org/type> }",
        "https://query.wikidata.org/sparql",
        [{ var1: dataFactory.literal("value1") }],
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier(
          "ASK WHERE { ?s ?p ?o }",
          "https://query.wikidata.org/sparql",
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://dbpedia.org/sparql",
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://query.wikidata.org/sparql",
          [{ var1: dataFactory.literal("value2") }],
        ),
      );
    });
  });

  describe("generateQueryBatchIdentifier", () => {
    it("returns identical identifiers for identical queries, endpoints and binding keys", () => {
      expect(
        renderer.generateQueryBatchIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://query.wikidata.org/sparql",
          [{ var1: dataFactory.literal("value1") }, { var2: dataFactory.literal("value2") }],
        ),
      ).toEqual(
        renderer.generateQueryBatchIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://query.wikidata.org/sparql",
          [
            { var1: dataFactory.literal("other value") },
            { var2: dataFactory.literal("other value") },
          ],
        ),
      );
    });

    it("returns different identifiers for any difference in query or endpoint", () => {
      const identifier = renderer.generateQueryBatchIdentifier(
        "ASK WHERE { ?s a <http://example.org/type> }",
        "https://query.wikidata.org/sparql",
        [{ var1: dataFactory.literal("value1") }],
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryBatchIdentifier(
          "ASK WHERE { ?s ?p ?o }",
          "https://query.wikidata.org/sparql",
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryBatchIdentifier(
          "ASK WHERE { ?s a <http://example.org/type> }",
          "https://dbpedia.org/sparql",
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
    });
  });

  describe("batched query execution", () => {
    it("askBatched and selectBatched execute through their respective buffers", async () => {
      vi.spyOn(renderer, "executeAsk").mockResolvedValue(undefined);
      vi.spyOn(renderer, "executeSelect").mockResolvedValue(undefined);
      const executeBatched = vi
        .spyOn(renderer, "executeBatched")
        .mockImplementation((_query, _endpoint, _bindings, _buffer, executor) => {
          executor(dataFactory.namedNode("urn:batch"));
          return Promise.resolve("result");
        });
      const endpoint = "https://query.wikidata.org/sparql";
      const query = "ASK WHERE { ?s a <http://www.w3.org/2000/01/rdf-schema#Literal> }";
      await expect(renderer.askBatched(query, endpoint, [])).resolves.toBe("result");
      await expect(renderer.selectBatched(query, endpoint, [])).resolves.toBe("result");
      expect(executeBatched).toHaveBeenCalledTimes(2);
      // Each batch function must dispatch to its own buffer and executor
      expect(executeBatched.mock.calls[0][3]).toBe(renderer.askBuffer);
      expect(executeBatched.mock.calls[1][3]).toBe(renderer.selectBuffer);
      expect(renderer.executeAsk).toHaveBeenCalledOnce();
      expect(renderer.executeSelect).toHaveBeenCalledOnce();
    });

    it("selectAll executes a select query and returns the bindings", async () => {
      const rows = [{ s: dataFactory.namedNode("ex:s1") }, { s: dataFactory.namedNode("ex:s2") }];
      vi.spyOn(renderer.endpointFetcher, "fetchBindings").mockResolvedValue(
        createFakeStream(rows) as unknown as NodeJS.ReadableStream,
      );
      await expect(
        renderer.selectAll("SELECT ?s WHERE { ?s ?p ?o }", "https://query.wikidata.org/sparql"),
      ).resolves.toEqual(rows);
    });

    it("executeBatched groups queries into batches and resolves each query with the batch result", async () => {
      vi.useFakeTimers();
      const buffer: QueryBuffer<boolean> = {};
      const query = "ASK WHERE { ?s ?p ?o }";
      const endpoint = "https://query.wikidata.org/sparql";
      // Two identical queries (same bindings, in reversed key order) and one different
      // one, so the batch contains both a group of duplicate resolutions and a single
      // resolution. Each set has two bindings so identifier sorting is exercised.
      const bindingSets: Record<string, RDF.NamedNode | RDF.Literal>[][] = [
        [
          { o: dataFactory.namedNode("http://example.org/obj1") },
          { p: dataFactory.literal("value1") },
        ],
        [
          { p: dataFactory.literal("value1") },
          { o: dataFactory.namedNode("http://example.org/obj1") },
        ],
        [
          { o: dataFactory.namedNode("http://example.org/obj2") },
          { p: dataFactory.literal("value1") },
        ],
      ];
      const targetIdentifier = renderer.generateQueryIdentifier(
        query,
        endpoint,
        bindingSets[2],
      ).value;
      const executor = async (batchIdentifier: RDF.NamedNode) => {
        for (const [queryIdentifier, resolutions] of Object.entries(
          buffer[batchIdentifier.value].resolutions,
        )) {
          for (const resolution of resolutions) {
            resolution(queryIdentifier === targetIdentifier);
          }
        }
      };
      const promises = bindingSets.map((bindings) =>
        renderer.executeBatched(query, endpoint, bindings, buffer, executor),
      );
      vi.runAllTimers();
      await expect(promises[0]).resolves.toBe(false);
      await expect(promises[1]).resolves.toBe(false);
      await expect(promises[2]).resolves.toBe(true);
    });
  });

  describe("executeAsk", () => {
    const batchIdentifier = dataFactory.namedNode("urn:batch");
    const queryIdentifier = dataFactory.namedNode("urn:query");
    const emptyQueryIdentifier = dataFactory.namedNode("urn:empty");

    it("executes a batch of ask queries", async () => {
      vi.spyOn(renderer, "selectAll").mockResolvedValue([
        { query: queryIdentifier, s: dataFactory.namedNode("ex:s") },
      ]);
      const resolveMock = vi.fn();
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "https://query.wikidata.org/sparql",
          query: "ASK WHERE { ?s ?p ?o }",
          rejections: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
          resolutions: {
            [queryIdentifier.value]: [resolveMock],
            [emptyQueryIdentifier.value]: [resolveMock],
          },
        },
      };
      await expect(renderer.executeAsk(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(resolveMock).toHaveBeenNthCalledWith(1, true);
      expect(resolveMock).toHaveBeenNthCalledWith(2, false);
    });

    it("forwards errors to all original reject functions", async () => {
      const queryRejection = vi.fn();
      const emptyRejection = vi.fn();
      vi.spyOn(renderer, "selectAll").mockRejectedValue(new Error("Query error"));
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "https://query.wikidata.org/sparql",
          query: "ASK WHERE { ?s ?p ?o }",
          rejections: {
            [queryIdentifier.value]: [queryRejection],
            [emptyQueryIdentifier.value]: [emptyRejection],
          },
          resolutions: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
        },
      };
      await expect(renderer.executeAsk(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(queryRejection).toHaveBeenCalledWith(new Error("Query error"));
      expect(emptyRejection).toHaveBeenCalledWith(new Error("Query error"));
    });

    it("forwards parse errors to all original reject functions", async () => {
      const queryRejection = vi.fn();
      const emptyRejection = vi.fn();
      vi.spyOn(renderer, "parseOperation").mockImplementation(() => {
        throw new Error("Parse error");
      });
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "https://query.wikidata.org/sparql",
          query: "ASK WHERE { ?s ?p ?o }",
          rejections: {
            [queryIdentifier.value]: [queryRejection],
            [emptyQueryIdentifier.value]: [emptyRejection],
          },
          resolutions: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
        },
      };
      await expect(renderer.executeAsk(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(queryRejection).toHaveBeenCalledWith(new Error("Parse error"));
      expect(emptyRejection).toHaveBeenCalledWith(new Error("Parse error"));
    });
  });

  describe("executeSelect", () => {
    const batchIdentifier = dataFactory.namedNode("urn:batch");
    const queryIdentifier = dataFactory.namedNode("urn:query");
    const emptyQueryIdentifier = dataFactory.namedNode("urn:empty");

    it("executes a batch of select queries", async () => {
      vi.spyOn(renderer, "selectAll").mockResolvedValue([
        { query: queryIdentifier, s: dataFactory.namedNode("ex:s1") },
        { query: queryIdentifier, s: dataFactory.namedNode("ex:s2") },
      ]);
      const resolveMock = vi.fn();
      const buffer: QueryBuffer<IBindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "https://query.wikidata.org/sparql",
          query: "SELECT ?s WHERE { ?s ?p ?o }",
          rejections: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
          resolutions: {
            [queryIdentifier.value]: [resolveMock],
            [emptyQueryIdentifier.value]: [resolveMock],
          },
        },
      };
      await expect(renderer.executeSelect(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(resolveMock).toHaveBeenNthCalledWith(1, [expect.anything(), expect.anything()]);
      expect(resolveMock).toHaveBeenNthCalledWith(2, []);
    });

    it("forwards errors to all original reject functions", async () => {
      const queryRejection = vi.fn();
      const emptyRejection = vi.fn();
      vi.spyOn(renderer, "selectAll").mockRejectedValue(new Error("Query error"));
      const buffer: QueryBuffer<IBindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "https://query.wikidata.org/sparql",
          query: "SELECT ?s WHERE { ?s ?p ?o }",
          rejections: {
            [queryIdentifier.value]: [queryRejection],
            [emptyQueryIdentifier.value]: [emptyRejection],
          },
          resolutions: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
        },
      };
      await expect(renderer.executeSelect(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(queryRejection).toHaveBeenCalledWith(new Error("Query error"));
      expect(emptyRejection).toHaveBeenCalledWith(new Error("Query error"));
    });

    it("forwards parse errors to all original reject functions", async () => {
      const queryRejection = vi.fn();
      const emptyRejection = vi.fn();
      vi.spyOn(renderer, "parseOperation").mockImplementation(() => {
        throw new Error("Parse error");
      });
      const buffer: QueryBuffer<IBindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "https://query.wikidata.org/sparql",
          query: "SELECT ?s WHERE { ?s ?p ?o }",
          rejections: {
            [queryIdentifier.value]: [queryRejection],
            [emptyQueryIdentifier.value]: [emptyRejection],
          },
          resolutions: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
        },
      };
      await expect(renderer.executeSelect(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(queryRejection).toHaveBeenCalledWith(new Error("Parse error"));
      expect(emptyRejection).toHaveBeenCalledWith(new Error("Parse error"));
    });
  });
});

// Minimal stream double for SparqlEndpointFetcher#fetchBindings: the renderer
// only registers "data", "end" and "error" listeners, so emit synchronously
// and return `this` to allow the chainable `.on()` calls.
function createFakeStream(rows: Record<string, RDF.NamedNode>[]) {
  const stream = {
    on(event: string, handler: (...args: unknown[]) => void): object {
      if (event === "data") {
        rows.forEach((row) => handler(row));
      } else if (event === "end") {
        handler();
      }
      return stream;
    },
  };
  return stream;
}
