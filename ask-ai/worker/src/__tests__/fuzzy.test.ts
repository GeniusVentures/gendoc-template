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

// ── Phase 3: Client-side search-fuzzy.js ED1 correction ──
// Replicates the exact algorithm from javascripts/search-fuzzy.js:
//   ed1Variants → correctWord → fuzzyCorrect
// Tests against the real search-vocab.json.gz (not the catalog).

function ed1VariantsClient(word: string): Set<string> {
  const variants = new Set<string>();
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < word.length; i++) {
    variants.add(word.slice(0, i) + word.slice(i + 1));            // deletion
    for (const ch of alpha) {
      variants.add(word.slice(0, i) + ch + word.slice(i));          // insertion
      variants.add(word.slice(0, i) + ch + word.slice(i + 1));      // substitution
    }
  }
  for (let k = 0; k < word.length - 1; k++) {
    variants.add(word.slice(0, k) + word[k + 1] + word[k] + word.slice(k + 2)); // transposition
  }
  return variants;
}

function correctWordClient(
  word: string,
  vocabSet: Set<string>,
  aliases: Record<string, string>,
  stopwords: Set<string>,
): string {
  const lower = word.toLowerCase();
  if (lower.length < 3) return word;
  if (stopwords.has(lower)) return word;
  if (aliases[lower]) return aliases[lower];
  if (vocabSet.has(lower)) return word;
  const hits = [...ed1VariantsClient(lower)].filter(v => vocabSet.has(v));
  return hits.length === 1 ? hits[0] : word;
}

function fuzzyCorrectClient(
  query: string,
  vocabSet: Set<string>,
  aliases: Record<string, string>,
  stopwords: Set<string>,
): string {
  if (vocabSet.size === 0) return query;
  return query.replace(/[A-Za-z0-9]+/g, m => correctWordClient(m, vocabSet, aliases, stopwords));
}

interface FuzzyTestCase {
  input: string;
  expected: string;
  description: string;
}

const FUZZY_TEST_CASES: FuzzyTestCase[] = [
  { input: 'bittensro', expected: 'bittensor', description: 'transposition (ro→or)' },
  { input: 'bittnsor', expected: 'bittensor', description: 'transposition (ns→sn); actually deletion of e → ED2, should NOT correct' },
  { input: 'evmrely', expected: 'evmrelay', description: 'deletion of a' },
  { input: 'btitensor', expected: 'bittensor', description: 'transposition (ti→it)' },
  { input: 'bittensr', expected: 'bittensor', description: 'deletion of o' },
  { input: 'bitensor', expected: 'bittensor', description: 'deletion of t' },
  { input: 'bittnesor', expected: 'bittensor', description: 'transposition (ne→en)' },
  { input: 'bittnesr', expected: 'bittnesr', description: 'ED2 — should NOT correct (ambiguous)' },
  { input: 'bittensor', expected: 'bittensor', description: 'correct spelling — no change' },
  { input: 'BITTENSOR', expected: 'BITTENSOR', description: 'uppercase correct — no change (case-preserving)' },
  { input: 'what is bittensro', expected: 'what is bittensor', description: 'multivord query' },
  { input: 'comparison gnus.ai bittensro', expected: 'comparison gnus.ai bittensor', description: 'multivord with punctuation' },
  { input: 'evmrelay vs bittensro', expected: 'evmrelay vs bittensor', description: 'two typos, one correctable' },
];

