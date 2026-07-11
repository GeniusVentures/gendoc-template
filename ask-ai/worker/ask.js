/**
 * ask-worker -- /api/ask endpoint for the gendoc llms-search widget.
 *
 * Retrieval is the llms.txt catalog itself: entry descriptions are scored
 * against the question, the top documents are fetched (HTML stripped via
 * HTMLRewriter), and Gemini answers from that context only, streamed back
 * as SSE. No vector DB, no pre-crawl, no KV.
 *
 * Config (wrangler.toml [vars] unless noted):
 *   LLMS_URL         master catalog, e.g. "https://docs.gnus.ai/llms.txt"
 *   ALLOWED_ORIGINS  comma-separated, e.g. "https://docs.gnus.ai,https://gnus.ai"
 *   GEMINI_MODEL     default "gemini-2.5-flash"
 *   BOT_NAME         e.g. "GNUS.ai Assistant"
 *   GEMINI_API_KEY   SECRET -- set with: wrangler secret put GEMINI_API_KEY
 */

const DOC_CHAR_CAP = 15000 // per-document context cap
const TOTAL_CHAR_CAP = 40000 // whole-context cap
const CATALOG_TTL_MS = 15 * 60 * 1000
const PROVIDER_CONNECT_MS = 3000  // timeout for TCP/TLS + HTTP response headers
const PROVIDER_FIRST_TOKEN_MS = 8000 // timeout for first SSE token after connection

const STOPWORDS = new Set(
    ('a an and are as at be by for from how in is it of on or that the this to was ' +
     'what when where which who why with does do can you your our my i me we he she ' +
     'if so no go up give list top tell show find get make need want just like also ' +
     'see the').split(/\s+/).filter(Boolean),
)

import { MkDocsSearchNormalizer } from './search-normalizer.js'

const catalogCache = new Map() // per-isolate, per-origin cache: Map<origin, { entries, ts }>
const normalizerCache = new Map() // Map<origin, MkDocsSearchNormalizer>

let DEBUG = false  // toggled per-request via ?debug=true from localhost

