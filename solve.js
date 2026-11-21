// A fast drop-in for csv-reader 1.0.0's readCsv: the same answer {columns, rows, errors} for every input {text, header}.
// It reads the text once, left to right, by charCode, taking each field as one slice of the text where it can.
// Pure: nothing is kept from one call to the next.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // How the last field ended: 0 comma, 1 line break, 2 end of text; and the characters an unquoted read kept.
  let ended = 0;
  let added = 0;

  // Unquoted characters from pos onto prefix, to the next comma or line break; a lone CR is dropped (stray_cr).
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
      if (p >= n) {
        value = value === '' ? text.slice(start, p) : value + text.slice(start, p);
        pos = n;
        ended = 2;
        added = kept;
        return value;
      }
      if (c === 44) {
        value = value === '' ? text.slice(start, p) : value + text.slice(start, p);
        pos = p + 1;
        ended = 0;
        added = kept;
        return value;
      }
      if (c === 10) {
        value = value === '' ? text.slice(start, p) : value + text.slice(start, p);
        pos = p + 1;
        line++;
        ended = 1;
        added = kept;
        return value;
      }
      // CR
      if (text.charCodeAt(p + 1) === 10) {
        value = value === '' ? text.slice(start, p) : value + text.slice(start, p);
        pos = p + 2;
        line++;
        ended = 1;
        added = kept;
        return value;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value = value === '' ? text.slice(start, p) : value + text.slice(start, p);
      start = p + 1;
    }
  }

  // A quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    let p = open + 1;
    let q;
    let doubled = false;
    while (true) {
      q = text.indexOf('"', p);
      if (q < 0) break;
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        p = q + 2;
        continue;
      }
      break;
    }
    if (q < 0) {
      // Never closes: the quote is a literal character and the text after it is read again as unquoted.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      return readUnquoted('"');
    }
    // The field's characters are open+1 .. q-1.
    let breaks = false;
    for (let i = open + 1; i < q; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) {
        breaks = true;
        break;
      }
    }
    let value;
    if (!breaks && !doubled) {
      value = text.slice(open + 1, q);
    } else {
      value = '';
      let s = open + 1;
      let i = s;
      while (i < q) {
        const c = text.charCodeAt(i);
        if (c === 34) {
          // a doubled quote: keep one
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
    }
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
