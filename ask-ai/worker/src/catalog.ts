import { Env, CatalogEntry, DocContent } from './types.js';
import { debug, STOPWORDS, DOC_CHAR_CAP, TOTAL_CHAR_CAP, CATALOG_TTL_MS } from './utils.js';

const catalogCache = new Map<string, { entries: CatalogEntry[]; ts: number }>();
const contentMapCache = new Map<string, Record<string, string>>();

export async function loadCatalog(env: Env, origin: string): Promise<CatalogEntry[]> {
  const cached = catalogCache.get(origin);
  if (cached && Date.now() - cached.ts < CATALOG_TTL_MS) {
    return cached.entries;
  }

  let llmsUrl = env.LLMS_URL;
  if (llmsUrl && llmsUrl.startsWith('/')) {
    llmsUrl = new URL(llmsUrl, origin).href;
  }

  const master = await fetchText(llmsUrl!);
  const catalogOrigin = new URL(llmsUrl!).origin;

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();

  const parse = (text: string) => {
    for (const m of text.matchAll(/^-\s*\[([^\]]+)\]\((\S+?)\)(?::\s*(.*))?$/gm)) {
      const [, title, href, desc = ''] = m;
      if (seen.has(href)) continue;
      seen.add(href);
      entries.push({ title, url: href, desc });
    }
  };

  parse(master);
  debug(`[${origin}] master entries: ${entries.length}`);

  // Load audience sub-catalogs (skip -full)
  const subs = entries.filter(e => /llms-(?!full)[\w-]+\.txt$/.test(e.url));
  for (const s of subs) {
    try {
      const subUrl = new URL(s.url, catalogOrigin).href;
      parse(await fetchText(subUrl));
    } catch (e: any) {
      console.error(`[ask] sub-catalog fetch failed: ${s.url}`, e.message);
    }
  }

  const docs = entries.filter(e => !/llms[\w-]*\.txt$/.test(e.url));
  catalogCache.set(origin, { entries: docs, ts: Date.now() });
  return docs;
}

export function scoreEntries(entries: CatalogEntry[], terms: string[]): CatalogEntry[] {
  return entries
    .map(e => {
      const title = e.title.toLowerCase();
      const desc = (e.desc || '').toLowerCase();
      const url = e.url.toLowerCase();

      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 3;
        if (desc.includes(t)) score += 2;
        if (url.includes(t)) score += 1;
      }

      const isSourceRef = /\/source-reference\/|\/python-reference\//.test(e.url);
      if (!isSourceRef) {
        const entityName = e.title.replace(/\s*\((?:class|struct|protocol|file|namespace|dir|enum)\)\s*$/i, '').trim();
        const isFallback = !e.desc || e.desc === '(no description yet)' ||
          e.desc.toLowerCase() === entityName.toLowerCase() ||
          e.desc.split(/\s+/).length < 3;
        if (!isFallback) score += 2;
      }

      const hasBrief = e.desc && e.desc.length > 0 &&
        e.desc !== '(no description yet)' &&
        e.desc.split(/\s+/).length > 1 &&
        e.desc.toLowerCase() !== e.title.replace(/\s*\([^)]+\)\s*$/, '').trim().toLowerCase();

      return { ...e, score, tiebreak: hasBrief ? 1 : 0 };
    })
    .filter(e => (e.score || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.tiebreak || 0) - (a.tiebreak || 0));
}

export function extractTerms(_env: Env, question: string, _origin: string): string[] {
  // Raw token extraction only — normalizer loads a 3 MB search_index.json
  // which exceeds the 128 MB free-tier memory limit on cold starts.
  return question.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter(t => !STOPWORDS.has(t)) || [];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchDoc(entry: CatalogEntry, env: Env, origin: string): Promise<DocContent | null> {
  try {
    const cmap = await loadContentMap(env, origin);
    if (cmap[entry.url]) {
      return { ...entry, text: cmap[entry.url] };
    }

    const docUrl = entry.url.startsWith('/')
      ? new URL(entry.url, env.SITE_URL || origin).href
      : entry.url;

    const res = await fetch(docUrl, {
      headers: { 'User-Agent': 'gendoc-ask-worker/1.0' },
      cf: { cacheTtl: 900, cacheEverything: true }
    });

    if (!res.ok) return null;

    const ctype = res.headers.get('content-type') || '';
    let text: string;

    if (ctype.includes('text/html')) {
      const state = { text: '', skip: 0 };
      await new HTMLRewriter()
        .on('script, style, nav, footer, header, aside, noscript, svg', {
          element(el: Element) {
            state.skip++;
            el.onEndTag(() => { state.skip--; });
          }
        })
        .on('h1, h2, h3, h4, p, li, td, pre, br', { element() { state.text += '\n'; } })
        .on('body *', {
          text(t: TextChunk) { if (state.skip === 0) state.text += t.text || ''; }
        })
        .transform(res)
        .arrayBuffer();
      text = state.text;
    } else {
      text = await res.text();
    }

    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { ...entry, text };
  } catch {
    return null;
  }
}

async function loadContentMap(env: Env, origin: string): Promise<Record<string, string>> {
  const cached = contentMapCache.get(origin);
  if (cached) return cached;

  try {
    // Try gzipped first (Cloudflare Pages), fall back to plain (local dev)
    let res = await fetch(new URL('/content-map.json.gz', origin).href);
    let data: Record<string, string>;
    if (res.ok) {
      data = await res.json();
    } else {
      res = await fetch(new URL('/content-map.json', origin).href);
      data = await res.json();
    }
    const contentMap = data;
    contentMapCache.set(origin, contentMap);
    return contentMap;
  } catch {
    contentMapCache.set(origin, {});
    return {};
  }
}
