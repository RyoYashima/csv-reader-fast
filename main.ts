// csv-reader 1.0.0, the house entry, make.fun's own reference program: the harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. An entry keeps this driver and replaces solve.js with a
// faster module whose run(input) returns the same answer for every input. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');
// On one CPU, background TurboFan compiles and parallel scavenger threads only add CPU time for a run this short:
// Maglev alone and a single-threaded scavenge cost less.
setFlagsFromString('--no-opt');
setFlagsFromString('--no-parallel-scavenge');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const RAW_INPUT = Symbol.for('csv-reader-fast.input');
const file = readFileSync(join(INPUT_DIR, 'cases.json'));

/**
 * The cases, read from the file's bytes as JSON.stringify wrote them: [{"id":"...","input":{"text":"...","header":b}},...].
 * Each input is {text, header}, its text decoded from the file on first use, and it carries the text's JSON string
 * bytes (input[RAW_INPUT]: {bytes, start, end}), which run reads as they stand. A file laid out any other way is read
 * with JSON.parse.
 */
const HEADER_KEY = Buffer.from('","header":');
function readCases(bytes: Uint8Array): { id: string; input: unknown }[] | null {
  const n = bytes.length;
  let p = 0;
  const expect = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) if (bytes[p + i] !== s.charCodeAt(i)) return false;
    p += s.length;
    return true;
  };
  /** The end of the JSON string whose first byte (after its opening quote) is at p: its closing quote's index. */
  const stringEnd = (from: number): number => {
    let q = from;
    while (true) {
      q = bytes.indexOf(34, q);
      if (q < 0) return -1;
      let k = q - 1;
      while (bytes[k] === 92) k--;
      if ((q - 1 - k) % 2 === 0) return q;
      q++;
    }
  };
  const decoder = new TextDecoder();
  const out: { id: string; input: unknown }[] = [];
  if (!expect('[')) return null;
  if (expect(']')) return p === n ? out : null;
  while (true) {
    if (!expect('{"id":"')) return null;
    const idEnd = stringEnd(p);
    if (idEnd < 0) return null;
    const id = JSON.parse(decoder.decode(bytes.subarray(p - 1, idEnd + 1))) as string;
    p = idEnd + 1;
    if (!expect(',"input":{"text":"')) return null;
    const start = p;
    // The text's closing quote is the first `","header":` after it whose quote no backslash escapes (inside the
    // string every quote is escaped, so the sequence turns up nowhere else).
    let end = start;
    while (true) {
      end = file.indexOf(HEADER_KEY, end);
      if (end < 0) return null;
      let k = end - 1;
      while (bytes[k] === 92) k--;
      if ((end - 1 - k) % 2 === 0) break;
      end++;
    }
    p = end + 1;
    let header: boolean;
    if (expect(',"header":true}}')) header = true;
    else if (expect(',"header":false}}')) header = false;
    else return null;
    let text: string | undefined;
    const input = {
      header,
      [RAW_INPUT]: { bytes, start, end },
    } as { text: string; header: boolean };
    Object.defineProperty(input, 'text', {
      enumerable: true,
      get: () => (text ??= JSON.parse(decoder.decode(bytes.subarray(start - 1, end + 1))) as string),
    });
    out.push({ id, input });
    if (expect(']')) return p === n ? out : null;
    if (!expect(',')) return null;
  }
}

const cases =
  readCases(file) ?? (JSON.parse(file.toString('utf8')) as { id: string; input: unknown }[]);

// An answer from solve.js carries its own JSON text as UTF-8 bytes (answer[RAW]): those bytes go out as they are; any
// other answer is serialized as JSON.stringify would write it inside the array.
const RAW = Symbol.for('csv-reader-fast.raw');
const encoder = new TextEncoder();
const parts: Uint8Array[] = [encoder.encode('[')];
const comma = encoder.encode(',');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) parts.push(comma);
  const answer = run(cases[i]!.input) as { [RAW]?: Uint8Array } | undefined;
  const raw = answer?.[RAW];
  parts.push(raw ?? encoder.encode(JSON.stringify(answer) ?? 'null'));
}
parts.push(encoder.encode(']'));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), Buffer.concat(parts));
