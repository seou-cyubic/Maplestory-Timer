/* L2(시간 누적) + L3(단일 프레임 전체 탐색)을 녹화 전체에 돌려 채점한다.

   묻는 것은 하나다 — **평균을 내면 허용오차를 0으로 되돌릴 수 있는가.**

   흰 분 글꼴을 0~3에서 0~9로 넓혔을 때 실화면 판독이 2,167건에서 350건으로
   나빠졌다. 원인은 잡음을 허용오차로 견디는 방식이 문자 수가 늘면 곧바로
   모호성이 되기 때문이었다. L2 는 잡음을 견디는 대신 평균으로 없앤다.

   절차
     1. 검증된 라벨(tools/fixtures/minute_labels_pending.json, 사람이 17/17 확인)
        위치에서 **누적 평균 이미지**를 만들고 거기서 글리프를 뽑아
        허용오차 0 의 엄격한 글꼴을 만든다.
     2. 녹화 전체를 위치별·프레임순으로 LayeredReader 에 흘려 L2/L3/거부를 센다.
     3. 단일 프레임 기준선(현행 글꼴)과 비교한다.

     node tools/survey_l2.js <녹화폴더>
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
require(path.join(ROOT, 'src/accumulate.js'));
const G = global.ASTRA.glyphs;
const A = global.ASTRA.accumulate;

const dir = process.argv[2];
if (!dir) { console.error('사용: node tools/survey_l2.js <녹화폴더>'); process.exit(2); }

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/glyphs.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'cells.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'cells.bin'));
const CELL = idx.cell, STRIDE = CELL * CELL * 3;

function matOf(off) {
  return { rows: CELL, cols: CELL, delete() {},
           data: new Uint8Array(bin.buffer, bin.byteOffset + off, STRIDE) };
}

// 위치별 · 프레임순
const byPos = new Map();
for (const c of idx.cells) {
  const k = c.x + ',' + c.y;
  if (!byPos.has(k)) byPos.set(k, []);
  byPos.get(k).push(c);
}
for (const v of byPos.values()) v.sort((a, b) => a.f - b.f);

/* ---- 1) 평균 이미지에서 엄격한 글꼴 만들기 ---------------------------- */
const labels = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tools/fixtures/minute_labels_pending.json'), 'utf8'));
const spec = Object.assign({}, doc.fonts.buff_minutes,
  { tolerance: 0, margin: 1, glyphs: {} });
const strict = new G.Font('buff_minutes_l2', spec);

function bitsKey(b) { return b.w + ':' + Array.from(b.bits).join(''); }
const seen = new Map();
let built = 0;
for (const L of labels.cells) {
  const k = L.x + ',' + L.y;
  const seq = byPos.get(k);
  if (!seq) continue;
  const at = seq.findIndex(c => c.f === L.f_used || c.f === L.frame || c.f === L.mid);
  // 라벨 파일은 source 에 프레임 번호를 담고 있다: rec/<dir>/fNNNNN
  const m = /f(\d+)$/.exec(L.source || '');
  const fnum = m ? parseInt(m[1], 10) : (at >= 0 ? seq[at].f : null);
  if (fnum === null) continue;
  const acc = new A.Accumulator({ maxFrames: 8 });
  // 라벨 프레임 직전 8장을 모은다 (같은 값이 60프레임 이어지므로 안전하다)
  for (const c of seq) {
    if (c.f > fnum) break;
    if (c.f <= fnum - 8) continue;
    acc.push(matOf(c.off));
  }
  const avg = acc.mean();
  if (!avg) continue;
  const mask = G.inkMask(avg, strict.ink);
  const digits = L.text.split('');
  const bands = G.bandCandidates(mask, CELL, CELL, strict.height, strict.minRunWidth, strict)
    .filter(b => b.runs.length === digits.length);
  if (!bands.length) continue;
  const band = bands[0];
  const sub = mask.subarray(band.y * CELL, (band.y + strict.height) * CELL);
  band.runs.forEach((r, i) => {
    const b = G.runBits(sub, CELL, strict.height, r[0], r[1]);
    seen.set(digits[i] + '|' + bitsKey(b), { ch: digits[i], b });
  });
  built += 1;
}
for (const e of seen.values()) strict.add(e.ch, e.b.bits, e.b.w, e.b.h);
const chars = Array.from(new Set(strict.glyphs.map(g => g.ch))).sort().join('');
console.log('엄격한 글꼴(평균 이미지 · 허용오차 0): 라벨 %d개에서 문자 %s · 변형 %d개',
  built, chars || '(없음)', strict.glyphs.length);

/* ---- 2) 녹화 전체를 층 판독기로 ---------------------------------------- */
const loose = new G.Font('buff_minutes_l3', doc.fonts.buff_minutes);
const totals = { l2: 0, l3: 0, refused: 0, changes: 0, frames: 0 };
const vals = { l2: new Map(), l3: new Map() };
for (const [k, seq] of byPos) {
  const rd = new A.LayeredReader({ strictFont: strict, looseFont: loose, maxFrames: 8 });
  for (const c of seq) {
    const r = rd.read(matOf(c.off));
    if (r.ok && /^\d+$/.test(r.text)) {
      const bag = r.layer === 'L2' ? vals.l2 : vals.l3;
      bag.set(r.text, (bag.get(r.text) || 0) + 1);
    }
  }
  totals.l2 += rd.stats.l2; totals.l3 += rd.stats.l3;
  totals.refused += rd.stats.refused; totals.changes += rd.stats.changes;
  totals.frames += rd.stats.frames;
}
const uniq = m => Array.from(m.keys()).filter(t => /^\d+$/.test(t))
  .map(Number).sort((a, b) => a - b);

