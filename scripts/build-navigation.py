#!/usr/bin/env python3
"""
Build navigation structure from index_*.md files.
Parses markdown lists and links to generate SUMMARY_EXT.md files in each category directory,
then assembles a root SUMMARY_EXT.md from the configured hand-written sections plus one
section per source reference set.
"""

import glob
import os
import re
import sys

import yaml


# Doxygen index categories converted by doxybook2.  A source reference set may
# not produce every category (e.g. Python yields no Modules/Pages), so each is
# only included when its directory and SUMMARY_EXT.md exist.
CATEGORIES = ["Classes", "Files", "Namespaces", "Modules", "Pages"]


def _slugify(text):
    """
    Convert heading text to a URL anchor slug.
    Matches the convention used by generate-index.sh and MkDocs.
    """
    slug = text.lower()
    slug = re.sub(r'\*\*', '', slug)
    slug = re.sub(r'`', '', slug)
    slug = re.sub(r'—', '-', slug)
    slug = re.sub(r'[^a-z0-9 -]', '', slug)
    slug = re.sub(r'  +', ' ', slug)
    slug = re.sub(r' ', '-', slug)
    slug = re.sub(r'--*', '-', slug)
    slug = slug.strip('-')
    return slug


def _is_up_to_date(target_path, source_path, extra_sources=None):
    """
    Return True if target_path exists and is newer than all source paths.
    """
    if not os.path.exists(target_path):
        return False
    target_mtime = os.path.getmtime(target_path)
    source_paths = [source_path]
    if extra_sources:
        source_paths.extend(extra_sources)
    for source in source_paths:
        if os.path.exists(source) and os.path.getmtime(source) > target_mtime:
            return False
    return True


