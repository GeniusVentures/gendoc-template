"""
clean_nav.py

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
      - scripts/clean_nav.py
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


def _promote_section_indexes(item):
    """
    Recursively turn each Section's orphaned titleless child into its index.

    A titleless Link child (the leftover parent link) is promoted by setting
    `is_index = True`, which is the flag Material's nav template checks to
    decide whether to render the section title as a link. Sections themselves
    always carry a title, so legitimate sections are never affected.
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
    # <label>).  Without this, Pages-with-children are only expandable,
    # never navigable, and the <label class="md-nav__title"> duplicates the
    # page title.
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
    """MkDocs hook entry point — rewrite Link urls then promote indexes."""
    for item in nav.items:
        _rewrite_link_urls(item)
        _promote_section_indexes(item)
    return nav
