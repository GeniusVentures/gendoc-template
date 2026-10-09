import { buildSearchIndex, rankedSearch, passageStart } from '../../widget-src/search-index.js';
import type { CatalogEntry } from './types.js';

/** Select relevant bounded passages instead of centering on the first word. */
export function selectContext(text: string, terms: string[], cap: number): string {
  cap = Math.max(0, Math.floor(cap));
  if (!cap || !text) return '';
  if (text.length <= cap) return text;
  if (!terms.length) return text.slice(0, cap);
  const width = 1200;
  const chunks = [];
  const headings = [...text.matchAll(/^#{1,6} .+$/gm)];
  let heading = -1;
  for (let start = 0; start < text.length; start += Math.max(1, width - 150)) {
    while (heading + 1 < headings.length && headings[heading + 1].index! <= start) heading++;
    const title = heading >= 0 ? headings[heading][0] : '';
    chunks.push({ location: String(start), title, text: text.slice(start, start + width) });
    if (start + width >= text.length) break;
  }
  const ranked = rankedSearch(buildSearchIndex(chunks), terms.join(' '));
  if (!ranked.length) return text.slice(0, cap);
  const pieces: string[] = [];
  const selected: Array<[number, number]> = [];
  let used = 0;
  for (const chunk of ranked) {
    const start = Number(chunk.location);
    // Adjacent windows overlap; do not spend context budget repeating text.
    if (selected.some(([a, b]) => start < b && start + chunk.text.length > a)) continue;
    const separator = pieces.length ? '\n\n[…]\n\n' : '';
    const remaining = cap - used - separator.length;
    if (remaining <= 0) break;
    const offset = passageStart(chunk.text, terms, remaining);
    const piece = chunk.text.slice(offset, offset + remaining);
    pieces.push(separator + piece);
    used += separator.length + piece.length;
    selected.push([start, start + chunk.text.length]);
  }
  return pieces.join('');
}

/** Client hints may select only an existing same-site catalog page. */
export function approvedHints(hints: string, entries: CatalogEntry[], origin: string): string {
  const path = (url: URL) => url.pathname.replace(/\/index\.html$/i, '/').replace(/\/+$/, '') || '/';
  const catalog = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    try {
      const url = new URL(entry.url, origin);
      if (url.origin === origin) catalog.set(path(url), entry);
    } catch { /* malformed catalog link */ }
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const line of hints.split('\n')) {
    const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)(.*)$/);
    if (!match) continue;
    try {
      const url = new URL(match[2], origin);
      const entry = catalog.get(path(url));
      if (url.origin !== origin || !entry || seen.has(url.href)) continue;
      seen.add(url.href);
      const title = entry.title.replace(/[\[\]\r\n]/g, ' ');
      result.push(`- [${title}](${url.href})${match[3]}`);
    } catch { /* malformed client hint */ }
  }
  return result.join('\n');
}