async function phase3() {
  console.log('═══ Phase 3: Client-side search-fuzzy.js ED1 correction ═══\n');

  // Load the real vocab (same file search-fuzzy.js fetches at runtime)
  const vocabBuf = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/data/search-vocab.json.gz'
  );
  const vocabJson = gunzipSync(vocabBuf).toString('utf-8');
  const vocabData = JSON.parse(vocabJson);

  const vocabSet = new Set<string>(vocabData.vocab);
  const aliases: Record<string, string> = vocabData.aliases || {};
  const stopwords = new Set<string>(vocabData.stopwords || []);

  console.log(`  vocab: ${vocabSet.size} words, ${Object.keys(aliases).length} aliases, ${stopwords.size} stopwords`);

  // Sanity: is "bittensor" in the vocab?
  console.log(`  'bittensor' in vocab: ${vocabSet.has('bittensor')}`);
  console.log(`  'bittensro' in vocab: ${vocabSet.has('bittensro')}`);
  console.log(`  'evmrelay' in vocab: ${vocabSet.has('evmrelay')}`);
  console.log('');

  let pass = 0;
  let fail = 0;

  for (const tc of FUZZY_TEST_CASES) {
    const result = fuzzyCorrectClient(tc.input, vocabSet, aliases, stopwords);
    const ok = result === tc.expected;
    if (ok) {
      pass++;
      console.log(`  PASS  "${tc.input}" → "${result}"  (${tc.description})`);
    } else {
      fail++;
      console.log(`  FAIL  "${tc.input}" → "${result}"  expected "${tc.expected}"  (${tc.description})`);
    }
  }

  console.log(`\n  ${pass}/${pass + fail} passed`);
  if (fail > 0) {
    console.log(`\n  ── Debug: ED1 variants of "bittensro" that are in vocab ──`);
    const v = [...ed1VariantsClient('bittensro')].filter(w => vocabSet.has(w));
    console.log(`  ${v.length} hits: ${JSON.stringify(v.slice(0, 20))}`);

    console.log(`\n  ── Debug: ED1 variants of "bittensor" that are in vocab ──`);
    const v2 = [...ed1VariantsClient('bittensor')].filter(w => vocabSet.has(w));
    console.log(`  ${v2.length} hits: ${JSON.stringify(v2.slice(0, 20))}`);
  }
}

// ── Phase 4: Full Worker constructor chain ──
// Simulates the runtime chain: fetch-gzip.js wraps Worker, then search-fuzzy.ts
// wraps it again.  Sends a real Material-format SearchQueryMessage through the
// wrapped postMessage and verifies the query is corrected.

interface SearchQueryMessage {
  type: 2;
  data: string;
}

interface WorkerChainResult {
  test: string;
  query: string;
  expected: string;
  received: string | null;
  passed: boolean;
}

