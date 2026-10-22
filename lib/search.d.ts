/** Text to store in an FTS5 column (tokenize='unicode61'). */
export declare function searchTokens(text: string): string;
/**
 * FTS5 MATCH expression for what a person typed: each space-separated term must appear, and the characters of a term
 * must be adjacent (a phrase). Returns '' when nothing searchable remains, which callers treat as "no search".
 */
export declare function searchQuery(input: string): string;
