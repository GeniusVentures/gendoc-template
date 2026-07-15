/**
 * fetch-gzip.js — shared fetch/XHR/Worker wrapper for .json → .json.gz with
 * transparent client-side gzip decompression.
 *
 * Intercepts three request paths:
 *
 *   1. window.fetch          — main-thread fetch()
 *   2. XMLHttpRequest        — Material loads some JSON via XHR (blob)
 *   3. Worker                — Material's search runs in a Web Worker and
 *                              fetches search_index.json from inside the
 *                              worker scope, where main-thread overrides do
 *                              not apply.  The Worker constructor is wrapped
 *                              so every classic worker is bootstrapped from a
 *                              Blob that installs the same fetch interceptor
 *                              (installGzipFetch is self-contained and
 *                              serialized via toString, with decompressGzip
 *                              prepended), then importScripts the original
 *                              worker script.
 *
 * Any request whose URL path ends with ".json" is rewritten to ".json.gz".
 * Gzip-compressed responses are decompressed client-side before the caller
 * sees them.  There is no fallback to the raw .json — built sites only ship
 * .json.gz (search_index.json can exceed 25 MB uncompressed).
 *
 * Injected at build-time by load-gendoc-config.py when
 * deploy.cloudflare.gzip_json is true.  When the toggle is off the
 * wrapper is never loaded — zero overhead, no interception.
 */
(function () {
  /**
   * Decompress a gzip-compressed ArrayBuffer.
   *
   * Concurrent reader + writer — the reader starts pulling before the writer
   * pushes, so backpressure never stalls the DecompressionStream.
   */
  function decompressGzip(buf) {
    var ds = new DecompressionStream("gzip");
    var reader = ds.readable.getReader();
    var writer = ds.writable.getWriter();

    var chunks = [];
    var readDone = reader.read().then(function pump(result) {
      if (result.done) {
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
        var merged = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < chunks.length; j++) {
          merged.set(chunks[j], off);
          off += chunks[j].byteLength;
        }
        return merged.buffer;
      }
      chunks.push(result.value);
      return reader.read().then(pump);
    });

    return writer.write(new Uint8Array(buf)).then(function () {
      return writer.close();
    }).then(function () {
      return readDone;
    });
  }

  /**
   * Install the .json → .json.gz fetch interceptor on a global scope
   * (window or a worker's self).
   *
   * MUST stay self-contained — it is serialized with toString() and
   * executed inside worker scopes, so it must not reference outer
   * variables.  decompressGzip is prepended in the worker bootstrap.
   */
  function installGzipFetch(scope) {
    var _fetch = scope.fetch.bind(scope);

    function isJsonUrl(url) {
      var path = String(url).split("?")[0].split("#")[0];
      return path.endsWith(".json");
    }

    scope.fetch = function (url, options) {
      if (!isJsonUrl(url)) { return _fetch(url, options); }

      var gzUrl = String(url) + ".gz";

      function tryDecompress(res) {
        if (!res.ok) { return Promise.reject(res); }
        return res.arrayBuffer().then(function (body) {
          if (body.byteLength === 0) {
            return _fetch(gzUrl, { cache: "reload" }).then(function (fresh) {
              if (!fresh.ok) { return Promise.reject(fresh); }
              return fresh.arrayBuffer();
            });
          }
          return body;
        });
      }

      return _fetch(gzUrl, options).then(tryDecompress).then(function (body) {
        var view = new Uint8Array(body);
        if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
          return decompressGzip(body).then(function (dec) {
            return new Response(dec, {
              status: 200, headers: { "Content-Type": "application/json" },
            });
          });
        }
        return new Response(body, {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      });
    };
  }

  // ── Main-thread fetch ────────────────────────────────────────────────────
  installGzipFetch(window);

  // ── Worker interception ──────────────────────────────────────────────────
  // Wrap the Worker constructor: classic workers are started from a Blob
  // that installs the gzip fetch interceptor in the worker scope, then
  // importScripts the original script.  decompressGzip is serialized alongside
  // installGzipFetch so the worker closure has it (installGzipFetch itself
  // cannot reference outer scope).
  var _Worker = window.Worker;

  window.Worker = function (scriptURL, options) {
    if (options && options.type === "module") {
      return new _Worker(scriptURL, options);
    }
    try {
      var abs = new URL(String(scriptURL), document.baseURI).href;
      var bootstrap =
        decompressGzip.toString() + ";\n" +
        "(" + installGzipFetch.toString() + ")(self);\n" +
        "importScripts(" + JSON.stringify(abs) + ");";
      var blobUrl = URL.createObjectURL(
        new Blob([bootstrap], { type: "text/javascript" })
      );
      return new _Worker(blobUrl, options);
    } catch (e) {
      return new _Worker(scriptURL, options);
    }
  };
  window.Worker.prototype = _Worker.prototype;

  // ── XMLHttpRequest interception ────────────────────────────────────────
  // Material creates XHR → open → responseType="blob" → addEventListener
  // ("load", fn) → send().  We override:
  //
  //   open()  — rewrite .json → .json.gz, set _fgzActive flag
  //   addEventListener() — when _fgzActive and type="load", wrap fn so
  //        the response Blob is decompressed before fn sees it
  //
  // Call order is: open → addEventListener → send, so _fgzActive is
  // already set by the time addEventListener runs.
  function isJsonUrl(url) {
    var path = String(url).split("?")[0].split("#")[0];
    return path.endsWith(".json");
  }

  var _open = XMLHttpRequest.prototype.open;
  var _ael  = XMLHttpRequest.prototype.addEventListener;

  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    if (typeof args[1] === "string" && isJsonUrl(args[1])) {
      args[1] = args[1] + ".gz";
      this._fgzActive = true;
    }
    return _open.apply(this, args);
  };

  XMLHttpRequest.prototype.addEventListener = function (type, fn, opts) {
    if (type === "load" && this._fgzActive) {
      var xhr = this;
      return _ael.call(xhr, type, function () {
        var blob = xhr.response;
        if (!blob || typeof blob.arrayBuffer !== "function") {
          fn.call(xhr, new Event("load"));
          return;
        }
        blob.arrayBuffer().then(function (ab) {
          var view = new Uint8Array(ab);
          if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
            return decompressGzip(ab).then(function (dec) {
              var jsonBlob = new Blob([dec], { type: "application/json" });
              Object.defineProperty(xhr, "response", {
                get: function () { return jsonBlob; },
                configurable: true,
              });
              fn.call(xhr, new Event("load"));
            });
          }
          fn.call(xhr, new Event("load"));
        });
      }, opts);
    }
    return _ael.apply(this, arguments);
  };
})();
