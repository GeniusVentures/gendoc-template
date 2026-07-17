"use strict";
/**
 * search-fuzzy.ts — fuzzy typo-correction for Material's search worker.
 *
 * Must load BEFORE Material for MkDocs (in the libs block, via injectors.ts)
 * so the Worker constructor is intercepted before Material creates its
 * search Web Worker.
 *
 * Loads search-vocab.json (fetch-gzip intercepts → .json.gz) and corrects query terms via edit-distance-1
 * variant lookup.  When a term like "bittensro" isn't in the vocab but
 * "bittensor" is, the query is silently corrected before the worker sees it.
 */
// Load vocab async — corrections start working once it's loaded.
let vocabReady = false;
let vocabSet = null;
let vocabAliases = {};
const vocabStopwords = {};
const vocabPromise = fetch('/data/search-vocab.json')
    .then((res) => {
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return res.json();
})
    .then((data) => {
    vocabSet = new Set(data.vocab);
    vocabAliases = data.aliases || {};
    const sw = data.stopwords || [];
    for (const w of sw)
        vocabStopwords[w] = true;
    vocabReady = true;
})
    .catch(() => {
    vocabSet = new Set();
    vocabReady = true;
});
/* ---- edit-distance-1 variants ---- */
function ed1Variants(word) {
    const variants = new Set();
    const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < word.length; i++) {
        variants.add(word.slice(0, i) + word.slice(i + 1)); // deletion
        for (let j = 0; j < alpha.length; j++) {
            const ch = alpha[j];
            variants.add(word.slice(0, i) + ch + word.slice(i)); // insertion
            variants.add(word.slice(0, i) + ch + word.slice(i + 1)); // substitution
        }
    }
    for (let k = 0; k < word.length - 1; k++) {
        variants.add(word.slice(0, k) + word[k + 1] + word[k] + word.slice(k + 2)); // transposition
    }
    return variants;
}
/* ---- correct a single word ---- */
function correctWord(word) {
    if (!vocabReady || !vocabSet || vocabSet.size === 0)
        return word;
    const lower = word.toLowerCase();
    if (lower.length < 3)
        return word;
    if (vocabStopwords[lower])
        return word;
    if (vocabAliases[lower])
        return vocabAliases[lower];
    if (vocabSet.has(lower))
        return word;
    // ED1 fuzzy: find unambiguous corrections
    const hits = [];
    const ed1set = ed1Variants(lower);
    ed1set.forEach((v) => { if (vocabSet.has(v))
        hits.push(v); });
    return hits.length === 1 ? hits[0] : word;
}
/* ---- apply correction to a query string ---- */
function fuzzyCorrect(query) {
    if (!vocabReady || !vocabSet || vocabSet.size === 0)
        return query;
    return query.replace(/[A-Za-z0-9]+/g, (m) => correctWord(m));
}
// Exposed for transport.ts — applies vocab-based ED1 correction to queries
// before they hit searchHints(), so hints are found for misspelled terms.
window.fuzzyCorrect = fuzzyCorrect;
/* ---- hook into the Worker constructor for search workers ---- */
// fetch-gzip.js may have already wrapped window.Worker — chain on top so
// both the gzip Blob bootstrap AND fuzzy postMessage correction work.
const PrevWorker = window.Worker;
window.Worker = function (scriptURL, options) {
    const worker = new PrevWorker(scriptURL, options);
    const url = String(scriptURL);
    // Match Material's search worker: "search" anywhere in the URL.
    if (url.indexOf('search') !== -1) {
        const origPost = worker.postMessage.bind(worker);
        worker.postMessage = function (msg, transfer) {
            if (msg && typeof msg === 'object' && typeof msg.data === 'string') {
                const corrected = fuzzyCorrect(msg.data);
                const newMsg = {};
                for (const k in msg) {
                    if (Object.prototype.hasOwnProperty.call(msg, k))
                        newMsg[k] = msg[k];
                }
                newMsg.data = corrected;
                return origPost(newMsg, transfer);
            }
            return origPost(msg, transfer);
        };
    }
    return worker;
};
window.Worker.prototype = PrevWorker.prototype;
