// A fast drop-in for csv-reader 1.0.0's readCsv: the same answer {columns, rows, errors} for every input {text, header}.
//
// The text is encoded to UTF-8 once and read left to right byte by byte (every delimiter is ASCII, so no UTF-8
// sequence is ever split), and the answer is written straight out as its JSON text, byte for byte what
// JSON.stringify(readCsv(input)) writes, with no string or array made per field. The answer run returns is a plain
// object whose columns, rows and errors read that JSON back on first use, so it is the same value to any reader;
// main.ts writes the bytes (answer[RAW]) to /output/answers.json as they are, without serializing it again.
// A text that is not well-formed UTF-16 (a lone surrogate) is read by the plain reader below instead, value by value.

export const RAW = Symbol.for('csv-reader-fast.raw');

// Byte classes. Unquoted: 0 kept as is, 1 comma, 2 LF, 3 CR, 4 kept but escaped in JSON.
// Quoted content: 0 kept as is, 2 LF, 3 CR, 4 escaped, 5 quote.
const U = new Uint8Array(256);
const Q = new Uint8Array(256);
for (let c = 0; c < 32; c++) U[c] = Q[c] = 4;
U[34] = 4;
U[92] = Q[92] = 4;
U[44] = 1;
U[10] = Q[10] = 2;
U[13] = Q[13] = 3;
Q[34] = 5;

const HEX = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ascii = (s) => encoder.encode(s);

const COLUMNS_OPEN = ascii('{"columns":');
const ROWS_OPEN = ascii(',"rows":[');
const ERRORS_OPEN = ascii('],"errors":[');
const CLOSE = ascii(']}');
const NULL = ascii('null');
const EMPTY = ascii('[]');
const E_STRAY = ascii('{"code":"stray_cr","line":');
const E_UNTERM = ascii('{"code":"unterminated_quote","line":');
const E_JUNK = ascii('{"code":"quote_junk","line":');
const E_SHORT = ascii('{"code":"short_row","line":');
const E_LONG = ascii('{"code":"long_row","line":');
const K_ROW = ascii(',"row":');
const K_FIELDS = ascii(',"fields":');
const K_EXTRA = ascii(',"extra":[');

// Scratch buffers, reused from one call to the next (only their bytes; nothing of a call's answer is kept in them).
let SRC = new Uint8Array(1 << 16);
let OUT = new Uint8Array(1 << 16);
let ERR = new Uint8Array(1 << 16);
let eo = 0;

/** Room for `more` bytes past `at` in OUT, keeping its first `at`. */
function growOut(at, more) {
  let cap = OUT.length * 2;
  while (cap < at + more) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(OUT.subarray(0, at));
  OUT = next;
  return next;
}

function errRoom(more) {
  if (eo + more <= ERR.length) return;
  let cap = ERR.length * 2;
  while (cap < eo + more) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(ERR.subarray(0, eo));
  ERR = next;
}

function errBytes(b) {
  ERR.set(b, eo);
  eo += b.length;
}

function errInt(v) {
  if (v === 0) {
    ERR[eo++] = 48;
    return;
  }
  let d = 1;
  while (d * 10 <= v) d *= 10;
  while (d > 0) {
    const q = Math.floor(v / d);
    ERR[eo++] = 48 + q;
    v -= q * d;
    d = Math.floor(d / 10);
  }
}

/** One error {code, line, row} (row -1: the header, null); its closing brace is left to the caller. */
function errOpen(code, line, row) {
  errRoom(160);
  if (eo > 0) ERR[eo++] = 44;
  errBytes(code);
  errInt(line);
  errBytes(K_ROW);
  if (row < 0) errBytes(NULL);
  else errInt(row);
}

/** Byte b (a quote, a backslash or a control character) as JSON writes it inside a string, at OUT[o]. */
function escapeAt(out, o, b) {
  out[o++] = 92;
  if (b === 34) out[o++] = 34;
  else if (b === 92) out[o++] = 92;
  else if (b === 10) out[o++] = 110;
  else if (b === 13) out[o++] = 114;
  else if (b === 9) out[o++] = 116;
  else if (b === 8) out[o++] = 98;
  else if (b === 12) out[o++] = 102;
  else {
    out[o++] = 117;
    out[o++] = 48;
    out[o++] = 48;
    out[o++] = HEX[b >> 4];
    out[o++] = HEX[b & 15];
  }
  return o;
}