function debug(...args) {
    if (DEBUG)
    {
        console.log('[ask:debug]', ...args)
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        // Enable debug logging for localhost requests with ?debug=true
        DEBUG = url.searchParams.get('debug') === 'true' && url.hostname === 'localhost'

        if (url.pathname !== '/api/ask') {
            return new Response('Not found', { status: 404 });
        }

        const cors = corsHeaders(request, env)
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: cors });
        }
        if (request.method !== 'POST') {
            return new Response('POST only', { status: 405, headers: cors });
        }
        if (!cors['Access-Control-Allow-Origin']) {
            return new Response('Origin not allowed', { status: 403 });
        }

        const origin = cors['Access-Control-Allow-Origin']  // guaranteed non-null here

        let body
        try {
            body = await request.json()
        } catch {
            return json({ error: 'bad json' }, 400, cors)
        }
        const question = String(body.question || '')
            .slice(0, 1000)
            .trim()
        const history = Array.isArray(body.history) ? body.history.slice(-6) : []
        if (!question) {
            return json({ error: 'empty question' }, 400, cors);
        }

        const entries = await loadCatalog(env, origin)
        const terms = await extractTerms(env, question, origin)
        // Fetch all scored docs up to a generous limit — TOTAL_CHAR_CAP
        // enforces the real budget, and the LLM context builder stops when full.
        const top = scoreEntries(entries, terms).slice(0, 30)
        console.log(`[ask] catalog entries: ${entries.length}, top matches: ${top.length}, terms: [${terms.join(', ')}], q: "${question.slice(0, 80)}"`)
        top.forEach((e, i) => console.log(`[ask]   #${i + 1} score=${e.score.toFixed(3)} "${e.title}"`))

        const sse = new TransformStream()
        const writer = sse.writable.getWriter()
        const send = (obj) => writer.write(enc(`data: ${JSON.stringify(obj)}\n\n`))

        const headers = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }

        if (!top.length) {
            // nothing in the catalog matches -- refuse without spending Gemini quota
            ;(async () => {
                await send({ sources: [] })
                await send({
                    text: "I don't have that in the materials I can see. Try rephrasing, or browse the documentation directly.",
                })
                await send({ done: true })
                await writer.close()
            })()
            return new Response(sse.readable, { headers })
        }

        ;(async () => {
            try {
                const docs = (await Promise.all(top.map((e) => fetchDoc(e, env, origin)))).filter(Boolean)
                await send({ sources: docs.map((d) => ({ title: d.title, url: d.url })) })

                let context = '',
                    used = 0, ctxDocs = 0, skipped = 0
                for (const d of docs) {
                    const slice = d.text.slice(0, Math.min(DOC_CHAR_CAP, TOTAL_CHAR_CAP - used))
                    if (slice.length < 200) {
                        skipped++;
                        continue;
                    }
                    context += `\n\n--- source: ${d.url}\ntitle: ${d.title}\n---\n${slice}`
                    used += slice.length
                    ctxDocs++
                }
                debug(`context: ${ctxDocs} docs, ${used} chars, ${skipped} skipped, ${docs.length} fetched`)

                const system =
                    `You answer questions about this project's documentation. ` +
                    `When the context below contains relevant items, list or describe ` +
                    `ALL of them — don't stop after one or two. The context is your ` +
                    `only source of facts. If nothing is relevant, say: "I don't see ` +
                    `that in the materials." Cite sources inline. Be thorough. ` +
                    `Before answering, use 1-2 lines of private chain-of-thought ` +
                    `prefixed with "Thinking:" — these will be hidden from the user. ` +
                    `Then write your answer on the lines that follow.` +
                    `\n\nCONTEXT:${context}`

                // ---- provider chain: try each until one accepts the request ----
                const chain = (env.PROVIDERS || 'openrouter,gemini').split(',').map((s) => s.trim())

                // Try each provider.  Connection must succeed within
                // PROVIDER_CONNECT_MS; first token must arrive within
                // PROVIDER_FIRST_TOKEN_MS.  On either timeout, fall through
                // to the next provider.
                let emittedText = false
                let hadThinking = false
                let thinkingText = ''
                let upstreamError = null

                for (const name of chain) {
                    let upstream = null
                    try {
                        upstream = await PROVIDERS[name]?.(env, system, history, question)
                    } catch (e) {
                        console.error(`provider ${name} failed:`, e.message)
                        continue
                    }
                    if (!upstream) {
                        continue
                    }

                    await send({ provider: name })

                    // Pump the provider's SSE
                    const reader = upstream.res.body.getReader()
                    const dec = new TextDecoder()
                    let buf = ''
                    let firstToken = true
                    let pumpDone = false

                    while (!pumpDone) {
                        let readResult
                        if (firstToken) {
                            const timeout = new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('first token timeout')), PROVIDER_FIRST_TOKEN_MS))
                            try {
                                readResult = await Promise.race([reader.read(), timeout])
                            } catch {
                                reader.cancel()
                                break  // fall through to next provider
                            }
                            firstToken = false
                        } else {
                            readResult = await reader.read()
                        }
                        const { done, value } = readResult
                        if (done) {
                            break;
                        }
                        buf += dec.decode(value, { stream: true })
                        let nl
                        while ((nl = buf.indexOf('\n')) >= 0) {
                            const line = buf.slice(0, nl).trim()
                            buf = buf.slice(nl + 1)
                            if (!line.startsWith('data:')) {
                                continue;
                            }
                            const payload = line.slice(5).trim()
                            if (!payload || payload === '[DONE]') {
                                continue;
                            }
                            // Log first few raw SSE chunks when debugging
                            if (DEBUG && !emittedText && !hadThinking) {
                                debug('raw sse:', payload.slice(0, 200))
                            }
                            let chunk
                            try {
                                chunk = JSON.parse(payload)
                            } catch {
                                continue;
                            }
                            // Surface mid-stream errors from the provider
                            if (chunk.error) {
                                upstreamError = chunk.error.message || 'Provider stream error'
                                console.error('[ask] stream error:', chunk.error)
                                continue
                            }
                            // OpenRouter reasoning models: reasoning → Thinking…,
                            // content → visible answer.  Gemini: extract()
                            // falls back to candidates[0].content.parts.
                            const reasoning = chunk.choices?.[0]?.delta?.reasoning || ''
                            const content = chunk.choices?.[0]?.delta?.content
                            if (reasoning) {
                                hadThinking = true
                                thinkingText += reasoning
                                await send({ thinking: reasoning });
                            }
                            if (content) {
                                emittedText = true
                                await send({ text: content });
                            }
                            // Non-OpenRouter fallback (Gemini, etc.)
                            if (!reasoning && !content) {
                                const text = upstream.extract(chunk)
                                if (text) {
                                    emittedText = true
                                    await send({ text });
                                }
                            }
                        }
                    }
                    // If model only produced reasoning (no content), fall back to
                    // showing reasoning as the answer text.
                    if (!emittedText && hadThinking) {
                        await send({ text: thinkingText });
                    }
                    // Provider produced output — stop trying others
                    if (emittedText || hadThinking) {
                        break  // exit provider chain, we got a response
                    }
                }  // end provider chain loop

                // All providers exhausted with no output
                if (!emittedText && !hadThinking) {
                    if (upstreamError) {
                        await send({
                            text: `The model provider failed while streaming: ${upstreamError}`,
                        })
                    } else {
                        await send({
                            text: 'The assistant is temporarily over capacity. Please try again in a few minutes.',
                        })
                    }
                }
                await send({ done: true })
            } catch (e) {
                console.error(e)
                try {
                    await send({ text: 'Something went wrong answering that.', done: true })
                } catch {}
            } finally {
                try {
                    await writer.close()
                } catch {}
            }
        })()

        return new Response(sse.readable, { headers })
    },
}

