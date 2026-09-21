/* Pure state tests — Node, no browser, no OpenCV, no models.

   These are the AGENT_HANDOFF.md §8.1 table plus the regressions for the
   defects found on 2026-09-05. They are SYNTHETIC: they prove the decision
   logic, not real-screen accuracy. Image accuracy lives in selftest.html and
   real-screen behaviour is only what a Chrome run actually shows.

     node tools/state_tests.js
*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { console, setTimeout, clearTimeout, performance: { now: () => Date.now() } };
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['src/parse.js', 'src/state.js', 'src/display.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
/* glyphs.js 는 readLine 에서만 vision 을 쓴다 (Scope, roi). 브라우저 없이
   돌리려고 그 둘만 세워 준다. 대조 자체는 순수 함수라 그대로 검증된다. */
sandbox.ASTRA = sandbox.ASTRA || {};
sandbox.ASTRA.vision = {
  /* 실제 vision.contiguous 와 같은 판단을 한다: cv.Mat 이 아니면(우리가 만든
     평면 객체) 이미 연속이므로 사본이 필요 없다. 예전 스텁에는 이 함수가 아예
     없어서 glyphs.js 의 `Vi.contiguous ? ... : null` 가드가 항상 건너뛰었고,
     그래서 평면 객체를 넘겼을 때 터지는 결함을 Node 시험이 못 봤다. */
  contiguous: function (mat) {
    if (!mat) return null;
    if (typeof mat.copyTo !== 'function') return null;
    throw new Error('스텁은 cv.Mat 을 다루지 않는다');
  },
  Scope: function () { this.add = function (m) { return m; }; this.done = function () {}; },
  roi: function (mat, x, y, w, h) {
    const out = { rows: h, cols: w, data: new Uint8Array(w * h * 3), delete() {} };
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        for (let k = 0; k < 3; k++) {
          out.data[(r * w + c) * 3 + k] = mat.data[((y + r) * mat.cols + (x + c)) * 3 + k];
        }
      }
    }
    return out;
  }
};
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/glyphs.js'), 'utf8'), sandbox,
  { filename: 'src/glyphs.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/accumulate.js'), 'utf8'), sandbox,
  { filename: 'src/accumulate.js' });

const A = sandbox.ASTRA;
const S = A.state, D = A.display, P = A.parse, GL = A.glyphs, AC = A.accumulate;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, got, want) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL  ' + name + '\n          got:  ' + got + '\n          want: ' + want);
  }
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
/* §8.1 booster: UI disappearance + rune duration                      */
/* ------------------------------------------------------------------ */

function rune(seconds, extra) {
  return Object.assign({
    iconPresence: seconds === null ? 'UNKNOWN' : 'PRESENT',
    observedSeconds: seconds, rawText: seconds === null ? null : clock(seconds),
    resolution: 1, confidence: 0.97, reason: seconds === null ? 'rune_number_unreadable' : 'read'
  }, extra || {});
}
function clock(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

// Drive a machine with a compact script and collect every event.
function drive(steps, opts) {
  const m = new S.BoosterUiState(opts);
  const events = [], decisions = [];
  let frame = 0;
  steps.forEach(function (st) {
    if (st === 'interrupt' || (st && st.interrupt)) {
      const d = m.interrupt((st && st.interrupt) || 'test');
      if (d) decisions.push(d);
      return;
    }
    frame += 1;
    const o = { presence: st.p, frameId: st.frame === undefined ? frame : st.frame,
                capturedAt: frame * 0.5, rune: st.rune === undefined ? null : st.rune,
                reason: st.reason };
    const r = m.update(o);
    if (r.decision) decisions.push(r.decision);
    if (r.event) events.push(r.event);
  });
  return { machine: m, events: events, decisions: decisions };
}

section('§8.1  부스터 — UI 소멸 + 룬 지속시간 (합성)');

{
  const r = drive([
    { p: 'ABSENT', rune: rune(120) }, { p: 'ABSENT', rune: rune(120) },
    { p: 'ABSENT', rune: rune(120) }
  ]);
  ok('최초부터 ABSENT, 룬 2:00 → 알림 없음',
    r.events.length === 0 && r.machine.state === 'UNSEEN',
    r.events.length + '회 · ' + r.machine.state, '0회 · UNSEEN');
}

[[109, 0, '1:49'], [110, 1, '1:50'], [111, 1, '1:51'], [120, 1, '2:00']].forEach(function (c) {
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(c[0]) }, { p: 'ABSENT', rune: rune(c[0]) },
    { p: 'ABSENT', rune: rune(c[0]) }, { p: 'ABSENT', rune: rune(c[0]) }
  ]);
  ok('PRESENT 확인 → ABSENT 확인, 룬 ' + c[2] + ' → ' + c[1] + '회',
    r.events.length === c[1],
    r.events.length + '회 (' + (r.decisions.slice(-1)[0] || {}).outcome + ')', c[1] + '회');
});

{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(120) },
    { p: 'PRESENT' }, { p: 'PRESENT' }, { p: 'PRESENT' }
  ]);
  ok('PRESENT → ABSENT 1프레임 → PRESENT → 알림 없음',
    r.events.length === 0 && r.machine.state === 'VISIBLE' &&
    r.decisions.some(function (d) { return d.outcome === 'cancelled' && d.reason === 'ui_returned'; }),
    r.events.length + '회 · ' + r.machine.state, '0회 · VISIBLE');
}

{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'UNKNOWN', reason: 'share_inactive' },
    { p: 'ABSENT', rune: rune(120) }, { p: 'ABSENT', rune: rune(120) },
    { p: 'ABSENT', rune: rune(120) }
  ]);
  ok('PRESENT → UNKNOWN(공유 단절) → ABSENT → 알림 없음',
    r.events.length === 0, r.events.length + '회 · ' + r.machine.state, '0회');
}

{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    'interrupt',
    { p: 'ABSENT', rune: rune(120) }, { p: 'ABSENT', rune: rune(120) },
    { p: 'ABSENT', rune: rune(120) }
  ]);
  ok('세션/보정 중단 후 ABSENT만으로는 종료 없음',
    r.events.length === 0 && r.machine.state === 'UNSEEN',
    r.events.length + '회 · ' + r.machine.state, '0회 · UNSEEN');
}

{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(null) }, { p: 'ABSENT', rune: rune(null) },
    { p: 'ABSENT', rune: rune(null) }, { p: 'ABSENT', rune: rune(null) },
    { p: 'ABSENT', rune: rune(null) }, { p: 'ABSENT', rune: rune(null) }
  ]);
  const last = r.decisions.slice(-1)[0] || {};
  ok('소멸 확정, 룬 OCR 실패 → 유한 재판독 후 확인 불가',
    r.events.length === 0 && last.outcome === 'unverifiable' && last.retries === 3,
    r.events.length + '회 · ' + last.outcome + ' retries=' + last.retries, '0회 · unverifiable retries=3');
}

{
  // Closed as unverifiable, then a rune appears much later: the old case must
  // not be re-opened, and no new disappearance exists to judge (§4.3.7).
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(null) }, { p: 'ABSENT', rune: rune(null) },
    { p: 'ABSENT', rune: rune(null) }, { p: 'ABSENT', rune: rune(null) },
    { p: 'ABSENT', rune: rune(null) },
    { p: 'ABSENT', rune: rune(180) }, { p: 'ABSENT', rune: rune(180) },
    { p: 'ABSENT', rune: rune(180) }
  ]);
  ok('확인 불가로 종료 후 나중에 룬 등장 → 과거 건 알림 없음',
    r.events.length === 0 && r.machine.state === 'RESOLVED',
    r.events.length + '회 · ' + r.machine.state, '0회 · RESOLVED');
}

