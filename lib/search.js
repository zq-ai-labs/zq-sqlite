/**
 * Chinese-aware full-text search on SQLite FTS5 with the built-in `unicode61` tokenizer (no extension needed).
 * Runs of Chinese, Japanese or Korean characters become overlapping two-character tokens, so common two-character
 * words (报价, 合同, 发票) are found through the index; other text keeps its words, lowercased. Index and query go
 * through the same function, so a later server database using the same tokens returns the same matches.
 *
 * A one-character query can only match tokens that start with that character (FTS5 has no suffix search).
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;
const RUNS = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+|[\p{L}\p{N}]+/gu;
function tokens(text) {
    const out = [];
    for (const [run] of text.normalize('NFKC').matchAll(RUNS)) {
        if (!CJK.test(run[0])) {
            out.push(run.toLowerCase());
            continue;
        }
        const chars = [...run];
        if (chars.length === 1) {
            out.push(chars[0]);
            continue;
        }
        for (let i = 0; i < chars.length - 1; i++)
            out.push(chars[i] + chars[i + 1]);
    }
    return out;
}
/** Text to store in an FTS5 column (tokenize='unicode61'). */
export function searchTokens(text) { return tokens(text).join(' '); }
/**
 * FTS5 MATCH expression for what a person typed: each space-separated term must appear, and the characters of a term
 * must be adjacent (a phrase). Returns '' when nothing searchable remains, which callers treat as "no search".
 */
export function searchQuery(input) {
    return input.split(/\s+/).map(term => tokens(term)).filter(list => list.length)
        .map(list => list.length === 1 && [...list[0]].length === 1 && CJK.test(list[0]) ? `"${list[0]}"*` : `"${list.join(' ').replaceAll('"', '""')}"`)
        .join(' ');
}
