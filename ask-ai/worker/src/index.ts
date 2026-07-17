/**
 * Ask AI Worker - TypeScript version
 * gendoc-template / GNUS.ai documentation chat
 *
 * Features:
 * - RAG over llms.txt catalog
 * - Rate limiting (Cloudflare binding + fallback)
 * - Jailbreak protection (using existing normalizer)
 * - Provider fallback with tuned timeouts
 * - Streaming SSE with thinking support
 */

import { Env, SSEMessage, CatalogEntry } from './types.js';
import { corsHeaders, json, enc, debug, PROVIDER_FIRST_TOKEN_MS, DOC_CHAR_CAP, TOTAL_CHAR_CAP } from './utils.js';
import { loadCatalog, scoreEntries, fetchDoc } from './catalog.js';
import { extractTerms, ed1Variants } from './normalizer.js';
import { isJailbreakAttempt } from './jailbreak.js';
import { PROVIDERS } from './providers.js';

/** Levenshtein edit distance.  Catch-all when ED1 Set lookup finds nothing. */
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

/** Return a window of `text` centered around the first occurrence of any `terms`, up to `cap` chars. */
function windowSlice(text: string, terms: string[], cap: number): string {
  if (text.length <= cap) return text;
  let best = -1;
  const lower = text.toLowerCase();
  for (const t of terms) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return text.slice(0, cap);
  const half = Math.floor(cap / 2);
  const start = Math.max(0, best - half);
  return text.slice(start, start + cap);
}

/**
 * Build fallback context when the normalizer couldn't match a word.
 * Tier 1: ED1 variant generation + title-word Set lookup (fast, O(1000) per word).
 * Tier 2: Levenshtein against all title words (catch-all for ED2+).
 */
