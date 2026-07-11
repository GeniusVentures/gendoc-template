import { Env } from './types.js';

export const DOC_CHAR_CAP = 15000;
export const TOTAL_CHAR_CAP = 40000;
export const CATALOG_TTL_MS = 15 * 60 * 1000;
export const PROVIDER_CONNECT_MS = 5000;
export const PROVIDER_FIRST_TOKEN_MS = 15000;

export const STOPWORDS = new Set(
  ('a an and are as at be by for from how in is it of on or that the this to was ' +
   'what when where which who why with does do can you your our my i me we he she ' +
   'if so no go up give list top tell show find get make need want just like also ' +
   'see the').split(/\s+/).filter(Boolean)
);

export function debug(...args: any[]) {
  if ((globalThis as any).DEBUG) {
    console.log('[ask:debug]', ...args);
  }
}

export const enc = (s: string) => new TextEncoder().encode(s);

export function json(obj: any, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

export async function fetchWithConnectTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
