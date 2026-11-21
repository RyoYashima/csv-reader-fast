// Builds the CSV scanner as a wasm module: scan() is runEscaped of solve.js, byte for byte.
import { assemble } from './wasm-asm.mjs';
import { compile } from './cc.mjs';

const STR = ['{"code":"stray_cr","line":', '{"code":"unterminated_quote","line":', '{"code":"quote_junk","line":', '{"code":"short_row","line":', '{"code":"long_row","line":', ',"row":', ',"fields":', ',"extra":[', 'null', ',"rows":['];
const S = {}; let off = 1024; const data = [];
for (const s of STR) { const b = [...Buffer.from(s)]; S[s] = [off, b.length]; data.push({ offset: off, bytes: b }); off += b.length; }
const [STRAY, UNTERM, JUNK, SHORT, LONG, KROW, KFIELDS, KEXTRA, NUL, ROWSO] = STR.map((s) => S[s]);
const G = ['$GE', '$GE0', '$GELIM', '$GWH'];

const ld = (a) => ['ld', a];
const put = (v) => ['put', '$o', v];
const putE = (v) => ['put', '$GE', v];
const errCheck = ['if', ['>u', ['+', '$GE', 300], '$GELIM'], [['ret', -2]]];
const err = (s) => [errCheck, ['call', 'err', s[0], s[1], '$rl', '$rr']];
const and = (...xs) => xs.reduce((a, b) => ['&', a, b]);
const copyO = (s) => [['copy', '$o', s[0], s[1]], ['inc', '$o', s[1]]];
const copyE = (s) => [['copy', '$GE', s[0], s[1]], ['inc', '$GE', s[1]]];
const crlfAt = (x, lim) => and(['<u', ['+', x, 3], lim], ['==', ld(['+', x, 2]), 92], ['==', ld(['+', x, 3]), 110]);
const u4 = (x) => [put(92), put(117), put(ld(['+', x, 2])), put(ld(['+', x, 3])), put(ld(['+', x, 4])), put(ld(['+', x, 5]))];

const intBody = compile([
  ['set', '$d', 1],
  ['loop', '$a', [['if', ['>=u', ['/u', '$v', '$d'], 10], [['set', '$d', ['*', '$d', 10]], ['br', '$a']]]]],
  ['loop', '$b', [putE(['+', 48, ['%u', ['/u', '$v', '$d'], 10]]), ['if', ['!=', '$d', 1], [['set', '$d', ['/u', '$d', 10]], ['br', '$b']]]]],
], G);
const errBody = compile([
  ['if', ['!=', '$GE', '$GE0'], [putE(44)]],
  ['copy', '$GE', '$s', '$l'], ['inc', '$GE', '$l'],
  ['call', 'int', '$line'],
  ...copyE(KROW),
  ['if', ['<s', '$row', 0], copyE(NUL), [['call', 'int', '$row']]],
], G);
const hex = (b) => ['?', ['<u', ['-', b, 48], 10], ['-', b, 48], ['?', ['<u', ['-', ['|', b, 32], 97], 6], ['-', ['|', b, 32], 87], 0]];
const oddBody = compile([
  ['set', '$v', ['|', ['|', ['*', hex(ld(['+', '$a', 1])), 4096], ['*', hex(ld(['+', '$a', 2])), 256]], ['|', ['*', hex(ld(['+', '$a', 3])), 16], hex(ld(['+', '$a', 4]))]]],
  ['ret', ['|', ['|', ['==', '$v', 10], ['==', '$v', 13]], ['|', ['|', ['==', '$v', 34], ['==', '$v', 44]], ['==', '$v', 92]]]],
], G);
const findBody = compile([
  ['loop', '$v', [['if', ['<=u', ['+', '$q', 16], '$n'], [
    ['set', '$m', ['vmask', ['veq', ['vld', '$q'], 34]]],
    ['if', '$m', [['ret', ['+', '$q', ['ctz', '$m']]]]],
    ['inc', '$q', 16], ['br', '$v']]]]],
  ['loop', '$l', [['if', ['<u', '$q', '$n'], [['if', ['!=', ld('$q'), 34], [['inc', '$q'], ['br', '$l']]]]]]],
  ['ret', '$q'],
], G);