function fuzzyScoreEntries(
  entries: CatalogEntry[],
  unmatched: string[],
): CatalogEntry[] {
  // Build title-word → entries index
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
  const unscored = new Set<CatalogEntry>(entries);

  for (const uw of unmatched) {
    if (uw.length < 3) continue;

    // Tier 1: exact + ED1 Set lookup
    const exact = titleIndex.get(uw);
    if (exact) for (const e of exact) {
      scored.set(e, Math.max(scored.get(e) || 0, 5));
      unscored.delete(e);
    }

    for (const v of ed1Variants(uw)) {
      const hits = titleIndex.get(v);
      if (hits) for (const e of hits) {
        scored.set(e, Math.max(scored.get(e) || 0, 3));
        unscored.delete(e);
      }
    }
  }

  // Tier 2: Levenshtein against remaining title words (ED2, ED3, ...)
  if (scored.size === 0) {
    for (const uw of unmatched) {
      if (uw.length < 3) continue;
      for (const [tw, list] of titleIndex) {
        const d = editDist(uw, tw);
        if (d <= 4 && Math.abs(uw.length - tw.length) <= 4) {
          const s = d === 0 ? 5 : d === 1 ? 3 : d === 2 ? 1 : d === 3 ? 0.5 : 0.25;
          for (const e of list) {
            scored.set(e, Math.max(scored.get(e) || 0, s));
          }
        }
      }
    }
  }

  return [...scored.entries()]
    .map(([e, score]) => ({ ...e, score }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Debug mode for localhost
    (globalThis as any).DEBUG = url.searchParams.get('debug') === 'true' && url.hostname === 'localhost';

    if (url.pathname !== '/api/ask') {
      return new Response('Not found', { status: 404 });
    }

    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: cors });
    }
    if (!cors['Access-Control-Allow-Origin']) {
      return new Response('Origin not allowed', { status: 403 });
    }

    const origin = cors['Access-Control-Allow-Origin'];

    // Parse body
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad json' }, 400, cors);
    }

    const question = String(body.question || '').slice(0, 1000).trim();
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const searchHints = String(body.search_hints || '').slice(0, 3000).trim();

    if (!question) {
      return json({ error: 'empty question' }, 400, cors);
    }

    // === Rate Limiting ===
    const clientIp = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
    const rateLimitKey = `${origin}:${clientIp}`;

    if (env.ASK_RATE_LIMITER) {
      try {
        const { success } = await env.ASK_RATE_LIMITER.limit({ key: rateLimitKey });
        if (!success) {
          console.warn(`[ask] rate limited: ${rateLimitKey}`);
          return json({ error: 'Too many requests. Please wait a minute and try again.' }, 429, cors);
        }
      } catch (e: any) {
        console.error('[ask] Rate limiter error (failing open):', e.message);
      }
    }

    // === Jailbreak Protection ===
    if (await isJailbreakAttempt(question, env, origin)) {
      console.warn(`[ask] BLOCKED jailbreak from ${clientIp}`);
      return json({ error: 'Your question appears to contain instructions that violate usage policy.' }, 400, cors);
    }

    // === Main Logic ===
    const entries = await loadCatalog(env, origin);
    const { terms, corrections, unmatched } = await extractTerms(env, question, origin);
    let top = scoreEntries(entries, terms).slice(0, 30);

    const sse = new TransformStream();
    const writer = sse.writable.getWriter();
    const send = (obj: SSEMessage) => writer.write(enc(`data: ${JSON.stringify(obj)}\n\n`));

    const headers = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' };

    if (unmatched.length > 0) {
      // Some words weren't matched by the normalizer.  Run fuzzy fallback
      // even when scoreEntries found partial matches — misspelled words
      // can accidentally match wrong entries, and fuzzy (ED1+Levenshtein)
      // typically finds the correct ones.
      const fuzzy = fuzzyScoreEntries(entries, unmatched).slice(0, 15);
      if (fuzzy.length > 0) {
        // Merge: fuzzy matches first (they're better for misspellings),
        // then scoreEntries results, deduplicated by URL.
        const seen = new Set(fuzzy.map(e => e.url));
        top = [...fuzzy, ...top.filter(e => !seen.has(e.url))].slice(0, 30);
      }
    }

    // When full-text hints are available, cap catalog entries that don't
    // match the CORRECTED term — common words like "gnus" can match 20+
    // entries and drown out the hints that actually answer the question.
    // Corrected-term matches pass through uncapped.
    // When we have spelling corrections, prioritize corrected-term matches
    // over entries that matched only common/uncorrected terms.  Without
    // corrections every entry is "fromOther" and the cap would throw away
    // most results — so only gate when corrections actually exist.
    if (searchHints && Object.keys(corrections).length > 0) {
      const correctedTerms = Object.values(corrections) as string[];
      const fromCorrected = top.filter(e =>
        correctedTerms.some(t => e.title.toLowerCase().includes(t))
      );
      const fromOther = top.filter(e =>
        !correctedTerms.some(t => e.title.toLowerCase().includes(t))
      );
      const kMaxOtherEntries = 5;  // cap for entries matching only common/uncorrected terms
      top = [...fromCorrected, ...fromOther.slice(0, kMaxOtherEntries)];
    }

    if (!top.length && (unmatched.length > 0 || searchHints)) {
      // Even fuzzy found nothing, or catalog has no entries for the corrected
      // terms — use client-side search hints if available, otherwise fall back
      // to the bare catalog directory.
      (async () => {
        let primaryContext = '';
        let hintedTitle = '';
        let hintedUrl = '';

        if (searchHints) {
          // Fetch the first hinted document's full text as the primary source.
          const firstHint = searchHints.split('\n')[0] || '';
          const hintMatch = firstHint.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
          if (hintMatch) {
            hintedTitle = hintMatch[1];
            hintedUrl = hintMatch[2];
            try {
              const doc = await fetchDoc(
                { title: hintedTitle, url: hintedUrl, desc: '' }, env, origin
              );
              if (doc && doc.text) {
                const slice = windowSlice(doc.text, terms, DOC_CHAR_CAP);
                if (slice.length >= 200) {
                  primaryContext =
                    `\n--- source: ${hintedUrl}\ntitle: ${hintedTitle}\n---\n${slice}`;
                }
              }
            } catch { /* fetch failed — fall back to snippets */ }
          }
        }

        const corrPairs = Object.entries(corrections);
        const correctedTermList = Object.values(corrections) as string[];

        let queryBlock = `USER QUESTION\n${question}\n`;
        if (corrPairs.length > 0) {
          const hintsStr = corrPairs.map(([orig, corr]) => `"${orig}" → "${corr}"`).join(', ');
          queryBlock +=
            `\nINTERPRETED QUERY (spelling corrected: ${hintsStr})\n` +
            `Compare or answer about: ${correctedTermList.join(', ')}\n`;
        }

        let instrNum = 0;
        const next = () => `${++instrNum}. `;
        const answerInstruction =
          `\nANSWER INSTRUCTION\n` +
          (primaryContext
            ? `${next()}Read the PRIMARY DOCUMENT — it was identified as the most relevant source.\n`
            : `${next()}Read the SEARCH HINTS below — they were identified as highly relevant.\n`) +
          (correctedTermList.length > 0
            ? `${next()}Look specifically for ${correctedTermList.join(', ')} and any related comparison.\n`
            : `${next()}Identify the relevant concepts.\n`) +
          `${next()}Answer using only the provided material.\n` +
          `${next()}If you acknowledge a spelling correction, do so in one sentence, then answer.\n` +
          (correctedTermList.length > 0
            ? `${next()}Do not say ${correctedTermList.join(' or ')} is absent unless it is absent from the material below.\n`
            : '') +
          `\nOUTPUT REQUIREMENTS\n` +
          `${next()}Begin with a direct answer to the user's question.\n` +
          `${next()}Preserve all relevant names, facts, figures, comparisons, qualifications, and examples found in the provided material. Do not omit relevant details merely to make the answer shorter.\n` +
          `${next()}Organize substantial answers with descriptive Markdown headings using ## or ###.\n` +
          `${next()}Place a blank line after every heading.\n` +
          `${next()}Use bullet lists for related facts. Use numbered lists only for sequences, rankings, or choices that the user must select from.\n` +
          `${next()}Explain each list item with enough context to be understandable; do not output fragments or labels without explanations.\n` +
          `${next()}Use short paragraphs and Markdown tables when comparing several items with the same attributes.\n` +
          `${next()}Do not add sections merely for decoration. Short answers do not require headings.\n` +
          `${next()}Before finishing, silently verify that every relevant detail from the primary material has been represented accurately.\n`;

        let system: string;
        if (primaryContext) {
          system =
            `You are a documentation assistant that ONLY answers from the provided material.\n\n` +
            queryBlock +
            `\nPRIMARY DOCUMENT — READ THIS FIRST\n${primaryContext}\n` +
            (searchHints
              ? `\nADDITIONAL SEARCH HINTS\n${searchHints}\n`
              : '') +
            answerInstruction;
        } else if (searchHints) {
          // No full-text fetch — use snippets as the primary source
          system =
            `You are a documentation assistant that ONLY answers from the provided material.\n\n` +
            queryBlock +
            `\nSEARCH HINTS (primary source)\n${searchHints}\n` +
            answerInstruction;
        } else {
          const catalogOverview = entries.slice(0, 100).map(e =>
            `- ${e.title}${e.desc ? ': ' + e.desc : ''}`
          ).join('\n');
          system =
            `You are a documentation assistant. The user asked: "${question}"\n` +
            `These terms weren't found in the documentation vocabulary: [${unmatched.join(', ')}].\n` +
            `They may be misspelled. Below is a directory of available documentation topics.\n` +
            `Based on the user's question and the topic names below, suggest what they\n` +
            `might have meant and point them to the relevant topic(s).\n\n` +
            `AVAILABLE TOPICS:\n${catalogOverview}\n\n` +
            `FORMAT: Present your suggestions as a bullet list. For each topic include its name and why it may be relevant. Use ## headings only if you have 3+ suggestions.`;
        }


        // Send sources before streaming — tests and UI need them even on hints-only path.
        // Include ALL hints as sources, not just the primary doc.
        const sourcesForSend: Array<{ title: string; url: string }> = [];
        if (primaryContext) sourcesForSend.push({ title: hintedTitle, url: hintedUrl });
        if (searchHints) {
          for (const hintLine of searchHints.split('\n')) {
            const sm = hintLine.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
            if (!sm) continue;
            const sUrl = sm[2];
            if (sUrl.startsWith('#') && !sUrl.startsWith('#/')) continue;
            // Don't duplicate the primary doc
            if (sUrl === hintedUrl) continue;
            sourcesForSend.push({ title: sm[1], url: sUrl });
          }
        }
        await send({ sources: sourcesForSend });

        const chain = (env.PROVIDERS || 'openrouter,gemini').split(',').map(s => s.trim());
        for (const name of chain) {
          let upstream = null;
          try { upstream = await PROVIDERS[name]?.(env, system, history, question); } catch { continue; }
          if (!upstream) continue;
          await send({ provider: name });
          const reader = upstream.res.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let fullText = '';
          let runaway = false;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              let chunk: any;
              try { chunk = JSON.parse(payload); } catch { continue; }
              const content = chunk.choices?.[0]?.delta?.content;
              if (content) {
                fullText += content;
                await send({ text: content });
                if (fullText.length > 100 && /(\\|\/){20,}/.test(fullText.slice(-60))) {
                  await send({ text: '\n\n[response truncated — model error]' });
                  runaway = true;
                  break;
                }
              }
            }
            if (runaway) { reader.cancel(); }
          }
          break;
        }
        await send({ done: true });
        try { await writer.close(); } catch {}
      })();
      return new Response(sse.readable, { headers });
    }

    if (!top.length) {
      (async () => {
        await send({ sources: [] });
        await send({ text: "I don't have that in the materials I can see. Try rephrasing, or browse the documentation directly." });
        await send({ done: true });
        await writer.close();
      })();
      return new Response(sse.readable, { headers });
    }

    (async () => {
      try {
        // Fetch docs in batches of 3 to stay under the 128 MB memory limit.
        const docs: any[] = [];
        for (let i = 0; i < top.length; i += 3) {
          const batch = top.slice(i, i + 3).map(e => fetchDoc(e, env, origin));
          const results = await Promise.all(batch);
          docs.push(...results.filter(Boolean));
        }

        // When hints exist, pick the first hint with a real page path (not
        // just a hash fragment) and fetch it as the PRIMARY source.
        let primaryDoc: any = null;
        if (searchHints) {
          const hintLines = searchHints.split('\n');
          for (const hintLine of hintLines) {
            const hm = hintLine.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
            if (!hm) continue;
            const hUrl = hm[2];
            // Skip hash-only anchors — they don't point to a distinct page.
            if (hUrl.startsWith('#') && !hUrl.startsWith('#/')) continue;
            primaryDoc = docs.find(d => d.url === hUrl || d.url.endsWith(hUrl));
            if (!primaryDoc) {
              try {
                primaryDoc = await fetchDoc(
                  { title: hm[1], url: hUrl, desc: '' }, env, origin
                );
              } catch { /* hinted doc unavailable — try next hint */ }
            }
            if (primaryDoc) break;
          }
        }

        // Separate: primary first (if we have it), then supporting.
        const supportingDocs = primaryDoc
          ? docs.filter(d => d.url !== primaryDoc!.url)
          : docs;

        const allSources = [
          ...(primaryDoc ? [primaryDoc] : []),
          ...supportingDocs,
        ];
        await send({ sources: allSources.map(d => ({ title: d.title, url: d.url })) });

        // Build primary context (own budget)
        let primaryContext = '';
        if (primaryDoc && primaryDoc.text) {
          const slice = windowSlice(primaryDoc.text, terms, DOC_CHAR_CAP);
          if (slice.length >= 200) {
            primaryContext =
              `\n--- source: ${primaryDoc.url}\ntitle: ${primaryDoc.title}\n---\n${slice}`;
          }
        }

        // Build supporting context
        let suppContext = '';
        let used = 0;
        for (const d of supportingDocs) {
          const cap = Math.min(DOC_CHAR_CAP, TOTAL_CHAR_CAP - used);
          const slice = windowSlice(d.text, terms, cap);
          if (slice.length < 200) continue;
          suppContext += `\n\n--- source: ${d.url}\ntitle: ${d.title}\n---\n${slice}`;
          used += slice.length;
        }
        debug(`context: primary=${primaryContext ? 'yes' : 'none'}, supporting=${supportingDocs.length} docs, ${used} chars`);

        // Build correction note
        const corrPairs = Object.entries(corrections);
        const correctedTermList = Object.values(corrections) as string[];

        let queryBlock = `USER QUESTION\n${question}\n`;
        if (corrPairs.length > 0) {
          const hints = corrPairs.map(([orig, corr]) => `"${orig}" → "${corr}"`).join(', ');
          queryBlock +=
            `\nINTERPRETED QUERY (spelling corrected: ${hints})\n` +
            `Compare or answer about: ${correctedTermList.join(', ')}\n`;
        } else if (unmatched.length > 0) {
          queryBlock +=
            `\nNOTE: These words may be misspelled: [${unmatched.join(', ')}]. ` +
            `Use the documents below to find the closest match.\n`;
        }

        const reasoningInstruction =
          `\nREASONING AND FINAL ANSWER\n` +
          `Your reasoning is displayed separately from your final answer.\n` +
          `Use the reasoning channel to analyze the material and plan the response.\n` +
          `The final answer must be completely self-contained and must include all relevant conclusions, facts, explanations, and examples discovered during reasoning.\n` +
          `Never assume that information written in reasoning counts as part of the final answer.\n` +
          `Do not return an outline-only final answer.\n`;

        const answerInstruction =
          `\nFINAL ANSWER CONTRACT\n` +
          `- Return a complete final answer, not an outline or writing plan.\n` +
          `- The final answer must stand on its own without the reasoning section.\n` +
          `- Include the relevant conclusions and details discovered during reasoning.\n` +
          `- When asked for features or capabilities, enumerate every relevant feature explicitly.\n` +
          `- Format each feature as: "- **Feature name:** One or more complete explanatory sentences."\n` +
          `- Never output category headings without the corresponding details beneath them.\n` +
          `- Use numbered lists only for ordered steps, rankings, or clarification choices.\n` +
          `- Before finishing, verify that the final answer itself contains the requested information.\n`;

        const system =
          `You are a specialized assistant that ONLY answers questions about this project's official documentation.\n` +
          reasoningInstruction +
          `\n${queryBlock}` +
          (primaryContext
            ? `\nPRIMARY DOCUMENT — READ THIS FIRST\n${primaryContext}\n`
            : '') +
          (suppContext
            ? `\nSUPPORTING DOCUMENTS\n${suppContext}\n`
            : '') +
          (searchHints
            ? `\nSEARCH HINTS\n${searchHints}\n`
            : '') +
          answerInstruction;

        const chain = (env.PROVIDERS || 'openrouter,gemini').split(',').map(s => s.trim());

        let emittedText = false;
        let hadThinking = false;
        let thinkingText = '';
        let upstreamError: string | null = null;

        for (const name of chain) {
          let upstream = null;
          try {
            upstream = await PROVIDERS[name]?.(env, system, history, question);
          } catch (e: any) {
            console.error(`provider ${name} failed:`, e.message);
            continue;
          }
          if (!upstream) continue;

          await send({ provider: name });

          const reader = upstream.res.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let firstToken = true;
          let fullText = '';
          let runaway = false;

          while (true) {
            let readResult;
            if (firstToken) {
              const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('first token timeout')), PROVIDER_FIRST_TOKEN_MS));
              try {
                readResult = await Promise.race([reader.read(), timeout]);
              } catch {
                reader.cancel();
                break;
              }
              firstToken = false;
            } else {
              readResult = await reader.read();
            }

            const { done, value } = readResult as any;
            if (done) break;

            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;

              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;

              let chunk: any;
              try { chunk = JSON.parse(payload); } catch { continue; }

              if (chunk.error) {
                upstreamError = chunk.error.message || 'Provider stream error';
                console.error('[ask] stream error:', chunk.error);
                continue;
              }

              const reasoning = chunk.choices?.[0]?.delta?.reasoning || '';
              const content = chunk.choices?.[0]?.delta?.content;

              if (reasoning) {
                hadThinking = true;
                thinkingText += reasoning;
                await send({ thinking: reasoning });
              }
              if (content) {
                fullText += content;
                emittedText = true;
                await send({ text: content });
                if (fullText.length > 100 && /(\\|\/){20,}/.test(fullText.slice(-60))) {
                  await send({ text: '\n\n[response truncated — model error]' });
                  runaway = true;
                  break;
                }
              }
              if (!reasoning && !content) {
                const text = upstream.extract(chunk);
                if (text) {
                  fullText += text;
                  emittedText = true;
                  await send({ text });
                  if (fullText.length > 100 && /(\\|\/){20,}/.test(fullText.slice(-60))) {
                    await send({ text: '\n\n[response truncated — model error]' });
                    runaway = true;
                    break;
                  }
                }
              }
            }
            if (runaway) { reader.cancel(); break; }
          }

          if (!emittedText && hadThinking) {
            await send({ text: '\nThe model completed its reasoning but failed to produce a final answer.' });
          }
          if (emittedText || hadThinking) break;
        }

        if (!emittedText && !hadThinking) {
          if (upstreamError) {
            await send({ text: `The model provider failed: ${upstreamError}` });
          } else {
            console.warn(`[ask] all providers timed out for: "${question.slice(0, 80)}"`);
            await send({ text: 'The assistant is taking longer than usual. Please try again in a moment.' });
          }
        }

        await send({ done: true });
      } catch (e: any) {
        console.error(e);
        try {
          await send({ text: 'Something went wrong answering that.', done: true });
        } catch {}
      } finally {
        try { await writer.close(); } catch {}
      }
    })();

    return new Response(sse.readable, { headers });
  }
};
