"""
clean-nav.py

MkDocs hook that makes linked parent navigation entries render as a clickable
title (linking to the entry's url) with a separate expand arrow, instead of a
non-clickable toggle that only collapses/expands.

Background
----------
When a nav entry has both a link and children — common in the architecture
index, where a numbered section heading links to an anchor inside a shared
markdown file — mkdocs promotes the entry to a Section (taking its title from
the link text) but keeps the original link as the first child. That child has
no title of its own, so by default Material renders it as a blank "None" entry
and the section header becomes a plain toggle (clicking the text only
collapses/expands).

Material's nav template renders a section as a clickable title + arrow toggle
only when the section has an *index* child (a child whose `is_index` is true).
This hook promotes each orphaned titleless child to be that index. The result:

  * clicking the section title navigates to its url (the anchor)
  * clicking the arrow expands/collapses the children
  * the index child itself is not duplicated in the list

Requires the `navigation.indexes` feature in mkdocs.yml.

Registered in mkdocs.yml via:

    hooks:
      - scripts/clean-nav.py
"""

from mkdocs.structure.nav import Link

import re

# Matches a relative .md link target, optionally followed by an anchor.
# `page.md#frag` or `page.md`.  External URLs (http://, mailto:, ...) are
# excluded by requiring the path to start without a scheme.
_MD_LINK_RE = re.compile(r'^(?P<root>(?![a-zA-Z][a-zA-Z0-9+.\-]*://).*)\.md(?P<frag>#.*)?$')


def _to_directory_url(url):
    """
    Convert a relative ``page.md`` (or ``page.md#anchor``) Link url to its
    directory-url form (``page/`` or ``page/#anchor``).

    ``use_directory_urls`` rewrites Page urls automatically, but nav entries
    that point at an anchor resolve as Link objects, so their url keeps the
    literal ``.md`` and the link breaks in the built site.  This rewrites only
    internal ``.md`` links; external URLs and already-directory links pass
    through unchanged.
    """
    if not url:
        return url
    return _MD_LINK_RE.sub(r'\g<root>/\g<frag>', url)


def _rewrite_link_urls(item):
    """Recursively convert every nav Link's .md url to a directory url."""
    url = getattr(item, "url", None)
    if isinstance(item, Link) and url:
        item.url = _to_directory_url(url)

    children = getattr(item, "children", None)
    if children:
        for child in children:
            _rewrite_link_urls(child)


def _remove_orphaned_links(item):
    """
    Remove titleless Link children that literate-nav creates as leftover
    parent links.  These orphans render as "None" entries in the sidebar.
    Without navigation.sections, the section header itself is the toggle —
    no synthetic index is needed.
    """
    children = getattr(item, "children", None)
    if not children:
        return

    for child in children:
        _remove_orphaned_links(child)

    # Remove titleless Link children (null-title orphans from literate-nav).
    item.children = [c for c in children
                     if not (isinstance(c, Link)
                             and getattr(c, "title", None) is None)]


def _promote_section_indexes(item):
    """
    Recursively turn each Section's orphaned titleless child into its index.

    A titleless Link child (the leftover parent link) is promoted by setting
    `is_index = True`, which is the flag Material's nav template checks to
    decide whether to render the section title as a link.
    Requires navigation.sections to be enabled.
    """
    children = getattr(item, "children", None)
    if not children:
        return

    # Recurse first so deeper sections are handled before their parent.
    for child in children:
        _promote_section_indexes(child)

    # Only Link objects can be promoted — Page.is_index is a read-only
    # property (True for real index.md/README.md files) and must not be
    # touched, and Sections never carry an index.
    for child in children:
        if (isinstance(child, Link)
                and getattr(child, "title", None) is None
                and getattr(child, "url", None)):
            child.is_index = True

    # If this item has children and an associated page URL but no existing
    # index child, synthesize a titleless Link so Material renders it as a
    # clickable section (an <a> next to the toggle arrow instead of a bare
    # <label>).
    url = getattr(item, "url", None)
    if not url:
        page = getattr(item, "page", None)
        if page is not None:
            url = getattr(page, "url", None)
    if url and children and not any(getattr(c, "is_index", False) for c in children):
        index_link = Link(title=None, url=url)
        children.insert(0, index_link)
        index_link.is_index = True


def on_nav(nav, config, files):
    """MkDocs hook entry point — rewrite Link urls then clean up orphans.

    When navigation.sections is enabled, promote titleless children to
    section indexes so Material renders clickable section titles.  When
    disabled (accordion mode), remove the orphans entirely — they would
    render as "None" entries.
    """
    features = config["theme"].get("features", [])
    has_sections = "navigation.sections" in features

    for item in nav.items:
        _rewrite_link_urls(item)
        if has_sections:
            _promote_section_indexes(item)
        else:
            _remove_orphaned_links(item)

    return nav
