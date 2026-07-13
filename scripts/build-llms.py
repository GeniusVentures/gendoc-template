#!/usr/bin/env python3
"""
build-llms.py -- generate /llms*.txt agent catalogs from the gendoc pipeline.

Lives in gendoc-template/scripts/. Run from the HOST PROJECT ROOT, like the
other gendoc scripts. Configured by the `llms:` section of gendoc.yml.

Design:
  * SUMMARY.md is the source of truth for hand-written docs (curated nav ==
    curated catalog). Docs not in SUMMARY.md are drafts and are not published.
  * Each source_references set (doxygen/doxybook2 output) becomes ONE catalog
    entry pointing at its index -- never per-file -- and is excluded from
    llms-full.txt.
  * Public Google Docs are fetched as markdown (no API key), cached in a
    committed folder so builds work offline, and published to site/corpus/.
  * Editorial judgment (descriptions, categories, exclusions) lives in
    llms-meta.json at the host root, maintained via the /update-catalogs
    Claude Code command. This script never invents descriptions.
  * Output is written into the MkDocs site_dir AFTER `mkdocs build`, so
    deploy.sh ships the catalogs with the site automatically.

Usage:
    python3 gendoc-template/scripts/build-llms.py [--fetch] [--config gendoc.yml]
      --fetch   also re-download configured Google Docs (network required)
"""

import argparse
import contextlib
import glob as glob_mod
import hashlib
import json
import os
import re
import shutil
import signal
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path, PurePath

with contextlib.suppress(AttributeError, ValueError):  # no SIGPIPE on Windows
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

import yaml

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)

def word_count(text: str) -> int:
    return len(text.split())

def doc_url(rel_md: str, use_directory_urls: bool) -> str:
    """Map docs/<rel>.md to its published URL the way MkDocs does.
    Returns a site-relative path (e.g. /model-and-router/) so the worker
    resolves against SITE_URL and the AI cites relative URLs, not hard-coded
    production domain."""
    p = rel_md.replace("\\", "/")
    p = re.sub(r"^\.?/", "", p)          # strip leading ./ or /
    p = re.sub(r"\.mdx?$", "", p)
    if use_directory_urls:
        if p.endswith("index") or p.endswith("README"):
            p = re.sub(r"(index|README)$", "", p)
        else:
            p += "/"
    else:
        p += ".html"
    return "/" + p.lstrip("/")

# --------------------------------------------------------------------------- #
# load configuration
# --------------------------------------------------------------------------- #

ap = argparse.ArgumentParser()
ap.add_argument("--config", default="gendoc.yml")
ap.add_argument("--fetch", action="store_true", help="re-download Google Docs")
ap.add_argument("--strict", action="store_true",
                help="exit 1 if any entries need editorial attention (for CI/PR checks)")
args = ap.parse_args()

cfg_path = Path(args.config)
if not cfg_path.exists():
    die(f"{args.config} not found -- run from the host project root")
cfg = yaml.safe_load(cfg_path.read_text())

llms = cfg.get("llms") or {}
if not llms.get("enabled", False):
    print("llms.enabled is false -- skipping catalog generation")
    sys.exit(0)

site_url = llms.get("site_url") or die("llms.site_url is required")
docs_dirs_raw = cfg["paths"]["handwritten_docs"]
docs_dirs = [Path(d) for d in (docs_dirs_raw if isinstance(docs_dirs_raw, list) else [docs_dirs_raw])]

# Resolve site_dir the same way build.sh does:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
#   SITE_DIR_ABS="$TEMPLATE_ROOT/$SITE_DIR"
SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATE_ROOT = SCRIPT_DIR.parent
site_dir_cfg = llms.get("site_dir") or cfg.get("mkdocs", {}).get("site_dir", "site")
site_dir = Path(site_dir_cfg)
if not site_dir.is_absolute():
    site_dir = TEMPLATE_ROOT / site_dir