const scan = [
  ['set', '$line', 1], ['set', '$rows', 0], ['set', '$width', -1],
  ['block', '$done', [['loop', '$rec', [
    ['block', '$sb', [['loop', '$sl', [
      ['brif', '$sb', ['!', ['<u', ['+', '$p', 1], '$n']]],
      ['brif', '$sb', ['!=', ld('$p'), 92]],
      ['set', '$c', ld(['+', '$p', 1])],
      ['if', ['==', '$c', 110], [['inc', '$p', 2], ['inc', '$line'], ['br', '$sl']]],
      ['if', and(['==', '$c', 114], crlfAt('$p', '$n')), [['inc', '$p', 4], ['inc', '$line'], ['br', '$sl']]],
      ['br', '$sb'],
    ]]]],
    ['brif', '$done', ['>=u', '$p', '$n']],
    ['set', '$rl', '$line'], ['set', '$rr', ['?', '$want', -1, '$rows']], ['set', '$rs', '$o'],
    ['if', ['>u', ['+', ['+', '$o', ['*', ['-', '$n', '$p'], 3]], ['+', ['*', '$width', 3], 4096]], '$olim'], [['ret', -2]]],
    ['if', ['!=', '$rows', 0], [put(44)]],
    put(91),
    ['set', '$fields', 0], ['set', '$cut', -1], ['set', '$ended', 0],
    ['loop', '$fld', [
      ['if', ['!=', '$fields', 0], [['if', ['==', '$fields', '$width'], [['set', '$cut', '$o']]], put(44)]],
      put(34), ['set', '$ls', '$o'], ['set', '$junk', 0], ['set', '$unq', 1],
      ['set', '$lq', and(['<u', ['+', '$p', 1], '$n'], ['==', ld('$p'), 92], ['==', ld(['+', '$p', 1]), 34])],
      ['if', '$lq', [
        ['set', '$q', ['+', '$p', 2]],
        ['block', '$qf', [['loop', '$ql', [
          ['set', '$q', ['call', 'find', '$q', '$n']],
          ['if', ['>=u', '$q', '$n'], [['set', '$q', -1], ['br', '$qf']]],
          ['if', and(['<u', ['+', '$q', 2], '$n'], ['==', ld(['+', '$q', 1]), 92], ['==', ld(['+', '$q', 2]), 34]), [['inc', '$q', 3], ['br', '$ql']]],
          ['br', '$qf'],
        ]]]],
        ['if', ['==', '$q', -1], [
          ...err(UNTERM), putE(125), put(92), put(34), ['inc', '$p', 2],
        ], [
          ['set', '$stop', ['-', '$q', 1]], ['set', '$i', ['+', '$p', 2]],
          ['block', '$cb', [['loop', '$cl', [
            ['if', ['<=u', ['+', '$i', 16], '$stop'], [
              ['set', '$m', ['vmask', ['veq', ['vld', '$i'], 92]]],
              ['vst', '$o', ['vld', '$i']],
              ['if', ['!', '$m'], [['inc', '$i', 16], ['inc', '$o', 16], ['br', '$cl']]],
              ['set', '$k', ['ctz', '$m']], ['inc', '$i', '$k'], ['inc', '$o', '$k']]],
            ['brif', '$cb', ['!', ['<u', '$i', '$stop']]],
            ['set', '$b', ld('$i')],
            ['if', ['!=', '$b', 92], [put('$b'), ['inc', '$i'], ['br', '$cl']]],
            ['set', '$c', ld(['+', '$i', 1])],
            ['if', ['==', '$c', 34], [put(92), put(34), ['inc', '$i', 4], ['br', '$cl']]],
            ['if', ['==', '$c', 110], [put(92), put(110), ['inc', '$line'], ['inc', '$i', 2], ['br', '$cl']]],
            ['if', ['==', '$c', 114], [put(92), put(110), ['inc', '$line'], ['set', '$i', ['+', '$i', ['+', 2, ['*', 2, crlfAt('$i', '$stop')]]]], ['br', '$cl']]],
            ['if', ['==', '$c', 117], [['if', ['call', 'odd', ['+', '$i', 1]], [['ret', -1]]], ...u4('$i'), ['inc', '$i', 6], ['br', '$cl']]],
            put(92), put('$c'), ['inc', '$i', 2], ['br', '$cl'],
          ]]]],
          ['set', '$p', ['+', '$q', 1]],
          ['if', ['>=u', '$p', '$n'], [['set', '$ended', 2], ['set', '$unq', 0]], [
            ['set', '$b', ld('$p')],
            ['if', ['==', '$b', 44], [['inc', '$p'], ['set', '$ended', 0], ['set', '$unq', 0]], [
              ['if', and(['==', '$b', 92], ['==', ld(['+', '$p', 1]), 110]), [['inc', '$p', 2], ['inc', '$line'], ['set', '$ended', 1], ['set', '$unq', 0]], [
                ['if', and(['==', '$b', 92], ['==', ld(['+', '$p', 1]), 114], crlfAt('$p', '$n')), [['inc', '$p', 4], ['inc', '$line'], ['set', '$ended', 1], ['set', '$unq', 0]], [
                  ['set', '$junk', 1],
                ]],
              ]],
            ]],
          ]],
        ]],
      ]],
      ['if', '$unq', [
        ['set', '$kf', '$o'],
        ['block', '$ub', [['loop', '$ul', [
          ['if', ['<=u', ['+', '$p', 16], '$n'], [
            ['set', '$m', ['vmask', ['vor', ['veq', ['vld', '$p'], 44], ['veq', ['vld', '$p'], 92]]]],
            ['vst', '$o', ['vld', '$p']],
            ['if', ['!', '$m'], [['inc', '$p', 16], ['inc', '$o', 16], ['br', '$ul']]],
            ['set', '$k', ['ctz', '$m']], ['inc', '$p', '$k'], ['inc', '$o', '$k']]],
          ['if', ['>=u', '$p', '$n'], [['set', '$ended', 2], ['br', '$ub']]],
          ['set', '$b', ld('$p')],
          ['if', and(['!=', '$b', 44], ['!=', '$b', 92]), [put('$b'), ['inc', '$p'], ['br', '$ul']]],
          ['if', ['==', '$b', 44], [['inc', '$p'], ['set', '$ended', 0], ['br', '$ub']]],
          ['set', '$c', ld(['+', '$p', 1])],
          ['if', ['==', '$c', 110], [['inc', '$p', 2], ['inc', '$line'], ['set', '$ended', 1], ['br', '$ub']]],
          ['if', ['==', '$c', 114], [
            ['if', crlfAt('$p', '$n'), [['inc', '$p', 4], ['inc', '$line'], ['set', '$ended', 1], ['br', '$ub']]],
            ...err(STRAY), putE(125), ['inc', '$p', 2], ['br', '$ul'],
          ]],
          ['if', ['==', '$c', 117], [['if', ['call', 'odd', ['+', '$p', 1]], [['ret', -1]]], ...u4('$p'), ['inc', '$p', 6], ['br', '$ul']]],
          put(92), put('$c'), ['inc', '$p', 2], ['br', '$ul'],
        ]]]],
        ['if', and('$junk', ['>u', '$o', '$kf']), [...err(JUNK), putE(125)]],
      ]],
      put(34), ['inc', '$fields'],
      ['brif', '$fld', ['==', '$ended', 0]],
    ]],
    ['if', and(['==', '$fields', 1], ['!', '$lq'], ['==', '$o', ['+', '$ls', 1]]), [['set', '$o', '$rs'], ['br', '$rec']]],
    ['if', ['<s', '$width', 0], [['set', '$width', '$fields']]],
    ['if', '$want', [put(93), ...copyO(ROWSO), ['set', '$want', 0], ['br', '$rec']]],
    ['if', ['<s', '$fields', '$width'], [
      ...err(SHORT), ...copyE(KFIELDS), ['call', 'int', '$fields'], putE(125),
      ['if', ['>u', ['+', ['+', '$o', ['*', ['-', '$width', '$fields'], 3]], 64], '$olim'], [['ret', -2]]],
      ['set', '$k', '$fields'],
      ['loop', '$pad', [put(44), put(34), put(34), ['inc', '$k'], ['brif', '$pad', ['<s', '$k', '$width']]]],
    ], [
      ['if', ['>s', '$fields', '$width'], [
        ['set', '$k', ['-', ['-', '$o', '$cut'], 1]],
        ['if', ['>u', ['+', ['+', '$GE', '$k'], 300], '$GELIM'], [['ret', -2]]],
        ...err(LONG), ...copyE(KEXTRA), ['copy', '$GE', ['+', '$cut', 1], '$k'], ['inc', '$GE', '$k'], putE(93), putE(125),
        ['set', '$o', '$cut'],
      ]],
    ]],
    put(93), ['inc', '$rows'], ['br', '$rec'],
  ]]]],
  ['set', '$GWH', '$want'],
  ['ret', '$o'],
];

