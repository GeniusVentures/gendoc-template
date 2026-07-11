#!/usr/bin/env python3
"""Precompute a compact search vocabulary from MkDocs search_index.json.

Uses the same tokenization as MkDocsSearchNormalizer but skips the SymSpell
delete index (which causes the 128 MB OOM in the Worker).  Writes a small JSON
that the worker loads per-origin and does on-demand fuzzy matching against.

Also embeds the canonical jailbreak misspelling corrections so there is a
single source of truth for all text-normalization data.

Usage:  python3 build-vocab.py [search_index.json] [output.json]
  Defaults: site/search/search_index.json -> site/data/search-vocab.json
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

STOP_WORDS: set[str] = set(
    "a an and are as at be by for from has how i in is it its of on or "
    "that the this to was what when where which who why with".split()
)

MIN_TOKEN_LEN: int = 3
TOP_STOPWORDS: int = 50

# ── Search-term aliases (same canonicalisations as search-normalizer.js) ─────
ALIASES: dict[str, str] = {
    "fullter": "flutter", "fluter": "flutter", "fluttter": "flutter",
    "fultter": "flutter", "clases": "classes", "routre": "router",
    "rounter": "router", "g-nus": "gnus", "typscript": "typescript",
    "javscript": "javascript", "clodflare": "cloudflare",
    "genius cognitive system": "gcs", "cognitive system": "gcs",
    "super genius": "supergenius", "open ai": "openai",
}

# ── Jailbreak misspelling corrections ────────────────────────────────────────
# Maps common misspellings of security-sensitive keywords to their canonical
# form so attackers can't evade keyword filters with simple typos.
JAILBREAK_CORRECTIONS: dict[str, str] = {
    "igonre": "ignore", "ignor": "ignore", "ingore": "ignore",
    "disreguard": "disregard",
    "forgit": "forget",
    "bypas": "bypass", "bipass": "bypass",
    "overide": "override",
    "jailbrake": "jailbreak", "jailbrak": "jailbreak",
    "devloper": "developer", "developr": "developer",
    "uncensor": "uncensored",
}

_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9+.#_-]*")


def tokenize(text: str) -> list[str]:
    return [
        t.lower().strip("-_.#+")
        for t in _TOKEN_RE.findall(str(text or ""))
    ]


def main() -> None:
    search_path = sys.argv[1] if len(sys.argv) > 1 else "site/search/search_index.json"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "site/data/search-vocab.json"

    print(f"Loading: {search_path}", file=sys.stderr)
    with open(search_path, encoding="utf-8") as fh:
        search_json = json.load(fh)
    docs = search_json.get("docs", []) if isinstance(search_json, dict) else []
    print(f"Documents: {len(docs)}", file=sys.stderr)

    word_freq: Counter[str] = Counter()
    title_words: set[str] = set()

    for doc in docs:
        title = doc.get("title", "") or ""
        text = doc.get("text", "") or ""
        location = doc.get("location", "") or ""
        keywords = doc.get("keywords", "") or ""

        tokens = tokenize(title)
        title_words.update(tokens)
        word_freq.update(tokens)

        word_freq.update(tokenize(keywords))
        word_freq.update(tokenize(
            location.replace("/", " ").replace("#", " ").replace(".", " ")
                   .replace("_", " ").replace("-", " ")
        ))
        word_freq.update(tokenize(text))

    # Auto-detect stopwords: top N most frequent
    auto_stopwords: set[str] = set()
    for word, _ in word_freq.most_common(TOP_STOPWORDS):
        if len(word) > 2 and not word.isdigit():
            auto_stopwords.add(word)

    # Protected terms: title words with frequency >= 2, not auto-stopwords
    protected_terms: set[str] = {
        w for w in title_words
        if len(w) >= 3 and word_freq.get(w, 0) >= 2 and w not in auto_stopwords
    }

    # Remove stopwords from vocabulary
    for sw in auto_stopwords:
        word_freq.pop(sw, None)
    for sw in STOP_WORDS:
        word_freq.pop(sw, None)

    vocab = [word for word, _ in word_freq.most_common()]

    output = {
        "vocab": vocab,
        "aliases": ALIASES,
        "stopwords": sorted(auto_stopwords),
        "protected": sorted(protected_terms),
        "jailbreakCorrections": JAILBREAK_CORRECTIONS,
        "totalDocs": len(docs),
        "totalWords": len(vocab),
    }

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    size_kb = out.stat().st_size / 1024
    print(f"Wrote {len(vocab)} words to {out_path} ({size_kb:.1f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
