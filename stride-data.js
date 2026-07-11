/* stride-data.js
 * Shared STRIDE data layer. Requires stride-parse-core.js and (ideally) a
 * running csv-worker.js. Reads STRIDE_ASSETS + DATA_VERSION from stride-assets.js.
 *
 * Public API:
 *   StrideData.loadDataset(file)       -> Promise<rows>
 *   StrideData.loadSchoolInfo()        -> Promise<rows>   (cached singleton)
 *   StrideData.loadSummary(module)     -> Promise<object> (summary_<module>.json)
 *   StrideData.loadPrepared(module)    -> Promise<rows>   (prepared_<module>.json)
 *   StrideData.join(rows, schoolInfo)  -> Promise<rows>
 *   StrideData.warm(files)             -> void            (idle background preload)
 */
(function (window) {
  "use strict";

  var ASSETS = window.STRIDE_ASSETS || {};
  var VERSION = (window.STRIDE_ASSETS && window.STRIDE_ASSETS.DATA_VERSION) || "v0";
  var SCHOOL_INFO_FILE = "insighted_school_info.csv";

  var PARSED_CACHE = "stride-parsed-v1";
  var RAW_CACHE = "stride-csv-preload-v1";
  var DB_NAME = "stride-data";
  var DB_STORE = "datasets";

  var memory = Object.create(null); // in-tab memo: file -> rows
  var inflight = Object.create(null); // file -> Promise (dedupe concurrent loads)
  var schoolInfoPromise = null;

  // --- URL resolution -----------------------------------------------------
  function urlFor(file) {
    if (ASSETS.urls && ASSETS.urls[file]) return ASSETS.urls[file];
    return "./" + file;
  }

  // --- Worker (lazy singleton) -------------------------------------------
  var _worker = null;
  var _pending = Object.create(null);
  function worker() {
    if (_worker || typeof Worker === "undefined") return _worker;
    try {
      _worker = new Worker("./csv-worker.js");
      _worker.onmessage = function (e) {
        var d = e.data || {};
        var p = _pending[d.id];
        if (!p) return;
        delete _pending[d.id];
        d.error ? p.reject(new Error(d.error)) : p.resolve(d.rows);
      };
      _worker.onerror = function () { _worker = null; }; // fall back to sync
    } catch (err) { _worker = null; }
    return _worker;
  }

  function parse(file, buffer) {
    var w = worker();
    if (!w) {
      // Synchronous fallback on the main thread.
      var text = window.StrideParseCore.decodeCsvText(buffer);
      return Promise.resolve(window.StrideParseCore.parseCsv(text));
    }
    return new Promise(function (resolve, reject) {
      var id = file + ":" + Date.now() + ":" + Math.random();
      _pending[id] = { resolve: resolve, reject: reject };
      w.postMessage({ type: "parse", id: id, file: file, buffer: buffer }, [buffer]);
    });
  }

  // --- IndexedDB ----------------------------------------------------------
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) return reject(new Error("no-idb"));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "fileName" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(file) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(file);
        tx.onsuccess = function () {
          var rec = tx.result;
          resolve(rec && rec.version === VERSION ? rec.rows : null);
        };
        tx.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }
  function idbPut(file, rows) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE)
          .put({ fileName: file, version: VERSION, parsedAt: Date.now(), rows: rows });
        tx.onsuccess = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  // --- Cache API ----------------------------------------------------------
  function cacheKey(file) { return urlFor(file) + "?v=" + VERSION; }

  function parsedCacheGet(file) {
    if (!("caches" in window)) return Promise.resolve(null);
    return caches.open(PARSED_CACHE).then(function (c) {
      return c.match(cacheKey(file)).then(function (res) { return res ? res.json() : null; });
    }).catch(function () { return null; });
  }
  function parsedCachePut(file, rows) {
    if (!("caches" in window)) return Promise.resolve();
    return caches.open(PARSED_CACHE).then(function (c) {
      return c.put(cacheKey(file), new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } }));
    }).catch(function () {});
  }

  function rawBytes(file) {
    // Prefer the raw cache (populated by the service worker); fall back to network.
    var key = urlFor(file);
    var fromCache = ("caches" in window)
      ? caches.open(RAW_CACHE).then(function (c) { return c.match(key); }).catch(function () { return null; })
      : Promise.resolve(null);
    return fromCache.then(function (res) {
      if (res) return res.arrayBuffer();
      return fetch(key).then(function (r) {
        if (!r.ok) throw new Error("fetch " + file + " -> " + r.status);
        return r.arrayBuffer();
      });
    });
  }

  // --- Main loader --------------------------------------------------------
  function loadDataset(file) {
    if (memory[file]) return Promise.resolve(memory[file]);
    if (inflight[file]) return inflight[file];

    var p = idbGet(file)
      .then(function (rows) {
        if (rows) return rows;                       // 1) IndexedDB (typed, versioned)
        return parsedCacheGet(file).then(function (cached) {
          if (cached) { idbPut(file, cached); return cached; } // 2) parsed Cache API
          return rawBytes(file)                      // 3) raw cache / SW / network
            .then(function (buf) { return parse(file, buf); })
            .then(function (parsed) {                 // 4) parse in worker, then persist
              parsedCachePut(file, parsed);
              idbPut(file, parsed);
              return parsed;
            });
        });
      })
      .then(function (rows) { memory[file] = rows; delete inflight[file]; return rows; })
      .catch(function (err) { delete inflight[file]; throw err; });

    inflight[file] = p;
    return p;
  }

  function loadSchoolInfo() {
    if (!schoolInfoPromise) schoolInfoPromise = loadDataset(SCHOOL_INFO_FILE);
    return schoolInfoPromise;
  }

  // --- Prepared / summary JSON (Phase 3) ---------------------------------
  function loadJson(name) {
    return fetch(urlFor(name) + "?v=" + VERSION).then(function (r) {
      if (!r.ok) throw new Error("fetch " + name + " -> " + r.status);
      return r.json();
    });
  }
  function loadSummary(mod) { return loadJson("summary_" + mod + ".json"); }
  function loadPrepared(mod) { return loadJson("prepared_" + mod + ".json"); }

  // --- Join (delegates to worker when available) -------------------------
  function join(rows, schoolInfo, key) {
    key = key || "school id";
    var w = worker();
    if (!w) {
      var index = Object.create(null);
      for (var i = 0; i < schoolInfo.length; i++) if (schoolInfo[i][key] != null) index[schoolInfo[i][key]] = schoolInfo[i];
      return Promise.resolve(rows.map(function (row) {
        var info = index[row[key]];
        return info ? Object.assign({}, info, row) : row;
      }));
    }
    return new Promise(function (resolve, reject) {
      var id = "join:" + Date.now() + ":" + Math.random();
      _pending[id] = { resolve: resolve, reject: reject };
      w.postMessage({ type: "join", id: id, rows: rows, schoolInfo: schoolInfo, key: key });
    });
  }

  // --- Idle background warming -------------------------------------------
  function warm(files) {
    var queue = (files || []).slice();
    function next() {
      if (!queue.length) return;
      loadDataset(queue.shift()).catch(function () {}).then(function () { scheduleIdle(next); });
    }
    scheduleIdle(next);
  }
  function scheduleIdle(fn) {
    if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 5000 });
    else setTimeout(fn, 1500);
  }

  window.StrideData = {
    loadDataset: loadDataset,
    loadSchoolInfo: loadSchoolInfo,
    loadSummary: loadSummary,
    loadPrepared: loadPrepared,
    join: join,
    warm: warm,
    scheduleIdle: scheduleIdle,
    VERSION: VERSION
  };
})(window);