def parse_markdown_links(md_content):
    """
    Parse markdown list items with links into a hierarchical structure.
    Returns list of tuples: (indent_level, link_text, link_url)

    Indent size is auto-detected: the first child item's extra leading spaces
    determine the spaces-per-level for the entire list.
    """
    items = []

    for line in md_content.split('\n'):
        # Skip empty lines and non-list items.
        if not line.strip() or not (line.lstrip().startswith('*') or line.lstrip().startswith('-')):
            continue

        leading_spaces = len(line) - len(line.lstrip())

        # Extract link: [text](url) — include anchor (#fragment) in URL.
        match = re.search(r'\[([^\]]+)\]\(([^)]+)', line)
        if match:
            text = match.group(1)
            url = match.group(2)
            items.append((leading_spaces, text, url))

    if not items:
        return items

    # Auto-detect indent size from the first parent→child transition.
    indent_size = 2  # default
    parent_spaces = items[0][0]
    for leading_spaces, _, _ in items[1:]:
        if leading_spaces > parent_spaces:
            indent_size = leading_spaces - parent_spaces
            break

    return [(sp // indent_size, text, url) for sp, text, url in items]


def _has_linked_descendant(items, parent_index):
    """
    Return True if any item after parent_index with a deeper indent has a URL.
    Stops as soon as the indent returns to or below the parent's indent.
    """
    parent_indent = items[parent_index][0]
    for j in range(parent_index + 1, len(items)):
        if items[j][0] <= parent_indent:
            break
        if items[j][2]:  # has a URL
            return True
    return False


def _unlink_parents_with_children(items):
    """
    Drop the link on any item that has at least one child.

    A linked parent with children is not a directory index page, so Material
    cannot promote it to a clickable section header; instead it re-inserts the
    parent's own link as a child entry whose title resolves to "None".  Making
    such parents unlinked renders them as clean, expandable section headers
    with no phantom child — exactly how the reference treats its grouped
    sections that lack a dedicated index page.
    """
    result = []
    for i, (indent, text, url) in enumerate(items):
        has_child = any(items[j][0] > indent for j in range(i + 1, len(items)))
        result.append((indent, text, None if has_child else url))
    return result


def _prune_empty_labels(items):
    """
    Remove label-only items (url=None) whose entire subtree contains no
    linked items.  Iterates repeatedly until no more pruning is possible,
    handling chains of empty parents (e.g. ipfs_lite -> ipfs -> <nothing>).
    """
    changed = True
    while changed:
        changed = False
        pruned = []
        for i, item in enumerate(items):
            indent, text, url = item
            if not url and not _has_linked_descendant(items, i):
                changed = True  # drop this item, loop again
            else:
                pruned.append(item)
        items = pruned
    return items


def build_literate_nav(items, unlink_parents=False):
    """
    Convert list of (indent, text, url) tuples into a Markdown list.
    Uses 4 spaces per indent level to match SUMMARY.md formatting.

    When unlink_parents is True, parents that have children are emitted as
    unlinked section headers so Material renders them as expandable sections
    without a phantom "None" index child (see _unlink_parents_with_children).
    """
    if unlink_parents:
        items = _unlink_parents_with_children(items)
    items = _prune_empty_labels(items)
    lines = []
    for indent, text, url in items:
        indent_str = "    " * indent
        if url:
            lines.append(f"{indent_str}- [{text}]({url})")
        else:
            lines.append(f"{indent_str}- {text}")
    return "<!--nav-->\n\n" + "\n".join(lines) + "\n"


def parse_index_file(filepath):
    """
    Parse a single index_*.md file and return list of navigation entries.
    """
    with open(filepath, 'r') as f:
        content = f.read()

    items = parse_markdown_links(content)
    return items


def _promote_page_roots(items):
    """
    Promote a deep anchor TOC — extracted from an index page — into a
    page-rooted nav: one linked page entry per document, with that
    document's H2/H3 subheadings nested beneath it (the nested layout the
    doxybook source reference uses, where each parent page lists its
    children).

    The first entry for each document (its H1 title, linked with a
    ``#fragment``) becomes the page-root link with the fragment stripped so
    it resolves to the page itself; every later entry sharing that page is
    emitted as an anchor child.  Because the H1 entry is consumed as the
    root it is never re-emitted as its own child — previously a section's
    title was listed both as the page root and as its first child.
    """
    seen_pages = set()
    result = []
    for indent, text, url in items:
        if not url:
            continue
        page = url.split("#")[0].strip()
        if not page:
            continue
        if indent == 0:
            if page not in seen_pages:
                seen_pages.add(page)
                # First entry → Page root (fragment stripped → Page object = breadcrumbs)
                result.append((0, text, page))
            else:
                # Later entry for same page → Link root (fragment kept → separate nav entry)
                result.append((0, text, url))
        else:
            # Children pass through at their natural indent
            result.append((indent, text, url))
    return result


def extract_links_from_section(filepath, heading_name):
    """
    Extract markdown list items under a specific H2 heading.

    If heading_name is empty, extracts all links from the file.
    If heading_name is specified but not found, warns and extracts all.
    Returns list of (indent, text, url) tuples.
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if not heading_name:
        return parse_markdown_links(content)

    # Find the target H2 heading.
    lines = content.split('\n')
    start_line = None
    heading_pattern = re.compile(r'^##\s+')
    for i, line in enumerate(lines):
        if heading_pattern.match(line):
            # Strip ##, bold markers, whitespace for comparison.
            heading_text = line[2:].strip().strip('*').strip()
            if heading_text.lower() == heading_name.lower():
                start_line = i
                break

    if start_line is None:
        print(f"Warning: heading '{heading_name}' not found in {filepath} "
              f"— extracting all links",
              file=sys.stderr)
        return parse_markdown_links(content)

    # Extract lines from start_line+1 to next H2 or EOF.
    section_lines = []
    for i in range(start_line + 1, len(lines)):
        if heading_pattern.match(lines[i]):
            break
        section_lines.append(lines[i])

    return parse_markdown_links('\n'.join(section_lines))


def _normalize_url(url, category_dir, category_path, link_text, src_dir_basename):
    """
    Normalize a link target to be relative to the category directory.

    Doxybook generates absolute paths like /source-reference/Files/d5/df0/foo/
    literate-nav treats any absolute path as an external resource, so we
    must strip the leading <src_dir_basename>/<category>/ prefix to produce a
    plain relative path like d5/df0/foo/ that literate-nav resolves
    correctly within the category's SUMMARY_EXT.md.

    Dir index entries (dir_*/ or dir_*.md) are kept as links — their pages
    list the files in that directory and are useful content.
    """
    if not url:
        return None

    normalized = url.replace("\\", "/").lstrip("/")

    # Strip leading src_dir_basename prefix (with or without leading slash).
    basename_prefix = src_dir_basename + "/"
    if normalized.startswith(basename_prefix):
        normalized = normalized[len(basename_prefix):]

    # Drop cross-category links.  Doxybook's index_classes.md can reference
    # entries in Namespaces/, Files/, etc.  Those paths don't exist under the
    # current category directory, so literate-nav resolves them wrongly.
    # Each category's own SUMMARY_EXT.md handles its own entries.
    known_categories = set(CATEGORIES)
    first_segment = normalized.split("/")[0]
    if first_segment in known_categories and first_segment != category_dir:
        return None

    # Strip leading category prefix e.g. "Files/".
    category_prefix = f"{category_dir}/"
    if normalized.startswith(category_prefix):
        normalized = normalized[len(category_prefix):]

    # Dir entries (doxygen directory listing pages) are directories without
    # a landing page — drop them so they don't appear as "None" in the nav.
    bare = normalized.rstrip("/").split("#")[0]
    if os.path.basename(bare).startswith("dir_"):
        return None

    # Resolve doxybook hash-suffixed files.  Doxybook sometimes appends a
    # hash to the filename (e.g. namespacesgns_1_1scale_1_1_0d176...md) but
    # the index links to the unhashed stem with a trailing slash.  If the
    # normalized path ends with / and no real directory exists at that path,
    # look for a .md file whose name starts with the same stem.
    if normalized.endswith("/"):
        stem = os.path.basename(normalized.rstrip("/"))
        parent_rel = os.path.dirname(normalized.rstrip("/"))
        parent_abs = os.path.join(category_path, parent_rel)
        candidate_dir = os.path.join(category_path, normalized.rstrip("/"))
        if not os.path.isdir(candidate_dir):
            matches = glob.glob(os.path.join(parent_abs, stem + "*.md"))
            if len(matches) == 1:
                # Use the relative path to the matched file from category_path.
                normalized = os.path.relpath(matches[0], category_path).replace("\\", "/")
            elif len(matches) > 1:
                # Multiple matches — pick the shortest name (closest to original).
                matches.sort(key=lambda p: len(os.path.basename(p)))
                normalized = os.path.relpath(matches[0], category_path).replace("\\", "/")

    return normalized or None


def _needs_nav_marker_regen(summary_path):
    """
    Return True if the summary file is missing the nav marker.
    """
    if not os.path.exists(summary_path):
        return True
    with open(summary_path, 'r', encoding='utf-8') as handle:
        first_line = handle.readline().strip()
    return first_line != "<!--nav-->"


def generate_category_pages(src_dir, force=False):
    """
    Generate SUMMARY_EXT.md files in each category directory of a source
    reference set.  Maps index_*.md to category directories.
    """
    index_to_category = {
        'index_classes.md':    'Classes',
        'index_files.md':      'Files',
        'index_groups.md':     'Modules',
        'index_namespaces.md': 'Namespaces',
        'index_pages.md':      'Pages',
    }

    generated    = []
    categories   = []
    any_updated  = False
    script_path  = os.path.abspath(__file__)
    src_dir_basename = os.path.basename(src_dir)

    for index_filename, category_dir in index_to_category.items():
        index_filepath = os.path.join(src_dir, index_filename)
        category_path  = os.path.join(src_dir, category_dir)

        if not os.path.exists(index_filepath) or not os.path.isdir(category_path):
            continue

        summary_file = os.path.join(category_path, "SUMMARY_EXT.md")

        # Skip all expensive work if nothing has changed.
        if not force and _is_up_to_date(summary_file, index_filepath, [script_path]):
            if not _needs_nav_marker_regen(summary_file):
                categories.append(category_dir)
                continue

        items = parse_index_file(index_filepath)
        if not items:
            continue

        normalized_items = [
            (indent, text, _normalize_url(url, category_dir, category_path, text, src_dir_basename))
            for indent, text, url in items
        ]
        if not normalized_items:
            continue

        # Prepend README.md as first nav entry so section-index makes the
        # category header a clickable link to the index page.
        nav_lines = build_literate_nav(normalized_items)
        nav_lines = "<!--nav-->\n\n- [" + category_dir + "](README.md)\n" + nav_lines[len("<!--nav-->\n\n"):]

        with open(summary_file, 'w') as f:
            f.write(nav_lines)

        # Symlink index_*.md as README.md in the category dir so the section
        # header has a landing page without duplicating content.
        # Use a relative target so the symlink is portable.
        readme_path = os.path.join(category_path, "README.md")
        if os.path.islink(readme_path) or os.path.exists(readme_path):
            os.remove(readme_path)
        rel_target = os.path.relpath(index_filepath, category_path)
        os.symlink(rel_target, readme_path)

        any_updated = True
        categories.append(category_dir)
        generated.append((summary_file, len(items)))
        print(f"Generated {summary_file} ({len(items)} entries)")

    if categories:
        _write_root_summary(src_dir, categories)

    return generated


def _write_root_summary(src_dir, categories):
    """
    Write SUMMARY_EXT.md inside the source reference directory so literate-nav
    has navigation when the user clicks into the source reference section.
    Uses directory URLs (trailing /) for the section-index plugin.
    """
    summary_path = os.path.join(src_dir, "SUMMARY_EXT.md")
    lines = ["<!--nav-->", ""]
    for category in categories:
        lines.append(f"- [{category}]({category}/)")
    content = "\n".join(lines) + "\n"
    with open(summary_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Source reference root nav written to {summary_path}")


def _write_readme(src_dir, categories, label, language=""):
    """
    Write README.md inside the source reference directory as the landing page
    for the source reference nav entry.
    """
    readme_path = os.path.join(src_dir, "README.md")
    lang_phrase = f"{language} " if language else ""
    lines = [f"# {label}\n",
             f"Browse the {lang_phrase}source documentation generated from Doxygen.\n"]
    for cat in categories:
        lines.append(f"- [{cat}]({cat}/)")
    with open(readme_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(lines) + "\n")
    print(f"Source reference README written to {readme_path}")


def write_root_nav(docs_dir, sets, nav_config):
    """
    Build root SUMMARY_EXT.md from configuration-driven navigation sections
    plus one section per source reference set.

    Each entry in nav_config['sections'] defines:
        label:           Unlinked nav section label
        source_file:     Markdown file whose list items populate the section
        extract_heading: Optional H2 heading to scope extraction (empty = all links)

    Each entry in `sets` defines:
        label:     Unlinked nav section label for the source set
        src_dir:   Absolute path to the set's generated markdown directory
        language:  Optional language name used in the landing page prose

    The generated source reference sections are appended last with directory
    URLs (trailing /) for the section-index plugin.
    """
    sections_conf = nav_config.get("sections", [])

    items = []

    # ── Process each configured section ────────────────────────────────────────
    for section in sections_conf:
        label = section.get("label", "")
        source_file = section.get("source_file", "")
        extract_heading = section.get("extract_heading", "")

        if not source_file:
            print(f"Warning: section '{label}' has no source_file — skipping",
                  file=sys.stderr)
            continue

        filepath = os.path.join(docs_dir, source_file)
        if not os.path.isfile(filepath):
            print(f"Warning: source_file '{source_file}' not found in {docs_dir} "
                  f"— skipping section '{label}'",
                  file=sys.stderr)
            continue

        # Unlinked section label.
        if label:
            items.append((0, label, None))

        # Extract links from the source file (scoped by heading if configured).
        section_links = extract_links_from_section(filepath, extract_heading)

        if section.get("promote_page_roots"):
            section_links = _promote_page_roots(section_links)

        # Shift indent +1 so children nest under the section label.
        for indent, text, url in section_links:
            items.append((indent + 1, text, url))

    # ── Append one section per source reference set ──────────────────────
    for src_set in sets:
        src_dir = src_set["src_dir"]
        src_dir_basename = os.path.basename(src_dir)
        set_items = []

        for category in CATEGORIES:
            cat_summary = os.path.join(src_dir, category, "SUMMARY_EXT.md")
            if os.path.isfile(cat_summary):
                set_items.append((1, category, f"{src_dir_basename}/{category}/"))

        if not set_items:
            continue

        items.append((0, src_set.get("label") or src_dir_basename, None))
        items.extend(set_items)

        category_names = [c for _, c, _ in set_items]
        _write_readme(src_dir, category_names,
                      src_set.get("label") or src_dir_basename,
                      src_set.get("language", ""))

    # ── Build and write SUMMARY_EXT.md ─────────────────────────────────────
    nav_content = build_literate_nav(items)
    output_path = os.path.join(docs_dir, "SUMMARY_EXT.md")
    with open(output_path, 'w', encoding='utf-8') as fh:
        fh.write(nav_content)

    set_count = len(sets)
    total = len(items)
    print(f"Root SUMMARY_EXT.md written to {output_path} ({total} nav entries, {set_count} source sets)")


def _load_source_sets(docs_dir, cfg):
    """
    Resolve the configured source_references list into the list of dicts
    expected by write_root_nav.  Each set's src_dir is docs_dir/<output_subdir>.
    Sets whose output directory does not exist (not yet generated) are skipped
    with a warning.
    """
    sets = []
    for entry in cfg.get("source_references") or []:
        out_subdir = entry.get("output_subdir")
        name = entry.get("name") or out_subdir
        if not out_subdir:
            print(f"Warning: source set '{name}' has no output_subdir — skipping",
                  file=sys.stderr)
            continue

        src_dir = os.path.join(docs_dir, out_subdir)
        if not os.path.isdir(src_dir):
            print(f"Warning: source set '{name}' output not found at {src_dir} "
                  f"— skipping (run the source reference build first)",
                  file=sys.stderr)
            continue

        sets.append({
            "label": entry.get("label") or name,
            "src_dir": src_dir,
            "language": entry.get("language", ""),
        })
    return sets


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Build SUMMARY_EXT.md navigation files.")
    parser.add_argument("--docs-dir", default=None,
                        help="Path to hand-written docs directory (becomes MkDocs docs_dir)")
    parser.add_argument("--gendoc-config", default=None,
                        help="Path to gendoc.yml for source reference + navigation configuration")
    parser.add_argument("--force", action="store_true", help="Force regeneration even if up to date")
    args = parser.parse_args()

    cfg = {}
    if args.gendoc_config and os.path.isfile(args.gendoc_config):
        with open(args.gendoc_config, 'r') as f:
            cfg = yaml.safe_load(f) or {}
    elif args.gendoc_config:
        print(f"Warning: gendoc config not found at {args.gendoc_config} "
              f"— no source reference sections will be generated",
              file=sys.stderr)

    if not args.docs_dir:
        # Without a docs dir there is nothing to merge into; nothing to do.
        sys.exit(0)

    if not os.path.isdir(args.docs_dir):
        print(f"Error: docs directory not found: {args.docs_dir}", file=sys.stderr)
        sys.exit(1)

    sets = _load_source_sets(args.docs_dir, cfg)
    for src_set in sets:
        generate_category_pages(src_set["src_dir"], force=args.force)

    nav_config = cfg.get("navigation", {})
    write_root_nav(args.docs_dir, sets, nav_config)

    sys.exit(0)
