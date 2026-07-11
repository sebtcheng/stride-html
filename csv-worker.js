/* csv-worker.js
 * Parses CSV bytes off the main thread. The page transfers the ArrayBuffer in;
 * the worker returns parsed rows. Keep parsing logic in stride-parse-core.js so
 * page and worker never diverge.
 */
importScripts("./stride-parse-core.js");

self.onmessage = function (e) {
  var msg = e.data || {};
  var id = msg.id;
  var file = msg.file;
  try {
    if (msg.type === "parse") {
      var text = self.StrideParseCore.decodeCsvText(msg.buffer);
      var rows = self.StrideParseCore.parseCsv(text);
      self.postMessage({ id: id, file: file, rows: rows });
    } else if (msg.type === "join") {
      // Optional: join rows to school info by a shared key, off-thread.
      var joined = joinBySchoolId(msg.rows, msg.schoolInfo, msg.key || "school id");
      self.postMessage({ id: id, file: file, rows: joined });
    } else {
      self.postMessage({ id: id, file: file, error: "Unknown message type: " + msg.type });
    }
  } catch (err) {
    self.postMessage({ id: id, file: file, error: String(err && err.message || err) });
  }
};

function joinBySchoolId(rows, schoolInfo, key) {
  var index = Object.create(null);
  for (var i = 0; i < schoolInfo.length; i++) {
    var s = schoolInfo[i];
    if (s && s[key] != null) index[s[key]] = s;
  }
  var out = new Array(rows.length);
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var info = index[row[key]];
    out[r] = info ? Object.assign({}, info, row) : row;
  }
  return out;
}