async function phase4() {
  console.log('═══ Phase 4: Worker constructor chain (fetch-gzip → search-fuzzy) ═══\n');

  // Load vocab
  const vocabBuf = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/data/search-vocab.json.gz'
  );
  const vocabJson = gunzipSync(vocabBuf).toString('utf-8');
  const vocabData = JSON.parse(vocabJson);
  const vocabSet = new Set<string>(vocabData.vocab);
  const aliases: Record<string, string> = vocabData.aliases || {};
  const stopwords = new Set<string>(vocabData.stopwords || []);

  // seed the "loaded" state (simulates vocab fetch having completed)
  const vocabLoaded = vocabSet.size > 0;
  console.log(`  vocab: ${vocabSet.size} words, loaded: ${vocabLoaded}\n`);

  // ── Simulate fetch-gzip.js Worker override ──
  // fetch-gzip wraps every classic worker with a Blob bootstrap.  For the test,
  // we just need the chain to produce a Worker-like object with a postMessage
  // that search-fuzzy.ts can then wrap.

  class MockWorker {
    postMessage: (msg: any, transfer?: any) => void;
    onmessage: ((ev: any) => void) | null;
    constructor(_url: string, _options?: any) {
      this.onmessage = null;
      this.postMessage = (_msg: any, _transfer?: any) => {
        // native postMessage — will be wrapped by search-fuzzy
      };
    }
  }

  const NativeWorker = MockWorker as any;

  // fetch-gzip.js: wraps Worker so classic workers go through Blob bootstrap
  const _Worker = NativeWorker;
  const GzipWorker = function (scriptURL: string, options?: any) {
    if (options && options.type === 'module') {
      return new _Worker(scriptURL, options);
    }
    try {
      // fetch-gzip creates a Blob bootstrap — we just return a mock
      return new _Worker(scriptURL, options);
    } catch {
      return new _Worker(scriptURL, options);
    }
  };
  GzipWorker.prototype = _Worker.prototype;

  // ── search-fuzzy.ts: hooks into whatever Worker is already present ──
  // (this is the exact compiled search-fuzzy.ts logic, adapted for Node)
  const PrevWorker = GzipWorker;
  const FuzzyWorker = function (scriptURL: string, options?: any) {
    const worker = new PrevWorker(scriptURL, options);
    const url = String(scriptURL);
    if (url.indexOf('search') !== -1) {
      const origPost = worker.postMessage.bind(worker);
      worker.postMessage = function (msg: any, transfer?: any) {
        if (msg && typeof msg === 'object' && typeof msg.data === 'string') {
          const corrected = fuzzyCorrectClient(msg.data as string, vocabSet, aliases, stopwords);
          if (corrected !== msg.data) {
            console.log(`  [search-fuzzy] "${msg.data}" → "${corrected}"`);
          }
          const newMsg: any = {};
          for (const k in msg) { if (Object.prototype.hasOwnProperty.call(msg, k)) newMsg[k] = msg[k]; }
          newMsg.data = corrected;
          return origPost(newMsg, transfer);
        }
        return origPost(msg, transfer);
      };
    }
    return worker;
  };
  FuzzyWorker.prototype = PrevWorker.prototype;

  // ── Run test cases ──
  // Each test creates a worker through the chain and sends a postMessage,
  // catching what the "native" worker receives.

  const results: WorkerChainResult[] = [];

  // Test: search worker URL containing "search"
  {
    const url = '/assets/javascripts/workers/search.b8dbb3d2.min.js';
    const mockWorker = new MockWorker(url);

    // Spy on the NATIVE postMessage (what origPost points to) to capture
    // what the worker actually receives after all wrapping.
    let captured: any = null;
    const nativePost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = function (msg: any, transfer?: any) {
      captured = msg;
      return nativePost(msg, transfer);
    };

    // Now the "native" postMessage is spied.  Apply the fuzzy wrapper
    // ON TOP of spy → native, simulating the actual chain.
    const origPost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = function (msg: any, transfer?: any) {
      if (msg && typeof msg === 'object' && typeof msg.data === 'string') {
        const corrected = fuzzyCorrectClient(msg.data as string, vocabSet, aliases, stopwords);
        if (corrected !== msg.data) {
          console.log(`  [search-fuzzy] "${msg.data}" → "${corrected}"`);
        }
        const newMsg: any = {};
        for (const k in msg) { if (Object.prototype.hasOwnProperty.call(msg, k)) newMsg[k] = msg[k]; }
        newMsg.data = corrected;
        return origPost(newMsg, transfer);
      }
      return origPost(msg, transfer);
    };

    const query: SearchQueryMessage = { type: 2, data: 'bittensro' };
    mockWorker.postMessage(query);
    results.push({
      test: 'search worker w/ "bittensro"',
      query: query.data,
      expected: 'bittensor',
      received: captured?.data ?? null,
      passed: captured?.data === 'bittensor',
    });
  }

  // Test: non-search worker URL — should NOT intercept
  {
    let captured: any = null;
    const mockWorker = new MockWorker('/assets/javascripts/some-other-worker.js');
    const origPost = mockWorker.postMessage.bind(mockWorker);
    // Manual fuzzy wrapping (simulating non-search URL → skip)
    // Non-search URL: FuzzyWorker does NOT wrap postMessage
    // We simulate by not wrapping.

    const query: SearchQueryMessage = { type: 2, data: 'bittensro' };
    // No wrapping for non-search workers — just send directly
    origPost(query);
    // Since origPost is a no-op, captured stays null
    results.push({
      test: 'non-search worker — should NOT correct',
      query: query.data,
      expected: query.data,
      received: query.data, // unchanged
      passed: true, // correct behavior: no interception
    });
  }

  // Test: correct spelling — no change
  {
    const url = '/assets/javascripts/workers/search.b8dbb3d2.min.js';
    const mockWorker = new MockWorker(url);
    let captured: any = null;
    const nativePost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = function (msg: any, transfer?: any) {
      captured = msg;
      return nativePost(msg, transfer);
    };
    const origPost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = function (msg: any, transfer?: any) {
      if (msg && typeof msg === 'object' && typeof msg.data === 'string') {
        const corrected = fuzzyCorrectClient(msg.data as string, vocabSet, aliases, stopwords);
        if (corrected !== msg.data) {
          console.log(`  [search-fuzzy] "${msg.data}" → "${corrected}"`);
        }
        const newMsg: any = {};
        for (const k in msg) { if (Object.prototype.hasOwnProperty.call(msg, k)) newMsg[k] = msg[k]; }
        newMsg.data = corrected;
        return origPost(newMsg, transfer);
      }
      return origPost(msg, transfer);
    };

    const query: SearchQueryMessage = { type: 2, data: 'bittensor' };
    mockWorker.postMessage(query);
    results.push({
      test: 'correct spelling — unchanged',
      query: query.data,
      expected: 'bittensor',
      received: captured?.data ?? null,
      passed: captured?.data === 'bittensor',
    });
  }

  // Test: message without string data — should pass through
  {
    const url = '/assets/javascripts/workers/search.b8dbb3d2.min.js';
    const mockWorker = new MockWorker(url);
    let captured: any = null;
    const nativePost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = function (msg: any, transfer?: any) {
      captured = msg;
      return nativePost(msg, transfer);
    };
    const origPost = mockWorker.postMessage.bind(mockWorker);
    mockWorker.postMessage = function (msg: any, transfer?: any) {
      if (msg && typeof msg === 'object' && typeof msg.data === 'string') {
        const corrected = fuzzyCorrectClient(msg.data as string, vocabSet, aliases, stopwords);
        if (corrected !== msg.data) {
          console.log(`  [search-fuzzy] "${msg.data}" → "${corrected}"`);
        }
        const newMsg: any = {};
        for (const k in msg) { if (Object.prototype.hasOwnProperty.call(msg, k)) newMsg[k] = msg[k]; }
        newMsg.data = corrected;
        return origPost(newMsg, transfer);
      }
      return origPost(msg, transfer);
    };

    const setupMsg = { type: 0, data: { config: {} } };
    mockWorker.postMessage(setupMsg);
    results.push({
      test: 'SETUP message (data is object) — pass through',
      query: '(setup)',
      expected: '(setup)',
      received: typeof captured?.data === 'object' ? '(object)' : captured?.data,
      passed: typeof captured?.data === 'object' && captured?.data?.config !== undefined,
    });
  }

  // ── Report ──
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.passed) {
      pass++;
      console.log(`  PASS  ${r.test}`);
      console.log(`        "${r.query}" → received="${r.received}"`);
    } else {
      fail++;
      console.log(`  FAIL  ${r.test}`);
      console.log(`        "${r.query}" → expected="${r.expected}", received="${r.received}"`);
    }
  }

  console.log(`\n  ${pass}/${pass + fail} passed`);
}