{
  // Same frame delivered twice must not count as a second observation.
  const m = new S.BoosterUiState();
  m.update({ presence: 'PRESENT', frameId: 1 });
  m.update({ presence: 'PRESENT', frameId: 2 });
  const a = m.update({ presence: 'ABSENT', frameId: 3, rune: rune(150) });
  const dup = m.update({ presence: 'ABSENT', frameId: 3, rune: rune(150) });
  const b = m.update({ presence: 'ABSENT', frameId: 4, rune: rune(150) });
  const c = m.update({ presence: 'ABSENT', frameId: 4, rune: rune(150) });
  ok('동일 프레임 중복 도착 → 알림 중복 없음',
    dup.decision.outcome === 'duplicate_frame' && !dup.event &&
    !a.event && b.event && !c.event,
    'dup=' + dup.decision.outcome + ' events=' + [a, dup, b, c].filter(function (x) { return x.event; }).length,
    'duplicate_frame · 1회');
}

{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(150) }, { p: 'ABSENT', rune: rune(150) },
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(150) }, { p: 'ABSENT', rune: rune(150) }
  ]);
  ok('새 UI 확인 후 다음 소멸 → 새 주기 알림 (총 2회)',
    r.events.length === 2 && r.events[0].disappearance_id !== r.events[1].disappearance_id,
    r.events.length + '회 · ' + r.events.map(function (e) { return e.disappearance_id; }).join(','),
    '2회 · 서로 다른 소멸건');
}

{
  // §4.3: the candidate frame's evidence is what counts. 1:50 on the frame the
  // UI vanished, already 1:49 by the confirming frame -> still one alert.
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(110) },
    { p: 'ABSENT', rune: rune(109) },
    { p: 'ABSENT', rune: rune(108) }
  ]);
  ok('후보 프레임 1:50, 확인 프레임 1:49 → 후보 근거로 1회',
    r.events.length === 1 && r.events[0].rune_seconds === 110 &&
    r.events[0].rune_from === 'candidate_frame',
    r.events.length + '회 · ' + (r.events[0] || {}).rune_seconds + 's · ' + (r.events[0] || {}).rune_from,
    '1회 · 110s · candidate_frame');
}

{
  // Mirror image: 1:49 on the candidate frame must NOT be rescued by a later
  // 1:50 reading.
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(109) },
    { p: 'ABSENT', rune: rune(110) },
    { p: 'ABSENT', rune: rune(115) }
  ]);
  ok('후보 프레임 1:49면 이후 1:50 판독으로 되살리지 않음',
    r.events.length === 0, r.events.length + '회', '0회');
}

{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: { iconPresence: 'ABSENT', observedSeconds: null, reason: 'rune_icon_absent' } },
    { p: 'ABSENT', rune: { iconPresence: 'ABSENT', observedSeconds: null, reason: 'rune_icon_absent' } }
  ]);
  const last = r.decisions.slice(-1)[0] || {};
  ok('룬 버프 없음 → 알림 없이 종료',
    r.events.length === 0 && last.outcome === 'suppressed' && last.reason === 'no_rune_buff',
    r.events.length + '회 · ' + last.outcome + '/' + last.reason, '0회 · suppressed/no_rune_buff');
}

{
  // The whole point of FIX-9: no digits are involved. A machine fed nothing but
  // presence still produces exactly one alert.
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: rune(118) }, { p: 'ABSENT', rune: rune(118) },
    { p: 'ABSENT', rune: rune(118) }, { p: 'ABSENT', rune: rune(118) },
    { p: 'ABSENT', rune: rune(118) }
  ]);
  ok('소멸 후 ABSENT가 계속돼도 알림은 정확히 1회',
    r.events.length === 1, r.events.length + '회', '1회');
}

section('§4.4  룬 버프 미확인 상태');
{
  const r = drive([
    { p: 'PRESENT' }, { p: 'PRESENT' },
    { p: 'ABSENT', rune: { iconPresence: 'UNKNOWN', observedSeconds: null, reason: 'rune_buff_not_identified' } },
    { p: 'ABSENT', rune: { iconPresence: 'UNKNOWN', observedSeconds: null, reason: 'rune_buff_not_identified' } },
    { p: 'ABSENT', rune: { iconPresence: 'UNKNOWN', observedSeconds: null, reason: 'rune_buff_not_identified' } },
    { p: 'ABSENT', rune: { iconPresence: 'UNKNOWN', observedSeconds: null, reason: 'rune_buff_not_identified' } },
    { p: 'ABSENT', rune: { iconPresence: 'UNKNOWN', observedSeconds: null, reason: 'rune_buff_not_identified' } }
  ]);
  const last = r.decisions.slice(-1)[0] || {};
  ok('룬 아이콘 미확인이면 추측 없이 "확인 불가"로 닫힘',
    r.events.length === 0 && last.outcome === 'unverifiable' &&
    last.reason === 'rune_buff_not_identified',
    r.events.length + '회 · ' + last.outcome + '/' + last.reason,
    '0회 · unverifiable/rune_buff_not_identified');
}

section('§4.2  관측 게이트 (순수 함수)');
{
  const cases = [
    [{ presence: 'ABSENT', shareInactive: true }, 'UNKNOWN', 'share_inactive'],
    [{ presence: 'ABSENT', calibrating: true }, 'UNKNOWN', 'calibrating'],
    [{ presence: 'ABSENT', calibrationMismatch: true }, 'UNKNOWN', 'calibration_changed'],
    [{ presence: 'ABSENT', sessionMismatch: true }, 'UNKNOWN', 'session_changed'],
    [{ presence: 'ABSENT', frameValid: false, frameReason: 'black_surface' }, 'UNKNOWN', 'frame_black_surface'],
    [{ presence: 'ABSENT', ageSeconds: 9, maxAgeSeconds: 3 }, 'UNKNOWN', 'result_stale'],
    [{ presence: 'ABSENT', frameValid: true, ageSeconds: 0.2 }, 'ABSENT', null],
    [{ presence: 'PRESENT', frameValid: true, ageSeconds: 0.2 }, 'PRESENT', null]
  ];
  let good = true, detail = [];
  cases.forEach(function (c) {
    const g = S.gateObservation(c[0]);
    const hit = g.presence === c[1] && (c[2] === null || g.reason === c[2]);
    if (!hit) good = false;
    detail.push(g.presence + '/' + g.reason);
  });
  ok('불확실 조건은 모두 UNKNOWN, 정상만 통과', good, detail.join(' '), '8/8');
}

/* ------------------------------------------------------------------ */
section('§8.1  경험치');

{
  const s = new S.ExperienceState();
  let fired = 0;
  for (let i = 0; i < 90; i++) if (s.update('100', i * 0.1)) fired++;
  ok('정체 알림 1회', fired === 1, fired, '1');
}
{
  // FIX-1. The gap must be longer than options.maxGapSeconds (2.0 s) so that
  // it really does force a re-baseline - otherwise the test would pass without
  // exercising the re-arm path at all.
  const f = new S.ExperienceState();
  let fired = 0;
  for (let t = 0; t < 400; t++) {
    if (t > 100 && t < 135) continue;          // 3.4 s capture gap
    if (f.update('100', t * 0.1)) fired++;
  }
  ok('FIX-1 캡처 끊김(3.4초)이 알림을 재무장하지 않음', fired === 1, fired, '1');
  ok('FIX-1 그 끊김이 실제로 재기준선을 유발했는지 확인',
    S.options.maxGapSeconds < 3.4, S.options.maxGapSeconds + 's < 3.4s', 'true');
}
{
  // FIX-7 (§3.7 / §6.1): 100 held to a stall, then a misread drops to 99 and
  // holds. The 2026-09-05 build alerted twice (7.1 s and 16.1 s).
  const s = new S.ExperienceState();
  const at = [];
  for (let t = 0; t <= 100; t++) if (s.update('100', t * 0.1)) at.push(+(t * 0.1).toFixed(1));
  for (let t = 101; t <= 300; t++) if (s.update('99', t * 0.1)) at.push(+(t * 0.1).toFixed(1));
  ok('FIX-7 정체 후 감소·오인식이 정체 알림을 재무장하지 않음',
    at.length === 1, at.length + '회 @ ' + at.join(','), '1회');
}
{
  // A real increase still re-arms.
  const s = new S.ExperienceState();
  const at = [];
  for (let t = 0; t <= 100; t++) if (s.update('100', t * 0.1)) at.push('a');
  s.update('101', 10.1); s.update('101', 10.2);
  for (let t = 103; t <= 300; t++) if (s.update('101', t * 0.1)) at.push('b');
  ok('실제 증가는 재무장한다 (2회)', at.length === 2, at.length + '회', '2회');
}