/** The answer for bytes {"columns":...}: its JSON value, read on first use, and the bytes themselves. */
function answerOf(bytes) {
  let value;
  const read = () => (value ??= JSON.parse(decoder.decode(bytes)));
  const answer = {};
  Object.defineProperty(answer, 'columns', { enumerable: true, get: () => read().columns });
  Object.defineProperty(answer, 'rows', { enumerable: true, get: () => read().rows });
  Object.defineProperty(answer, 'errors', { enumerable: true, get: () => read().errors });
  Object.defineProperty(answer, RAW, { value: bytes });
  return answer;
}

export function run(input) {
  const raw = input[RAW_INPUT];
  if (raw !== undefined) {
    // A plain Uint8Array view (a Buffer is one of another shape), so the compiled reader sees one kind of array.
    const b = raw.bytes;
    const bytes = Object.getPrototypeOf(b) === Uint8Array.prototype ? b : new Uint8Array(b.buffer, b.byteOffset, b.length);
    const answer = runEscaped(bytes, raw.start, raw.end, input.header === true);
    if (answer !== null) return answer;
  }
  const text = String(input.text);
  const header = input.header === true;
  if (!text.isWellFormed()) return runPlain(text, header);

  if (SRC.length < text.length * 3) SRC = new Uint8Array(text.length * 3 + 1024);
  const src = SRC;
  const n = encoder.encodeInto(text, src).written;
  // Every input byte writes at most 6 output bytes (a control character as \u00XX); padding is checked as it goes.
  let out = OUT.length < n * 6 + 1024 ? growOut(0, n * 6 + 1024) : OUT;
  let o = 0;
  eo = 0;

  let p = text.charCodeAt(0) === 0xfeff ? 3 : 0;
  let line = 1;
  let rows = 0;
  let width = -1;
  let columns = null;
  let wantHeader = header;

  while (true) {
    // Line breaks before a record are no record.
    while (p < n) {
      const b = src[p];
      if (b === 10) {
        p++;
        line++;
      } else if (b === 13 && p + 1 < n && src[p + 1] === 10) {
        p += 2;
        line++;
      } else break;
    }
    if (p >= n) break;

    const recordLine = line;
    const recordRow = wantHeader ? -1 : rows;
    const rowStart = o;
    if (rows > 0) out[o++] = 44;
    out[o++] = 91;
    let fields = 0;
    let cut = -1;
    let lastQuoted = false;
    let lastStart = 0;
    let ended = 0;

    do {
      if (fields > 0) {
        if (fields === width) cut = o;
        out[o++] = 44;
      }
      out[o++] = 34;
      lastStart = o;
      let junk = false;
      let unquoted = true;
      lastQuoted = p < n && src[p] === 34;
      if (lastQuoted) {
        const open = p;
        let q = open + 1;
        while (true) {
          q = src.indexOf(34, q);
          if (q < 0 || q >= n) {
            q = -1;
            break;
          }
          if (q + 1 < n && src[q + 1] === 34) {
            q += 2;
            continue;
          }
          break;
        }
        if (q < 0) {
          // Never closes: a literal quote, and the text after it read again as unquoted.
          errOpen(E_UNTERM, recordLine, recordRow);
          ERR[eo++] = 125;
          out[o++] = 92;
          out[o++] = 34;
          p = open + 1;
        } else {
          let i = open + 1;
          while (i < q) {
            const b = src[i];
            const k = Q[b];
            if (k === 0) {
              out[o++] = b;
              i++;
            } else if (k === 5) {
              out[o++] = 92;
              out[o++] = 34;
              i += 2;
            } else if (k === 2) {
              out[o++] = 92;
              out[o++] = 110;
              line++;
              i++;
            } else if (k === 3) {
              out[o++] = 92;
              out[o++] = 110;
              line++;
              i += src[i + 1] === 10 ? 2 : 1;
            } else {
              o = escapeAt(out, o, b);
              i++;
            }
          }
          p = q + 1;
          if (p >= n) {
            ended = 2;
            unquoted = false;
          } else {
            const b = src[p];
            if (b === 44) {
              p++;
              ended = 0;
              unquoted = false;
            } else if (b === 10) {
              p++;
              line++;
              ended = 1;
              unquoted = false;
            } else if (b === 13 && p + 1 < n && src[p + 1] === 10) {
              p += 2;
              line++;
              ended = 1;
              unquoted = false;
            } else junk = true;
          }
        }
      }
      if (unquoted) {
        const keptFrom = o;
        while (true) {
          if (p >= n) {
            ended = 2;
            break;
          }
          const b = src[p];
          const k = U[b];
          if (k === 0) {
            out[o++] = b;
            p++;
          } else if (k === 1) {
            p++;
            ended = 0;
            break;
          } else if (k === 2) {
            p++;
            line++;
            ended = 1;
            break;
          } else if (k === 3) {
            if (p + 1 < n && src[p + 1] === 10) {
              p += 2;
              line++;
              ended = 1;
              break;
            }
            errOpen(E_STRAY, recordLine, recordRow);
            ERR[eo++] = 125;
            p++;
          } else {
            o = escapeAt(out, o, b);
            p++;
          }
        }
        if (junk && o > keptFrom) {
          errOpen(E_JUNK, recordLine, recordRow);
          ERR[eo++] = 125;
        }
      }
      out[o++] = 34;
      fields++;
    } while (ended === 0);

    if (fields === 1 && !lastQuoted && o === lastStart + 1) {
      // One empty unquoted field: no record.
      o = rowStart;
      continue;
    }
    if (width < 0) width = fields;
    if (wantHeader) {
      // "[" and the fields, then "]".
      columns = new Uint8Array(o - rowStart + 1);
      columns.set(out.subarray(rowStart, o));
      columns[o - rowStart] = 93;
      o = rowStart;
      wantHeader = false;
      continue;
    }
    if (fields < width) {
      errOpen(E_SHORT, recordLine, recordRow);
      errBytes(K_FIELDS);
      errInt(fields);
      ERR[eo++] = 125;
      const pad = (width - fields) * 3;
      if (o + pad + 1024 > out.length) out = growOut(o, pad + 1024 + n * 6);
      for (let k = fields; k < width; k++) {
        out[o++] = 44;
        out[o++] = 34;
        out[o++] = 34;
      }
    } else if (fields > width) {
      const extra = out.subarray(cut + 1, o);
      errOpen(E_LONG, recordLine, recordRow);
      errBytes(K_EXTRA);
      errRoom(extra.length + 8);
      errBytes(extra);
      ERR[eo++] = 93;
      ERR[eo++] = 125;
      o = cut;
    }
    out[o++] = 93;
    rows++;
  }

  return assemble(out, o, header, columns);
}