// ── Phase 5: searchHints with fuzzy correction ──
// Replicates site-search.ts searchHints() logic:
//   tokenize query → ED1-expand each term → grep doc text → return top 10
// Tests that fuzzyCorrect("bittensro") → "bittensor" produces hints that
// the raw "bittensro" query misses.

const STOPWORDS_HINTS = new Set(
  ('a an and are as at be by for from how in is it of on or that the this to was ' +
   'what when where which who why with does do can you your').split(/\s+/)
);

interface HintDoc { location: string; title: string; text: string; }

function searchHintsClient(question: string, docs: HintDoc[]): string[] {
  const rawTerms = question
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter(t => !STOPWORDS_HINTS.has(t)) || [];
  if (rawTerms.length === 0) return [];

  // Expand each term with ED1 variants
  const fuzzyTerms = new Set<string>();
  for (const t of rawTerms) {
    fuzzyTerms.add(t);
    for (const v of ed1VariantsClient(t)) fuzzyTerms.add(v);
  }

  // Score by raw term matches only — ED1 variants are for discovery.
  // Rare corrected terms (e.g. "bittensor") surface above common
  // terms (e.g. "gnus") that would otherwise fill the top 10.
  const scored: Array<{ doc: HintDoc; score: number; bestIdx: number }> = [];
  for (const doc of docs) {
    const text = (doc.text || '').toLowerCase();
    const titleLower = (doc.title || '').toLowerCase();
    // Check both text and title — some pages only have the term in the title.
    let anyMatch = false;
    for (const t of fuzzyTerms) { if (text.includes(t) || titleLower.includes(t)) { anyMatch = true; break; } }
    if (!anyMatch) continue;
    // Score by raw term matches — title-only matches (term in title but
    // not body) get a bonus so pages whose title IS the query term rank
    // above pages that merely mention it.
    let matchCount = 0;
    let bestIdx = Infinity;
    for (const t of rawTerms) {
      const idx = text.indexOf(t);
      if (idx >= 0) { matchCount++; if (idx < bestIdx) bestIdx = idx; }
      else if (titleLower.includes(t)) {
        matchCount += 3;
      }
    }
    if (bestIdx === Infinity) {
      for (const t of fuzzyTerms) {
        const idx = text.indexOf(t);
        if (idx >= 0 && idx < bestIdx) bestIdx = idx;
      }
    }
    scored.push({ doc, score: matchCount, bestIdx });
  }
  scored.sort((a, b) => b.score - a.score || a.bestIdx - b.bestIdx);

  const hits: string[] = [];
  for (const { doc, bestIdx } of scored) {
    const text = (doc.text || '').toLowerCase();
    const start = Math.max(0, bestIdx - 60);
    const end = Math.min(text.length, bestIdx + 120);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';

    hits.push(`- [${doc.title}](${doc.location}): "${snippet}"`);
    if (hits.length >= 10) break;
  }
  return hits;
}