/* ------------------------------------------------------------------ */
section('§8.1  비약 수명');

{
  // §3.4 exactly: 900 s left, then the icon is gone for good.
  const g = new S.BuffExpiry(5);
  const fired = [];
  if (g.update({ iconPresent: true, remaining: 900, now: 0, observable: true })) fired.push(0);
  for (let t = 0.5; t <= 1200; t += 0.5) {
    if (g.update({ iconPresent: false, remaining: null, now: t, observable: true })) fired.push(t);
  }
  ok('FIX-8 900초 남은 상태의 조기 소멸 → 이후 지연 종료 알림 없음',
    fired.length === 0 && g.status === 'UNKNOWN' && g.closed === true,
    fired.length + '회 @ ' + fired.join(',') + ' · ' + g.status, '0회 · UNKNOWN(closed)');
}
{
  // The legitimate ending still fires exactly once.
  const g = new S.BuffExpiry(5);
  const fired = [];
  const steps = [
    { iconPresent: true, remaining: 1740, now: 0, observable: true },
    { iconPresent: true, remaining: 6, now: 1734, observable: true },
    { iconPresent: true, remaining: null, now: 1737, observable: true },
    { iconPresent: true, remaining: null, now: 1739, observable: true },
    { iconPresent: false, remaining: null, now: 1741, observable: true },
    { iconPresent: false, remaining: null, now: 1742, observable: true },
    { iconPresent: false, remaining: null, now: 1744, observable: true }
  ];
  steps.forEach(function (s) { if (g.update(s)) fired.push(s.now); });
  ok('FIX-6 최종 구간 뒤 아이콘 소멸 → 1회', fired.length === 1 && g.status === 'ENDED',
    fired.length + '회 · ' + g.status, '1회 · ENDED');
}
{
  // Covered, then gone: unverifiable, never "ended".
  const g = new S.BuffExpiry(5);
  const fired = [];
  /* 가림을 **2프레임**으로 둔다. 규칙의 취지("못 본 사이의 일을 종료로
     단정하지 말라")는 그대로이고, 판정 기준만 '한 번이라도'에서 '이어질
     때'로 좁혔다. 한 프레임 결손까지 중단으로 보면, 판독이 없는 마지막 5초
     구간에서 그것을 풀 방법이 없어 비약 알림이 영영 사라진다 (사용자 반복
     보고, 2026-09-07). 시간이 넉넉히 남은 채 사라지는 경우는 여전히
     예측값 검사(pred <= hideBelow + 2)가 막는다. */
  [{ iconPresent: true, remaining: 3, now: 0, observable: true },
   { iconPresent: true, remaining: null, now: 1, observable: true },
   { iconPresent: false, remaining: null, now: 2, observable: false },
   { iconPresent: false, remaining: null, now: 3, observable: false },
   { iconPresent: false, remaining: null, now: 4, observable: true },
   { iconPresent: false, remaining: null, now: 6, observable: true }
  ].forEach(function (s) { if (g.update(s)) fired.push(s.now); });
  ok('가림 중 소멸은 종료가 아니라 확인 불가',
    fired.length === 0 && g.status === 'UNKNOWN' && g.reason === 'icon_gone_after_interruption',
    fired.length + '회 · ' + g.status + '/' + g.reason, '0회 · UNKNOWN/icon_gone_after_interruption');
}
{
  const t = new S.TimerState('wealth');
  t.maxSeconds = 1800;
  const a = t.observe(12000, 0, 60);
  const b = t.observe(15000, 1, 60);
  const c = t.observe(1140, 2, 60);
  ok('FIX-4 검증 상한(1800초) 초과 판독은 계속 거부 (200분/250분)',
    !a.accepted && a.reason === 'above_max' && !b.accepted && c.accepted,
    [a.reason, b.reason, c.accepted].join('/'), 'above_max/above_max/true');
}

/* ------------------------------------------------------------------ */
section('표시 전용 카운트다운 (2026-09-06 사용자 요청)');

{
  const d = new D.DisplayCountdown({ seconds: 99, decimals: 2, overrunSeconds: 1 });
  d.start(1000, 'a');
  ok('부스터 탐지 즉시 99.00초부터', d.text(1000) === '99.00초', d.text(1000), '99.00초');
  ok('0.01초 단위 표시', d.text(1000.005) === '99.00초' && d.text(1012.34) === '86.66초',
    d.text(1012.34), '86.66초');
  ok('99초 지점에서 0.00초', d.text(1099) === '0.00초', d.text(1099), '0.00초');
  ok('100초 경과 후 서버 지연 텍스트', d.text(1100).indexOf('서버 지연 대기중') === 0,
    d.text(1100), '서버 지연 대기중 …');
  const dots = [d.text(1100), d.text(1100.5), d.text(1101), d.text(1101.5)];  // waiting starts at 1100
  ok('점은 0.5초마다 . → . . → . . . → . 순환',
    dots[0].endsWith(' .') && dots[1].endsWith('. .') && dots[2].endsWith('. . .') &&
    dots[3] === dots[0],
    dots.map(function (x) { return JSON.stringify(x.slice(9)); }).join(' '), '. / . . / . . . / .');
  d.sync(true, 1200, 'a');
  ok('같은 탐지 중에는 재시작하지 않음', d.startedAt === 1000, d.startedAt, '1000');
  d.sync(true, 1300, 'b');
  ok('새 탐지(토큰 변경)면 재시작', d.startedAt === 1300, d.startedAt, '1300');
  d.sync(false, 1400, 'b');
  ok('사라지면 표시 중단', d.text(1400) === null && d.state(1400) === 'idle',
    String(d.text(1400)), 'null');

  // 싱크: 화면 숫자 1회 판독으로 위치를 맞춘 뒤 자동 타이머 (2026-09-06 사용자 요청)
  const sy = new D.DisplayCountdown({ seconds: 99, decimals: 2, overrunSeconds: 1 });
  sy.start(0, 's');
  ok('싱크 전에는 counting_unsynced', sy.state(1) === 'counting_unsynced', sy.state(1), 'counting_unsynced');
  sy.syncTo(35.91, 10);
  ok('싱크하면 그 시점 잔여가 정확히 일치', sy.text(10) === '35.91초', sy.text(10), '35.91초');
  ok('싱크 후 자동으로 흘러감', sy.text(15) === '30.91초', sy.text(15), '30.91초');
  ok('싱크 후 상태는 counting', sy.state(15) === 'counting', sy.state(15), 'counting');
  ok('싱크 기준으로 0에 도달하면 서버 지연',
    sy.text(10 + 35.91 + 1.01).indexOf('서버 지연 대기중') === 0,
    sy.text(10 + 35.91 + 1.01), '서버 지연 대기중 …');

  // 비약: 분 표시가 바뀌는 순간 재싱크하면 값이 정확해진다
  const wm = new D.DisplayCountdown({ seconds: 1800, decimals: 0, overrunSeconds: 0, format: 'clock' });
  wm.start(0, 'w');
  wm.syncTo(1799, 0);                       // "29" -> 29:59
  ok('비약 첫 싱크 29:59', wm.text(0) === '29:59', wm.text(0), '29:59');
  wm.syncTo(1739, 60);                      // 60초 뒤 "28"로 바뀌는 순간 재싱크
  ok('숫자 변화 시 재싱크로 정확해짐', wm.text(60) === '28:59' && wm.syncs === 2,
    wm.text(60) + ' · 싱크 ' + wm.syncs + '회', '28:59 · 2회');
  ok('재싱크 후에도 자동으로 흘러감', wm.text(90) === '28:29', wm.text(90), '28:29');
}
{
  const w = new D.DisplayCountdown({ seconds: 1800, decimals: 0, overrunSeconds: 0, format: 'clock' });
  w.start(0, 'p1');
  ok('비약 탐지 즉시 30:00', w.text(0) === '30:00', w.text(0), '30:00');
  ok('1초 단위 표시', w.text(1) === '29:59' && w.text(61) === '28:59',
    w.text(1) + '/' + w.text(61), '29:59/28:59');
  /* 1분 미만은 "0:04" 가 아니라 "4초" 로 쓴다. 게임이 그렇게 그리고(녹화
     전수조사: 노란 가운데 맨숫자는 언제나 1분 미만의 초), 사용자 지시
     2026-09-07 "5, 4, 3, 2, 1 초가 전부 표시되어야" 도 그 표기를 말한다.
     기대값을 바꾼 것은 표기 규칙이 바뀌었기 때문이고, 세는 값 자체는 같다. */
  ok('마지막 5초 구간도 계속 표시 (게임 숫자는 사라짐)', w.text(1796) === '4초', w.text(1796), '4초');
  ok('1800초 경과 후 서버 지연 텍스트', w.text(1800).indexOf('서버 지연 대기중') === 0,
    w.text(1800), '서버 지연 대기중 …');
}