/* ------------------------------ provider chain ----------------------------- */
/** Wrap a fetch with a connection timeout — once the response headers arrive,
 *  streaming can continue indefinitely.  Returns the response or throws. */
async function fetchWithConnectTimeout(url, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, { ...init, signal: controller.signal })
        return res
    } finally {
        clearTimeout(timer)
    }
}

/* Each adapter returns { res, extract } on success, or null to fall through   */
/* to the next provider (non-ok responses = quota/outage = fall through).      */

const PROVIDERS = {
    async gemini(env, system, history, question) {
        if (!env.GEMINI_API_KEY) {
            return null;
        }
        const model = env.GEMINI_MODEL || 'gemini-2.5-flash'
        const res = await fetchWithConnectTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: system }] },
                    contents: [
                        ...history.map((h) => ({
                            role: h.role === 'assistant' ? 'model' : 'user',
                            parts: [{ text: String(h.content).slice(0, 2000) }],
                        })),
                        { role: 'user', parts: [{ text: question }] },
                    ],
                    generationConfig: { temperature: 0.2 },
                }),
            },
            PROVIDER_CONNECT_MS,
        )
        if (!res.ok) {
            console.error('gemini', res.status, (await res.text()).slice(0, 200))
            return null
        }
        return {
            res,
            extract: (c) => c.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(''),
        }
    },

    async openrouter(env, system, history, question) {
        if (!env.OPENROUTER_API_KEY) {
            return null;
        }
        const models = (env.OPENROUTER_MODELS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        if (models.length === 0) {
            return null;
        }
        const body = {
            stream: true,
            temperature: 0.2,
            reasoning: { enabled: true, exclude: false },
            messages: [
                { role: 'system', content: system },
                ...history.map((h) => ({
                    role: h.role === 'assistant' ? 'assistant' : 'user',
                    content: String(h.content).slice(0, 2000),
                })),
                { role: 'user', content: question },
            ],
        }
        if (models.length > 1) {
            body.models = models
            body.route = 'fallback'
        } else {
            body.model = models[0]
        }
        const res = await fetchWithConnectTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': env.SITE_URL || '',
                'X-Title': env.BOT_NAME || 'gendoc-ask',
            },
            body: JSON.stringify(body),
        }, PROVIDER_CONNECT_MS)
        if (!res.ok) {
            console.error('openrouter', res.status, (await res.text()).slice(0, 200))
            return null
        }
        return { res, extract: (c) => c.choices?.[0]?.delta?.content || c.choices?.[0]?.delta?.reasoning || c.choices?.[0]?.message?.content || '' }
    },
}

