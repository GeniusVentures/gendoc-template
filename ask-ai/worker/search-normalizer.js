/**
 * search-normalizer.js — domain-aware typo correction + query expansion for MkDocs search.json.
 * Drop-in for Cloudflare Workers.  Uses SymSpell-style delete indexing for O(n) lookup.
 */

export class MkDocsSearchNormalizer {
  constructor(options = {}) {
    this.maxEditDistance = options.maxEditDistance ?? 2;
    this.minTokenLength = options.minTokenLength ?? 3;
    this.maxSuggestionsPerToken = options.maxSuggestionsPerToken ?? 5;

    // Seeded stop words (always filtered).  More are auto-detected from frequency.
    this.stopWords = new Set(
      'a an and are as at be by for from has how i in is it its of on or that the this to was what when where which who why with'.split(' ')
    );

    this.wordToMeta = new Map();
    this.titleWordSet = new Set();   // words that appear in titles (for protected-term detection)
    this.deleteIndex = new Map();
    this.aliasToCanonical = new Map();
  }

  static async load(searchJsonUrl) {
    const normalizer = new MkDocsSearchNormalizer();
    const response = await fetch(searchJsonUrl, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!response.ok) {
      throw new Error(`Failed to load search index: ${response.status}`);
    }
    normalizer.loadSearchJson(await response.json());
    return normalizer;
  }

