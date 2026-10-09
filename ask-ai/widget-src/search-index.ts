/** Static, section-based inverted index. No search service or query-time corpus scan. */
export interface SearchDoc { location: string; title: string; text: string; }
interface IndexedDoc extends SearchDoc { length: number; }
export interface AskSearchIndex {
    version: 1;
    docs: IndexedDoc[];
    postings: Record<string, Array<[number, number, number]>>;
    averageLength: number;
}
const STOPWORDS = new Set((
    "a an and are as at be by for from how in is it of on or that the this to was " +
    "what when where which who why with does do can you your"
).split(/\s+/));

export function searchTokens(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9][a-z0-9+.#_-]*/g) || [])
        .map(term => term.replace(/^[_.-]+|[_.-]+$/g, ""))
        .filter(term => term.length >= 2 && !STOPWORDS.has(term));
}

export function buildSearchIndex(docs: SearchDoc[]): AskSearchIndex {
    const postings: AskSearchIndex["postings"] = Object.create(null);
    const indexed = docs.map((doc, id) => {
        const body = searchTokens(doc.text);
        const frequencies = new Map<string, [number, number]>();
        for (const [field, tokens] of [body, searchTokens(doc.title)].entries()) {
            for (const term of tokens) {
                const counts = frequencies.get(term) || [0, 0];
                counts[field]++;
                frequencies.set(term, counts);
            }
        }
        for (const [term, [bodyCount, titleCount]] of frequencies) {
            (postings[term] ||= []).push([id, bodyCount, titleCount]);
        }
        return { ...doc, length: Math.max(1, body.length) };
    });
    return {
        version: 1, docs: indexed, postings,
        averageLength: indexed.reduce((sum, doc) => sum + doc.length, 0) / (indexed.length || 1) || 1,
    };
}

export function isSearchIndex(value: unknown): value is AskSearchIndex {
    if (!value || typeof value !== "object") return false;
    const index = value as AskSearchIndex;
    if (index.version !== 1 || !Array.isArray(index.docs) ||
        !index.postings || typeof index.postings !== "object" || Array.isArray(index.postings) ||
        !Number.isFinite(index.averageLength) || index.averageLength <= 0) return false;
    if (!index.docs.every(doc => doc && typeof doc.location === "string" &&
        typeof doc.title === "string" && typeof doc.text === "string" &&
        Number.isFinite(doc.length) && doc.length > 0)) return false;
    return Object.values(index.postings).every(list => Array.isArray(list) && list.every(row =>
        Array.isArray(row) && row.length === 3 && Number.isInteger(row[0]) &&
        row[0] >= 0 && row[0] < index.docs.length &&
        Number.isFinite(row[1]) && row[1] >= 0 && Number.isFinite(row[2]) && row[2] >= 0,
    ));
}

function variants(word: string): Set<string> {
    const result = new Set<string>();
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i <= word.length; i++) {
        if (i < word.length) result.add(word.slice(0, i) + word.slice(i + 1));
        for (const ch of alphabet) {
            result.add(word.slice(0, i) + ch + word.slice(i));
            if (i < word.length) result.add(word.slice(0, i) + ch + word.slice(i + 1));
        }
        if (i + 1 < word.length) result.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    }
    return result;
}

export function rankedSearch(index: AskSearchIndex, query: string): SearchDoc[] {
    const scores = new Map<number, number>();
    const terms = [...new Set(searchTokens(query))].slice(0, 24);
    for (const term of terms) {
        const exact = Object.prototype.hasOwnProperty.call(index.postings, term);
        const candidates = exact ? [term] : term.length >= 3
            ? [...variants(term)].filter(v => Object.prototype.hasOwnProperty.call(index.postings, v)).slice(0, 20) : [];
        // Ambiguous corrections stay alternatives; never silently pick one.
        const bestForTerm = new Map<number, number>();
        for (const candidate of candidates) {
            const list = index.postings[candidate];
            const idf = Math.log(1 + (index.docs.length - list.length + 0.5) / (list.length + 0.5));
            for (const [id, bodyCount, titleCount] of list) {
                const tf = bodyCount + 3 * titleCount;
                const norm = 1.2 * (0.25 + 0.75 * index.docs[id].length / index.averageLength);
                const score = idf * (tf * 2.2 / (tf + norm)) * (exact ? 1 : 0.7);
                bestForTerm.set(id, Math.max(bestForTerm.get(id) || 0, score));
            }
        }
        for (const [id, score] of bestForTerm) scores.set(id, (scores.get(id) || 0) + score);
    }
    return [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([id]) => index.docs[id]);
}

/** Favor windows containing several specific terms over the first generic hit. */
export function passageStart(text: string, terms: string[], width: number): number {
    if (text.length <= width || width <= 0) return 0;
    const lower = text.toLowerCase();
    const positions = [...new Set(terms.filter(Boolean))].map(term => {
        const hits: number[] = [];
        let from = 0;
        while (hits.length < 128) {
            const found = lower.indexOf(term.toLowerCase(), from);
            if (found < 0) break;
            hits.push(found);
            from = found + term.length;
        }
        return hits;
    }).filter(hits => hits.length);
    let best = 0;
    let bestScore = -1;
    for (const position of [0, ...positions.flat()]) {
        const start = Math.max(0, Math.min(text.length - width, position - Math.floor(width / 4)));
        const score = positions.reduce((sum, hits) => sum +
            (hits.some(hit => hit >= start && hit < start + width) ? 1 / Math.sqrt(hits.length) : 0), 0);
        if (score > bestScore || (score === bestScore && start < best)) { best = start; bestScore = score; }
    }
    return best;
}

export function searchSnippet(doc: SearchDoc, query: string): string {
    const text = doc.text;
    if (!text) return doc.title;
    const start = passageStart(text, searchTokens(query), 220);
    const end = Math.min(text.length, start + 220);
    return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
        .replace(/\s+/g, " ").trim();
}