use_dir_urls = cfg.get("mkdocs", {}).get("use_directory_urls", True)
corpus_cache = Path(llms.get("corpus_cache", "llms-corpus"))
meta_path = Path(llms.get("meta_file", "llms-meta.json"))
audiences = llms.get("audiences") or {
    "llms-sales.txt":     {"title": "Sales & SMB Enablement", "categories": ["sales", "product", "pricing"]},
    "llms-technical.txt": {"title": "Architecture & Developer Reference", "categories": ["technical", "architecture", "api", "nodes"]},
    "llms-investors.txt": {"title": "Investor & JV Context", "categories": ["investors", "token"]},
}
project_name = cfg.get("project", {}).get("name", "Project")
project_brief = cfg.get("project", {}).get("brief", "")

if not site_dir.exists():
    die(f"site dir '{site_dir}' not found (resolved as TEMPLATE_ROOT/{site_dir_cfg}, "
        f"matching build.sh) -- run build.sh first; catalogs are a post-build step")

meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"docs": {}}
needs_editorial = []

# --------------------------------------------------------------------------- #
# 1. fetch/cache Google Docs (markdown export, no API key; doc must be
#    link-shared). Cached copies are committed so offline builds still work.
# --------------------------------------------------------------------------- #

corpus_cache.mkdir(exist_ok=True)
for gd in llms.get("google_docs", []):
    out = corpus_cache / gd["out"]
    if args.fetch:
        url = f"https://docs.google.com/document/d/{gd['id']}/export?format=md"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gendoc-llms/1.0"})
            with urllib.request.urlopen(req, timeout=30) as res:
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(res.read())
            print(f"  fetched Google Doc -> {out}")
        except Exception as e:  # noqa: BLE001
            print(f"  WARNING: fetch failed for {gd['id']} ({e}); using cached copy")
    if not out.exists():
        print(f"  WARNING: no cached copy of {gd['out']} -- run with --fetch (skipping)")

# publish corpus into the built site as raw markdown at stable URLs
site_corpus = site_dir / "corpus"
if corpus_cache.exists() and any(corpus_cache.iterdir()):
    site_corpus.mkdir(exist_ok=True)
    for f in corpus_cache.rglob("*.md"):
        dest = site_corpus / f.relative_to(corpus_cache)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)

# --------------------------------------------------------------------------- #
# 2. collect entries: SUMMARY.md docs + corpus docs + source-reference sets
# --------------------------------------------------------------------------- #

entries = []  # {key, url, title, words, content|None, section}
seen = set()  # deduplicate: SUMMARY_EXT.md has one entry per heading, all to the same file

section = None
for docs_dir in docs_dirs:
    summary = docs_dir / "SUMMARY.md"
    if not summary.exists():
        # Some projects use SUMMARY_EXT.md (generated by build-navigation.py)
        summary = docs_dir / "SUMMARY_EXT.md"
    if not summary.exists():
        print(f"  WARNING: no SUMMARY.md or SUMMARY_EXT.md in {docs_dir} -- skipping")
        continue
    for line in summary.read_text().splitlines():
        h = re.match(r"^##\s+(.+)$", line)
        if h:
            section = h.group(1).strip()
            continue
        for title, rel in re.findall(r"\[([^\]]+)\]\(([^)]+\.mdx?(?:#[^)]*)?)\)", line):
            rel = re.sub(r"#.*$", "", rel)   # strip anchor
            if rel in seen:
                continue
            seen.add(rel)
            src = docs_dir / rel
            if not src.exists():
                print(f"  WARNING: SUMMARY.md links missing file {rel} (in {docs_dir})")
                continue
            content = src.read_text()
            entries.append({
                "key": f"docs:{rel}",
                "url": doc_url(rel, use_dir_urls),
                "title": title,
                "words": word_count(content),
                "content": content,
                "section": section,
            })

