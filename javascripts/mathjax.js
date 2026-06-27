/**
 * mathjax.js
 *
 * MathJax v3 configuration for use with pymdownx.arithmatex (generic: true).
 * Retypes math after every MkDocs Material SPA navigation.
 */
window.MathJax = {
  tex: {
    inlineMath:  [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true,
  },
  options: {
    ignoreHtmlClass: ".*|",
    processHtmlClass: "arithmatex",
  },
};

// Re-typeset after every SPA page swap so math renders on navigated pages.
if (typeof document$ !== "undefined") {
  document$.subscribe(() => {
    if (typeof MathJax !== "undefined" && MathJax.typesetPromise) {
      MathJax.typesetPromise();
    }
  });
}

