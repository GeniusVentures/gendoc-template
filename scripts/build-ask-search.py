#!/usr/bin/env python3
"""Build Ask AI's static section index; Material keeps its own search index."""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

STOPWORDS = set((
    "a an and are as at be by for from how in is it of on or that the this to was "
    "what when where which who why with does do can you your"
).split())


def tokens(text):
    return [term for raw in re.findall(r"[a-z0-9][a-z0-9+.#_-]*", text.lower())
            if len(term := raw.strip("_.-")) >= 2 and term not in STOPWORDS]


def build_index(source):
    docs = []
    postings = defaultdict(list)
    for doc in source.get("docs", []):
        if not isinstance(doc, dict) or not all(isinstance(doc.get(key), str)
                                               for key in ("location", "title", "text")):
            continue
        text = doc["text"]
        # Bound passages while retaining every part of long sections.
        starts = range(0, max(1, len(text)), 1050)
        for start in starts:
            passage = text[start:start + 1200]
            body = Counter(tokens(passage))
            title = Counter(tokens(doc["title"]))
            doc_id = len(docs)
            docs.append({"location": doc["location"], "title": doc["title"],
                         "text": passage, "length": max(1, sum(body.values()))})
            for term in sorted(body.keys() | title.keys()):
                postings[term].append([doc_id, body[term], title[term]])
            if start + 1200 >= len(text):
                break
    average = sum(doc["length"] for doc in docs) / len(docs) if docs else 1
    return {"version": 1, "docs": docs, "postings": dict(postings), "averageLength": average}


def main():
    source_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    source = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(source, dict) or not isinstance(source.get("docs"), list):
        raise ValueError("Expected a Material search index with a docs array")
    index = build_index(source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False) + "\n",
                           encoding="utf-8")
    print(f"Ask AI index: {len(index['docs'])} passages, {len(index['postings'])} terms")


if __name__ == "__main__":
    main()