  loadSearchJson(searchJson) {
    const docs = Array.isArray(searchJson?.docs) ? searchJson.docs : [];

    for (const doc of docs) {
      const title = doc.title ?? "";
      const text = doc.text ?? "";
      const location = doc.location ?? "";
      const keywords = doc.keywords ?? "";

      // Track title words separately for protected-term detection
      for (const t of this.tokenize(title)) {
        this.titleWordSet.add(t);
      }

      this.addText(title, { source: "title", boost: 8 });
      this.addText(keywords, { source: "keywords", boost: 10 });
      this.addText(location.replace(/[\/#._-]+/g, " "), { source: "location", boost: 5 });
      this.addText(text, { source: "text", boost: 1 });
    }

    // Auto-detect stopwords: top 50 most frequent words
    this.detectStopwords(50);

    // Auto-detect protected terms: words that appear in titles ≥3x
    // more than in body text, or title-only words.
    this.detectProtectedTerms();

    // Remove stopwords from the index (they're never used for matching)
    for (const sw of this.stopWords) {
      this.wordToMeta.delete(sw);
    }

    // Built-in aliases for common misspellings and abbreviations
    const aliases = [
      ["fullter", "flutter"], ["fluter", "flutter"], ["fluttter", "flutter"],
      ["fultter", "flutter"], ["clases", "classes"], ["routre", "router"],
      ["rounter", "router"], ["g-nus", "gnus"], ["typscript", "typescript"],
      ["javscript", "javascript"], ["clodflare", "cloudflare"],
      ["genius cognitive system", "gcs"], ["cognitive system", "gcs"],
      ["super genius", "supergenius"], ["open ai", "openai"],
    ];
    for (const [alias, canonical] of aliases) {
      this.aliasToCanonical.set(this.tokenize(alias).join(" "), this.tokenize(canonical).join(" "));
    }

    this.buildDeleteIndex();
  }

  /** Mark the N most frequent words as stopwords. */
  detectStopwords(n = 50) {
    const sorted = [...this.wordToMeta.entries()]
      .sort((a, b) => b[1].frequency - a[1].frequency)
      .slice(0, n);
    for (const [word] of sorted) {
      if (word.length <= 2) continue;   // keep very short tokens
      if (/^[0-9]+$/.test(word)) continue;
      this.stopWords.add(word);
    }
  }

  /** Mark title-heavy words as protected (never auto-corrected). */
  detectProtectedTerms() {
    for (const word of this.titleWordSet) {
      if (word.length < 3) continue;
      const meta = this.wordToMeta.get(word);
      if (!meta) continue;
      // Title-only word (appears in titles but not in body text)
      const inText = meta.sources.has("text");
      if (!inText && meta.frequency >= 2) {
        this.stopWords.add(word);  // don't correct these
      }
    }
  }

  addText(text, meta = {}) {
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      this.addWord(token, meta);
    }
  }

  addWord(rawWord, meta = {}) {
    const word = rawWord.toLowerCase();
    if (word.length < this.minTokenLength) return;
    if (this.stopWords.has(word)) return;
    if (/^\d+$/.test(word)) return;

    const existing = this.wordToMeta.get(word) ?? { word, frequency: 0, boost: 0, sources: new Set() };
    existing.frequency += 1;
    existing.boost += meta.boost ?? 1;
    if (meta.source) existing.sources.add(meta.source);
    this.wordToMeta.set(word, existing);
  }

  buildDeleteIndex() {
    this.deleteIndex.clear();
    for (const word of this.wordToMeta.keys()) {
      const deletes = this.generateDeletes(word, this.maxEditDistance);
      for (const del of deletes) {
        let bucket = this.deleteIndex.get(del);
        if (!bucket) { bucket = new Set(); this.deleteIndex.set(del, bucket); }
        bucket.add(word);
      }
      // Exact word as its own bucket
      let exact = this.deleteIndex.get(word);
      if (!exact) { exact = new Set(); this.deleteIndex.set(word, exact); }
      exact.add(word);
    }
  }

  normalizeQuery(query) {
    const original = query ?? "";

    // Check phrase aliases first
    let working = original;
    const normalizedQuery = this.tokenize(original).join(" ");
    for (const [alias, canonical] of this.aliasToCanonical.entries()) {
      if (alias.includes(" ") && normalizedQuery.includes(alias)) {
        const pattern = alias.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]+');
        working = working.replace(new RegExp('\\b' + pattern + '\\b', 'gi'), canonical);
      }
    }

    const rawTokens = this.tokenize(working);
    const correctedTokens = [];

    for (const token of rawTokens) {
      const lower = token.toLowerCase();
      if (lower.length < this.minTokenLength) { correctedTokens.push(token); continue; }
      if (this.stopWords.has(lower)) { correctedTokens.push(token); continue; }
      if (lower.includes(".") || lower.includes("_")) { correctedTokens.push(token); continue; }

      // Check single-word aliases first (e.g. "fullter" → "flutter")
      const aliasHit = this.aliasToCanonical.get(lower);
      if (aliasHit && aliasHit.indexOf(' ') < 0) {
        correctedTokens.push(aliasHit);
        continue;
      }

      const suggestion = this.suggest(lower, 1, 0.74)[0];
      if (suggestion && suggestion.word !== lower) {
        correctedTokens.push(suggestion.word);
      } else {
        correctedTokens.push(lower);
      }
    }

    // Union: original + corrected tokens (so misspellings still match)
    const lower = correctedTokens.map(t => t.toLowerCase());
    const raw = rawTokens.map(t => t.toLowerCase());
    const expanded = [...new Set([...raw, ...lower])];

    return {
      tokens: expanded,
      corrected: expanded.some((t, i) => t !== raw[i])
    };
  }

  suggest(token, maxSuggestions, minConfidence) {
    if (this.wordToMeta.has(token)) {
      return [{ word: token, confidence: 1, distance: 0 }];
    }

    const candidates = new Set();
    const deletes = this.generateDeletes(token, this.maxEditDistance);
    for (const del of deletes) {
      const bucket = this.deleteIndex.get(del);
      if (bucket) for (const c of bucket) candidates.add(c);
    }

    const scored = [];
    for (const candidate of candidates) {
      const distance = this.damerauLevenshtein(token, candidate);
      if (distance > this.maxEditDistance) continue;
      const meta = this.wordToMeta.get(candidate);
      const confidence = this.scoreToConfidence(meta?.frequency ?? 0, distance, token, candidate);
      if (confidence < minConfidence) continue;
      scored.push({ word: candidate, distance, confidence });
    }

    scored.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.distance - b.distance;
    });
    return scored.slice(0, maxSuggestions);
  }

  scoreToConfidence(frequency, distance, input, candidate) {
    const len = Math.max(input.length, candidate.length);
    const distanceRatio = distance / Math.max(1, len);
    let confidence = 1 - distanceRatio;
    confidence += Math.min(0.1, Math.log(1 + frequency) / 50);
    return Math.max(0, Math.min(1, confidence));
  }

  generateDeletes(word, maxDistance) {
    const deletes = new Set();
    const queue = [{ value: word, distance: 0 }];
    while (queue.length) {
      const item = queue.shift();
      if (item.distance >= maxDistance) continue;
      for (let i = 0; i < item.value.length; i++) {
        const deleted = item.value.slice(0, i) + item.value.slice(i + 1);
        if (!deletes.has(deleted)) {
          deletes.add(deleted);
          queue.push({ value: deleted, distance: item.distance + 1 });
        }
      }
    }
    return deletes;
  }

  damerauLevenshtein(a, b) {
    const alen = a.length, blen = b.length;
    if (a === b) return 0;
    if (alen === 0) return blen;
    if (blen === 0) return alen;
    const matrix = Array.from({ length: alen + 1 }, () => new Array(blen + 1).fill(0));
    for (let i = 0; i <= alen; i++) matrix[i][0] = i;
    for (let j = 0; j <= blen; j++) matrix[0][j] = j;
    for (let i = 1; i <= alen; i++) {
      for (let j = 1; j <= blen; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
        }
      }
    }
    return matrix[alen][blen];
  }

  tokenize(text) {
    return String(text ?? "").match(/[A-Za-z0-9][A-Za-z0-9+.#_-]*/g)
      ?.map(t => t.toLowerCase().replace(/^[-_.#+]+|[-_.#+]+$/g, ""))
      .filter(Boolean) ?? [];
  }
}
