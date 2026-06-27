/**
 * breadcrumbs.js
 *
 * Renders a GitBook-style breadcrumb path by finding the current page's
 * active nav link then walking up the DOM to collect ancestor nav items.
 */
(function () {
  "use strict";

  function buildBreadcrumbs() {
    const existing = document.getElementById("gnus-breadcrumbs");
    if (existing) { existing.remove(); }

    // Find active anchor links only — Material also puts --active on <label>
    // elements for section toggles; we only want the <a> page links.
    const activeLinks = Array.from(
      document.querySelectorAll("a.md-nav__link--active")
    );
    if (activeLinks.length === 0) { return; }

    // Use the last one (deepest in the DOM) as the current page anchor.
    const current = activeLinks[activeLinks.length - 1];

    // Walk up the DOM collecting the direct nav anchor of each ancestor
    // md-nav__item, building the crumb list from root → page.
    const crumbs = [];
    let node = current.closest(".md-nav__item");
    while (node) {
      // The link may be inside a .md-nav__container div, so search one level down.
      const link = node.querySelector(
        ":scope > a.md-nav__link, :scope > .md-nav__container > a.md-nav__link"
      );
      if (link) {
        const label = link.textContent.trim();
        const href  = link.getAttribute("href") || null;
        if (label) { crumbs.unshift({ label, href }); }
      }
      node = node.parentElement
        ? node.parentElement.closest(".md-nav__item")
        : null;
    }

    // Deduplicate consecutive identical labels (section-index dupes).
    const deduped = crumbs.filter(
      (c, i) => i === 0 || c.label !== crumbs[i - 1].label
    );

    if (deduped.length <= 1) { return; }

    // Build the breadcrumb element.
    const nav = document.createElement("nav");
    nav.id = "gnus-breadcrumbs";
    nav.setAttribute("aria-label", "Breadcrumb");
    nav.style.cssText = [
      "font-size:0.75rem",
      "color:var(--md-default-fg-color--light)",
      "margin-bottom:0.75rem",
      "display:flex",
      "flex-wrap:wrap",
      "align-items:center",
      "gap:0.25rem",
    ].join(";");

    deduped.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.textContent = "›";
        sep.setAttribute("aria-hidden", "true");
        sep.style.cssText = "opacity:0.5;";
        nav.appendChild(sep);
      }

      const isLast = i === deduped.length - 1;
      if (crumb.href && !isLast) {
        const a = document.createElement("a");
        a.href = crumb.href;
        a.textContent = crumb.label;
        a.style.cssText = "color:var(--md-default-fg-color--light);text-decoration:none;";
        a.addEventListener("mouseenter", () => { a.style.textDecoration = "underline"; });
        a.addEventListener("mouseleave", () => { a.style.textDecoration = "none"; });
        nav.appendChild(a);
      } else {
        const span = document.createElement("span");
        span.textContent = crumb.label;
        if (isLast) { span.setAttribute("aria-current", "page"); }
        nav.appendChild(span);
      }
    });

    const article = document.querySelector("article.md-content__inner");
    if (!article) { return; }
    const h1 = article.querySelector("h1");
    if (h1) {
      article.insertBefore(nav, h1);
    } else {
      article.prepend(nav);
    }
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(() => {
      requestAnimationFrame(buildBreadcrumbs);
    });
  } else {
    document.addEventListener("DOMContentLoaded", buildBreadcrumbs);
  }

})();
