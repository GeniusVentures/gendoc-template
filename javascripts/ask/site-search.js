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
    // Score every matching doc by how many raw query terms it matches.
    // ED1 variants are only for discovery — raw term count ranks docs so
    // rare corrected terms (e.g. "bittensor") surface above common ones
    // (e.g. "gnus") that match thousands of docs.
    const scored = [];
    for (const doc of docs) {
        const text = (doc.text || '').toLowerCase();
        const titleLower = (doc.title || '').toLowerCase();
        // Check both text and title for matches — some pages (like
        // /why-gnus.ai/customizable/) have the term only in the title.
        let anyMatch = false;
        for (const t of fuzzyTerms) {
            if (text.includes(t) || titleLower.includes(t)) {
                anyMatch = true;
                break;
            }
        }
        if (!anyMatch)
            continue;
        // Score by raw term matches — title-only matches (term in title but
        // not body) get a bonus so pages whose title IS the query term rank
        // above pages that merely mention it.  Terms found in body text get
        // no title bonus — prevents common terms like "gnus" from inflating
        // every page whose title includes them.
        let matchCount = 0;
        let bestIdx = Infinity;
        for (const t of rawTerms) {
            const idx = text.indexOf(t);
            if (idx >= 0) {
                matchCount++;
                if (idx < bestIdx)
                    bestIdx = idx;
            }
            else if (titleLower.includes(t)) {
                matchCount += 3; // title-only match
            }
        }
        // Also check fuzzy terms for bestIdx (the snippet anchor)
        if (bestIdx === Infinity) {
            for (const t of fuzzyTerms) {
                const idx = text.indexOf(t);
                if (idx >= 0 && idx < bestIdx)
                    bestIdx = idx;
            }
        }
        scored.push({ doc, score: matchCount, bestIdx });
    }
    // Sort by score desc, then by index (earlier match wins tie)
    scored.sort((a, b) => b.score - a.score || a.bestIdx - b.bestIdx);
    const hits = [];
    for (const { doc, bestIdx } of scored) {
        const text = (doc.text || '').toLowerCase();
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
