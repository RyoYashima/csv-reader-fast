# csv-reader-fast

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/RyoYashima/csv-reader-fast/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/RyoYashima/csv-reader-fast/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` exports `run({text, header})`, whose answer is exactly csv-reader's `{columns, rows, errors}` for every input (BOM, LF/CRLF, stray CRs, quote junk, unterminated quotes, short and long rows). The driver hands each case's text to it as the very bytes of its JSON string in cases.json, and a small WebAssembly scanner (SIMD over runs of plain bytes, built by `wasm/build.mjs` from the same steps as the JavaScript reader beside it) reads them once, writing the answer straight out as its JSON bytes in its own memory; the driver writes those bytes as they are. A plain `{text, header}` works too. `main.ts` is one line, so Node strips almost no TypeScript.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=a9q726ar&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