// The text as its own JSON string's bytes: input[RAW_INPUT] is {bytes, start, end}, the UTF-8 bytes between the quotes
// of the text's JSON string in /input/cases.json (main.ts hands them on as they are, so the text is never decoded).
// There a quote is \", a backslash \\, LF \n and CR \r; every other character is itself or an escape that stands for
// no comma, quote or line break, and the answer's JSON writes each of those the same way, so they are copied as they
// stand. A \u escape for a comma, quote, backslash, LF or CR (which JSON.stringify never writes) sends the text to
// the decoded reader instead.
export const RAW_INPUT = Symbol.for('csv-reader-fast.input');

// Escaped bytes, outside quotes: 0 kept as is, 1 comma, 6 backslash (an escape).
const UE = new Uint8Array(256);
UE[44] = 1;
UE[92] = 6;

function hexOf(b) {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}

/** Whether the \u escape whose u is at src[at] stands for a comma, quote, backslash, LF or CR. */
function oddEscape(src, at) {
  const v = (hexOf(src[at + 1]) << 12) | (hexOf(src[at + 2]) << 8) | (hexOf(src[at + 3]) << 4) | hexOf(src[at + 4]);
  return v === 10 || v === 13 || v === 34 || v === 44 || v === 92;
}

/** The answer read from the text's JSON string bytes, or null when an escape there needs the decoded reader. */
/** A copy of buf's first `at` bytes in a buffer with room for `more` past them. */
function grown(buf, at, more) {
  let cap = buf.length * 2;
  while (cap < at + more) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(buf.subarray(0, at));
  return next;
}