/* ------------------------------ catalog load ------------------------------ */

async function loadCatalog(env, origin) {
    const cached = catalogCache.get(origin)
    if (!DEBUG && cached && Date.now() - cached.ts < CATALOG_TTL_MS) {
        return cached.entries;
    }
    let llmsUrl = env.LLMS_URL
    if (llmsUrl && llmsUrl.startsWith('/')) {
        llmsUrl = new URL(llmsUrl, origin).href
    }
    const master = await fetchText(llmsUrl)
    const catalogOrigin = new URL(llmsUrl).origin
    const entries = []
    const seen = new Set()
    const parse = (text) => {
        for (const m of text.matchAll(/^-\s*\[([^\]]+)\]\((\S+?)\)(?::\s*(.*))?$/gm)) {
            const [, title, href, desc = ''] = m
            if (seen.has(href)) {
                continue;
            }
            seen.add(href)
            entries.push({ title, url: href, desc })
        }
    }
    parse(master)
    debug(`[${origin}] master entries: ${entries.length}`)
    // one hop into audience catalogs (skip the giant -full file).  Resolve
    // relative URLs against the master catalog origin so site-relative paths
    // in llms.txt work both locally and against deployed custom domains.
    const subs = entries.filter((e) => /llms-(?!full)[\w-]+\.txt$/.test(e.url))
    debug(`[${origin}] sub-catalogs to fetch: ${subs.length}, urls: ${subs.map(s => s.url).join(', ')}`)
    for (const s of subs) {
        try {
            const subUrl = new URL(s.url, catalogOrigin).href
            debug(`[${origin}] fetching sub-catalog: ${subUrl}`)
            parse(await fetchText(subUrl))
        } catch (e) {
            console.error(`[ask] [${origin}] sub-catalog fetch failed:`, s.url, e.message)
        }
    }
    const docs = entries.filter((e) => !/llms[\w-]*\.txt$/.test(e.url))
    catalogCache.set(origin, { entries: docs, ts: Date.now() })
    return docs
}

function scoreEntries(entries, terms) {
    return entries
        .map((e) => {
            const title = e.title.toLowerCase(),
                desc = (e.desc || '').toLowerCase(),
                url = e.url.toLowerCase()
            let score = 0
            for (const t of terms) {
                if (title.includes(t)) {
                    score += 3;
                }
                if (desc.includes(t)) {
                    score += 2;
                }
                if (url.includes(t)) {
                    score += 1;
                }
            }
            // Bonus for curated descriptions (real editorial from llms-meta.json,
            // not auto-generated from Doxygen or fallback names). Source-reference
            // entries come from Doxygen XML — their brief descriptions are
            // auto-generated, not curated. Only hand-written doc descriptions
            // should get the editorial boost.
            const isSourceRef = /\/source-reference\/|\/python-reference\//.test(e.url)
            if (!isSourceRef) {
                const entityName = e.title.replace(/\s*\((?:class|struct|protocol|file|namespace|dir|enum)\)\s*$/i, '').trim()
                const isFallback = !e.desc || e.desc === '(no description yet)' ||
                    e.desc.toLowerCase() === entityName.toLowerCase() ||
                    e.desc.split(/\s+/).length < 3
                if (!isFallback) {
                    score += 2;
                }
            }
            // Tiebreak: prefer entries with real Doxygen briefs (> 1 word)
            // over bare fallback class names.  Source-ref entries with briefs
            // like "Orchestrates the full inference pipeline" rank above
            // entries whose description is just the class name repeated.
            const hasBrief = e.desc && e.desc.length > 0 &&
                e.desc !== '(no description yet)' &&
                e.desc.split(/\s+/).length > 1 &&
                e.desc.toLowerCase() !== e.title.replace(/\s*\([^)]+\)\s*$/, '').trim().toLowerCase()
            const tiebreak = hasBrief ? 1 : 0
            return { ...e, score, tiebreak }
        })
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score || b.tiebreak - a.tiebreak)
}

