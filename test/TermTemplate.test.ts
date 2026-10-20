import type * as RDF from "@rdfjs/types";
import { describe, expect, it } from "vitest";
import { TermTemplate } from "../lib/TermTemplate";

describe("TermTemplate", () => {
  describe("constructor", () => {
    it("should create an instance when all data is present", () => {
      const bindings = new Map([
        ["template", { value: "urn:template" }],
        ["pattern", { value: ".*" }],
        ["text", { value: "<p>example</p>" }],
        ["target", { value: "https://localhost/sparql" }],
      ]) as unknown as RDF.Bindings;
      expect(new TermTemplate(bindings)).toBeInstanceOf(TermTemplate);
    });

    it("should throw on bad pattern", () => {
      const bindings = new Map([
        ["template", { value: "urn:template" }],
        ["pattern", { value: "[[[" }],
        ["text", { value: "<p>example</p>" }],
        ["target", { value: "https://localhost/sparql" }],
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow();
    });

    it("should throw on missing identifier", () => {
      const bindings = new Map([
        ["pattern", { value: ".*" }],
        ["text", { value: "<p>example</p>" }],
        ["target", { value: "https://localhost/sparql" }],
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow("undefined");
    });

    it("should throw on missing pattern", () => {
      const bindings = new Map([
        ["template", { value: "urn:template" }],
        ["text", { value: "<p>example</p>" }],
        ["target", { value: "https://localhost/sparql" }],
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow("undefined");
    });

    it("should throw on missing text", () => {
      const bindings = new Map([
        ["template", { value: "urn:template" }],
        ["pattern", { value: ".*" }],
        ["target", { value: "https://localhost/sparql" }],
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow("undefined");
    });

    it("should throw on missing target", () => {
      const bindings = new Map([
        ["template", { value: "urn:template" }],
        ["pattern", { value: ".*" }],
        ["text", { value: "<p>example</p>" }],
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow("undefined");
    });
  });

  describe("calculateRelevance", () => {
    const bindings = new Map([
      ["template", { value: "urn:template" }],
      ["pattern", { value: "^AB" }],
      ["text", { value: "<p>example</p>" }],
      ["target", { value: "https://localhost/sparql" }],
    ]) as unknown as RDF.Bindings;

    const template = new TermTemplate(bindings);

    it("should return negative infinity for non-matching values", () => {
      const term = { value: "B" } as RDF.Term;
      expect(template.calculateRelevance(term)).toBe(Number.NEGATIVE_INFINITY);
    });

    it("should return match length for matching values", () => {
      const term = { value: "ABCD" } as RDF.Term;
      expect(template.calculateRelevance(term)).toBe(2);
    });

    it("resets lastIndex so repeated calls on a global-flag pattern always find the first match", () => {
      // A global-flag RegExp retains lastIndex between .exec() calls.
      // calculateRelevance must reset it, otherwise the second call
      // starts searching after the previous match and returns null.
      const globalBindings = new Map([
        ["template", { value: "urn:global" }],
        ["pattern", { value: "AB" }],
        ["text", { value: "<p>example</p>" }],
        ["target", { value: "https://localhost/sparql" }],
      ]) as unknown as RDF.Bindings;
      const globalTemplate = new TermTemplate(globalBindings);
      // Replace with a global-flag pattern to exercise the lastIndex reset
      Object.defineProperty(globalTemplate, "pattern", {
        value: new RegExp("AB", "gu"),
        writable: true,
      });

      const term = { value: "ABCD" } as RDF.Term;
      expect(globalTemplate.calculateRelevance(term)).toBe(2);
      // Without lastIndex reset, the second call would start at index 2
      // and fail to find "AB" again.
      expect(globalTemplate.calculateRelevance(term)).toBe(2);
    });
  });
});