console.log('');
console.log('층별 판독 (칸 %d개)', totals.frames);
console.log('  L2 (평균·허용오차 0) : %d건', totals.l2);
console.log('  L3 (단일·현행 글꼴)  : %d건', totals.l3);
console.log('  거부                : %d건', totals.refused);
console.log('  누적 초기화(변화 감지): %d회', totals.changes);
console.log('');
console.log('  L2 가 읽은 서로 다른 값: %s', uniq(vals.l2).join(' ') || '(없음)');
console.log('  L3 가 읽은 서로 다른 값: %s', uniq(vals.l3).join(' ') || '(없음)');
const all = new Set([...uniq(vals.l2), ...uniq(vals.l3)]);
console.log('  합쳐서 %d개: %s', all.size, Array.from(all).sort((a, b) => a - b).join(' '));

/* ---- 3) 단일 프레임 기준선 --------------------------------------------- */
let base = 0; const baseVals = new Map();
for (const c of idx.cells) {
  const r = G.readLine(matOf(c.off), null, loose, {});
  if (r && r.ok) { base++; if (/^\d+$/.test(r.text)) baseVals.set(r.text, 1); }
}
console.log('');
console.log('기준선 (L2 없이 현행 글꼴 단독): %d건 · 서로 다른 값 %d개: %s',
  base, uniq(baseVals).length, uniq(baseVals).join(' '));

/* ---- 4) 정확성: 분 값은 60초 계단으로만 움직여야 한다 ------------------
   많이 읽는 것과 맞게 읽는 것은 다르다. 판독 수가 늘어도 시간 수열을 어기면
   그건 개선이 아니라 오판독이다. 여기서는 판독기를 채점자로 쓰지 않고
   물리 제약(분은 60초에 1씩 준다)으로만 본다. */
function grade(label, getReads) {
  let steps = 0, good = 0, bad = 0; const examples = [];
  for (const [k, seq] of byPos) {
    const rs = getReads(k, seq);
    if (rs.length < 2) continue;
    const runs = [];
    for (const [f, t] of rs) {
      if (runs.length && runs[runs.length - 1][0] === t && f - runs[runs.length - 1][2] <= 5) {
        runs[runs.length - 1][2] = f;
      } else runs.push([t, f, f]);
    }
    for (let i = 1; i < runs.length; i++) {
      const [pv, pf0] = runs[i - 1], [v, f0] = runs[i];
      const span = f0 - pf0;
      if (span < 30 || span > 90) continue;      // 인접 계단만 본다
      steps++;
      if (Number(v) === Number(pv) - 1) good++;
      else { bad++; if (examples.length < 6) examples.push(`${k} f${pf0}"${pv}"→f${f0}"${v}"(${span}f)`); }
    }
  }
  console.log('  %s: 인접 계단 %d개 중 정합 %d · 어긋남 %d (%.1f%%)',
    label, steps, good, bad, steps ? 100 * bad / steps : 0);
  examples.forEach(e => console.log('      ' + e));
}
console.log('');
console.log('정확성 채점 (분은 60초에 1씩 감소)');
{
  const L2 = new Map(), BASE = new Map();
  for (const [k, seq] of byPos) {
    const rd = new A.LayeredReader({ strictFont: strict, looseFont: null, maxFrames: 8 });
    const a = [], b = [];
    for (const c of seq) {
      const r = rd.read(matOf(c.off));
      if (r.ok && /^\d+$/.test(r.text)) a.push([c.f, r.text]);
      const s = G.readLine(matOf(c.off), null, loose, {});
      if (s && s.ok && /^\d+$/.test(s.text)) b.push([c.f, s.text]);
    }
    L2.set(k, a); BASE.set(k, b);
  }
  grade('기준선(단일·현행)', k => BASE.get(k) || []);
  grade('L2(평균·허용오차0)', k => L2.get(k) || []);
}

/* ---- 5) --write: 엄격한 글꼴을 config 에 싣는다 -------------------------
   기존 buff_minutes 는 L3 대비책으로 그대로 둔다. 새 글꼴은 추가만 하므로
   지금 동작이 나빠질 수 없다. */
if (process.argv.includes('--write')) {
  const out = strict.toJSON();
  doc.fonts.buff_minutes_l2 = Object.assign({}, spec, {
    glyphs: out.glyphs,
    _note: ('L2 전용. **누적 평균 이미지**에서 뽑았고 허용오차 0이다. ' +
            '단일 프레임에 쓰면 코덱 잡음 때문에 거의 맞지 않는다 — 반드시 ' +
            'accumulate.LayeredReader 의 strictFont 로만 써라. 라벨은 ' +
            'tools/fixtures/minute_labels_pending.json (사람이 17/17 확인). ' +
            '실측: 녹화 90,584칸에서 L2 4,438건 · 시간정합 계단 54/54 어긋남 0, ' +
            '기준선(단일·현행 글꼴)은 2,168건 · 계단 22개 중 3개 어긋남.')
  });
  fs.writeFileSync(path.join(ROOT, 'config/glyphs.json'),
                   JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log('\nconfig/glyphs.json 에 buff_minutes_l2 기록 (문자 %s · 변형 %d)',
    chars, strict.glyphs.length);
}