{
  // Blink tolerance for the presentation countdowns.
  function run(seq, misses) {
    const p = new D.StickyPresence(misses);
    return { trace: seq.map(function (v) { return p.update(v) ? 'on' : 'off'; }).join(' '),
             sightings: p.sighting };
  }
  const blink = run([true, true, false, true, true], 2);
  ok('한 프레임 깜빡임은 표시 카운트다운을 재시작시키지 않음',
    blink.trace === 'on on on on on' && blink.sightings === 1,
    blink.trace + ' · sightings=' + blink.sightings, 'on×5 · sightings=1');
  const gone = run([true, true, false, false, false], 2);
  ok('실제 소멸(2회 연속 부재)이면 표시 중단',
    gone.trace === 'on on on off off', gone.trace, 'on on on off off');
  const unk = run([true, null, null, true], 2);
  ok('관측 불가(null)는 표시를 끄지 않음',
    unk.trace === 'on on on on' && unk.sightings === 1, unk.trace, 'on×4');
  const again = run([true, false, false, true], 2);
  ok('사라졌다 다시 나타나면 새 표시 주기',
    again.sightings === 2, 'sightings=' + again.sightings, '2');
  const never = run([false, false, false], 2);
  ok('한 번도 없으면 표시 시작하지 않음',
    never.trace === 'off off off' && never.sightings === 0,
    never.trace + ' · sightings=' + never.sightings, 'off×3 · sightings=0');
}

/* ------------------------------------------------------------------ */
section('경험치 활동 감지 (숫자 대신 화면 변화)');
{
  function run(steps, stall) {
    const a = new S.ExperienceActivity(stall)   // 기본값(state.js)을 그대로 시험한다;
    const fired = [];
    steps.forEach(function (s2) { if (a.update(s2)) fired.push(s2.now); });
    return { a: a, fired: fired };
  }
  const obs = function (changed, now) { return { changed: changed, now: now, observable: true }; };

  // 계속 변함 = 사냥 중
  let steps = [];
  for (let t = 0; t <= 200; t++) steps.push(obs(true, t * 0.5));
  let r = run(steps);
  ok('계속 변하면 정체 알림 없음', r.fired.length === 0 && r.a.status === 'TRACKING',
    r.fired.length + '회 · ' + r.a.status, '0회 · TRACKING');

  // 멈춤 = 8초 뒤 정확히 1회 (7초에는 아직 울리지 않는다)
  steps = [obs(true, 0)];
  for (let t = 1; t <= 60; t++) steps.push(obs(false, t * 0.5));
  r = run(steps);
  ok('8초 무변화면 정확히 1회', r.fired.length === 1 && Math.abs(r.fired[0] - 8) < 0.6,
    r.fired.length + '회 @ ' + r.fired[0] + '초', '1회 @ 8초');

  // 다시 변하면 재무장, 또 멈추면 다시 1회
  steps = [obs(true, 0)];
  for (let t = 1; t <= 30; t++) steps.push(obs(false, t * 0.5));
  steps.push(obs(true, 16));
  for (let t = 1; t <= 30; t++) steps.push(obs(false, 16 + t * 0.5));
  r = run(steps);
  ok('실제 변화가 재무장한다 (총 2회)', r.fired.length === 2, r.fired.length + '회', '2회');

  // 관측 불가 구간은 정체로 세지 않는다 (스트림 정지·가림)
  steps = [obs(true, 0)];
  for (let t = 1; t <= 20; t++) steps.push({ changed: null, now: t * 0.5, observable: false, reason: 'stream_frozen' });
  for (let t = 21; t <= 30; t++) steps.push(obs(false, t * 0.5));
  r = run(steps);
  ok('관측 불가 시간은 정체로 누적되지 않음', r.fired.length === 0,
    r.fired.length + '회 · 무변화 ' + r.a.idleSeconds.toFixed(1) + '초', '0회');

  // 한 번 울린 뒤 관측 공백이 생겨도 다시 울리지 않는다
  steps = [obs(true, 0)];
  for (let t = 1; t <= 40; t++) steps.push(obs(false, t * 0.5));
  steps.push({ changed: null, now: 21, observable: false });
  for (let t = 1; t <= 40; t++) steps.push(obs(false, 21 + t * 0.5));
  r = run(steps);
  ok('관측 공백이 정체 알림을 재무장하지 않음', r.fired.length === 1, r.fired.length + '회', '1회');
}

/* ------------------------------------------------------------------ */
section('문법');
{
  ok('parse_experience 점 구분자', P.parseExperience('79.580.389.573.127[72.700%]') === '79580389573127',
    P.parseExperience('79.580.389.573.127[72.700%]'), '79580389573127');
  ok('parse_experience 불완전 문자열 거부', P.parseExperience('79,58 [72.7%]') === null,
    String(P.parseExperience('79,58 [72.7%]')), 'null');

  // Punctuation tolerance, from real 2026-09-06 readings of the user's screen.
  // The structure (grouped integer + decimal percentage) is still mandatory.
  const punct = [
    ['92,710.139.487.918[84.695%', '92710139487918'],
    ['92,710.139.487.91894.695%', '92710139487918'],
    ['92,710.139.487.918 (84.695%)', '92710139487918'],
    ['92,710.139.487.918[84.695%1', '92710139487918'],
    ['92,710.162.959.063184.6958]', '92710162959063']
  ];
  ok('OCR 괄호·% 변형을 같은 값으로 판독',
    punct.every(function (c) { return P.parseExperience(c[0]) === c[1]; }),
    punct.map(function (c) { return String(P.parseExperience(c[0])); }).join(' '),
    punct.map(function (c) { return c[1]; }).join(' '));

  const rejects = [
    '92,710.15.918.778[84.695%]',   // a thousands group lost a digit
    '92,710.139.487.918',           // no percentage at all
    '[84.695%]',                    // no integer
    '92,710.139.487.918[184.695%]'  // percentage out of range
  ];
  ok('구조가 깨진 문자열은 여전히 거부',
    rejects.every(function (t) { return P.parseExperience(t) === null; }),
    rejects.map(function (t) { return String(P.parseExperience(t)); }).join(' '),
    'null null null null');
  ok('parse_time 9:59', P.parseTime('9:59', 'clock') === 599, P.parseTime('9:59', 'clock'), '599');
  ok('parse_time 1:50 = 110초', P.parseTime('1:50', 'clock') === 110, P.parseTime('1:50', 'clock'), '110');
  ok('parse_time 1:49 = 109초', P.parseTime('1:49', 'clock') === 109, P.parseTime('1:49', 'clock'), '109');
  // 분:59 규칙 — 분만 보이면 그 분의 끝을 뜻한다 (사용자 확인 2026-09-06)
  ok('분 표시 "29" = 29:59 (1799초)', P.parseTime('29', 'minutes') === 1799,
    P.parseTime('29', 'minutes'), '1799');
  ok('분 표시 "1" = 1:59 (119초)', P.parseTime('1', 'minutes') === 119,
    P.parseTime('1', 'minutes'), '119');
  ok('초 표시는 그대로', P.parseTime('29', 'seconds') === 29, P.parseTime('29', 'seconds'), '29');
}

