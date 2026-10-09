# Documentation search and Ask AI

The search box uses Material's browser search worker plus `search-fuzzy.ts`.
Ask AI separately uses a static section index for source hints and a Cloudflare
Worker for catalog retrieval, passage selection, and streamed provider responses.
Both paths keep the existing browser / Cloudflare architecture.

`scripts/build.sh` generates `data/ask-search.json` from Material's
`search/search_index.json`. It contains bounded section passages and word
postings for BM25 ranking with title weights. The normal gzip build step also
compresses this file. Older sites fall back to Material's index, indexed once
per tab. Failed loads can retry on a later question.

Follow-up questions carry at most two recent user topics into retrieval.
Standalone questions use only their current text. Assistant messages do not
become retrieval topics. The original question still goes to the answer model.
The worker accepts hint links only for same-site pages in the documentation
catalog and selects relevant passages within the existing context budgets.

Run the unit suite from the repository root:

```sh
npm ci --prefix ask-ai/worker
npm test --prefix ask-ai/worker
```

Tests compile and exercise production TypeScript modules with local fixtures and
mocked browser, catalog, and provider responses. They cover typo boundaries,
ranking, snippets, follow-ups, index fallback/retry, invalid input, source links,
and provider fallback. They do not require provider keys or a live server.

To use the fixes on a host site, update its template submodule, rebuild its site
(including the new index and widget modules), and redeploy its Ask AI worker.
