/**
 * normalizer.ts — lightweight runtime query normalization.
 *
 * Loads a precomputed vocabulary JSON (built at deploy time by scripts/build-vocab.js)
 * and does term extraction with on-demand fuzzy matching.  No SymSpell delete index —
 * edit-distance-1 variants are generated and checked against the vocab Set at query
 * time, which is O(26 * word_length) per unknown token.
 */

import { Env } from './types.js';

// Inlined from utils.ts to keep the normalizer self-contained.
const STOPWORDS = new Set(
  ('a an and are as at be by for from how in is it of on or that the this to was ' +
   'what when where which who why with does do can you your our my i me we he she ' +
   'if so no go up give list top tell show find get make need want just like also ' +
   'see the').split(/\s+/).filter(Boolean)
);

interface SearchVocab {
  vocab: string[];
  aliases: Record<string, string>;
  stopwords: string[];
}

const cache = new Map<string, { vocabSet: Set<string>; aliases: Record<string, string>; additionalStopwords: Set<string> }>();

function tokenize(text: string): string[] {
  return String(text ?? "").match(/[A-Za-z0-9][A-Za-z0-9+.#_-]*/g)
    ?.map(t => t.toLowerCase().replace(/^[-_.#+]+|[-_.#+]+$/g, ""))
    .filter(Boolean) ?? [];
}

/**
 * Generate all edit-distance-1 variants of `word`:
 *   - one character deleted at each position
 *   - one character substituted at each position (alphabet)
 *   - one character inserted at each position (alphabet)
 *   - adjacent character transpositions
 */
export function ed1Variants(word: string): Set<string> {
  const variants = new Set<string>();
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';

  // Deletion
  for (let i = 0; i < word.length; i++) {
    variants.add(word.slice(0, i) + word.slice(i + 1));
  }

  // Substitution + Insertion
  for (let i = 0; i <= word.length; i++) {
    for (const ch of alpha) {
      variants.add(word.slice(0, i) + ch + word.slice(i));       // insertion
      if (i < word.length) {
        variants.add(word.slice(0, i) + ch + word.slice(i + 1)); // substitution
      }
    }
  }

  // Transposition
  for (let i = 0; i < word.length - 1; i++) {
    variants.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }

  return variants;
}

/**
 * Decompress gzip bytes — exact same concurrent reader/writer pattern as
 * fetch-gzip.js to avoid backpressure deadlock in workerd / Cloudflare Workers.
 */
async function decompressGzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const reader = ds.readable.getReader();
  const writer = ds.writable.getWriter();
  const chunks: Uint8Array[] = [];

  // Start the reader FIRST so it's ready before the writer pushes data.
  // If the writer writes before the reader calls read(), the stream's
  // internal buffer fills and writer.write() hangs (backpressure deadlock).
  const readDone = reader.read().then(function pump(result: any): any {
    if (result.done) {
      let total = 0;
      for (let i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
      const merged = new Uint8Array(total);
      let off = 0;
      for (let j = 0; j < chunks.length; j++) {
        merged.set(chunks[j], off);
        off += chunks[j].byteLength;
      }
      return merged.buffer as ArrayBuffer;
    }
    chunks.push(result.value);
    return reader.read().then(pump);
  }) as Promise<ArrayBuffer>;

  await writer.write(new Uint8Array(buf));
  await writer.close();
  return readDone;
}

async function loadVocab(env: Env, origin: string) {
  const cached = cache.get(origin);
  if (cached) return cached;

  // Python http.server sends raw gzip bytes without Content-Encoding.
  // Read the body once, then detect format.  (res.json() would consume
  // the body, making res.arrayBuffer() in the catch unusable.)
  let res = await fetch(new URL('/data/search-vocab.json.gz', origin).href,
    { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw new Error(`Failed to load vocab: ${res.status}`);

  const raw = await res.arrayBuffer();
  let data: SearchVocab;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    const view = new Uint8Array(raw);
    if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
      const decoded = await decompressGzip(raw);
      data = JSON.parse(new TextDecoder().decode(decoded));
    } else {
      throw new Error('Vocab response is neither JSON nor gzip');
    }
  }

  const vocabSet = new Set(data.vocab);
  const additionalStopwords = new Set(data.stopwords);
  const result = { vocabSet, aliases: data.aliases, additionalStopwords };
  cache.set(origin, result);
  console.log(`[ask] vocab loaded: ${vocabSet.size} words`);
  return result;
}

export interface ExtractTermsResult {
  terms: string[];
  /** original → corrected word (ED1 or alias match) */
  corrections: Record<string, string>;
  /** words not found in vocab at all, no ED1 match */
  unmatched: string[];
}

/**
 * Extract and normalize search terms from a user question.
 * Uses the precomputed vocabulary for typo correction via on-demand
 * edit-distance-1 variant lookup (no precomputed delete index).
 */
export async function extractTerms(env: Env, question: string, origin: string): Promise<ExtractTermsResult> {
  const rawTokens = tokenize(question);
  if (rawTokens.length === 0) return { terms: [], corrections: {}, unmatched: [] };

  let vocabSet: Set<string>;
  let aliases: Record<string, string>;
  let additionalStopwords: Set<string>;

  try {
    const v = await loadVocab(env, origin);
    vocabSet = v.vocabSet;
    aliases = v.aliases;
    additionalStopwords = v.additionalStopwords;
  } catch (e: any) {
    console.log(`[ask] vocab load failed, using raw terms: ${e.message}`);
    const terms = rawTokens.filter(t => !STOPWORDS.has(t) && t.length >= 2);
    return { terms, corrections: {}, unmatched: [] };
  }

  const corrected: string[] = [];
  const corrections: Record<string, string> = {};
  const unmatched: string[] = [];

  for (const token of rawTokens) {
    const lower = token.toLowerCase();

    // Skip stopwords and short tokens
    if (lower.length < 3) { corrected.push(lower); continue; }
    if (STOPWORDS.has(lower) || additionalStopwords.has(lower)) { corrected.push(lower); continue; }
    if (lower.includes('.') || lower.includes('_')) { corrected.push(lower); continue; }

    // Check single-word alias
    if (aliases[lower] && !aliases[lower].includes(' ')) {
      corrections[lower] = aliases[lower];
      corrected.push(aliases[lower]);
      continue;
    }

    // Exact vocab match — no correction needed
    if (vocabSet.has(lower)) {
      corrected.push(lower);
      continue;
    }

    // Fuzzy match: generate edit-distance-1 variants, find vocab hits
    const variants = ed1Variants(lower);
    const hits = [...variants].filter(v => vocabSet.has(v));

    if (hits.length === 1) {
      // Single unambiguous correction
      corrections[lower] = hits[0];
      corrected.push(hits[0]);
    } else {
      // Ambiguous or no correction — keep original, mark unmatched
      corrected.push(lower);
      unmatched.push(lower);
    }
  }

  // Union: original + corrected (so misspellings still match raw content)
  const expanded = [...new Set([...rawTokens.map(t => t.toLowerCase()), ...corrected])];
  const terms = expanded.filter(t => t.length >= 2 && !STOPWORDS.has(t) && !additionalStopwords.has(t));
  return { terms, corrections, unmatched };
}
