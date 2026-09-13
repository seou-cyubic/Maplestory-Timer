/* survey_extract.py 가 오려낸 칸을 **운영 판독기 그대로** 읽는다.

   src/glyphs.js 를 그대로 불러 쓴다. 재구현이 아니라 배포되는 코드를 재는
   것이라, 여기서 나온 숫자가 곧 그 구현의 성적이다.

     node tools/survey_read.js <녹화폴더>

   출력: <녹화폴더>/reads.json
     [{f, x, y, font, text}]  — 판독에 성공한 칸만. 실패는 남기지 않는다
     (거부는 값이 아니라 '읽지 않음'이고, 어느 칸이 비었는지는 격자에서 안다).
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.self = global;
global.ASTRA = { vision: {
  Scope: function () { this.add = m => m; this.done = () => {}; },
  roi: () => null
} };
require(path.join(ROOT, 'src/glyphs.js'));
const G = global.ASTRA.glyphs;

const dir = process.argv[2];
if (!dir) { console.error('사용: node tools/survey_read.js <녹화폴더>'); process.exit(2); }

const atlas = new G.Atlas(JSON.parse(fs.readFileSync(path.join(ROOT, 'config/glyphs.json'), 'utf8')));
const FONTS = [['yellow', atlas.font('buff_yellow')], ['minutes', atlas.font('buff_minutes')]];

const idx = JSON.parse(fs.readFileSync(path.join(dir, 'cells.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'cells.bin'));
const CELL = idx.cell, STRIDE = CELL * CELL * 3;

const out = [];
let read = 0, refused = 0;
const t0 = Date.now();
for (let i = 0; i < idx.cells.length; i++) {
  const c = idx.cells[i];
  const mat = { rows: CELL, cols: CELL, delete() {},
                data: new Uint8Array(bin.buffer, bin.byteOffset + c.off, STRIDE) };
  let got = null;
  for (const [name, font] of FONTS) {
    if (!font) continue;
    const r = G.readLine(mat, null, font, {});
    /* 노란 글꼴과 흰 글꼴은 잉크 규칙이 서로를 배제하므로 둘 다 성공하는 일은
       없다. 그래도 먼저 성공한 쪽을 쓰고 멈춘다 — 운영 경로와 같은 순서다. */
    if (r && r.ok) { got = { f: c.f, x: c.x, y: c.y, font: name, text: r.text }; break; }
  }
  if (got) { out.push(got); read++; } else refused++;
  if (i % 20000 === 0) console.log('  %d/%d ...', i, idx.cells.length);
}
const ms = Date.now() - t0;
fs.writeFileSync(path.join(dir, 'reads.json'), JSON.stringify(out));
console.log('칸 %d개 · 판독 %d · 비어있음/거부 %d · %d ms (%.1f µs/칸)',
  idx.cells.length, read, refused, ms, ms * 1000 / idx.cells.length);
console.log('저장: ' + path.join(dir, 'reads.json'));
