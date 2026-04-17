Build a small `wc`-style command-line tool in this directory, from scratch, in
modern Node.js (>=20) with **no third-party dependencies**.

Requirements:

- Executable entry point at `src/wc.js` (with a Node shebang) that reads either
  the file paths passed as arguments or, if none are given, stdin.
- Default output (matching `wc`): `<lines> <words> <bytes> <filename>`, one
  line per file, plus a `total` line if multiple files were given.
- Flags: `-l` (lines only), `-w` (words only), `-c` (bytes only). When more
  than one flag is passed, print the requested counts in `l w c` order.
- `--help` prints usage and exits 0.
- A test file at `src/wc.test.js` that exercises the core counting logic
  (lines, words, bytes) using `node:test` and `node:assert/strict`.
- A short `README.md` in this directory documenting usage.

Make sure `node src/wc.js --help` and `node --test src/wc.test.js` both work
when you're done.
