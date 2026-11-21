// A tiny WebAssembly assembler for a linear text form (one instruction per line, i32 only, plus a few v128 ops).
// module = { memoryPages, data: [{offset, bytes}], globals: [{name, init}], funcs: [{name, params:[], result: bool, locals:[], body: text, export}] }
const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sleb = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const str = (s) => { const b = [...Buffer.from(s)]; return [...uleb(b.length), ...b]; };
const sec = (id, body) => [id, ...uleb(body.length), ...body];
const vec = (items) => [...uleb(items.length), ...items.flat()];

const SIMPLE = {
  'unreachable': [0x00], 'nop': [0x01], 'return': [0x0f], 'drop': [0x1a], 'select': [0x1b],
  'i32.eqz': [0x45], 'i32.eq': [0x46], 'i32.ne': [0x47], 'i32.lt_s': [0x48], 'i32.lt_u': [0x49], 'i32.gt_s': [0x4a], 'i32.gt_u': [0x4b],
  'i32.le_s': [0x4c], 'i32.le_u': [0x4d], 'i32.ge_s': [0x4e], 'i32.ge_u': [0x4f], 'i32.clz': [0x67], 'i32.ctz': [0x68],
  'i32.add': [0x6a], 'i32.sub': [0x6b], 'i32.mul': [0x6c], 'i32.div_u': [0x6e], 'i32.rem_u': [0x70], 'i32.and': [0x71], 'i32.or': [0x72],
  'i32.xor': [0x73], 'i32.shl': [0x74], 'i32.shr_s': [0x75], 'i32.shr_u': [0x76],
  'memory.copy': [0xfc, 0x0a, 0x00, 0x00], 'memory.fill': [0xfc, 0x0b, 0x00],
  'i8x16.splat': [0xfd, 0x0f], 'i8x16.eq': [0xfd, 0x23], 'v128.or': [0xfd, 0x50], 'v128.any_true': [0xfd, 0x53], 'i8x16.bitmask': [0xfd, 0x64],
};
const MEM = { 'i32.load': [0x28, 2], 'i32.load8_u': [0x2d, 0], 'i32.store': [0x36, 2], 'i32.store8': [0x3a, 0], 'i32.store16': [0x3b, 1], 'v128.load': [0xfd, 0x00, 0], 'v128.store': [0xfd, 0x0b, 0] };

export function assemble(mod) {
  const types = [], typeKey = [];
  const typeOf = (f) => { const k = f.params.length + ':' + (f.result ? 1 : 0); let i = typeKey.indexOf(k); if (i < 0) { i = typeKey.length; typeKey.push(k); types.push([0x60, ...vec(f.params.map(() => [0x7f])), ...(f.result ? [1, 0x7f] : [0])]); } return i; };
  const fidx = Object.fromEntries(mod.funcs.map((f, i) => [f.name, i]));
  const gidx = Object.fromEntries((mod.globals || []).map((g, i) => [g.name, i]));
  const codes = mod.funcs.map((f) => {
    const names = [...f.params, ...f.locals];
    const lidx = (n) => { const i = names.indexOf(n); if (i < 0) throw new Error(f.name + ': no local ' + n); return i; };
    const labels = [];
    const out = [];
    for (let raw of f.body.split('\n')) {
      const line = raw.replace(/;;.*$/, '').trim();
      if (!line) continue;
      const [op, ...a] = line.split(/\s+/);
      const depth = (l) => { const i = labels.lastIndexOf(l); if (i < 0) throw new Error(f.name + ': no label ' + l + ' at ' + line); return labels.length - 1 - i; };
      if (op === 'block' || op === 'loop' || op === 'if') { out.push({ block: 2, loop: 3, if: 4 }[op], 0x40); labels.push(a[0] || '$_'); }
      else if (op === 'else') out.push(0x05);
      else if (op === 'end') { out.push(0x0b); labels.pop(); }
      else if (op === 'br' || op === 'br_if') out.push(op === 'br' ? 0x0c : 0x0d, ...uleb(depth(a[0])));
      else if (op === 'local.get' || op === 'local.set' || op === 'local.tee') out.push({ 'local.get': 0x20, 'local.set': 0x21, 'local.tee': 0x22 }[op], ...uleb(lidx(a[0])));
      else if (op === 'global.get' || op === 'global.set') out.push(op === 'global.get' ? 0x23 : 0x24, ...uleb(gidx[a[0]]));
      else if (op === 'i32.const') out.push(0x41, ...sleb(Number(a[0]) | 0));
      else if (op === 'call') { if (!(a[0] in fidx)) throw new Error('no func ' + a[0]); out.push(0x10, ...uleb(fidx[a[0]])); }
      else if (op in MEM) { const m = MEM[op]; const off = a[0] ? Number(a[0].replace('offset=', '')) : 0; out.push(...m.slice(0, -1), m.at(-1), ...uleb(off)); }
      else if (op in SIMPLE) out.push(...SIMPLE[op]);
      else throw new Error(f.name + ': unknown op ' + line);
    }
    if (labels.length) throw new Error(f.name + ': unclosed ' + labels);
    out.push(0x0b);
    const locals = f.locals.length ? [1, ...uleb(f.locals.length), 0x7f] : [0];
    const body = [...locals, ...out];
    return [...uleb(body.length), ...body];
  });
  const funcTypes = mod.funcs.map(typeOf);
  const bytes = [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, vec(types)),
    ...sec(3, vec(funcTypes.map((t) => uleb(t)))),
    ...sec(5, vec([[0, ...uleb(mod.memoryPages)]])),
    ...((mod.globals || []).length ? sec(6, vec(mod.globals.map((g) => [0x7f, 1, 0x41, ...sleb(g.init), 0x0b]))) : []),
    ...sec(7, vec([[...str('mem'), 2, 0], ...mod.funcs.filter((f) => f.export).map((f) => [...str(f.name), 0, ...uleb(fidx[f.name])])])),
    ...sec(10, vec(codes)),
    ...sec(11, vec((mod.data || []).map((d) => [0, 0x41, ...sleb(d.offset), 0x0b, ...uleb(d.bytes.length), ...d.bytes]))),
  ];
  return Uint8Array.from(bytes);
}
