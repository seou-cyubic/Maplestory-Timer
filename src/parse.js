/* Grammar-level parsing, ported from legacy/src/astra_test/state.py.
   Experience values are kept as digit strings so precision never depends on
   IEEE-754 range; only ordering comparisons are ever needed. */
(function (root) {
  'use strict';

  /* The readout is "<integer>[<pct>%]".

     OCR renders the game's thousands commas as dots, and - measured on the
     user's screen 2026-09-06 - it also renders the square brackets as "(",
     ")", "1", "|" or nothing, and the percent sign as "8":

       92,710.139.487.918[84.695%      92,710.139.487.918 (84.695%)
       92,710.139.487.91894.695%       92,710.162.959.063184.6958]

     Every one of those is the same complete readout; only the punctuation
     glyphs differ. Insisting on exact brackets threw all of them away and the
     experience was never read on that machine.

     What must NOT be relaxed is the structure: a thousands-grouped integer
     AND a decimal percentage, both present, with nothing else in the string.
     That is what makes a partially-cropped readout fail to parse. Truncation
     is caught separately by the edge-contact/widening check in vision.js, and
     the percent value itself is never used - only its presence. */
  var OPEN = '[\\[({|!lI1]';
  var CLOSE = '[\\])}|!lI1]';
  var EXP_RE = new RegExp(
    '^\\s*(\\d{1,3}(?:[,.]\\d{3})+|\\d+)' +   // integer, thousands-grouped
    '\\s*' + OPEN + '?\\s*' +                     // "[" however it came out
    '(\\d{1,3}[.,]\\d{1,3})' +                    // percentage
    '\\s*[%8]\\s*' +                              // "%" however it came out
    CLOSE + '?\\s*$');

  function parseExperience(text) {
    if (typeof text !== 'string') return null;
    var m = EXP_RE.exec(text);
    if (!m) return null;
    var pct = parseFloat(m[2].replace(',', '.'));
    if (!(pct >= 0 && pct <= 100)) return null;
    var digits = m[1].replace(/[,.]/g, '').replace(/^0+(?=\d)/, '');
    return digits;
  }

  // Ordering for arbitrary-length non-negative digit strings.
  function cmpExp(a, b) {
    if (a === b) return 0;
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : 1;
  }

  function formatExp(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var CLOCK_RE = /^(\d{1,2}):(\d{2})$/;
  var PLAIN_RE = /^\d{1,3}$/;

  function parseTime(text, mode) {
    if (typeof text !== 'string') return null;
    var t = text.trim().replace(/ /g, '');
    if (mode === 'clock') {
      var m = CLOCK_RE.exec(t);
      if (m && parseInt(m[2], 10) < 60) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    if ((mode === 'minutes' || mode === 'seconds') && PLAIN_RE.test(t)) {
      /* 분만 표시될 때는 그 분의 '끝'을 뜻한다 (사용자 확인 2026-09-06:
         "숫자 29 는 29:00 이 아니라 29:59 를 의미한다. 모든 버프 아이콘에서
         분 만 있을때는, 분:00 이 아니라 분:59 를 의미한다").

         게임이 남은 분을 내림해서 보여주므로, "29"가 떠 있는 동안 실제 잔여는
         29:00~29:59이고, 29로 바뀌는 그 순간이 정확히 29:59다. 숫자가 바뀌는
         순간에 다시 싱크하는 표시 로직과 맞물려 이 값이 정확해진다. */
      if (mode === 'minutes') return parseInt(t, 10) * 60 + 59;
      return parseInt(t, 10);
    }
    return null;
  }

  root.parse = { parseExperience: parseExperience, parseTime: parseTime, cmpExp: cmpExp, formatExp: formatExp };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