for f in sorted(corpus_cache.rglob("*.md")) if corpus_cache.exists() else []:
    rel = f.relative_to(corpus_cache)
    content = f.read_text()
    gd = next((g for g in llms.get("google_docs", []) if g["out"] == str(rel)), {})
    entries.append({
        "key": f"corpus:{rel}",
        "url": f"/corpus/{rel}",
        "title": gd.get("title", f.stem),
        "words": word_count(content),
        "content": content,
        "section": "External Documents",
    })

# Per-compound entries from Doxygen XML indexes -- one entry per class/file/namespace
kind_to_dir = {
    "class": "Classes", "struct": "Classes", "protocol": "Classes",
    "file": "Files",
    "namespace": "Namespaces",
}
for sr in cfg.get("source_references", []) or []:
    base_url = sr["base_url"].rstrip("/")
    xml_index = TEMPLATE_ROOT / "doxygen-output" / sr["name"] / "xml" / "index.xml"
    found = False
    if xml_index.exists():
        try:
            tree = ET.parse(str(xml_index))
            root = tree.getroot()
            for compound in root.findall("compound"):
                refid = compound.get("refid")
                kind = compound.get("kind", "")
                name_el = compound.find("name")
                if not refid or not kind or name_el is None or name_el.text is None:
                    continue
                name = name_el.text.strip()
                kind_dir = kind_to_dir.get(kind)
                if not kind_dir:
                    continue
                # Extract brief + detailed description from the compound's XML
                desc = ""
                content_text = ""  # plain-text body for LLM context
                comp_xml = xml_index.parent / f"{refid}.xml"
                if comp_xml.exists():
                    try:
                        ctree = ET.parse(str(comp_xml))
                        cdef = ctree.getroot().find("compounddef")
                        if cdef is not None:
                            brief = cdef.find("briefdescription")
                            if brief is not None:
                                desc = "".join(brief.itertext()).strip()
                            # Build a clean text summary: brief + detailed + member list
                            parts = []
                            if desc:
                                parts.append(desc)
                            detail = cdef.find("detaileddescription")
                            if detail is not None:
                                dtext = "".join(detail.itertext()).strip()
                                if dtext:
                                    parts.append(dtext)
                            # Collect member signatures + brief descriptions
                            members = []
                            for sec in cdef.findall("sectiondef"):
                                for mdef in sec.findall("memberdef"):
                                    mkind = mdef.get("kind", "")
                                    mname_el = mdef.find("name")
                                    mname = mname_el.text.strip() if mname_el is not None and mname_el.text else ""
                                    if not mname:
                                        continue
                                    mdef_el = mdef.find("definition")
                                    mdef_text = mdef_el.text.strip() if mdef_el is not None and mdef_el.text else mname
                                    mbrief_el = mdef.find("briefdescription")
                                    mbrief = ""
                                    if mbrief_el is not None:
                                        mbrief = "".join(mbrief_el.itertext()).strip()
                                    members.append((mkind, mname, mbrief))
                            if members:
                                parts.append("Members:")
                                for mkind, mname, mbrief in members:
                                    line = f"  {mname}"
                                    if mbrief:
                                        line += f" — {mbrief}"
                                    parts.append(line)
                            content_text = "\n".join(parts)
                    except ET.ParseError:
                        pass
                # Fallback: use the short name so scoring has something to match
                if not desc:
                    desc = name.split("::")[-1]
                    # For paths (dir/file), take only the last component
                    if "/" in desc:
                        desc = desc.rsplit("/", 1)[-1]
                # Skip if the generated page doesn't exist (e.g. doxybook2
                # didn't produce a page for this protocol/compound).
                page_dir = site_dir / base_url.lstrip("/") / kind_dir / refid
                if not page_dir.exists():
                    continue
                entries.append({
                    "key": f"set:{sr['name']}:{refid}",
                    "url": f"{base_url}/{kind_dir}/{refid}/",
                    "title": f"{name} ({kind})",
                    "desc": desc,
                    "words": word_count(content_text) if content_text else 0,
                    "content": content_text or None,  # plain-text for LLM, None if empty
                    "section": "Source Reference",
                    "is_set": True,
                })
                found = True
        except ET.ParseError as e:
            print(f"  WARNING: failed to parse {xml_index}: {e}")
    # Fallback: single entry if XML index missing or empty
    if not found:
        entries.append({
            "key": f"set:{sr['name']}",
            "url": sr["base_url"],
            "title": sr.get("label", sr["name"]) + " (source reference)",
            "words": 0,
            "content": None,
            "section": "Source Reference",
            "is_set": True,
        })

