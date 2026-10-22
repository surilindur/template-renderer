import type * as RDF from "@rdfjs/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArrayIterator } from "asynciterator";
import { DataFactory } from "rdf-data-factory";
import type { BindingsStream, IQueryEngine } from "@comunica/types";
import { AlgebraFactory } from "@traqula/algebra-transformations-1-2";
import { TemplateRenderer, type QueryBuffer } from "../lib/TemplateRenderer";
import type { ITemplate } from "../lib/Template";
import type { ITemplateContext } from "../lib/TemplateContext";

describe("TemplateRenderer", () => {
  let renderer: TemplateRenderer;
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
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("loadTemplates", () => {
    it("retrieves templates using the query engine", async () => {
      await expect(renderer.loadTemplates([])).resolves.not.toThrow();
      expect(queryEngine.queryBindings).toHaveBeenCalledOnce();
      const template = renderer.templates.get("urn:template")!;
      expect(template.content).toBe("<p>example</p>");
    });

    it("forwards errors from the query engine", async () => {
      vi.spyOn(queryEngine, "queryBindings").mockRejectedValue(
        new Error("Error from query engine"),
      );
      await expect(renderer.loadTemplates([])).rejects.toThrow("Error from query engine");
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

  describe("bindingsToRecords", () => {
    it("converts a bindings array to a record array", () => {
      const bindings = [
        new Map<RDF.Variable, RDF.Term>([
          [dataFactory.variable("var1"), dataFactory.literal("value1")],
        ]),
        new Map<RDF.Variable, RDF.Term>([
          [dataFactory.variable("var1"), dataFactory.namedNode("ex:value2")],
        ]),
      ] as unknown as RDF.Bindings[];
      expect(TemplateRenderer.bindingsToRecords(bindings)).toEqual([
        { var1: dataFactory.literal("value1") },
        { var1: dataFactory.namedNode("ex:value2") },
      ]);
    });
  });

  describe("bindingsToValues", () => {
    it("converts bindings array to values clause", () => {
      const bindings = [{ var1: dataFactory.literal("value1") }];
      expect(renderer.bindingsToValues(bindings)).toEqual(
        algebraFactory.createValues([dataFactory.variable("var1")], bindings),
      );
    });
  });

  describe("parseOperation", () => {
    it("parses an operation", () => {
      expect(TemplateRenderer.parseOperation("")).toEqual({ type: "nop" });
    });
  });

  describe("serializeOperation", () => {
    it("serializes an operation", () => {
      expect(TemplateRenderer.serializeOperation(algebraFactory.createNop())).toBe("");
    });
  });

  describe("visualiseTerm", () => {
    it("returns direct serialization without applicable templates", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([]);
      await expect(renderer.visualiseTerm({ value: "abc" } as unknown as RDF.Term)).resolves.toBe(
        '<pre class="error">{\n  "value": "abc"\n}</pre>',
      );
    });

    it("visualises the term recursively", async () => {
      vi.spyOn(renderer, "findTemplates").mockReturnValue([
        { content: "template content", pattern: /^.*/, target: "urn:target" } as ITemplate,
      ]);
      vi.spyOn(renderer, "askBatched").mockResolvedValue(true);
      vi.spyOn(renderer, "selectBatched").mockResolvedValue([] as RDF.Bindings[]);
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
      vi.spyOn(renderer.eta, "renderStringAsync").mockRejectedValue(
        new Error("Template rendering error"),
      );
      await expect(
        renderer.visualiseTerm(dataFactory.namedNode("term to visualise")),
      ).resolves.toBe('<pre class="error">Error: Template rendering error</pre>');
    });
  });

  describe("generateQueryIdentifier", () => {
    it("returns identical identifiers for identical queries, sources and bindings", () => {
      const bindings = [
        { var1: dataFactory.literal("value1"), var2: dataFactory.literal("value2") },
      ];
      expect(renderer.generateQueryIdentifier("query1", ["source1"], bindings)).toEqual(
        renderer.generateQueryIdentifier("query1", ["source1"], bindings),
      );
    });

    it("returns different identifiers for any difference in query, sources or binding values", () => {
      const identifier = renderer.generateQueryIdentifier(
        "query1",
        ["source1"],
        [{ var1: dataFactory.literal("value1") }],
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier(
          "query2",
          ["source1"],
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier(
          "query1",
          ["source2"],
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryIdentifier(
          "query1",
          ["source1"],
          [{ var1: dataFactory.literal("value2") }],
        ),
      );
    });
  });

  describe("generateQueryBatchIdentifier", () => {
    it("returns identical identifiers for identical queries, sources and binding keys", () => {
      expect(
        renderer.generateQueryBatchIdentifier(
          "query1",
          ["source1"],
          [{ var1: dataFactory.literal("value1") }, { var2: dataFactory.literal("value2") }],
        ),
      ).toEqual(
        renderer.generateQueryBatchIdentifier(
          "query1",
          ["source1"],
          [
            { var1: dataFactory.literal("other value") },
            { var2: dataFactory.literal("other value") },
          ],
        ),
      );
    });

    it("returns different identifiers for any difference in query or sources", () => {
      const identifier = renderer.generateQueryBatchIdentifier(
        "query1",
        ["source1"],
        [{ var1: dataFactory.literal("value1") }],
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryBatchIdentifier(
          "query2",
          ["source1"],
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
      expect(identifier).not.toEqual(
        renderer.generateQueryBatchIdentifier(
          "query1",
          ["source2"],
          [{ var1: dataFactory.literal("value1") }],
        ),
      );
    });
  });

  describe("batched query execution", () => {
    it("askBatched and selectBatched execute through their respective buffers", async () => {
      vi.spyOn(renderer, "executeAsk").mockResolvedValue(undefined);
      vi.spyOn(renderer, "executeSelect").mockResolvedValue(undefined);
      vi.spyOn(renderer, "executeBatched").mockImplementation(
        (_query, _sources, _bindings, buffer, executor) => {
          executor(dataFactory.namedNode("urn:batch"));
          return Promise.resolve("result");
        },
      );
      await expect(renderer.askBatched("query", [], [])).resolves.toBe("result");
      await expect(renderer.selectBatched("query", [], [])).resolves.toBe("result");
      expect(renderer.executeBatched).toHaveBeenCalledTimes(2);
      expect(renderer.executeAsk).toHaveBeenCalledOnce();
      expect(renderer.executeSelect).toHaveBeenCalledOnce();
    });

    it("selectAll executes a select query and converts the stream to an array", async () => {
      vi.spyOn(queryEngine, "queryBindings").mockResolvedValue(
        new ArrayIterator(["bindings1", "bindings2"]) as unknown as BindingsStream,
      );
      await expect(renderer.selectAll("query", [])).resolves.toEqual(["bindings1", "bindings2"]);
    });

    it("executeBatched groups queries into batches and resolves each query with the batch result", async () => {
      vi.useFakeTimers();
      const buffer: QueryBuffer<boolean> = {};
      const query = "ASK WHERE { ?s ?p ?o }";
      const sources = ["urn:source1"];
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
        sources,
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
        renderer.executeBatched(query, sources, bindings, buffer, executor),
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
        new Map<string, RDF.NamedNode>([
          ["query", queryIdentifier],
          ["s", dataFactory.namedNode("ex:s")],
        ]) as unknown as RDF.Bindings,
      ]);
      const resolveMock = vi.fn();
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: "ASK WHERE { ?s ?p ?o }",
          sources: [],
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
      vi.spyOn(renderer, "selectAll").mockRejectedValue(new Error("Query error"));
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: "ASK WHERE { ?s ?p ?o }",
          sources: [],
          rejections: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
          resolutions: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
        },
      };
      await expect(renderer.executeAsk(buffer, batchIdentifier)).rejects.toThrow("Query error");
    });
  });

  describe("executeSelect", () => {
    const batchIdentifier = dataFactory.namedNode("urn:batch");
    const queryIdentifier = dataFactory.namedNode("urn:query");
    const emptyQueryIdentifier = dataFactory.namedNode("urn:empty");

    it("executes a batch of select queries", async () => {
      vi.spyOn(renderer, "selectAll").mockResolvedValue([
        new Map<string, RDF.NamedNode>([
          ["query", queryIdentifier],
          ["s", dataFactory.namedNode("ex:s1")],
        ]) as unknown as RDF.Bindings,
        new Map<string, RDF.NamedNode>([
          ["query", queryIdentifier],
          ["s", dataFactory.namedNode("ex:s2")],
        ]) as unknown as RDF.Bindings,
      ]);
      const resolveMock = vi.fn();
      const buffer: QueryBuffer<RDF.Bindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: "SELECT ?s WHERE { ?s ?p ?o }",
          sources: [],
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
      expect(resolveMock).toHaveBeenNthCalledWith(1, [expect.any(Map), expect.any(Map)]);
      expect(resolveMock).toHaveBeenNthCalledWith(2, []);
    });

    it("forwards errors to all original reject functions", async () => {
      vi.spyOn(renderer, "selectAll").mockRejectedValue(new Error("Query error"));
      const buffer: QueryBuffer<RDF.Bindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: "SELECT ?s WHERE { ?s ?p ?o }",
          sources: [],
          rejections: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
          resolutions: {
            [queryIdentifier.value]: [vi.fn()],
            [emptyQueryIdentifier.value]: [vi.fn()],
          },
        },
      };
      await expect(renderer.executeSelect(buffer, batchIdentifier)).rejects.toThrow("Query error");
    });
  });
});