/* ------------------------------------------------------------------ */
/* 글꼴 아틀라스 — 버프 아이콘 숫자 두 종류                            */
/* ------------------------------------------------------------------ */

section('글꼴 대조 (합성)');
{
  const toy = new GL.Font('toy', {
    height: 4,
    segmentation: 'runs', tolerance: 1, margin: 2,
    run_width: [1, 8], full_height_runs: true,
    glyphs: { A: ['111', '100', '100', '111'], B: ['111', '101', '101', '111'] }
  });
  function bits(rows) {
    const w = rows[0].length, h = rows.length, b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = rows[y][x] === '1' ? 1 : 0;
    return { w: w, h: h, bits: b };
  }
  const gA = toy.glyphs.filter(function (g) { return g.ch === 'A'; })[0];
  ok('완전 일치는 거리 0', GL.bitDistance(bits(['111', '100', '100', '111']), gA) === 0,
    GL.bitDistance(bits(['111', '100', '100', '111']), gA), '0');
  ok('A 와 B 는 2픽셀 차이', GL.bitDistance(bits(['111', '101', '101', '111']), gA) === 2,
    GL.bitDistance(bits(['111', '101', '101', '111']), gA), '2');

  // 두 후보가 똑같이 가까우면 격차가 0이라 거부해야 한다.
  const ambiguous = bits(['111', '100', '101', '111']);
  ok('두 후보가 똑같이 가까우면 추측하지 않고 거부',
    GL.matchGlyph(ambiguous, toy) === null, String(GL.matchGlyph(ambiguous, toy)), 'null');

  // 한 픽셀만 흔들린 A 는 A 로 읽혀야 한다 (B 와는 3픽셀 차이).
  const wobbly = bits(['111', '100', '100', '110']);
  ok('테두리 한 픽셀 흔들림은 봐준다', GL.matchGlyph(wobbly, toy) === 'A',
    String(GL.matchGlyph(wobbly, toy)), 'A');
  const strictFont = new GL.Font('strict', {
    height: 4, segmentation: 'runs', tolerance: 0, margin: 1,
    glyphs: { A: ['111', '100', '100', '111'] } });
  ok('허용오차 0 글꼴은 그 흔들림도 거부',
    GL.matchGlyph(wobbly, strictFont) === null,
    String(GL.matchGlyph(wobbly, strictFont)), 'null');
}

section('글꼴 아틀라스 — 실화면 버프 칸');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/glyphs.json'), 'utf8'));
  const atlas = new GL.Atlas(cfg);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/buff_cells.json'), 'utf8'));
  const bin = fs.readFileSync(path.join(ROOT, 'tools/fixtures/buff_cells.bin'));

  function matOf(c) {
    return { rows: man.rows, cols: c.crop_w, delete: function () {},
             data: new Uint8Array(bin.buffer, bin.byteOffset + c.offset, man.rows * c.crop_w * 3) };
  }
  const shipped = { yellow: atlas.font('buff_yellow'), minutes: atlas.font('buff_minutes') };
  ok('두 글꼴이 config 에 실려 있다', !!shipped.yellow && !!shipped.minutes,
    Object.keys(cfg.fonts).join(','), 'exp,buff_yellow,buff_minutes');

  let good = 0, refused = 0, wrong = 0; const bad = [];
  man.cells.forEach(function (c) {
    const f = shipped[c.font];
    const r = f ? GL.readLine(matOf(c), null, f, {}) : null;
    const got = (r && r.ok) ? r.text : null;
    if (got === c.text) good++;
    else if (got === null) { refused++; bad.push(c.source + '@' + c.x + ' "' + c.text + '" 거부'); }
    else { wrong++; bad.push(c.source + '@' + c.x + ' "' + c.text + '" -> "' + got + '"'); }
  });
  ok('실화면 ' + man.cells.length + '칸을 전부 정확히 읽는다', good === man.cells.length,
    good + '/' + man.cells.length + ' (거부 ' + refused + ', 오판독 ' + wrong + ') ' + bad.join(' · '),
    man.cells.length + '/' + man.cells.length);
  ok('오판독은 한 건도 없다', wrong === 0, wrong, '0');

  const clockCells = man.cells.filter(function (c) { return c.text.indexOf(':') >= 0; });
  const clockOk = clockCells.every(function (c) {
    const r = GL.readLine(matOf(c), null, shipped.yellow, {});
    return r && r.ok && r.text === c.text;
  });
  ok('콜론을 잉크가 아니라 간격으로 복원한다 (' + clockCells.length + '칸)',
    clockOk, String(clockOk), 'true');

  /* 프레임 단위 leave-one-out: 한 화면을 통째로 빼고 아틀라스를 다시 만들어
     그 화면을 읽는다. 처음 보는 프레임에서 무엇이 일어나는지가 여기 나온다. */
  function buildFrom(cells, spec, name) {
    const f = new GL.Font(name, Object.assign({}, spec, { glyphs: {} }));
    const seen = new Map();
    cells.forEach(function (c) {
      const mat = matOf(c), mask = GL.inkMask(mat, f.ink);
      const digits = c.text.split('').filter(function (x) { return x >= '0' && x <= '9'; });
      GL.bandCandidates(mask, mat.cols, mat.rows, f.height, f.minRunWidth, f).forEach(function (band) {
        if (band.runs.length !== digits.length) return;
        const sub = mask.subarray(band.y * mat.cols, (band.y + f.height) * mat.cols);
        band.runs.forEach(function (r, i) {
          const b = GL.runBits(sub, mat.cols, f.height, r[0], r[1]);
          seen.set(digits[i] + '|' + b.w + ':' + Array.from(b.bits).join(''), { ch: digits[i], b: b });
        });
      });
    });
    seen.forEach(function (e) { f.add(e.ch, e.b.bits, e.b.w, e.b.h); });
    return f;
  }
  const frames = Array.from(new Set(man.cells.map(function (c) { return c.source; })));
  let loWrong = 0, loGood = 0, loRef = 0;
  frames.forEach(function (held) {
    const train = man.cells.filter(function (c) { return c.source !== held; });
    const fonts = {
      yellow: buildFrom(train.filter(function (c) { return c.font === 'yellow'; }),
        cfg.fonts.buff_yellow, 'y'),
      minutes: buildFrom(train.filter(function (c) { return c.font === 'minutes'; }),
        cfg.fonts.buff_minutes, 'm')
    };
    man.cells.filter(function (x) { return x.source === held; }).forEach(function (c) {
      const r = GL.readLine(matOf(c), null, fonts[c.font], {});
      const got = (r && r.ok) ? r.text : null;
      if (got === c.text) loGood++; else if (got === null) loRef++; else loWrong++;
    });
  });
  /* 이것이 핵심 안전 성질이다: 처음 보는 화면에서 아틀라스에 없는 변형을
     만나면 **거부**할 뿐, 비슷한 글자로 찍지 않는다. 거부하면 OCR이 받아
     읽고 그 값으로 변형을 배운다. */
  ok('처음 보는 프레임에서도 오판독 0 (거부 ' + loRef + ', 정답 ' + loGood + ')',
    loWrong === 0, loWrong, '0');
  ok('처음 보는 프레임 정답률이 절반은 넘는다',
    loGood > man.cells.length / 2, loGood + '/' + man.cells.length,
    '> ' + Math.floor(man.cells.length / 2));
}