# ── external-docs plugin sources ──────────────────────────────────────────
# The external-docs MkDocs plugin injects markdown files from outside the
# docs directory into the build.  Read sources from gendoc.yml so everything
# is configured in one place (paths are relative to the host project root).

HOST_ROOT = str(TEMPLATE_ROOT.parent)
ext_docs = cfg.get("external_docs", {})
ext_sources = ext_docs.get("sources", [])
if ext_sources:
    for src in ext_sources:
        if isinstance(src, dict):
            group_label = src.get("label", "")
            paths = src.get("paths", [])
        else:
            group_label = ""
            paths = [src]
        for pattern in paths:
            abs_pattern = os.path.join(HOST_ROOT, pattern)
            for fpath in sorted(glob_mod.glob(abs_pattern, recursive=True)):
                if not fpath.endswith((".md", ".markdown")):
                    continue
                p = Path(fpath)
                rel = os.path.relpath(fpath, str(TEMPLATE_ROOT))
                # Strip leading ".." segments to build src_uri matching
                # the external-docs plugin's on_files logic.
                parts = [part for part in PurePath(rel).parts if part != ".."]
                src_uri = "/".join(parts)
                if src_uri in seen:
                    continue
                seen.add(src_uri)
                content = p.read_text()
                entries.append({
                    "key": f"external:{src_uri}",
                    "url": doc_url(src_uri, use_dir_urls),
                    "title": p.stem.replace("-", " ").replace("_", " "),
                    "words": word_count(content),
                    "content": content,
                    "section": f"External: {group_label}" if group_label else "External Documentation",
                })

# --------------------------------------------------------------------------- #
# 3. reconcile with editorial metadata
# --------------------------------------------------------------------------- #

for e in entries:
    m = meta["docs"].get(e["key"])
    h = sha(e["content"]) if e["content"] is not None else "set"
    if m is None:
        desc = e.get("desc") or None
        meta["docs"][e["key"]] = {
            "hash": h,
            "description": desc,
            "category": "api" if e.get("is_set") else None,
            "optional": bool(e.get("is_set")),
            "exclude": False,
            "nav_section": e["section"],
        }
        if not e.get("is_set"):
            if not desc:
                needs_editorial.append((e["key"], "new"))
            else:
                needs_editorial.append((e["key"], "seeded from Doxygen"))
    elif m["hash"] != h:
        m["hash"] = h
        if e.get("is_set"):
            # Source-reference entries are auto-generated — just update hash + desc
            if e.get("desc"):
                m["description"] = e["desc"]
        else:
            m["stale"] = True
            needs_editorial.append((e["key"], "content changed"))
    elif not m.get("description") and e.get("desc"):
        # Backfill description from Doxygen brief / fallback name
        m["description"] = e.get("desc")
        needs_editorial.append((e["key"], "description backfilled"))
    elif m.get("stale"):
        if e.get("is_set"):
            # Auto-clear stale flag for source-ref entries
            m["stale"] = False
        else:
            needs_editorial.append((e["key"], "stale flag set -- description not yet verified"))
    elif not m.get("description"):
        needs_editorial.append((e["key"], "missing description"))

for key in list(meta["docs"]):
    if not any(e["key"] == key for e in entries):
        del meta["docs"][key]

