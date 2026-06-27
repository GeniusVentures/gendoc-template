/**
 * mermaid.js
 *
 * Initialises Mermaid with a theme matching the current Material color scheme.
 * Re-runs after every SPA navigation and on light/dark mode toggle.
 */
(function () {
  "use strict";

  function getMermaidTheme() {
    return document.body.getAttribute("data-md-color-scheme") === "slate"
      ? "dark"
      : "default";
  }

  function initMermaid() {
    if (typeof mermaid === "undefined") { return; }
    mermaid.initialize({
      startOnLoad: false,
      theme: getMermaidTheme(),
    });
    mermaid.run({ querySelector: ".mermaid" });
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(initMermaid);
  } else {
    document.addEventListener("DOMContentLoaded", initMermaid);
  }

  // Re-render when the user toggles light/dark mode.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === "data-md-color-scheme") {
        document.querySelectorAll(".mermaid[data-processed]").forEach((el) => {
          el.removeAttribute("data-processed");
        });
        initMermaid();
        break;
      }
    }
  });
  observer.observe(document.body, { attributes: true });

})();