section('글꼴 학습 (OCR 대체 경로)');
{
  const spec = { height: 4, segmentation: 'runs', tolerance: 0, margin: 1,
                 run_width: [1, 8], learn_variants: true, glyphs: {} };
  const f = new GL.Font('learn', spec);
  ok('빈 글꼴은 아무것도 모른다', f.glyphs.length === 0, f.glyphs.length, '0');
  const b1 = new Uint8Array([1, 1, 1, 0, 1, 0, 1, 1]);            // 2x4
  const res = { text: ' ', unknownBitmaps: [{ index: 0, textIndex: 0, w: 2, h: 4, bits: b1 }] };
  ok('OCR 값으로 모르는 글리프를 배운다', GL.learnFrom(res, '7', f) === 1 && f.has('7'),
    f.glyphs.map(function (g) { return g.ch; }).join(''), '7');
  ok('같은 비트맵을 다시 배우지 않는다', GL.learnFrom(res, '7', f) === 0,
    GL.learnFrom(res, '7', f), '0');
  const b2 = new Uint8Array([1, 1, 1, 1, 1, 0, 1, 1]);
  const res2 = { text: ' ', unknownBitmaps: [{ index: 0, textIndex: 0, w: 2, h: 4, bits: b2 }] };
  ok('learn_variants 면 같은 글자의 새 변형도 배운다',
    GL.learnFrom(res2, '7', f) === 1 && f.glyphs.length === 2, f.glyphs.length, '2');
  const strict = new GL.Font('strict', Object.assign({}, spec, { learn_variants: false }));
  GL.learnFrom(res, '7', strict);
  ok('learn_variants 가 없으면 새 변형은 배우지 않는다',
    GL.learnFrom(res2, '7', strict) === 0 && strict.glyphs.length === 1, strict.glyphs.length, '1');
  ok('길이가 다르면 아무것도 배우지 않는다',
    GL.learnFrom({ text: '  ', unknownBitmaps: res.unknownBitmaps }, '7',
      new GL.Font('x', spec)) === 0, 'ok', '0');
}

/* ------------------------------------------------------------------ */
/* L2 시간 누적 / L3 전체 탐색                                          */
/* ------------------------------------------------------------------ */

section('L2 누적기');
{
  // 32x8 짜리 가짜 칸. 값 = 밝기, 잡음은 ±n 으로 흔든다.
  const W = 8, H = 4, N = W * H * 3;
  function frame(base, noise, seed) {
    const d = new Uint8Array(N);
    let r = seed || 1;
    for (let i = 0; i < N; i++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const jitter = noise ? ((r % (2 * noise + 1)) - noise) : 0;
      d[i] = Math.max(0, Math.min(255, base + jitter));
    }
    return { rows: H, cols: W, data: d };
  }
  /* 잡음 폭은 실측에 맞춘다. 누적 평균 대비 화소차가 같은 값 구간에서 최대
     5.70, 값이 바뀌는 경계에서 8.29였고 그래서 임계가 6이다. 임계보다 큰
     잡음을 주면 누적기가 매번 초기화되는 것이 정상이고, 그건 평균 성능이
     아니라 초기화 경로를 시험하는 것이 된다. ±8 이면 평균 절대차 약 4로
     실제 코덱 잡음과 비슷하다. */
  const acc = new AC.Accumulator({ maxFrames: 8, changeThreshold: 6 });
  for (let i = 0; i < 8; i++) acc.push(frame(120, 8, i + 1));
  ok('여덟 장을 모았다', acc.count() === 8, acc.count(), '8');
  const mean = acc.mean();
  let dev = 0;
  for (let i = 0; i < N; i++) dev += Math.abs(mean.data[i] - 120);
  dev /= N;
  /* 잡음이 평균으로 줄어드는 것이 L2 의 전부다. 한 장이면 평균 ±10 근처,
     여덟 장 평균이면 그보다 뚜렷이 작아야 한다. */
  const one = frame(120, 8, 99);
  let dev1 = 0;
  for (let i = 0; i < N; i++) dev1 += Math.abs(one.data[i] - 120);
  dev1 /= N;
  ok('평균이 단일 프레임보다 참값에 가깝다 (' + dev1.toFixed(2) + ' -> ' + dev.toFixed(2) + ')',
    dev < dev1 * 0.7, dev.toFixed(2), '< ' + (dev1 * 0.7).toFixed(2));

  // 내용이 바뀌면 누적을 버린다
  const before = acc.count();
  const r = acc.push(frame(200, 5, 7));
  ok('내용이 바뀌면 누적을 버린다', r.changed === true && acc.count() === 1,
    'changed=' + r.changed + ' count=' + acc.count(), 'changed=true count=1');
  // 잡음만으로는 버리지 않는다
  const acc2 = new AC.Accumulator({ maxFrames: 8, changeThreshold: 6 });
  let spurious = 0;
  for (let i = 0; i < 20; i++) { if (acc2.push(frame(120, 8, i + 1)).changed) spurious++; }
  ok('잡음만으로는 거의 버리지 않는다', spurious <= 2, spurious + '회', '<= 2회');

  ok('크기가 바뀌면 스스로 초기화한다',
    (function () {
      const a = new AC.Accumulator({});
      a.push(frame(100, 0, 1));
      a.push({ rows: 2, cols: 2, data: new Uint8Array(12) });
      return a.count() === 1 && a.w === 2;
    })(), 'ok', 'true');
}

section('L2/L3 층 판독기');
{
  /* 두 문자짜리 장난감 글꼴. 잉크는 밝기 임계라 잡음에 흔들린다.
     L2 는 평균 낸 뒤 허용오차 0 으로, L3 는 단일 프레임을 허용오차 2 로 읽는다. */
  const glyphs = { A: ['1110', '1000', '1000', '1110'], B: ['1110', '1010', '1010', '1110'] };
  const strict = new GL.Font('strict', {
    height: 4, ink: { kind: 'min_rgb', min: 128 }, segmentation: 'runs',
    tolerance: 0, margin: 1, run_width: [1, 8], min_run_width: 1, glyphs: glyphs });
  const loose = new GL.Font('loose', {
    height: 4, ink: { kind: 'min_rgb', min: 128 }, segmentation: 'runs',
    tolerance: 2, margin: 2, run_width: [1, 8], min_run_width: 1, glyphs: glyphs });

  // 'A' 를 그린 6x4 칸 (오른쪽 두 열은 여백)
  function draw(noise, seed) {
    const rows = glyphs.A, W = 6, H = 4, d = new Uint8Array(W * H * 3);
    let r = seed || 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const on = x < 4 && rows[y].charAt(x) === '1';
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        const j = noise ? ((r % (2 * noise + 1)) - noise) : 0;
        const v = Math.max(0, Math.min(255, (on ? 200 : 40) + j));
        const i = (y * W + x) * 3;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    return { rows: H, cols: W, data: d };
  }

  const rd = new AC.LayeredReader({ strictFont: strict, looseFont: loose, maxFrames: 8 });
  let first = rd.read(draw(0, 1));
  ok('첫 프레임은 L3 (아직 평균할 것이 없다)', first.ok && first.layer === 'L3',
    first.layer, 'L3');
  let last = null;
  for (let i = 0; i < 6; i++) last = rd.read(draw(0, i + 2));
  ok('쌓이면 L2 로 읽는다', last.ok && last.layer === 'L2' && last.text === 'A',
    last.layer + ' "' + last.text + '"', 'L2 "A"');
  ok('L2 가 평균한 장수를 보고한다', last.averaged >= 2, last.averaged, '>= 2');

  // 아무 글꼴도 없으면 거부한다 (추측하지 않는다)
  const none = new AC.LayeredReader({ strictFont: null, looseFont: null });
  const r0 = none.read(draw(0, 1));
  ok('글꼴이 없으면 거부한다', r0.ok === false, String(r0.ok), 'false');

  ok('통계가 층별로 쌓인다', rd.stats.l2 + rd.stats.l3 === rd.stats.frames,
    rd.stats.l2 + '+' + rd.stats.l3 + ' vs ' + rd.stats.frames, '같아야 함');
}