/* -------------------------- spelling correction via search index --------- */

async function getNormalizer(env, origin) {
    const cached = normalizerCache.get(origin)
    if (!DEBUG && cached)
    {
        return cached;
    }
    const url = new URL('/search/search_index.json', origin).href
    const normalizer = await MkDocsSearchNormalizer.load(url)
    normalizerCache.set(origin, normalizer)
    console.log(`[ask] [${origin}] normalizer loaded: ${normalizer.wordToMeta.size} keywords`)
    return normalizer
}

async function extractTerms(env, question, origin) {
    const rawTerms = question
        .toLowerCase()
        .match(/[a-z0-9]{2,}/g)
        ?.filter((t) => !STOPWORDS.has(t)) || []
    if (rawTerms.length === 0) return rawTerms;

    try {
        const n = await getNormalizer(env, origin)
        const result = n.normalizeQuery(question)
        if (result.corrected) {
            console.log(`[ask] spelling corrected: [${rawTerms}] -> [${result.tokens}]`)
        }
        return result.tokens.filter((t) => !STOPWORDS.has(t))
    } catch (e) {
        console.log(`[ask] normalizer failed, using raw terms: ${e.message}`)
        return rawTerms
    }
}

/* ------------------------------- doc fetching ----------------------------- */

const contentMapCache = new Map() // Map<origin, object>

async function loadContentMap(env, origin) {
    const cached = contentMapCache.get(origin)
    if (!DEBUG && cached)
    {
        return cached;
    }
    try {
        const url = new URL('/content-map.json', origin).href
        const contentMap = await fetchText(url).then(JSON.parse)
        contentMapCache.set(origin, contentMap)
        return contentMap
    } catch {
        contentMapCache.set(origin, {})
        return {}
    }
}

async function fetchDoc(entry, env, origin) {
    try {
        // Check content map first (clean Doxygen XML text for source-ref entries)
        const cmap = await loadContentMap(env, origin)
        if (cmap[entry.url]) {
            return { ...entry, text: cmap[entry.url] }
        }
        const docUrl = entry.url.startsWith('/')
            ? new URL(entry.url, env.SITE_URL || origin).href
            : entry.url;
        const res = await fetch(docUrl, {
            headers: { 'User-Agent': 'gendoc-ask-worker/1.0' },
            cf: { cacheTtl: 900, cacheEverything: true },
        })
        if (!res.ok) {
            return null;
        }
        const ctype = res.headers.get('content-type') || ''
        let text
        if (ctype.includes('text/html')) {
            const state = { text: '', skip: 0 }
            await new HTMLRewriter()
                .on('script, style, nav, footer, header, aside, noscript, svg', {
                    element(el) {
                        state.skip++
                        el.onEndTag(() => {
                            state.skip--
                        })
                    },
                })
                .on('h1, h2, h3, h4, p, li, td, pre, br', {
                    element() {
                        state.text += '\n'
                    },
                })
                .on('body *', {
                    text(t) {
                        if (state.skip === 0) {
                            state.text += t.text || "";
                        }
                    },
                })
                .transform(res)
                .arrayBuffer()
            text = state.text
        } else {
            text = await res.text()
        }
        text = text
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        return { ...entry, text }
    } catch {
        return null
    }
}

async function fetchText(url) {
    const res = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } })
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.text()
}

/* --------------------------------- helpers -------------------------------- */

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || ''
    const allowed = (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    const h = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }
    if (allowed.includes(origin)) {
        h['Access-Control-Allow-Origin'] = origin;
    }
    return h
}

const enc = (s) => new TextEncoder().encode(s)
const json = (obj, status, cors) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
