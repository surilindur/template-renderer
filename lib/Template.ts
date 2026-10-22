interface ITemplate {
  /**
   * The pattern, that the term value must match, for this template to be used.
   */
  pattern: RegExp;
  /**
   * The content of the template, in EJS/ETA template language.
   */
  content: string;
  /**
   * The target against which all queries issues by this template are evaluated.
   */
  target: string;
}

export type { ITemplate };
