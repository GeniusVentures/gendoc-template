"use strict";
/**
 * Synchronous pre-Material script loader.
 *
 * To add a new injector, add its path to the array below — no template
 * changes needed.
 */
(() => {
    const base = new URL(".", document.currentScript.src);
    function loadSync(name) {
        const src = new URL(name, base).href;
        document.write(`<script src="${src}"><\/script>`);
    }
    const injectors = [
        "../fetch-gzip.js",
        "search-fuzzy.js",
    ];
    for (const name of injectors)
        loadSync(name);
})();