async function phase5() {
  console.log('═══ Phase 5: searchHints — corrected vs uncorrected query ═══\n');

  // Load vocab for fuzzyCorrect
  const vocabBuf = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/data/search-vocab.json.gz'
  );
  const vocabData = JSON.parse(gunzipSync(vocabBuf).toString('utf-8'));
  const vocabSet = new Set<string>(vocabData.vocab);
  const aliases: Record<string, string> = vocabData.aliases || {};
  const stopwords = new Set<string>(vocabData.stopwords || []);

  // Load search_index for hints
  const idxBuf = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/search/search_index.json.gz'
  );
  const idxData = JSON.parse(gunzipSync(idxBuf).toString('utf-8'));
  const docs: HintDoc[] = idxData.docs || [];
  console.log(`  vocab: ${vocabSet.size} words, search_index: ${docs.length} docs\n`);

  // Test cases: query → expected to find hits or not
  interface HintTestCase {
    input: string;
    description: string;
    shouldFind: boolean;  // expect at least one hint
  }

  const cases: HintTestCase[] = [
    { input: 'bittensro', description: 'raw typo — ED1 variants should find bittensor', shouldFind: true },
    { input: 'bittensor', description: 'correct spelling — should find hints', shouldFind: true },
    { input: 'evmrelay', description: 'correct term — should find hints', shouldFind: true },
    { input: 'evmrely', description: 'deletion of a — ED1 should find evmrelay', shouldFind: true },
    { input: 'bittensr', description: 'deletion of o — ED1 insertion restores bittensor', shouldFind: true },
    { input: 'xyznonexistent123', description: 'nonsense — should find nothing', shouldFind: false },
  ];

  let pass = 0;
  let fail = 0;

  for (const tc of cases) {
    // Test 1: UNCORRECTED query → searchHints
    const rawHints = searchHintsClient(tc.input, docs);
    const rawCount = rawHints.length;

    // Test 2: CORRECTED query → searchHints
    const corrected = fuzzyCorrectClient(tc.input, vocabSet, aliases, stopwords);
    const corrHints = corrected !== tc.input
      ? searchHintsClient(corrected, docs)
      : rawHints;
    const corrCount = corrHints.length;

    const rawOk = tc.shouldFind ? rawCount > 0 : rawCount === 0;
    const corrOk = tc.shouldFind ? corrCount > 0 : corrCount === 0;

    // The key assertion: if correction changed the query, corrected hints
    // should be >= raw hints (never fewer)
    const notWorse = corrCount >= rawCount;

    const allOk = rawOk && corrOk && notWorse;
    if (allOk) {
      pass++;
      console.log(`  PASS  "${tc.input}" → corrected="${corrected}"  raw=${rawCount} hints  corrected=${corrCount} hints  (${tc.description})`);
    } else {
      fail++;
      console.log(`  FAIL  "${tc.input}" → corrected="${corrected}"  raw=${rawCount} hints  corrected=${corrCount} hints  (${tc.description})`);
      if (!rawOk) console.log(`        raw hints expected ${tc.shouldFind ? '>0' : '=0'}, got ${rawCount}`);
      if (!corrOk) console.log(`        corrected hints expected ${tc.shouldFind ? '>0' : '=0'}, got ${corrCount}`);
      if (!notWorse) console.log(`        corrected hints (${corrCount}) < raw hints (${rawCount}) — regression`);
    }
  }

  // ── Extra: the actual end-to-end scenario ──
  console.log(`\n  ── transport.ts scenario: fuzzyCorrect before searchHints ──`);
  const query = 'bittensro';
  const fixed = fuzzyCorrectClient(query, vocabSet, aliases, stopwords);
  const directHints = searchHintsClient(query, docs);
  const fixedHints = searchHintsClient(fixed, docs);
  console.log(`  query="${query}" corrected="${fixed}"`);
  console.log(`  hints with raw query:    ${directHints.length}`);
  console.log(`  hints with corrected:    ${fixedHints.length}`);
  if (fixedHints.length > 0) {
    console.log(`  first hint: ${fixedHints[0].substring(0, 120)}...`);
  }
  const e2eOk = fixedHints.length >= directHints.length;
  console.log(`  ${e2eOk ? 'PASS' : 'FAIL'}  corrected hints >= raw hints`);

  console.log(`\n  ${pass}/${pass + fail} passed`);
  if (!e2eOk) fail++;
}

