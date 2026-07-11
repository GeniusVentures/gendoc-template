"""
MkDocs hook that rewrites GitBook-specific syntax to standard HTML/Markdown:
  1. GitBook cover/coverY from page.meta -> hero img injected at top of content
  2. {% embed url="..." %} tags -> <video> or <iframe> HTML
  3. GitBook inline math $$..$$ (no newlines) -> arithmatex inline
  4. GitBook block math $$newline..newline$$ -> arithmatex block
  5. (../)*/.gitbook/assets/ paths -> absolute /assets/
  6. Raw Doxygen file/brief/author/date tags -> stripped
"""
import re
import os


_SEARCH_GZIP_SHIM = """<script>
(function () {
  var originalFetch = window.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }

  window.fetch = async function (input, init) {
    var response = await originalFetch(input, init);

    try {
      var requestUrl = "";
      if (typeof input === "string") {
        requestUrl = String(input);
      } else if (input instanceof URL) {
        requestUrl = String(input);
      } else if (input && input.url) {
        requestUrl = input.url;
      }

      var pathname = new URL(requestUrl, window.location.href).pathname;

      if (!pathname.endsWith("/search/search_index.json")) {
        return response;
      }

      var encoding = response.headers.get("Content-Encoding");
      if (!encoding) {
        encoding = response.headers.get("content-encoding");
      }

      if (encoding && /gzip/i.test(encoding)) {
        return response;
      }

      if (typeof DecompressionStream === "undefined") {
        return response;
      }

      var probe = new Uint8Array(await response.clone().arrayBuffer());
      if (probe.length < 2) {
        return response;
      }

      if (probe[0] !== 0x1f) {
        return response;
      }

      if (probe[1] !== 0x8b) {
        return response;
      }

      var headers = new Headers(response.headers);
      headers.delete("Content-Encoding");
      headers.delete("content-encoding");

      var hasContentType = headers.has("Content-Type");
      if (!hasContentType) {
        hasContentType = headers.has("content-type");
      }

      if (!hasContentType) {
        headers.set("Content-Type", "application/json; charset=utf-8");
      }

      var stream = new Blob([probe]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    } catch (error) {
      return response;
    }
  };
})();
</script>
"""

# ── GitBook cover via page.meta ───────────────────────────────────────────────