const L = ['$line', '$rows', '$width', '$rl', '$rr', '$rs', '$fields', '$cut', '$lq', '$ls', '$ended', '$junk', '$unq', '$q', '$i', '$stop', '$b', '$c', '$kf', '$k', '$m'];
export const wasm = assemble({
  memoryPages: 1,
  globals: G.map((name) => ({ name, init: 0 })),
  data,
  funcs: [
    { name: 'int', params: ['$v'], result: false, locals: ['$d'], body: intBody },
    { name: 'err', params: ['$s', '$l', '$line', '$row'], result: false, locals: [], body: errBody },
    { name: 'odd', params: ['$a'], result: true, locals: ['$v'], body: oddBody },
    { name: 'find', params: ['$q', '$n'], result: true, locals: ['$m'], body: findBody },
    { name: 'scan', export: true, params: ['$p', '$n', '$want', '$o', '$olim'], result: true, locals: L, body: compile(scan, G) },
    { name: 'init', export: true, params: ['$e', '$lim'], result: false, locals: [], body: compile([['set', '$GE', '$e'], ['set', '$GE0', '$e'], ['set', '$GELIM', '$lim']], G) },
    { name: 'errEnd', export: true, params: [], result: true, locals: [], body: compile([['ret', '$GE']], G) },
    { name: 'wantHeader', export: true, params: [], result: true, locals: [], body: compile([['ret', '$GWH']], G) },
  ],
});
if (process.argv[1]?.endsWith('build.mjs')) { const m = await WebAssembly.compile(wasm); console.log('wasm bytes', wasm.length, WebAssembly.Module.exports(m).map((e) => e.name).join(',')); }