function runEscaped(src, start, end, header) {
  const n = end;
  // The answer is written in place, in a buffer of its own: {"columns":, the header record, ,"rows":[, the rows, and
  // the errors after them. Every byte of the text writes at most 3 (an empty field between commas); padding is checked.
  let out = new Uint8Array((end - start) * 3 + 4096);
  let o = 0;
  eo = 0;
  out.set(COLUMNS_OPEN, o);
  o += COLUMNS_OPEN.length;
  if (!header) {
    out.set(NULL, o);
    o += NULL.length;
    out.set(ROWS_OPEN, o);
    o += ROWS_OPEN.length;
  }

  let p = src[start] === 0xef && src[start + 1] === 0xbb && src[start + 2] === 0xbf ? start + 3 : start;
  let line = 1;
  let rows = 0;
  let width = -1;
  let wantHeader = header;

  while (true) {
    while (p + 1 < n && src[p] === 92) {
      const c = src[p + 1];
      if (c === 110) {
        p += 2;
        line++;
      } else if (c === 114 && p + 3 < n && src[p + 2] === 92 && src[p + 3] === 110) {
        p += 4;
        line++;
      } else break;
    }
    if (p >= n) break;

    const recordLine = line;
    const recordRow = wantHeader ? -1 : rows;
    const rowStart = o;
    if (o + 1024 > out.length) out = grown(out, o, (n - p) * 3 + 1024);
    if (rows > 0) out[o++] = 44;
    out[o++] = 91;
    let fields = 0;
    let cut = -1;
    let lastQuoted = false;
    let lastStart = 0;
    let ended = 0;

    do {
      if (fields > 0) {
        if (fields === width) cut = o;
        out[o++] = 44;
      }
      out[o++] = 34;
      lastStart = o;
      let junk = false;
      let unquoted = true;
      lastQuoted = p + 1 < n && src[p] === 92 && src[p + 1] === 34;
      if (lastQuoted) {
        const open = p;
        // Every raw quote byte inside the string is a CSV quote (\"); one followed by \" is doubled.
        let q = open + 2;
        while (true) {
          q = src.indexOf(34, q);
          if (q < 0 || q >= n) {
            q = -1;
            break;
          }
          if (q + 2 < n && src[q + 1] === 92 && src[q + 2] === 34) {
            q += 3;
            continue;
          }
          break;
        }
        if (q < 0) {
          errOpen(E_UNTERM, recordLine, recordRow);
          ERR[eo++] = 125;
          out[o++] = 92;
          out[o++] = 34;
          p = open + 2;
        } else {
          const stop = q - 1;
          let i = open + 2;
          while (i < stop) {
            const b = src[i];
            if (b !== 92) {
              out[o++] = b;
              i++;
              continue;
            }
            const c = src[i + 1];
            if (c === 34) {
              // \"\" : one quote
              out[o++] = 92;
              out[o++] = 34;
              i += 4;
            } else if (c === 110) {
              out[o++] = 92;
              out[o++] = 110;
              line++;
              i += 2;
            } else if (c === 114) {
              out[o++] = 92;
              out[o++] = 110;
              line++;
              i += i + 3 < stop && src[i + 2] === 92 && src[i + 3] === 110 ? 4 : 2;
            } else if (c === 117) {
              if (oddEscape(src, i + 1)) return null;
              out[o++] = 92;
              out[o++] = 117;
              out[o++] = src[i + 2];
              out[o++] = src[i + 3];
              out[o++] = src[i + 4];
              out[o++] = src[i + 5];
              i += 6;
            } else {
              out[o++] = 92;
              out[o++] = c;
              i += 2;
            }
          }
          p = q + 1;
          if (p >= n) {
            ended = 2;
            unquoted = false;
          } else {
            const b = src[p];
            if (b === 44) {
              p++;
              ended = 0;
              unquoted = false;
            } else if (b === 92 && src[p + 1] === 110) {
              p += 2;
              line++;
              ended = 1;
              unquoted = false;
            } else if (b === 92 && src[p + 1] === 114 && p + 3 < n && src[p + 2] === 92 && src[p + 3] === 110) {
              p += 4;
              line++;
              ended = 1;
              unquoted = false;
            } else junk = true;
          }
        }
      }
      if (unquoted) {
        const keptFrom = o;
        while (true) {
          if (p >= n) {
            ended = 2;
            break;
          }
          const b = src[p];
          const k = UE[b];
          if (k === 0) {
            out[o++] = b;
            p++;
            continue;
          }
          if (k === 1) {
            p++;
            ended = 0;
            break;
          }
          const c = src[p + 1];
          if (c === 110) {
            p += 2;
            line++;
            ended = 1;
            break;
          }
          if (c === 114) {
            if (p + 3 < n && src[p + 2] === 92 && src[p + 3] === 110) {
              p += 4;
              line++;
              ended = 1;
              break;
            }
            errOpen(E_STRAY, recordLine, recordRow);
            ERR[eo++] = 125;
            p += 2;
          } else if (c === 117) {
            if (oddEscape(src, p + 1)) return null;
            out[o++] = 92;
            out[o++] = 117;
            out[o++] = src[p + 2];
            out[o++] = src[p + 3];
            out[o++] = src[p + 4];
            out[o++] = src[p + 5];
            p += 6;
          } else {
            out[o++] = 92;
            out[o++] = c;
            p += 2;
          }
        }
        if (junk && o > keptFrom) {
          errOpen(E_JUNK, recordLine, recordRow);
          ERR[eo++] = 125;
        }
      }
      out[o++] = 34;
      fields++;
    } while (ended === 0);

    if (fields === 1 && !lastQuoted && o === lastStart + 1) {
      o = rowStart;
      continue;
    }
    if (width < 0) width = fields;
    if (wantHeader) {
      out[o++] = 93;
      out.set(ROWS_OPEN, o);
      o += ROWS_OPEN.length;
      wantHeader = false;
      continue;
    }
    if (fields < width) {
      errOpen(E_SHORT, recordLine, recordRow);
      errBytes(K_FIELDS);
      errInt(fields);
      ERR[eo++] = 125;
      const pad = (width - fields) * 3;
      if (o + pad + 1024 > out.length) out = grown(out, o, pad + 1024 + (n - p) * 3);
      for (let k = fields; k < width; k++) {
        out[o++] = 44;
        out[o++] = 34;
        out[o++] = 34;
      }
    } else if (fields > width) {
      const extra = out.subarray(cut + 1, o);
      errOpen(E_LONG, recordLine, recordRow);
      errBytes(K_EXTRA);
      errRoom(extra.length + 8);
      errBytes(extra);
      ERR[eo++] = 93;
      ERR[eo++] = 125;
      o = cut;
    }
    out[o++] = 93;
    rows++;
  }
  if (wantHeader) {
    // header with no record: columns []
    out.set(EMPTY, o);
    o += EMPTY.length;
    out.set(ROWS_OPEN, o);
    o += ROWS_OPEN.length;
  }
  if (o + eo + 64 > out.length) out = grown(out, o, eo + 64);
  out.set(ERRORS_OPEN, o);
  o += ERRORS_OPEN.length;
  out.set(ERR.subarray(0, eo), o);
  o += eo;
  out.set(CLOSE, o);
  o += CLOSE.length;
  return answerOf(out.subarray(0, o));
}

