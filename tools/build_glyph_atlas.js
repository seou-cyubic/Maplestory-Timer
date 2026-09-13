/* 버프 아이콘 숫자 글꼴 아틀라스를 실화면 표본에서 만든다.

   왜 도구로 두는가: 아틀라스는 손으로 그린 것이 아니라 실제 게임 화면에서
   뽑아낸 비트맵이다. 표본이 늘거나 잉크 규칙을 바꾸면 다시 돌려야 하고,
   그때 판독기와 **같은 코드 경로**로 뽑아야 한다. 눈으로 자른 비트맵을
   넣었더니 판독기가 고른 띠와 한 칸씩 어긋나 전부 미확인이 된 적이 있다.

   두 번 훑는다.
     1) 정답의 숫자 개수와 구간 수가 맞는 띠에서 후보 비트맵을 모두 모은다.
     2) 그 후보로 실제 판독을 돌려 정답과 정확히 일치하는 띠만 남기고,
        그 띠의 비트맵만 아틀라스에 넣는다.
   1)만 하면 세로로 어긋난 띠의 조각이 섞여 서로 모순된 아틀라스가 된다
   (실측: 재판독 정확도 7/21). 2)를 거치면 30/30이 됐다.

   사용: node tools/build_glyph_atlas.js [--write]
         --write 없이는 결과만 보고하고 config 를 건드리지 않는다. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.self = global;
// glyphs.js 는 readLine 에서만 vision 을 쓴다. 테스트용 최소 대역.
global.ASTRA = { vision: {
  Scope: function () { this.add = m => m; this.done = () => {}; },
  roi: () => null
} };
require(path.join(ROOT, 'src/glyphs.js'));
const G = global.ASTRA.glyphs;

const CFG = path.join(ROOT, 'config/glyphs.json');
const doc = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/buff_cells.json'), 'utf8'));
const bin = fs.readFileSync(path.join(ROOT, 'tools/fixtures/buff_cells.bin'));

function matOf(c) {
  return { rows: man.rows, cols: c.crop_w, delete() {},
           data: new Uint8Array(bin.buffer, bin.byteOffset + c.offset, man.rows * c.crop_w * 3) };
}
const FONTS = { yellow: 'buff_yellow', minutes: 'buff_minutes' };

function bitsKey(b) { return b.w + ':' + Array.from(b.bits).join(''); }

function collect(font, cells, atlasFont) {
  const seen = new Map();
  for (const c of cells) {
    const mat = matOf(c);
    const mask = G.inkMask(mat, atlasFont.ink);
    const digits = c.text.split('').filter(ch => ch >= '0' && ch <= '9');
    /* 1차 수집은 칸마다 **점수 1위 띠 하나만** 본다.

       처음에는 조건에 맞는 띠를 전부 모았는데, 표본이 41칸에서 58칸으로 늘자
       세로로 어긋난 띠의 조각까지 후보에 섞여 1차 아틀라스가 모호해졌고,
       그 결과 2차에서 정답과 일치하는 띠가 급감해 **판독이 오히려 나빠졌다**
       (분 글꼴 판독 1900건 -> 350건). 1위 띠만 쓰면 잡음이 들어오지 않는다. */
    const bands = G.bandCandidates(mask, mat.cols, mat.rows, atlasFont.height,
                                   atlasFont.minRunWidth, atlasFont)
      .filter(b => b.runs.length === digits.length);
    if (bands.length) {
      const band = bands[0];
      const sub = mask.subarray(band.y * mat.cols, (band.y + atlasFont.height) * mat.cols);
      band.runs.forEach((r, i) => {
        const b = G.runBits(sub, mat.cols, atlasFont.height, r[0], r[1]);
        seen.set(digits[i] + '|' + bitsKey(b), { ch: digits[i], b: b });
      });
    }
  }
  return Array.from(seen.values());
}

function install(atlasFont, entries) {
  atlasFont.glyphs = [];
  atlasFont.maxWidth = 0;
  for (const e of entries) atlasFont.add(e.ch, e.b.bits, e.b.w, e.b.h);
}

function readCell(c, atlasFont) {
  const r = G.readLine(matOf(c), null, atlasFont, {});
  return (r && r.ok) ? r.text : null;
}

const report = [];
for (const [kind, name] of Object.entries(FONTS)) {
  const cells = man.cells.filter(c => c.font === kind);
  const f = new G.Font(name, doc.fonts[name]);

  install(f, collect(kind, cells, f));            // 1차: 후보 전부
  const keep = new Map();
  for (const c of cells) {                        // 2차: 정답과 맞는 띠만
    const mat = matOf(c);
    const mask = G.inkMask(mat, f.ink);
    const digits = c.text.split('').filter(ch => ch >= '0' && ch <= '9');
    for (const band of G.bandCandidates(mask, mat.cols, mat.rows, f.height, f.minRunWidth, f)) {
      if (band.runs.length !== digits.length) continue;
      const got = G.decodeBand(mask, mat.cols, f, band, null);
      if (!got.ok || got.text !== c.text) continue;
      const sub = mask.subarray(band.y * mat.cols, (band.y + f.height) * mat.cols);
      band.runs.forEach((r, i) => {
        const b = G.runBits(sub, mat.cols, f.height, r[0], r[1]);
        keep.set(digits[i] + '|' + bitsKey(b), { ch: digits[i], b: b });
      });
      break;
    }
  }
  install(f, Array.from(keep.values()));

  let ok = 0, refused = 0, wrong = 0; const bad = [];
  for (const c of cells) {
    const got = readCell(c, f);
    if (got === c.text) ok++;
    else if (got === null) { refused++; bad.push(`${c.source}@${c.x},${c.y} "${c.text}" 거부`); }
    else { wrong++; bad.push(`${c.source}@${c.x},${c.y} "${c.text}" -> "${got}" 오판독`); }
  }
  const chars = Array.from(new Set(f.glyphs.map(g => g.ch))).sort().join('');
  report.push({ name, cells: cells.length, ok, refused, wrong, bad,
                chars, variants: f.glyphs.length, font: f });
  doc.fonts[name].glyphs = f.toJSON().glyphs;
}

for (const r of report) {
  console.log(`${r.name}: ${r.ok}/${r.cells} 정답 · ${r.refused} 거부 · ${r.wrong} 오판독`);
  console.log(`   문자 ${r.chars || '(없음)'} · 변형 ${r.variants}개`);
  r.bad.forEach(b => console.log('   ' + b));
}
if (process.argv.includes('--write')) {
  fs.writeFileSync(CFG, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log('config/glyphs.json 갱신됨');
} else {
  console.log('(--write 를 주면 config/glyphs.json 에 기록한다)');
}
