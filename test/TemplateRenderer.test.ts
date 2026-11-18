import type * as RDF from "@rdfjs/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArrayIterator } from "asynciterator";
import { DataFactory } from "rdf-data-factory";
import type { IQueryEngine } from "@comunica/types";
import type { Algebra } from "@traqula/algebra-transformations-1-2";
import { AlgebraFactory } from "@traqula/algebra-transformations-1-2";
import { TemplateRenderer, type QueryBuffer } from "../lib/TemplateRenderer";
import type { ITemplate } from "../lib/Template";
import type { ITemplateContext } from "../lib/TemplateContext";
import type { Eta } from "eta";
import { IBindings } from "fetch-sparql-endpoint";

describe("TemplateRenderer", () => {
  type TestTemplateRenderer = TemplateRenderer & {
    readonly eta: Eta;
    calculateRelevance(template: ITemplate, term: RDF.Term): number;
    parseOperation(op: string): Algebra.Operation;
    serializeOperation(operation: Algebra.Operation): string;
    bindingsToValues(bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): Algebra.Values;
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
    selectAll(query: string, endpoint: string): Promise<Record<string, RDF.Term>[]>;
    executeAsk(buffer: QueryBuffer<boolean>, batchIdentifier: RDF.NamedNode): Promise<void>;
    executeSelect(
      buffer: QueryBuffer<Record<string, RDF.Term>[]>,
      batchIdentifier: RDF.NamedNode,
    ): Promise<void>;
    askBatched(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    ): Promise<boolean>;
    selectBatched(
      query: string,
      endpoint: string,
      bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    ): Promise<Record<string, RDF.Term>[]>;
    readonly askBuffer: QueryBuffer<boolean>;
    readonly selectBuffer: QueryBuffer<Record<string, RDF.Term>[]>;
    readonly endpointFetcher: { fetchBindings(endpoint: string, query: string): unknown };
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
            [
              "priority",
              dataFactory.literal(
                "10",
                dataFactory.namedNode("http://www.w3.org/2001/XMLSchema#integer"),
              ),
            ],
            ["target", dataFactory.namedNode("https://localhost/sparql")],
          ]),
          // A lower-priority duplicate, to exercise template deduplication
          new Map<string, RDF.Term>([
            ["template", dataFactory.namedNode("urn:template")],
            ["pattern", dataFactory.literal(".*")],
            ["text", dataFactory.literal("<p>duplicate</p>")],
            [
              "priority",
              dataFactory.literal(
                "0",
                dataFactory.namedNode("http://www.w3.org/2001/XMLSchema#integer"),
              ),
            ],
            ["target", dataFactory.namedNode("https://localhost/sparql")],
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
      const defaultRenderer = new TemplateRenderer({});
      // JSON.stringify(undefined) serializes to the string "undefined"
      await expect(defaultRenderer.visualiseTerm(undefined)).resolves.toBe(
        `<pre class="error">${encodeURI(JSON.stringify(undefined))}</pre>`,
      );
      expect(defaultRenderer.findTemplates(dataFactory.namedNode("abc"))).toEqual([]);
    });
  });

  describe("loadTemplates", () => {
    it("retrieves templates using the query engine when sources are given", async () => {
      await expect(renderer.loadTemplates(["https://localhost/sparql"])).resolves.toBe(1);
      expect(queryEngine.queryBindings).toHaveBeenCalledOnce();
      const template = renderer.templates.get("urn:template")!;
      expect(template.content).toBe("<p>example</p>");
    });

    it("returns no templates when no sources are given", async () => {
      await expect(renderer.loadTemplates([])).resolves.toBe(0);
      expect(queryEngine.queryBindings).not.toHaveBeenCalled();
    });

    it("forwards errors from the query engine", async () => {
      vi.spyOn(queryEngine, "queryBindings").mockRejectedValue(
        new Error("Error from query engine"),
      );
      await expect(renderer.loadTemplates(["https://localhost/sparql"])).rejects.toThrow(
        "Error from query engine",
      );
    });
  });

  describe("findTemplates", () => {
    it("returns the applicable templates sorted by relevance", () => {
      const template1: ITemplate = { content: "content1", pattern: /^ab/, target: "urn:target1" };
      const template2: ITemplate = { content: "content2", pattern: /^abc/, target: "urn:target2" };
      const template3: ITemplate = { content: "content3", pattern: /^xyz$/, target: "urn:target3" };
      renderer.templates.set("t1", template1);
      renderer.templates.set("t2", template2);
      renderer.templates.set("t3", template3);
      expect(renderer.findTemplates(dataFactory.namedNode("abc"))).toEqual([template2, template1]);
    });
  });

  describe("calculateRelevance", () => {
    it("returns the length of the regex match for applicable templates", () => {
      const template: ITemplate = { content: "content", pattern: /^ab/, target: "urn:target" };
      expect(renderer.calculateRelevance(template, dataFactory.namedNode("abcdef"))).toBe(2);
    });

    it("returns negative infinity for inapplicable templates", () => {
      const template: ITemplate = { content: "content", pattern: /^xyz/, target: "urn:target" };
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

  describe("visualiseTerm", () => {
    it("returns direct serialization without applicable templates", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([]);
      await expect(renderer.visualiseTerm({ value: "abc" } as unknown as RDF.Term)).resolves.toBe(
        `<pre class="error">${encodeURI(JSON.stringify({ value: "abc" }, undefined, 2))}</pre>`,
      );
    });

    it("visualises the term recursively", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([
        { content: "template content", pattern: /^.*/, target: "urn:target" } as ITemplate,
      ]);
      vi.spyOn(renderer, "askBatched").mockResolvedValue(true);
      vi.spyOn(renderer, "selectBatched").mockResolvedValue([] as Record<string, RDF.Term>[]);
      vi.spyOn(renderer.eta, "renderStringAsync").mockImplementation(
        async (template: string, data: object): Promise<string> => {
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
      await expect(
        renderer.visualiseTerm(dataFactory.namedNode("term to visualise")),
      ).resolves.toBe("recursive output html");
    });

    it("visualises errors during template rendering", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([
        { content: "template content", pattern: /^.*/, target: "urn:target" } as ITemplate,
      ]);
      const error = new Error("Template rendering error");
      vi.spyOn(renderer.eta, "renderStringAsync").mockRejectedValue(error);
      await expect(
        renderer.visualiseTerm(dataFactory.namedNode("term to visualise")),
      ).resolves.toBe(`<pre class="error">${encodeURI(String(error))}</pre>`);
    });
  });

  describe("generateQueryIdentifier", () => {
    it("returns identical identifiers for identical queries, endpoints and bindings", () => {
      const bindings = [
        { var1: dataFactory.literal("value1"), var2: dataFactory.literal("value2") },
      ];
      expect(renderer.generateQueryIdentifier("query1", "source1", bindings)).toEqual(
        renderer.generateQueryIdentifier("query1", "source1", bindings),
      );
    });

    it("returns different identifiers for any difference in query, endpoint or binding values", () => {
      const identifier = renderer.generateQueryIdentifier("query1", "source1", [
        { var1: dataFactory.literal("value1") },
      ]);
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier("query2", "source1", [
          { var1: dataFactory.literal("value1") },
        ]),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier("query1", "source2", [
          { var1: dataFactory.literal("value1") },
        ]),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier("query1", "source1", [
          { var1: dataFactory.literal("value2") },
        ]),
      );
    });
  });

  describe("generateQueryBatchIdentifier", () => {
    it("returns identical identifiers for identical queries, endpoints and binding keys", () => {
      expect(
        renderer.generateQueryBatchIdentifier("query1", "source1", [
          { var1: dataFactory.literal("value1") },
          { var2: dataFactory.literal("value2") },
        ]),
      ).toEqual(
        renderer.generateQueryBatchIdentifier("query1", "source1", [
          { var1: dataFactory.literal("other value") },
          { var2: dataFactory.literal("other value") },
        ]),
      );
    });

    it("returns different identifiers for any difference in query or endpoint", () => {
      const identifier = renderer.generateQueryBatchIdentifier("query1", "source1", [
        { var1: dataFactory.literal("value1") },
      ]);
      expect(identifier).not.toEqual(
        renderer.generateQueryBatchIdentifier("query2", "source1", [
          { var1: dataFactory.literal("value1") },
        ]),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryBatchIdentifier("query1", "source2", [
          { var1: dataFactory.literal("value1") },
        ]),
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
      await expect(renderer.askBatched("query", "urn:endpoint", [])).resolves.toBe("result");
      await expect(renderer.selectBatched("query", "urn:endpoint", [])).resolves.toBe("result");
      expect(executeBatched).toHaveBeenCalledTimes(2);
      // Each batch function must dispatch to its own buffer and executor
      expect(executeBatched.mock.calls[0][3]).toBe(renderer.askBuffer);
      expect(executeBatched.mock.calls[1][3]).toBe(renderer.selectBuffer);
      expect(renderer.executeAsk).toHaveBeenCalledOnce();
      expect(renderer.executeSelect).toHaveBeenCalledOnce();
    });

    it("selectAll executes a select query and converts the stream to an array", async () => {
      const rows = [{ s: dataFactory.namedNode("ex:s1") }, { s: dataFactory.namedNode("ex:s2") }];
      vi.spyOn(renderer.endpointFetcher, "fetchBindings").mockResolvedValue(
        createFakeStream(rows) as unknown as NodeJS.ReadableStream,
      );
      await expect(
        renderer.selectAll("SELECT ?s WHERE { ?s ?p ?o }", "urn:endpoint"),
      ).resolves.toEqual(rows);
    });

    it("executeBatched groups queries into batches and resolves each query with the batch result", async () => {
      vi.useFakeTimers();
      const buffer: QueryBuffer<boolean> = {};
      const query = "ASK WHERE { ?s ?p ?o }";
      const endpoint = "urn:endpoint";
      // Two identical queries (same bindings, in reversed order) and one different
      // one, so the batch contains both a group of duplicate resolutions and a single
      // resolution. Each set has two bindings so identifier sorting is exercised.
      const bindingSets: Record<string, RDF.NamedNode | RDF.Literal>[][] = [
        [{ z: dataFactory.namedNode("o0") }, { a: dataFactory.literal("p1") }],
        [{ a: dataFactory.literal("p1") }, { z: dataFactory.namedNode("o0") }],
        [{ z: dataFactory.namedNode("o1") }, { a: dataFactory.literal("p1") }],
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
          endpoint: "urn:endpoint",
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
          endpoint: "urn:endpoint",
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
      await expect(renderer.executeAsk(buffer, batchIdentifier)).rejects.toThrow("Query error");
      expect(queryRejection).toHaveBeenCalledOnce();
      expect(emptyRejection).toHaveBeenCalledOnce();
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
      const buffer: QueryBuffer<Record<string, RDF.Term>[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "urn:endpoint",
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
      const buffer: QueryBuffer<Record<string, RDF.Term>[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          endpoint: "urn:endpoint",
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
      await expect(renderer.executeSelect(buffer, batchIdentifier)).rejects.toThrow("Query error");
      expect(queryRejection).toHaveBeenCalledOnce();
      expect(emptyRejection).toHaveBeenCalledOnce();
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