section('L2 글꼴이 config 에 실려 있다');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/glyphs.json'), 'utf8'));
  const f = cfg.fonts.buff_minutes_l2;
  ok('buff_minutes_l2 존재', !!f, Object.keys(cfg.fonts).join(','),
    'exp,buff_yellow,buff_minutes,buff_minutes_l2');
  if (f) {
    ok('L2 글꼴은 허용오차 0 이다 (평균 이미지 전용)', f.tolerance === 0, f.tolerance, '0');
    const chars = Array.from(new Set(Object.keys(f.glyphs).map(k => k.split('#')[0]))).sort().join('');
    ok('숫자 0~9 를 전부 안다', chars === '0123456789', chars, '0123456789');
    const base = Array.from(new Set(Object.keys(cfg.fonts.buff_minutes.glyphs)
      .map(k => k.split('#')[0]))).sort().join('');
    /* 기존 buff_minutes 는 L3 대비책으로 남아 있어야 한다. 여기를 건드리면
       L2 가 실패했을 때 돌아갈 곳이 없어진다. */
    ok('기존 buff_minutes 는 L3 대비책으로 남아 있다', base === '0123', base, '0123');
  }
}

section('평면 이미지 객체를 그대로 읽을 수 있다 (L2 회귀)');
{
  /* L2 는 누적 평균을 {rows, cols, data} 평면 객체로 만들어 readLine 에 넘긴다.
     vision.contiguous 가 그것을 cv.Mat 으로 가정하면 "mat.copyTo is not a
     function" 으로 hud/buffs 워커가 죽는다 — 실제로 그렇게 죽었다. */
  const font = new GL.Font('plain', {
    height: 4, ink: { kind: 'min_rgb', min: 128 }, segmentation: 'runs',
    tolerance: 0, margin: 1, run_width: [1, 8], min_run_width: 1,
    glyphs: { A: ['1110', '1000', '1000', '1110'] } });
  const W = 6, H = 4, d = new Uint8Array(W * H * 3);
  const rows = ['1110', '1000', '1000', '1110'];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (x < 4 && rows[y].charAt(x) === '1') ? 200 : 40;
      const i = (y * W + x) * 3;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  const plain = { rows: H, cols: W, data: d };
  let err = null, r = null;
  try { r = GL.readLine(plain, null, font, {}); } catch (e) { err = String(e.message || e); }
  ok('평면 객체로 readLine 이 예외를 내지 않는다', err === null, err || 'ok', '예외 없음');
  ok('평면 객체를 정확히 읽는다', !!(r && r.ok && r.text === 'A'),
    r ? r.text : 'null', 'A');

  // 누적 평균 이미지도 같은 모양이어야 한다
  const acc = new AC.Accumulator({});
  acc.push(plain);
  const avg = acc.mean();
  ok('누적 평균도 readLine 이 받는 모양이다',
    !!(avg && avg.rows === H && avg.cols === W && avg.data && avg.data.length === W * H * 3),
    avg ? (avg.cols + 'x' + avg.rows + ' len=' + avg.data.length) : 'null',
    W + 'x' + H + ' len=' + (W * H * 3));
  let err2 = null, r2 = null;
  try { r2 = GL.readLine(avg, null, font, {}); } catch (e) { err2 = String(e.message || e); }
  ok('누적 평균을 예외 없이 읽는다', err2 === null && !!(r2 && r2.ok),
    err2 || (r2 && r2.text), 'A');
}

/* ------------------------------------------------------------------ */
/* 비약 만료 알림 — 마지막 5초는 숫자가 없다 (사용자 반복 보고)          */
/* ------------------------------------------------------------------ */

section('비약 만료 알림 (실화면 수열)');
{
  /* 녹화 rec_20260907080700 에서 관측된 실제 수열이다.
     … 1:12(72초) → 22 → 5 → 숫자 사라짐 → 아이콘 사라짐.
     메이플스토리는 5초 미만이면 숫자를 지운다. 그 구간에는 판독이 없으므로
     아이콘 존재만이 근거이고, 여기가 흔들리면 알림이 통째로 사라진다. */
  function run(opts) {
    opts = opts || {};
    const life = new S.BuffExpiry(5);
    const timer = new S.TimerState('wealth');
    timer.maxSeconds = 1800;
    let fired = null, t = 0;
    const step = (icon, shown, observable) => {
      let rem = null;
      if (shown !== null) {
        const r = timer.observe(shown, t, 1);
        if (r.accepted) rem = shown;
      }
      if (life.update({ iconPresent: icon, remaining: rem, now: t,
                        observable: observable === undefined ? true : observable })
          && !fired) fired = { t: t, reason: life.reason };
      t += 1;
    };
    for (let v = 72; v >= 5; v--) step(true, v);
    // 5초 미만: 숫자 없음, 아이콘은 남아 있다
    for (let k = 0; k < 4; k++) {
      const blind = opts.blindAt === k;
      const gone = opts.missAt === k;
      step(gone ? false : true, null, blind ? false : true);
    }
    for (let k = 0; k < 3; k++) step(false, null, true);
    return fired;
  }

  ok('정상 수열에서 만료 알림이 울린다',
    !!run(), run() ? run().reason : 'null', 'icon_gone_after_final_seconds');

  /* 마지막 5초에 아이콘 정합이 한 프레임 흔들려도 알림은 살아야 한다.
     sticky 판정을 쓰기 전에는 여기서 수명이 "설명 없는 소멸" 로 닫히고
     판독이 없어 되살릴 수 없었다. */
  ok('마지막 구간에서 아이콘이 한 프레임 빠져도 울린다',
    !!run({ missAt: 1 }), run({ missAt: 1 }) ? run({ missAt: 1 }).reason : 'null',
    '알림 있음');

  /* 한 프레임 가림도 마찬가지다. 연속 2회부터 중단으로 본다. */
  ok('마지막 구간에서 한 프레임 관측 불가여도 울린다',
    !!run({ blindAt: 1 }), run({ blindAt: 1 }) ? run({ blindAt: 1 }).reason : 'null',
    '알림 있음');

  /* 다만 진짜로 가려진 채 사라지면 추정하지 않는다 — FIX-8 의 취지는 유지. */
  const long = (function () {
    const life = new S.BuffExpiry(5);
    let fired = false, t = 0;
    for (let v = 72; v >= 5; v--) { life.update({ iconPresent: true, remaining: v, now: t++, observable: true }); }
    for (let k = 0; k < 5; k++) life.update({ iconPresent: true, remaining: null, now: t++, observable: false });
    for (let k = 0; k < 3; k++) { if (life.update({ iconPresent: false, remaining: null, now: t++, observable: true })) fired = true; }
    return { fired: fired, reason: life.reason };
  })();
  ok('오래 가려진 채 사라지면 알림하지 않는다 (FIX-8 유지)',
    long.fired === false && long.reason === 'icon_gone_after_interruption',
    long.fired + ' / ' + long.reason, 'false / icon_gone_after_interruption');
}
/* ------------------------------------------------------------------ */
/* 스킬 아이콘 표시 타이머 (사용자 지시 2026-09-07)                     */
/* ------------------------------------------------------------------ */