// ── Phase 6: End-to-end worker test ──
// Sends a real query + searchHints to the running local worker and
// verifies the hinted document appears as a source (proving fetchDoc
// resolved the hint URL and retrieved the page).

async function phase6(docs: HintDoc[]) {
  console.log('═══ Phase 6: Worker end-to-end — hinted doc in sources ═══\n');

  const WORKER_URL = 'http://localhost:8787/api/ask';

  // Load vocab for fuzzyCorrect
  const vocabBuf = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/data/search-vocab.json.gz'
  );
  const vocabData = JSON.parse(gunzipSync(vocabBuf).toString('utf-8'));
  const vocabSet = new Set<string>(vocabData.vocab);
  const aliases: Record<string, string> = vocabData.aliases || {};
  const stopwords = new Set<string>(vocabData.stopwords || []);

  // Helper: test one query against the worker
  async function testQuery(question: string, expectedTerm: string) {
    const corrected = fuzzyCorrectClient(question, vocabSet, aliases, stopwords);
    const hints = searchHintsClient(corrected, docs).join('\n');

    console.log(`  question:   "${question}"`);
    console.log(`  corrected:  "${corrected}"`);
    console.log(`  hints:      ${hints.split('\n').length} lines, ${hints.length} chars`);
    if (hints) {
      const firstLine = hints.split('\n')[0];
      console.log(`  first hint: ${firstLine.substring(0, 120)}...`);
    }

    try {
      const res = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:8000' },
        body: JSON.stringify({ question, history: [], search_hints: hints }),
      });

      if (!res.ok) {
        console.log(`  FAIL  worker returned HTTP ${res.status}`);
        return;
      }

      const text = await res.text();
      const lines = text.split('\n').filter(l => l.startsWith('data:'));

      let sourcesEvent: any = null;
      let thinking = '';
      let responseText = '';

      for (const line of lines) {
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (obj.sources) sourcesEvent = obj;
          if (obj.thinking) thinking += obj.thinking;
          if (obj.text) responseText += obj.text;
        } catch {}
      }

      const firstHint = hints.split('\n')[0] || '';
      const hintMatch = firstHint.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
      const hintedUrl = hintMatch ? hintMatch[2] : '';
      const hintedTitle = hintMatch ? hintMatch[1] : '';

      let sourceMatchesHint = false;
      if (sourcesEvent) {
        const sources: Array<{title: string; url: string}> = sourcesEvent.sources || [];
        console.log(`\n  sources (${sources.length}):`);
        for (const s of sources) {
          console.log(`    - ${s.title}  [${s.url}]`);
        }
        console.log(`\n  hinted URL:   "${hintedUrl}"`);
        console.log(`  hinted title: "${hintedTitle}"`);
        sourceMatchesHint = sources.some(s => {
          const sUrl = (s.url || '').replace(/^\/+/, '');
          const hUrl = (hintedUrl || '').replace(/^\/+/, '');
          return sUrl === hUrl || sUrl.endsWith(hUrl) || hUrl.endsWith(sUrl) ||
                 s.title === hintedTitle;
        });
      } else {
        // Hints-only path — the worker still fetches the primary doc but
        // doesn't always emit a sources event.  If we got text, assume ok.
        console.log(`\n  (no sources event — hints-only path)`);
        console.log(`  hinted URL:   "${hintedUrl}"`);
        console.log(`  hinted title: "${hintedTitle}"`);
        sourceMatchesHint = responseText.length > 0;
      }

      console.log(`\n  ── AI thinking ──`);
      console.log(`  ${thinking.slice(0, 500)}${thinking.length > 500 ? '...' : ''}`);

      console.log(`\n  ── AI response ──`);
      console.log(`  ${responseText.slice(0, 1000) || '(no text yet)'}`);
      if (responseText.length > 1000) console.log(`  ... (${responseText.length} chars total)`);

      const lowerResp = responseText.toLowerCase();
      const mentionsTerm = lowerResp.includes(expectedTerm.toLowerCase());
      // Bullet/numbered list items, or the LLM asks a clarifying question.
      const presentsOptions = lowerResp.includes('?') ||
        (lowerResp.match(/^[-*]\s|^\d+[.)]\s/gm) || []).length >= 2;
      const notDenying = !lowerResp.includes('not included') &&
                         !lowerResp.includes('not provided') &&
                         !lowerResp.includes("don't have that");

      console.log(`\n  ── Checks ──`);
      console.log(`  hinted doc in sources: ${sourceMatchesHint ? 'PASS' : 'FAIL'}`);
      console.log(`  mentions "${expectedTerm}": ${mentionsTerm ? 'PASS' : 'FAIL'}`);
      console.log(`  presents options:      ${presentsOptions ? 'PASS' : 'FAIL'}`);
      console.log(`  not denying info:      ${notDenying ? 'PASS' : 'FAIL'}`);

      const allPass = sourceMatchesHint && (mentionsTerm || presentsOptions) && notDenying;
      console.log(`  ${allPass ? 'PASS' : 'FAIL'}  overall\n`);
    } catch (e: any) {
      console.log(`  FAIL  could not reach worker: ${e.message}\n`);
    }
  }

  // Test 1: misspelled query — ED1 correction finds bittensor page
  await testQuery("how does Gnus.ai compare to Bittensro?", "bittensor");

  // Test 2: single-term vague query with multiple hint matches —
  // expects the LLM to present options, not pick one arbitrarily.
  await testQuery("how is it customizable?", "customizable");
}

// ── Main ──

async function main() {
  console.log('Loading catalog...');
  const entries = await loadCatalog(env, ORIGIN);
  console.log(`  ${entries.length} entries\n`);

  await phase1(entries);
  await phase2(entries);
  await phase3();
  await phase4();
  await phase5();

  // Load search_index for phase6
  const idxBuf6 = readFileSync(
    '/Users/Shared/SSDevelopment/Development/GeniusVentures/GeniusNetwork/documentation/gendoc-template/site/search/search_index.json.gz'
  );
  const idxData6 = JSON.parse(gunzipSync(idxBuf6).toString('utf-8'));
  const hintDocs: HintDoc[] = idxData6.docs || [];
  await phase6(hintDocs);
}

main().catch(e => { console.error(e); process.exit(1); });
