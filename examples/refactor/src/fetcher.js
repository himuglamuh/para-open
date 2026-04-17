// Legacy callback-style URL fetcher. Refactor me to async/await internally,
// but keep the same `(urls, cb)` callback signature for back-compat.
import http from "node:http";
import https from "node:https";

function fetchOne(url, cb) {
  const lib = url.startsWith("https:") ? https : http;
  const req = lib.get(url, (res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
    });
    res.on("end", () => cb(null, buf));
  });
  req.on("error", (err) => cb(err));
}

export function fetchAndCombine(urls, cb) {
  const results = new Array(urls.length);
  let remaining = urls.length;
  let errored = false;
  if (remaining === 0) {
    return cb(null, results);
  }
  urls.forEach((url, i) => {
    fetchOne(url, (err, body) => {
      if (errored) return;
      if (err) {
        errored = true;
        return cb(err);
      }
      results[i] = body;
      remaining -= 1;
      if (remaining === 0) cb(null, results);
    });
  });
}
