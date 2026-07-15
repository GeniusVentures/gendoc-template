/**
 * Unit test for extractTerms + fuzzyScoreEntries.
 * Run: cd worker && npx tsx src/__tests__/fuzzy.test.ts [N]
 *
 * Phase 1: Tests ED0-ED7 variants of "evmrelay".
 * Phase 2: Stress test — takes top N keywords from the vocab, generates
 *          ED1/ED2/ED3 misspellings, and verifies the fuzzy pipeline
 *          recovers the original word.  Default N=20, max 1000.
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { extractTerms, ed1Variants } from '../normalizer.js';
import { loadCatalog, scoreEntries } from '../catalog.js';
import { CatalogEntry } from '../types.js';

const N = Math.min(parseInt(process.argv[2] || '20', 10), 1000);

// Minimal Env stub
const env = {
  LLMS_URL: 'http://localhost:8000/llms.txt',
  SITE_URL: 'http://localhost:8000',
} as any;
const ORIGIN = 'http://localhost:8000';

// ── fuzzyScoreEntries (copied from index.ts) ──

function editDist(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function fuzzyScoreEntries(
  entries: CatalogEntry[],
  unmatched: string[],
): CatalogEntry[] {
  const titleIndex = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const words = e.title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    for (const w of words) {
      let list = titleIndex.get(w);
      if (!list) { list = []; titleIndex.set(w, list); }
      list.push(e);
    }
  }

  const scored = new Map<CatalogEntry, number>();

  for (const uw of unmatched) {
    if (uw.length < 3) continue;

    // Tier 1: exact + ED1 Set lookup
    const exact = titleIndex.get(uw);
    if (exact) for (const e of exact) scored.set(e, Math.max(scored.get(e) || 0, 5));

    for (const v of ed1Variants(uw)) {
      const hits = titleIndex.get(v);
      if (hits) for (const e of hits) scored.set(e, Math.max(scored.get(e) || 0, 3));
    }
  }

  // Tier 2: Levenshtein against all title words
  if (scored.size === 0) {
    for (const uw of unmatched) {
      if (uw.length < 3) continue;
      for (const [tw, list] of titleIndex) {
        const d = editDist(uw, tw);
        if (d <= 4 && Math.abs(uw.length - tw.length) <= 4) {
          const s = d === 0 ? 5 : d === 1 ? 3 : d === 2 ? 1 : d === 3 ? 0.5 : 0.25;
          for (const e of list) scored.set(e, Math.max(scored.get(e) || 0, s));
        }
      }
    }
  }

  return [...scored.entries()]
    .map(([e, score]) => ({ ...e, score }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ── Misspelling generators ──

/** Pick a random ED1 variant (deletion, transposition, or substitution). */
function randomED1(word: string, rng: () => number): string {
  const choice = Math.floor(rng() * 3);
  if (choice === 0) {
    // deletion
    const i = Math.floor(rng() * word.length);
    return word.slice(0, i) + word.slice(i + 1);
  } else if (choice === 1) {
    // transposition
    if (word.length < 2) return word;
    const i = Math.floor(rng() * (word.length - 1));
    return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  } else {
    // substitution
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    const i = Math.floor(rng() * word.length);
    const c = alpha[Math.floor(rng() * 26)];
    return word.slice(0, i) + c + word.slice(i + 1);
  }
}

function randomED2(word: string, rng: () => number): string {
  return randomED1(randomED1(word, rng), rng);
}

function randomED3(word: string, rng: () => number): string {
  return randomED1(randomED1(randomED1(word, rng), rng), rng);
}

// ── Phase 1: evmrelay variants ──

const VARIANTS: Record<string, number> = {
  'evmrelay': 0, 'evmrely': 1, 'emvrealy': 2, 'vemrleay': 3,
  'vmrelye': 4, 'vemrlae': 5, 'vmrealy': 6, 'mevrlya': 7,
};

async function phase1(entries: CatalogEntry[]) {
  console.log('═══ Phase 1: evmrelay ED0-ED7 ═══\n');

  for (const [variant, ed] of Object.entries(VARIANTS)) {
    const question = `what is ${variant}?`;
    const { terms, corrections, unmatched } = await extractTerms(env, question, ORIGIN);

    console.log(`── ED${ed}: "${variant}" ──`);
    console.log(`  terms: [${terms.join(', ')}]  corr: ${JSON.stringify(corrections)}  unmatched: [${unmatched.join(', ')}]`);

    let top = scoreEntries(entries, terms).slice(0, 30);
    if (!top.length && unmatched.length > 0) {
      top = fuzzyScoreEntries(entries, unmatched).slice(0, 15);
      console.log(`  → fuzzy fallback: ${top.length} results`);
    } else {
      console.log(`  → scoreEntries: ${top.length} results`);
    }
    if (top.length > 0) {
      const titles = top.slice(0, 3).map(e => e.title);
      console.log(`  top: ${JSON.stringify(titles)}`);
    }
    console.log('');
  }
}

// ── Phase 2: bulk stress test ──

function getTopVocabWords(n: number, titleWordSet: Set<string>): string[] {
  // Load the raw vocab from the gzipped file (bypass HTTP for speed)
  const buf = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/data/search-vocab.json.gz'
  );
  const json = gunzipSync(buf).toString('utf-8');
  const data = JSON.parse(json);
  // Filter: words >= 4 chars, not all-digits, AND appear in a catalog title
  return (data.vocab as string[])
    .filter((w: string) => w.length >= 4 && !/^\d+$/.test(w) && titleWordSet.has(w))
    .slice(0, n);
}

interface WordResult {
  word: string;
  ed1_found: boolean;
  ed2_found: boolean;
  ed3_found: boolean;
  ed1_tier: string;  // 'normalizer' | 'fuzzy-ed1' | 'fuzzy-lev' | 'miss'
  ed2_tier: string;
  ed3_tier: string;
}

