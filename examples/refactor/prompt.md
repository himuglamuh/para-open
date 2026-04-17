The code in `src/fetcher.js` uses a nested-callback ("callback hell") style.
Refactor it to use `async/await` with native `fetch` (Node 20+ has it built in)
while preserving the exact same external behavior:

- `fetchAndCombine(urls, cb)` should still take a list of URLs and a Node-style
  callback `cb(err, results)`. Internally it should be implemented with
  `async/await`, but the public signature stays the same so existing callers
  don't break.
- Errors from any URL should short-circuit and call `cb(err)` once.
- Order of `results` must match the order of `urls`.

Write a brief note at the top of the file explaining what changed and why.
Do not introduce any new dependencies.