meta_path.write_text(json.dumps(meta, indent=2) + "\n")

# --------------------------------------------------------------------------- #
# 4. emit catalogs into site_dir
# --------------------------------------------------------------------------- #

def cat_line(e):
    m = meta["docs"][e["key"]]
    desc = m.get("description") or "(no description yet)"
    size = f" ({e['words']} words)" if e["words"] else ""
    return f"- [{e['title']}]({e['url']}): {desc}{size}"

published = [e for e in entries if not meta["docs"][e["key"]].get("exclude")]

for fname, aud in audiences.items():
    docs = [e for e in published if meta["docs"][e["key"]].get("category") in aud["categories"]]
    core = [e for e in docs if not meta["docs"][e["key"]].get("optional")]
    opt = [e for e in docs if meta["docs"][e["key"]].get("optional")]
    out = [f"# {project_name} -- {aud['title']}", "",
           "> Answer only from the documents below. Cite source URLs. "
           "If none of them cover the question, say so.", "", "## Documents", ""]
    out += [cat_line(e) for e in core]
    if opt:
        out += ["", "## Optional", ""] + [cat_line(e) for e in opt]
    rel = [r for r in llms.get("related_catalogs", []) if fname in r.get("audiences", [])]
    if rel:
        out += ["", "## Related Catalogs", ""]
        out += [f"- [{r['title']}]({r['url']}): {r['description']}" for r in rel]
    (site_dir / fname).write_text("\n".join(out) + "\n")
    print(f"  wrote {fname} ({len(docs)} docs)")

brief = project_brief.rstrip()
if brief and not brief.endswith("."):
    brief += "."
master = [f"# {project_name}", "",
          f"> {brief} This is the master catalog; audience-specific "
          "catalogs are linked below.", "", "## Catalogs", ""]
for fname, aud in audiences.items():
    master.append(f"- [{aud['title']}](/{fname}): "
                  f"for {', '.join(aud['categories'])} questions")
master.append(f"- [Full corpus](/llms-full.txt): "
              "all documentation inlined (large; excludes source reference)")
related = llms.get("related_catalogs", [])
if related:
    master += ["", "## Related Catalogs", ""]
    master += [f"- [{r['title']}]({r['url']}): {r['description']}" for r in related]
pinned = [e for e in published if meta["docs"][e["key"]].get("pinned")]
if pinned:
    master += ["", "## Key Documents", ""] + [cat_line(e) for e in pinned]
(site_dir / "llms.txt").write_text("\n".join(master) + "\n")
print("  wrote llms.txt")

full = [f"# {project_name} -- Full Corpus"]
for e in published:
    if e["content"] is None:
        continue
    full.append(f"\n\n---\nsource: {e['url']}\ntitle: {e['title']}\n---\n\n{e['content']}")
full_text = "".join(full)
(site_dir / "llms-full.txt").write_text(full_text + "\n")
print(f"  wrote llms-full.txt ({len(full_text)//1024} KB)")

# Write a content lookup map for source-reference entries so the worker
# gets clean Doxygen XML text instead of scraping stripped HTML pages.
content_map = {}
for e in published:
    if e.get("is_set") and e.get("content"):
        content_map[e["url"]] = e["content"]
if content_map:
    (site_dir / "content-map.json").write_text(json.dumps(content_map) + "\n")
    total_chars = sum(len(v) for v in content_map.values())
    print(f"  wrote content-map.json ({len(content_map)} source-ref entries, {total_chars} chars)")

if needs_editorial:
    print(f"\n{len(needs_editorial)} entr{'y' if len(needs_editorial)==1 else 'ies'} need editorial attention:")
    for key, why in needs_editorial:
        print(f"  * {key} -- {why}")
    print("\nRun /update-catalogs in Claude Code, then re-run build.sh.")
    if args.strict:
        sys.exit(1)
else:
    print("\nAll catalog entries have current descriptions and categories.")