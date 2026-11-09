/** The screen-reader name of an `Explain` chip: "what <of> means". An `of` that already starts with "what" ("what the vault does") reads as that, never "what what". */
export const explainName = (of: string): string => `what ${of.replace(/^what\s+/i, "")} means`;
