/**
 * Fuzzy search over MkDocs Material's search_index.json.
 * Fetched once and cached. Does edit-distance-1 matching against
 * page text so "bittensor" → "bittensor" is found even when the
 * catalog title/description doesn't contain the term.
 */
const STOPWORDS = new Set(('a an and are as at be by for from how in is it of on or that the this to was ' +
    'what when where which who why with does do can you your').split(/\s+/));
let cachedDocs = null;
let pending = null;
async function loadDocs() {
    if (cachedDocs)
        return cachedDocs;
    if (pending)
        return pending;
    pending = (async () => {
        try {
            const res = await fetch('/search/search_index.json');
            if (res.ok) {
                const data = await res.json();
                cachedDocs = data.docs || [];
            }
        }
        catch { /* offline / unavailable */ }
        if (!cachedDocs)
            cachedDocs = [];
        pending = null;
        return cachedDocs;
    })();
    return pending;
}
/** Generate all edit-distance-1 variants of `word`. */
function ed1Variants(word) {
    const variants = new Set();
    const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < word.length; i++) {
        variants.add(word.slice(0, i) + word.slice(i + 1)); // deletion
        for (const ch of alpha) {
            variants.add(word.slice(0, i) + ch + word.slice(i)); // insertion
            variants.add(word.slice(0, i) + ch + word.slice(i + 1)); // substitution
        }
    }
    for (let i = 0; i < word.length - 1; i++) {
        variants.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)); // transposition
    }
    return variants;
}
/**
 * Search the site's search_index.json for pages matching `question` terms.
 * Returns up to 10 markdown-formatted hints (title + URL + snippet) for
 * inclusion in the LLM request as search context.
 */
export async function searchHints(question) {
    const rawTerms = question
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g)
        ?.filter(t => !STOPWORDS.has(t)) || [];
    if (rawTerms.length === 0)
        return '';
    // Expand each term with ED1 variants for fuzzy matching
    const fuzzyTerms = new Set();
    for (const t of rawTerms) {
        fuzzyTerms.add(t);
        for (const v of ed1Variants(t))
            fuzzyTerms.add(v);
    }
    const docs = await loadDocs();
    if (docs.length === 0)
        return '';
    const hits = [];
    for (const doc of docs) {
        const text = (doc.text || '').toLowerCase();
        // Check if any fuzzy term appears in the document text
        let matched = false;
        for (const t of fuzzyTerms) {
            if (text.includes(t)) {
                matched = true;
                break;
            }
        }
        if (!matched)
            continue;
        // Extract a snippet around the first matching term
        let bestIdx = Infinity;
        for (const t of fuzzyTerms) {
            const idx = text.indexOf(t);
            if (idx >= 0 && idx < bestIdx)
                bestIdx = idx;
        }
        const start = Math.max(0, bestIdx - 60);
        const end = Math.min(text.length, bestIdx + 120);
        let snippet = text.slice(start, end);
        if (start > 0)
            snippet = '…' + snippet;
        if (end < text.length)
            snippet = snippet + '…';
        hits.push(`- [${doc.title}](${doc.location}): "${snippet}"`);
        if (hits.length >= 10)
            break;
    }
    return hits.join('\n');
}