section('스킬 아이콘 표시 타이머 — 마지막 5초와 서버 지연');
{
  /* 지시 그대로다.
       "남은 시간이 5초 미만일 경우 보여지지 않는다. UI 에서는 그 전 타이머로
        싱크를 맞춘 타이머가 6초 미만일때도 돌아가야 한다. 그렇게 5, 4, 3, 2, 1
        초가 전부 표시되어야 하고, 0초가 되었는데도 아이콘이 남아있다면
        '서버 지연 대기중 .' / '. .' / '. . .' 이 0.5초마다 순서대로." */
  function runFinal(res) {
    const t = new D.SkillTimer({ seconds: 1800, resolution: res });
    let now = 0;
    t.update(true, 8, now);          // 화면이 마지막으로 준 값
    const seen = [];
    for (let k = 1; k <= 12; k++) {        // 이후 숫자는 사라진다 (seconds=null)
      now = k;
      t.update(true, null, now);
      seen.push(t.text(now));
    }
    return seen;
  }
  const seen = runFinal(1);
  const nums = seen.filter(x => /^\d+초$/.test(x)).map(x => parseInt(x, 10));
  ok('숫자가 사라져도 5,4,3,2,1 이 전부 표시된다',
    [5, 4, 3, 2, 1].every(v => nums.indexOf(v) >= 0),
    nums.join(','), '5,4,3,2,1 포함');

  ok('0초가 되면 서버 지연 문구로 넘어간다',
    seen.some(x => x && x.indexOf('서버 지연 대기중') === 0),
    seen[seen.length - 1], '서버 지연 대기중 …');

  /* 점은 . -> . . -> . . . 순서로 0.5초마다 돈다. */
  const dots = [];
  {
    const t = new D.SkillTimer({ seconds: 1800, resolution: 1 });
    t.update(true, 1, 0);
    for (let k = 0; k <= 6; k++) {
      const now = 1 + k * 0.5;
      t.update(true, null, now);
      dots.push(t.text(now));
    }
  }
  ok('점이 0.5초마다 . / . . / . . . 순서로 돈다',
    dots[0] === '서버 지연 대기중 .' && dots[1] === '서버 지연 대기중 . .' &&
    dots[2] === '서버 지연 대기중 . . .' && dots[3] === '서버 지연 대기중 .',
    dots.slice(0, 4).map(x => x.replace('서버 지연 대기중 ', '')).join(' | '),
    '. | . . | . . . | .');

  /* 아이콘이 사라지면 표시도 끝난다 — 서버 지연은 아이콘이 남아 있을 때만이다. */
  {
    const t = new D.SkillTimer({ seconds: 1800, resolution: 1 });
    t.update(true, 1, 0);
    t.update(false, null, 1); t.update(false, null, 2);
    ok('아이콘이 사라지면 서버 지연이 아니라 표시가 멈춘다',
      t.text(3) === null, String(t.text(3)), 'null');
  }

  /* 분 해상도(룬 쿨타임·비약의 분 표시)는 매 판독마다 다시 놓으면 안 된다.
     "26" 이 계속 보인다고 해서 26:59 로 되돌리면 초가 사라진다. */
  {
    const t = new D.SkillTimer({ seconds: 1800, resolution: 60 });
    t.update(true, 1619, 0);                 // 26:59
    for (let k = 1; k <= 30; k++) t.update(true, 1619, k);
    const r = Math.round(t.remaining(30));
    ok('분 표시는 같은 값이 계속 보여도 되돌아가지 않는다',
      r === 1589, r + '초', '1589초 (26:59에서 30초 흐름)');
    t.update(true, 1559, 31);               // 25:59 로 내려간 순간
    ok('분이 내려간 순간에는 다시 맞춘다 (그때가 분:59로 정확하다)',
      Math.round(t.remaining(31)) === 1559, Math.round(t.remaining(31)) + '초', '1559초');
  }

  /* 끊겼다 돌아왔을 때 같은 분이면 초를 지킨다. */
  {
    const t = new D.SkillTimer({ seconds: 1800, resolution: 60, missesToDrop: 2 });
    t.update(true, 1619, 0);                 // 26:59
    for (let k = 1; k <= 40; k++) t.update(true, 1619, k);   // 26:19 까지
    t.update(false, null, 41); t.update(false, null, 42);  // 끊김
    ok('끊긴 동안에는 표시가 없다', t.text(43) === null, String(t.text(43)), 'null');
    t.update(true, 1619, 44);               // 여전히 "26"
    const r = Math.round(t.remaining(44));
    ok('다시 붙었을 때 같은 분이면 초를 지킨다 (26:59로 되돌아가지 않는다)',
      r > 1550 && r < 1590, r + '초', '1550~1590초 (26:59가 아님)');
  }
  {
    const t = new D.SkillTimer({ seconds: 1800, resolution: 60, missesToDrop: 2 });
    t.update(true, 1619, 0);
    for (let k = 1; k <= 40; k++) t.update(true, 1619, k);
    t.update(false, null, 41); t.update(false, null, 42);
    t.update(true, 1559, 43);               // 분이 달라졌다 ("25")
    ok('다시 붙었을 때 분이 다르면 새 값으로 맞춘다',
      Math.round(t.remaining(43)) === 1559, Math.round(t.remaining(43)) + '초', '1559초');
  }

  /* 한 프레임 깜빡임은 아무 것도 하지 않는다 (30분 표시를 다시 시작하면 안 된다). */
  {
    const t = new D.SkillTimer({ seconds: 1800, resolution: 60, missesToDrop: 2 });
    t.update(true, 1619, 0);
    for (let k = 1; k <= 20; k++) t.update(true, 1619, k);
    t.update(null, null, 21);               // 판정 불가
    t.update(false, null, 22);              // 한 번 없음
    t.update(true, 1619, 23);
    ok('한 프레임 깜빡여도 표시가 다시 시작되지 않는다',
      Math.round(t.remaining(23)) === 1596, Math.round(t.remaining(23)) + '초', '1596초');
  }
}

section('비약 타이머가 같은 분에서 되돌아가지 않는다 (사용자 보고 2026-09-08)');
{
  /* "현재 타이머가 n분 m초 라면, n분 59초 로 초기화 되지 말아야 한다.
      n-1분 으로 초기화 될 때만 59초 초기화를 허용한다."

     원인은 재싱크 방아쇠였다. number_changed 는 **칸 지문이 달라졌다**는
     신호이지 값이 달라졌다는 신호가 아니고, 손실 압축 탓에 값이 그대로인
     칸의 7.9% 가 참으로 나온다 (녹화 300프레임 실측). 그래서 몇 초에 한 번씩
     n:59 로 되돌아갔다. */
  const t = new D.SkillTimer({ seconds: 1800, resolution: 60 });
  t.update(true, 1619, 0);                    // 화면 "26" -> 26:59
  for (let k = 1; k <= 40; k++) {
    // 화면은 여전히 "26". 지문은 압축 잡음으로 계속 바뀐다고 보고된다.
    t.update(true, 1619, k);
  }
  const r40 = Math.round(t.remaining(40));
  ok('같은 분이면 지문이 바뀌었다고 해도 되돌아가지 않는다',
    r40 === 1579, r40 + '초 (26:19)', '1579초 — 26:59로 되돌아가지 않음');

  t.update(true, 1559, 41);                   // 화면이 "25" 로 내려갔다
  ok('n-1분으로 내려갈 때만 :59 초기화를 허용한다',
    Math.round(t.remaining(41)) === 1559, Math.round(t.remaining(41)) + '초', '1559초 (25:59)');

  /* 표시가 앞서 있을 때 화면이 한 분 크면 따라가지 않는다 — 따라가면 거꾸로
     뛴다. 첫 싱크가 분 중간에 걸리면 표시는 최대 59초 앞선다. */
  const u = new D.SkillTimer({ seconds: 1800, resolution: 60 });
  u.update(true, 1619, 0);                    // 26:59 로 놓임 (실제로는 26:20이었다 치자)
  for (let k = 1; k <= 61; k++) u.update(true, 1619, k);   // 25:58 까지 흐름
  const before = Math.round(u.remaining(61));
  u.update(true, 1619, 62);                   // 화면은 아직 "26"
  const after = Math.round(u.remaining(62));
  ok('표시가 앞서 있어도 거꾸로 뛰지 않는다',
    after < before + 2, before + '초 -> ' + after + '초', '거꾸로 뛰지 않음');

  /* 다만 비약을 새로 마시면 크게 뛴다 — 그건 따라가야 한다. */
  const v = new D.SkillTimer({ seconds: 1800, resolution: 60 });
  v.update(true, 299, 0);                     // "4" -> 4:59
  for (let k = 1; k <= 30; k++) v.update(true, 299, k);
  v.update(true, 1799, 31);                   // 새로 마셔 "29"
  ok('비약을 새로 마시면 새 지속시간을 따라간다',
    Math.round(v.remaining(31)) === 1799, Math.round(v.remaining(31)) + '초', '1799초 (29:59)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('실패: ' + failures.join(' | ')); process.exit(1); }