function checkRecovery(
  entries: CatalogEntry[],
  original: string,
  misspelling: string,
): { found: boolean; tier: string } {
  // We need the original word's entries. Look them up in the catalog.
  const originalEntries = entries.filter(e =>
    e.title.toLowerCase().split(/[^a-z0-9]+/).includes(original)
  );
  if (originalEntries.length === 0) return { found: false, tier: 'no-catalog-entry' };

  // Simulate the handler pipeline: scoreEntries first, then fuzzy fallback
  // merged with fuzzy results preferred (same as index.ts handler).
  const scored = scoreEntries(entries, [misspelling]).slice(0, 30);
  const fuzzy = fuzzyScoreEntries(entries, [misspelling]).slice(0, 15);

  // Merge: fuzzy first (better for misspellings), then scoreEntries deduped
  const seen = new Set(fuzzy.map(e => e.url));
  const merged = [...fuzzy, ...scored.filter(e => !seen.has(e.url))];
  const found = merged.some(e => originalEntries.some(oe => oe.url === e.url));
  // Determine tier
  let tier = 'miss';
  if (found) {
    // Check if it was Tier 1 (ED1 set lookup) or Tier 2 (Levenshtein)
    const t1 = ed1Variants(misspelling);
    const titleWords = new Set<string>();
    for (const e of entries) {
      for (const w of e.title.toLowerCase().split(/[^a-z0-9]+/)) titleWords.add(w);
    }
    if (titleWords.has(misspelling) || [...t1].some(v => titleWords.has(v))) {
      tier = 'fuzzy-ed1';
    } else {
      tier = 'fuzzy-lev';
    }
  }
  return { found, tier };
}

async function phase2(entries: CatalogEntry[]) {
  console.log(`═══ Phase 2: top ${N} vocab words, ED1/ED2/ED3 misspellings ═══\n`);

  // Build title-word set for filtering
  const titleWordSet = new Set<string>();
  for (const e of entries) {
    for (const w of e.title.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3) titleWordSet.add(w);
    }
  }

  const words = getTopVocabWords(N, titleWordSet);
  console.log(`Loaded ${words.length} vocab words (title-matched from top of vocab)\n`);

  // Deterministic "random" for reproducibility
  let seed = 42;
  const rng = () => { seed = (seed * 1664525 + 1013904223) | 0; return (seed >>> 0) / 0xFFFFFFFF; };

  const results: WordResult[] = [];
  const start = Date.now();

  for (let idx = 0; idx < words.length; idx++) {
    const word = words[idx];
    const r1 = randomED1(word, rng);
    const r2 = randomED2(word, rng);
    const r3 = randomED3(word, rng);

    const ed1 = checkRecovery(entries, word, r1);
    const ed2 = checkRecovery(entries, word, r2);
    const ed3 = checkRecovery(entries, word, r3);

    results.push({
      word,
      ed1_found: ed1.found, ed1_tier: ed1.tier,
      ed2_found: ed2.found, ed2_tier: ed2.tier,
      ed3_found: ed3.found, ed3_tier: ed3.tier,
    });

    // Progress every 100
    if ((idx + 1) % 100 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const sofar = results.slice(idx - 99);
      const ed1ok = sofar.filter(r => r.ed1_found).length;
      const ed2ok = sofar.filter(r => r.ed2_found).length;
      const ed3ok = sofar.filter(r => r.ed3_found).length;
      console.log(`  ${idx + 1}/${words.length} (${elapsed}s)  recent-100: ED1=${ed1ok}% ED2=${ed2ok}% ED3=${ed3ok}%`);
    }
  }

  // Summary
  const total = results.length;
  const ed1ok = results.filter(r => r.ed1_found).length;
  const ed2ok = results.filter(r => r.ed2_found).length;
  const ed3ok = results.filter(r => r.ed3_found).length;

  const tierCounts = (tier: string) => results.filter(r =>
    r.ed1_tier === tier || r.ed2_tier === tier || r.ed3_tier === tier
  ).length;

  console.log(`\n═══ Results (${total} words, ${((Date.now() - start) / 1000).toFixed(1)}s) ═══`);
  console.log(`  ED1 recovery: ${ed1ok}/${total} (${(ed1ok/total*100).toFixed(1)}%)`);
  console.log(`  ED2 recovery: ${ed2ok}/${total} (${(ed2ok/total*100).toFixed(1)}%)`);
  console.log(`  ED3 recovery: ${ed3ok}/${total} (${(ed3ok/total*100).toFixed(1)}%)`);
  console.log(`  By tier: fuzzy-ed1=${tierCounts('fuzzy-ed1')} fuzzy-lev=${tierCounts('fuzzy-lev')} scoreEntries-direct=${tierCounts('scoreEntries-direct')}`);

  // Show first 10 failures for each ED level
  for (const ed of [1, 2, 3]) {
    const key = `ed${ed}_found` as keyof WordResult;
    const fails = results.filter(r => !r[key]).slice(0, 10);
    if (fails.length > 0) {
      console.log(`\n  ED${ed} failures (first 10):`);
      for (const f of fails) {
        const tier = ed === 1 ? f.ed1_tier : ed === 2 ? f.ed2_tier : f.ed3_tier;
        console.log(`    "${f.word}" → tier=${tier}`);
      }
    }
  }
}

// ── Main ──

async function main() {
  console.log('Loading catalog...');
  const entries = await loadCatalog(env, ORIGIN);
  console.log(`  ${entries.length} entries\n`);

  await phase1(entries);
  await phase2(entries);
}

main().catch(e => { console.error(e); process.exit(1); });
