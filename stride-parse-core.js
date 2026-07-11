/* stride-parse-core.js
 * Shared pure functions. No DOM, no window assumptions beyond a global export.
 * Loaded by both the page (<script>) and the worker (importScripts).
 */
(function (root) {
  "use strict";

  // --- Decoding -----------------------------------------------------------
  // Accepts an ArrayBuffer/Uint8Array and returns UTF-8 text, stripping BOM.
  function decodeCsvText(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // Strip UTF-8 BOM if present.
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      bytes = bytes.subarray(3);
    }
    var text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return repairMojibake(text);
  }

  // --- Mojibake repair ----------------------------------------------------
  // Fixes the common Latin-1/UTF-8 double-encoding seen in STRIDE exports.
  var MOJIBAKE_MAP = {
    "\u00c3\u00b1": "\u00f1", // ñ
    "\u00c3\u0091": "\u00d1", // Ñ
    "\u00c3\u00a9": "\u00e9", // é
    "\u00c3\u00a1": "\u00e1", // á
    "\u00c3\u00ad": "\u00ed", // í
    "\u00c3\u00b3": "\u00f3", // ó
    "\u00c3\u00ba": "\u00fa", // ú
    "\u00c2\u00b0": "\u00b0", // °
    "\u00e2\u0080\u0099": "\u2019", // ’
    "\u00e2\u0080\u009c": "\u201c", // “
    "\u00e2\u0080\u009d": "\u201d", // ”
    "\u00e2\u0080\u0093": "\u2013", // –
    "\u00e2\u0080\u0094": "\u2014"  // —
  };
  function repairMojibake(text) {
    if (text.indexOf("\u00c3") === -1 && text.indexOf("\u00e2") === -1 && text.indexOf("\u00c2") === -1) {
      return text; // fast path: nothing to fix
    }
    var out = text;
    for (var k in MOJIBAKE_MAP) {
      if (MOJIBAKE_MAP.hasOwnProperty(k)) {
        out = out.split(k).join(MOJIBAKE_MAP[k]);
      }
    }
    return out;
  }

  // --- Cell cleaning ------------------------------------------------------
  // canonicalCell: full trim + collapse whitespace + unquote. Use for headers.
  function canonicalCell(value) {
    if (value == null) return "";
    var s = String(value).trim();
    if (s.length > 1 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      s = s.slice(1, -1).split('""').join('"');
    }
    return s.replace(/\s+/g, " ").trim();
  }

  // fastCleanCell: cheap trim only. Use for the many data cells (hot path).
  function fastCleanCell(value) {
    if (value == null) return "";
    var s = String(value);
    var start = 0, end = s.length;
    while (start < end && s.charCodeAt(start) <= 32) start++;
    while (end > start && s.charCodeAt(end - 1) <= 32) end--;
    return start === 0 && end === s.length ? s : s.slice(start, end);
  }

  // --- CSV parsing --------------------------------------------------------
  // RFC-4180-ish parser: handles quotes, escaped quotes, CRLF, embedded commas.
  // Returns an array of plain objects keyed by LOWERCASED header names.
  function parseCsv(text) {
    if (!text) return [];
    var rows = parseRows(text);
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return canonicalCell(h).toLowerCase(); });
    var out = new Array(rows.length - 1);
    for (var r = 1; r < rows.length; r++) {
      var raw = rows[r];
      // Skip fully empty lines.
      if (raw.length === 1 && raw[0] === "") { out[r - 1] = null; continue; }
      var obj = {};
      for (var c = 0; c < header.length; c++) {
        obj[header[c]] = fastCleanCell(raw[c]);
      }
      out[r - 1] = obj;
    }
    return out.filter(Boolean);
  }

  // Tokenizer: text -> array of string arrays.
  function parseRows(text) {
    var rows = [];
    var field = "";
    var row = [];
    var inQuotes = false;
    var i = 0;
    var n = text.length;
    while (i < n) {
      var ch = text.charCodeAt(i);
      if (inQuotes) {
        if (ch === 34) { // "
          if (i + 1 < n && text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += text[i]; i++; continue;
      }
      if (ch === 34) { inQuotes = true; i++; continue; }
      if (ch === 44) { row.push(field); field = ""; i++; continue; } // ,
      if (ch === 13) { i++; continue; } // \r (ignore, CRLF handled by \n)
      if (ch === 10) { row.push(field); rows.push(row); row = []; field = ""; i++; continue; } // \n
      field += text[i]; i++;
    }
    // Flush last field/row.
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  var api = {
    decodeCsvText: decodeCsvText,
    repairMojibake: repairMojibake,
    canonicalCell: canonicalCell,
    fastCleanCell: fastCleanCell,
    parseCsv: parseCsv
  };

  // Export to both window (page) and self (worker).
  root.StrideParseCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);