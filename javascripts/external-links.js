/**
 * external-links.js
 *
 * Opens external links and PDF links in a new tab after every SPA navigation.
 */
(function () {
  "use strict";

  function tagExternalLinks() {
    // External http/https links.
    document.querySelectorAll("a[href^='http']").forEach((a) => {
      try {
        const url = new URL(a.href, window.location.origin);
        if (url.hostname !== window.location.hostname) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
      } catch (_) {
        // Malformed URLs — leave as-is.
      }
    });

    // PDF links — open in new tab regardless of origin.
    document.querySelectorAll("a[href$='.pdf']").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(tagExternalLinks);
  } else {
    document.addEventListener("DOMContentLoaded", tagExternalLinks);
  }

})();