function assemble(out, o, header, columns) {
  const head = header ? (columns ?? EMPTY) : NULL;
  const total = COLUMNS_OPEN.length + head.length + ROWS_OPEN.length + o + ERRORS_OPEN.length + eo + CLOSE.length;
  const bytes = new Uint8Array(total);
  let at = 0;
  bytes.set(COLUMNS_OPEN, at);
  at += COLUMNS_OPEN.length;
  bytes.set(head, at);
  at += head.length;
  bytes.set(ROWS_OPEN, at);
  at += ROWS_OPEN.length;
  bytes.set(out.subarray(0, o), at);
  at += o;
  bytes.set(ERRORS_OPEN, at);
  at += ERRORS_OPEN.length;
  bytes.set(ERR.subarray(0, eo), at);
  at += eo;
  bytes.set(CLOSE, at);
  return answerOf(bytes);
}

// The plain reader, value by value, for a text with a lone surrogate (which UTF-8 cannot carry as it stands).
function runPlain(text, header) {
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  let ended = 0;
  let added = 0;

  function readUnquoted(prefix) {
    let value = prefix;
    let start = pos;
    let kept = 0;
    while (true) {
      let p = start;
      let c = 0;
      while (p < n) {
        c = text.charCodeAt(p);
        if (c === 44 || c === 10 || c === 13) break;
        p++;
      }
      kept += p - start;
      value += text.slice(start, p);
      if (p >= n) {
        pos = n;
        ended = 2;
        added = kept;
        return value;
      }
      if (c === 44) {
        pos = p + 1;
        ended = 0;
        added = kept;
        return value;
      }
      if (c === 10) {
        pos = p + 1;
        line++;
        ended = 1;
        added = kept;
        return value;
      }
      if (text.charCodeAt(p + 1) === 10) {
        pos = p + 2;
        line++;
        ended = 1;
        added = kept;
        return value;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      start = p + 1;
    }
  }

  function readQuoted() {
    const open = pos;
    let p = open + 1;
    let q;
    while (true) {
      q = text.indexOf('"', p);
      if (q < 0) break;
      if (text.charCodeAt(q + 1) === 34) {
        p = q + 2;
        continue;
      }
      break;
    }
    if (q < 0) {
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      return readUnquoted('"');
    }
    let value = '';
    let s = open + 1;
    let i = s;
    while (i < q) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        value += text.slice(s, i + 1);
        i += 2;
        s = i;
      } else if (c === 13) {
        value += text.slice(s, i) + '\n';
        line++;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        s = i;
      } else {
        if (c === 10) line++;
        i++;
      }
    }
    value += text.slice(s, q);
    pos = q + 1;
    if (pos >= n) {
      ended = 2;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      ended = 0;
      return value;
    }
    if (c === 10) {
      pos++;
      line++;
      ended = 1;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      ended = 1;
      return value;
    }
    const junk = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === 0);

    if (fields.length === 1 && !quoted && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const len = fields.length;
    if (len < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: len });
      for (let k = len; k < width; k++) fields.push('');
    } else if (len > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// Warm-up: one small text through every path of run (each break, error, escape and row shape), so V8 has seen each
// branch before it compiles run, and the real texts run on compiled code that does not throw itself away on the first
// short row. Its answers are dropped.
const WARM =
  '\uFEFFa,b,"c ""q"" d",e\r\n\r\n1,2,3,"4"\n\n5,6,7,"8"\r\n\r\n\n5,6\r\n7,8,9,10,11,12\r\n"x\r\ny\nz\rw",p\rq,"j"unk,ok\n' +
  'caf\u00e9,\u6771\u4eac,"",\\ \t\u0001\n"never closes,1,2\n';
for (let i = 0; i < 4; i++) {
  run({ text: WARM, header: true });
  run({ text: WARM.slice(1), header: false });
  run({ text: 'a,b\n1\n', header: false });
  for (const [text, header] of [[WARM, true], [WARM.slice(1), false], ['a,b\n1\n', false]]) {
    const bytes = encoder.encode(JSON.stringify(text));
    run({ text, header, [RAW_INPUT]: { bytes, start: 1, end: bytes.length - 1 } });
  }
}
