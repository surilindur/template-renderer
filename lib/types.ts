import type * as RDF from "@rdfjs/types";
import type { QuerySourceUnidentified } from "@comunica/types";
import type { IBindings } from "fetch-sparql-endpoint";

type QueryBatch<T> = {
  query: string;
  endpoint: string;
  bindings: IBindings[];
  resolutions: Record<string, ((value: T) => void)[]>;
  rejections: Record<string, ((error: unknown) => void)[]>;
};

type QueryBuffer<T> = Record<string, QueryBatch<T>>;

interface ITemplateRenderer {
  /**
   * Load all templates from the specified sources.
   * @param sources The sources to query for templates.
   * @returns The number of templates loaded.
   */
  loadTemplates: (sources: QuerySourceUnidentified[]) => Promise<void>;
  /**
   * Visualise the given RDF term using the loaded templates.
   * This method selects the first appropriate template and uses only that.
   * This is an unsafe operation: the HTML output is not escaped.
   * @param term The term to visualise.
   * @returns The HTML content of the visualisation.
   */
  render: (term: RDF.Term | undefined) => Promise<string>;
  /**
   * Visualise the given RDF term using the loaded templates.
   * This method renders all appropriate templates.
   * This is an unsafe operation: the HTML output is not escaped.
   * @param term The term to visualise.
   * @returns The HTML content of the visualisation.
   */
  renderAll: (term: RDF.Term | undefined) => Promise<string[]>;
}

/**
 * The context expected to be present in each term template.
 * This includes the term itself, that is to be visualised,
 * as well as helper functions for query execution and further visualisations.
 */
interface ITemplateContext {
  /**
   * The current RDF term being visualised.
   */
  term: RDF.Term;
  /**
   * Generate an HTML visualisation of the specified RDF term.
   */
  visualiseTerm: (term: RDF.Term) => Promise<string>;
  /**
   * Execute a SPARQL SELECT query against the current template's target,
   * returning the first solution mapping only.
   */
  querySelect: (
    query: string,
    bindings?: Record<string, RDF.NamedNode | RDF.Literal>[],
  ) => Promise<Record<string, RDF.Term> | undefined>;
  /**
   * Execute a SPARQL SELECT query against the current template's target,
   * returning all solution mappings.
   */
  querySelectAll: (
    query: string,
    bindings?: Record<string, RDF.NamedNode | RDF.Literal>[],
  ) => Promise<Record<string, RDF.Term>[]>;
  /**
   * Execute a SPARQL ASK query against the current template's target.
   */
  queryAsk: (
    query: string,
    bindings?: Record<string, RDF.NamedNode | RDF.Literal>[],
  ) => Promise<boolean>;
}

interface ITemplate {
  /**
   * The regular expression that the term value must match.
   * The length of the match will be the relevance of the template.
   */
  pattern: RegExp;
  /**
   * The content of the template, in EJS/Eta template language.
   */
  content: string;
  /**
   * The URI of the SPARQL endpoint that will handle all queries issued
   * from within the template using one of the query methods.
   */
  endpoint: string;
  /**
   * The type of RDF term this template can be applied to.
   * This helps avoid running named node templates on literals, for example.
   */
  target: RDF.NamedNode["termType"] | RDF.Literal["termType"];
}

export type { QueryBatch, QueryBuffer, ITemplateRenderer, ITemplateContext, ITemplate };
