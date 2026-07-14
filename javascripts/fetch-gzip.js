/**
 * fetch-gzip.js — shared fetch wrapper for .json → .json.gz transparent decompression.
 *
 * Intercepts all window.fetch calls on the main thread.  Any request whose
 * URL path ends with ".json" is rewritten to ".json.gz".  Gzip-compressed
 * responses are decompressed client-side before the caller sees them.
 *
 * Injected at build-time by load-gendoc-config.py when
 * deploy.cloudflare.gzip_json is true.  When the toggle is off the
 * wrapper is never loaded — zero overhead, no interception.
 *
 * There is NO .json fallback.  If the .json.gz fetch fails the error
 * propagates naturally (same as a missing .json would).
 */
(function () {
  var _fetch = window.fetch.bind(window);

  /**
   * Return true when *path* ends with ".json".
   * Query strings and fragments are stripped first so
   *   /ask-config.json?cache=no  →  true
   *   /search_index.json.gz      →  false
   */
  function isJsonUrl(url) {
    var path = String(url).split("?")[0].split("#")[0];
    return path.endsWith(".json");
  }

  window.fetch = function (url, options) {
    // Pass-through for non-JSON requests (images, CSS, HTML, etc.).
    if (!isJsonUrl(url)) {
      return _fetch(url, options);
    }

    // Rewrite .json → .json.gz — no fallback, this is the canonical URL.
    var gzUrl = String(url) + ".gz";

    return _fetch(gzUrl, options).then(function (res) {
      // Not OK?  Propagate the error — callers handle rejected promises
      // or non-2xx status the same as they would for a missing .json.
      if (!res.ok) {
        return Promise.reject(res);
      }

      return res.arrayBuffer().then(function (body) {
        var view = new Uint8Array(body);

        // Gzip magic-byte detection (0x1f 0x8b).
        // When the server serves the file as binary (no Content-Encoding)
        // the raw bytes are still compressed — decompress them here.
        if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
          var ds = new DecompressionStream("gzip");
          var writer = ds.writable.getWriter();
          return writer.write(body).then(function () {
            writer.close();
            return new Response(ds.readable).arrayBuffer();
          }).then(function (decompressed) {
            return new Response(decompressed, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          });
        }

        // Server already sent Content-Encoding: gzip — body arrived
        // decompressed.  Return as-is with the correct content type.
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    });
  };
})();