def _inject_cover(markdown, page):
    """
    Inject a GitBook-style hero cover image at the top of the page content.
    MkDocs populates page.meta from YAML frontmatter in read_source() before
    on_page_markdown fires.
    coverY is a vertical offset percentage (0 = top, GitBook default is center).
    """
    meta = page.meta or {}
    cover = meta.get("cover")
    if not cover:
        return markdown
    cover_path = re.sub(r'(?:\.\./)*\.gitbook/assets/', '/assets/', str(cover).strip())
    # coverY: 0 means no vertical shift — map to object-position percentage.
    # GitBook uses coverY as a pixel offset; we approximate as a percentage.
    cover_y = meta.get("coverY", 0)
    try:
        y_pct = max(0, min(100, 50 + int(cover_y) // 4))
    except (ValueError, TypeError):
        y_pct = 50
    hero = (
        f'<div style="width:100%;height:450px;overflow:hidden;'
        f'max-width:calc(100% + 3.2rem);">'
        f'<img src="{cover_path}" '
        f'style="width:100%;height:100%;object-fit:cover;object-position:center {y_pct}%;" '
        f'alt="cover">'
        f'</div>\n\n'
    )
    return hero + markdown


def _inject_description(markdown, page):
    """
    Inject the GitBook 'description' frontmatter as a styled subtitle
    immediately after the first h1 heading.
    """
    description = (page.meta or {}).get("description")
    if not description:
        return markdown
    description = str(description).strip().strip("'\"")
    subtitle = (
        f'\n<p style="font-size:1.1rem;opacity:0.7;margin-top:-0.5rem;'
        f'margin-bottom:1rem;font-style:italic;">{description}</p>\n'
    )
    return re.sub(r'(^#\s+.+$)', r'\1' + subtitle, markdown, count=1, flags=re.MULTILINE)


# ── GitBook {% file %} blocks ─────────────────────────────────────────────────
# {% file src="path" %}label{% endfile %} → download link with file icon.
_GITBOOK_FILE = re.compile(
    r'\{%-?\s*file\s+src="([^"]+)"\s*-?%\}([\s\S]*?)\{%-?\s*endfile\s*-?%\}',
    re.IGNORECASE
)

def _file_to_link(match):
    src   = re.sub(r'(?:\.\./)*\.gitbook/assets/', '/assets/', match.group(1).strip())
    label = match.group(2).strip() or os.path.basename(src)
    return (
        f'<a href="{src}" target="_blank" rel="noopener noreferrer" '
        f'style="display:inline-flex;align-items:center;'
        f'gap:0.4rem;padding:0.4rem 0.75rem;border:1px solid var(--md-default-fg-color--lighter);'
        f'border-radius:4px;text-decoration:none;font-size:0.85rem;">'
        f'📄 {label}</a>'
    )

# ── GitBook {% content-ref %} blocks ─────────────────────────────────────────
# {% content-ref url="path" %}...{% endcontent-ref %} → internal page card link.
_GITBOOK_CONTENT_REF = re.compile(
    r'\{%-?\s*content-ref\s+url="([^"]+)"\s*-?%\}([\s\S]*?)\{%-?\s*endcontent-ref\s*-?%\}',
    re.IGNORECASE
)

def _content_ref_to_link(match):
    url   = re.sub(r'\.md$', '/', match.group(1).strip())
    # Extract any markdown link label from the inner content, fall back to url.
    inner = match.group(2).strip()
    label_m = re.search(r'\[([^\]]+)\]', inner)
    label = label_m.group(1) if label_m else url
    return (
        f'<a href="{url}" style="display:inline-flex;align-items:center;'
        f'gap:0.4rem;padding:0.4rem 0.75rem;border:1px solid var(--md-default-fg-color--lighter);'
        f'border-radius:4px;text-decoration:none;font-size:0.85rem;">'
        f'📄 {label}</a>'
    )

# ── GitBook hint blocks ───────────────────────────────────────────────────────# Maps GitBook hint styles to Material admonition types.
_HINT_STYLE_MAP = {
    "info":    "info",
    "warning": "warning",
    "danger":  "danger",
    "success": "success",
}
_GITBOOK_HINT = re.compile(
    r'\{%-?\s*hint\s+style="([^"]+)"\s*-?%\}([\s\S]*?)\{%-?\s*endhint\s*-?%\}',
    re.IGNORECASE
)

def _hint_to_admonition(match):
    style   = match.group(1).strip().lower()
    content = match.group(2).strip()
    kind    = _HINT_STYLE_MAP.get(style, "note")
    # Indent content lines for admonition block syntax.
    indented = "\n".join("    " + line if line.strip() else "" for line in content.splitlines())
    return f'!!! {kind}\n{indented}\n'
_GITBOOK_EMBED = re.compile(
    r'\{%-?\s*embed\s+url="([^"]+)"\s*-?%\}',
    re.IGNORECASE
)

# GitBook uses $$...$$ for BOTH inline and block math.
# arithmatex with generic:true expects \(...\) for inline and \[...\] for block.
# Inline: $$...$$ with no newlines inside.
# Block:  $$\n...\n$$ with newlines inside.
_GITBOOK_INLINE_MATH = re.compile(r'\$\$([^\n$]+?)\$\$')
_GITBOOK_BLOCK_MATH  = re.compile(r'\$\$([\s\S]+?)\$\$', re.MULTILINE)


def _embed_to_html(match):
    """Convert a GitBook embed tag to a <video> or <iframe> element."""
    url = match.group(1)
    path = url.split("?")[0]
    if path.endswith((".mp4", ".webm", ".ogg")):
        # Let the browser use the video's natural aspect ratio at full width.
        return (
            f'<video controls autoplay muted playsinline '
            f'style="width:100%;display:block;margin:1rem 0;">'
            f'<source src="{url}" type="video/mp4">'
            f'</video>'
        )
    # For iframes (YouTube, etc.) use a 16:9 responsive wrapper.
    wrapper = 'style="position:relative;width:100%;padding-bottom:56.25%;height:0;overflow:hidden;margin:1rem 0;"'
    inner   = 'style="position:absolute;top:0;left:0;width:100%;height:100%;"'
    return (
        f'<div {wrapper}>'
        f'<iframe src="{url}" {inner} frameborder="0" allowfullscreen loading="lazy"></iframe>'
        f'</div>'
    )


# ── Doxygen tag patterns ──────────────────────────────────────────────────────
_DOXYGEN_TAGS = r'file|brief|date|author|version|copyright|note|warning|attention|bug|todo|deprecated'

_DOXYGEN_TAG_LINE = re.compile(
    r'={10,}\s*(?:\\(?:' + _DOXYGEN_TAGS + r')[^\n]*)+\n?',
    re.IGNORECASE
)
_DOXYGEN_HEADING_TAG = re.compile(
    r'^#+\s*\\(?:' + _DOXYGEN_TAGS + r')\s.*$',
    re.MULTILINE | re.IGNORECASE
)


def on_page_markdown(markdown, page, config, files):
    """
    1. Convert GitBook {% embed url="..." %} to <video> or <iframe> HTML.
    2. Rewrite (../)*/.gitbook/assets/ to absolute /assets/ (raw HTML src
       attributes are not rewritten by MkDocs, so relative paths cannot work).
    3. Strip raw Doxygen tags that doxybook2 emits as literal text.
    """
    if not config.get("gitbook_mode"):
        return markdown
    markdown = _inject_cover(markdown, page)
    markdown = _inject_description(markdown, page)
    markdown = _GITBOOK_FILE.sub(_file_to_link, markdown)
    markdown = _GITBOOK_CONTENT_REF.sub(_content_ref_to_link, markdown)
    markdown = _GITBOOK_HINT.sub(_hint_to_admonition, markdown)
    markdown = _GITBOOK_EMBED.sub(_embed_to_html, markdown)
    markdown = _GITBOOK_INLINE_MATH.sub(lambda m: r'\(' + m.group(1) + r'\)', markdown)
    markdown = _GITBOOK_BLOCK_MATH.sub(lambda m: r'\[' + m.group(1) + r'\]', markdown)
    markdown = re.sub(r'(?:\.\./)*\.gitbook/assets/', '/assets/', markdown)
    markdown = _DOXYGEN_TAG_LINE.sub('', markdown)
    markdown = _DOXYGEN_HEADING_TAG.sub('', markdown)

    return markdown


def on_nav(nav, config, files):
    """
    Strip GitBook SUMMARY.md artifact nav items that point to the root
    README.md but are listed as children of other sections.
    Specifically removes:
      * [README](README.md)          -- top-level artifact
      * [GNUS.AI](README.md)         -- misplaced child artifact
    Both are leaf items whose src_path is exactly 'README.md'.
    """
    if not config.get("gitbook_mode"):
        return nav

    def _filter(items):
        result = []
        for item in items:
            if hasattr(item, 'children') and item.children:
                item.children = _filter(item.children)
                result.append(item)
            else:
                src = getattr(getattr(item, 'file', None), 'src_path', '') or ''
                if src == 'README.md' and getattr(item, 'title', '') in ('README', 'GNUS.AI'):
                    continue
                result.append(item)
        return result

    nav.items = _filter(nav.items)
    return nav


def on_post_build(config):
    """
    Inject a pre-bundle search-index gzip shim into generated HTML so local
    preview still works when the search index is stored as gzipped bytes.
    """
    if not config.get("gitbook_mode"):
        return
    site_dir = config.get('site_dir')
    if not site_dir:
        return

    bundle_tag = '<script src="assets/javascripts/bundle'

    for root, _, files in os.walk(site_dir):
        for name in files:
            if not name.endswith('.html'):
                continue

            path = os.path.join(root, name)
            with open(path, 'r', encoding='utf-8') as f:
                html = f.read()

            if _SEARCH_GZIP_SHIM in html or bundle_tag not in html:
                continue

            html = html.replace(bundle_tag, _SEARCH_GZIP_SHIM + '      ' + bundle_tag, 1)

            with open(path, 'w', encoding='utf-8') as f:
                f.write(html)


