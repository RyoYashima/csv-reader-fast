// A tiny tree-to-linear compiler for wasm-asm.mjs: expressions and statements as nested arrays (i32 only).
const BIN = { '+': 'i32.add', '-': 'i32.sub', '*': 'i32.mul', '==': 'i32.eq', '!=': 'i32.ne', '<u': 'i32.lt_u', '<=u': 'i32.le_u', '>u': 'i32.gt_u', '>=u': 'i32.ge_u', '<s': 'i32.lt_s', '>s': 'i32.gt_s', '&': 'i32.and', '|': 'i32.or', '/u': 'i32.div_u', '%u': 'i32.rem_u' };
export function compile(stmts, globals = []) {
  const L = [];
  const isG = (v) => globals.includes(v);
  const ex = (e) => {
    if (typeof e === 'number') return L.push('i32.const ' + e);
    if (typeof e === 'string') return L.push((isG(e) ? 'global.get ' : 'local.get ') + e);
    const [op, ...a] = e;
    if (op in BIN) { ex(a[0]); ex(a[1]); return L.push(BIN[op]); }
    if (op === '!') { ex(a[0]); return L.push('i32.eqz'); }
    if (op === 'ld') { ex(a[0]); return L.push('i32.load8_u'); }
    if (op === 'tee') { ex(a[1]); return L.push('local.tee ' + a[0]); }
    if (op === 'call') { a.slice(1).forEach(ex); return L.push('call ' + a[0]); }
    if (op === '?') { ex(a[1]); ex(a[2]); ex(a[0]); return L.push('select'); }
    if (op === 'vld') { ex(a[0]); return L.push('v128.load'); }
    if (op === 'veq') { ex(a[0]); L.push('i32.const ' + a[1]); L.push('i8x16.splat'); return L.push('i8x16.eq'); }
    if (op === 'vor') { ex(a[0]); ex(a[1]); return L.push('v128.or'); }
    if (op === 'vmask') { ex(a[0]); return L.push('i8x16.bitmask'); }
    if (op === 'ctz') { ex(a[0]); return L.push('i32.ctz'); }
    if (op === '&&') { // short-circuit: a ? b : 0
      ex(a[0]); L.push('if $_v'); L.push('end'); throw new Error('&& unsupported');
    }
    throw new Error('bad expr ' + JSON.stringify(e));
  };
  const st = (s) => {
    const [op, ...a] = s;
    if (op === 'set') { ex(a[1]); L.push((isG(a[0]) ? 'global.set ' : 'local.set ') + a[0]); }
    else if (op === 'inc') { ex(a[0]); ex(a[1] ?? 1); L.push('i32.add'); L.push((isG(a[0]) ? 'global.set ' : 'local.set ') + a[0]); }
    else if (op === 'st') { ex(a[0]); ex(a[1]); L.push('i32.store8'); }
    else if (op === 'put') { // put byte at $o and advance: ['put', '$o', value]
      ex(a[0]); ex(a[1]); L.push('i32.store8'); ex(a[0]); L.push('i32.const 1'); L.push('i32.add'); L.push((isG(a[0]) ? 'global.set ' : 'local.set ') + a[0]);
    }
    else if (op === 'if') { ex(a[0]); L.push('if $_'); a[1].forEach(st); if (a[2]) { L.push('else'); a[2].forEach(st); } L.push('end'); }
    else if (op === 'loop' || op === 'block') { L.push(op + ' ' + a[0]); a[1].forEach(st); L.push('end'); }
    else if (op === 'br') L.push('br ' + a[0]);
    else if (op === 'brif') { ex(a[1]); L.push('br_if ' + a[0]); }
    else if (op === 'ret') { ex(a[0]); L.push('return'); }
    else if (op === 'do') { ex(a[0]); L.push('drop'); }
    else if (op === 'call') { a.slice(1).forEach(ex); L.push('call ' + a[0]); }
    else if (op === 'copy') { ex(a[0]); ex(a[1]); ex(a[2]); L.push('memory.copy'); }
    else if (op === 'vst') { ex(a[0]); ex(a[1]); L.push('v128.store'); }
    else if (op === 'raw') L.push(...a);
    else throw new Error('bad stmt ' + JSON.stringify(s));
  };
  stmts.forEach(st);
  return L.join('\n');
}
