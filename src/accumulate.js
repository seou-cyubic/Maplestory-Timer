/* L2(시간 누적 판독)와 L3(단일 프레임 전체 탐색).

   왜 필요한가
   -----------
   공유 화면은 무손실 스크린샷이 아니라 **손실 압축된 비디오**다. 실측
   (2026-09-07, 실사냥 녹화):

     정지한 아이콘 칸의 연속 30프레임 중 픽셀까지 같은 것  0개
     그 칸의 화소차                                     평균 10.55

   지금까지는 이 잡음을 **허용오차**로 견뎠다. 그런데 허용오차는 문자가 늘면
   곧바로 모호성이 된다. 실제로 흰 분 글꼴을 0~3에서 0~9로 넓혔더니 실화면
   판독이 2,167건에서 350건으로 **나빠졌다** — 2등 문자와 벌어져야 하는 조건에
   걸려 대부분 거부됐다. 허용오차로 잡음을 견디는 방식의 한계다.

   잡음은 시간에 대해 평균이 0이므로, 견디는 대신 **없앨** 수 있다. 실측:

     1장       10.55        8장 평균      3.60
     2장 평균   6.66        16장 평균     1.70
     4장 평균   4.82

   그래서 L2는 같은 값이 떠 있는 동안의 프레임을 모아 평균 낸 뒤 읽는다.
   깨끗해진 이미지에서는 허용오차를 0으로 되돌릴 수 있고, 허용오차가 0이면
   모호성 자체가 성립하지 않는다.

   변화 감지
   ---------
   평균을 값이 바뀐 뒤까지 끌고 가면 두 값이 겹쳐 뭉개진다. 그래서 값이 바뀌는
   순간 누적을 버려야 한다. **직전 프레임과 비교하면 안 된다** — 실측에서
   같은 값 구간의 이웃 프레임 화소차가 최대 7.83, 값이 바뀌는 경계가 7.86으로
   겹친다. 대신 **누적 평균과 비교**하면 갈린다:

     같은 값 구간, 누적평균 대비   평균 1.59  최대 5.70
     값이 바뀌는 경계             8.29 / 10.13

   임계 6.0 을 쓴다. 잡음으로 잘못 초기화되면 평균 깊이만 얕아질 뿐 판독이
   틀리지는 않는다. 반대로 변화를 놓치면 두 값이 섞이므로, 놓치는 쪽보다
   버리는 쪽으로 치우치게 잡은 값이다. */
(function (root) {
  'use strict';

  var DEFAULT_MAX = 8;
  var DEFAULT_CHANGE = 6.0;

  /* 같은 내용이 이어지는 동안의 프레임을 모아 평균을 낸다.

     고리 버퍼를 쓴다. 누적합만 들고 있으면 오래된 프레임을 뺄 수 없어서
     내용이 바뀌기 전의 잔상이 오래 남는다. 칸 하나가 32x32x3 이라 8장이라도
     24KB 다 — 정확한 편이 낫다. */
  function Accumulator(opts) {
    opts = opts || {};
    this.maxFrames = opts.maxFrames || DEFAULT_MAX;
    this.changeThreshold = opts.changeThreshold === undefined
      ? DEFAULT_CHANGE : opts.changeThreshold;
    this.reset();
  }

  Accumulator.prototype.reset = function () {
    this.ring = [];
    this.at = 0;
    this.w = 0; this.h = 0;
    this.lastDiff = null;
    this.changes = 0;
    this.pushes = 0;
  };

  Accumulator.prototype.count = function () { return this.ring.length; };

  /* mat: {rows, cols, data} (BGR 연속). 반환 {changed, count}. */
  Accumulator.prototype.push = function (mat) {
    if (!mat || !mat.data) return { changed: false, count: this.ring.length };
    var w = mat.cols, h = mat.rows, n = w * h * 3;
    if (this.w !== w || this.h !== h) { this.reset(); this.w = w; this.h = h; }

    var changed = false;
    /* 누적이 한 장뿐일 때는 변화를 판정하지 않는다.

       '평균'이 한 장이면 비교가 곧 프레임 대 프레임이고, 그때는 잡음이 가장
       크다 — 실측에서 같은 값 구간의 프레임 간 화소차가 최대 7.83으로 임계
       6을 넘었다. 그대로 두면 두 번째 프레임마다 헛되이 초기화돼 평균이
       깊어지지 못한다.

       대신 값이 정확히 1~2번째 프레임 사이에서 바뀌면 두 값이 한 번 섞인다.
       그 섞인 평균은 어떤 글리프와도 완전 일치하지 않아 L2 가 **거부**하고
       (허용오차 0이므로 오판독이 아니라 거부다), 다음 프레임이 그 평균과
       달라 곧바로 초기화된다. 손해가 한 프레임의 거부로 한정된다. */
    if (this.ring.length >= 2) {
      var mean = this._meanArray();
      var acc = 0;
      for (var i = 0; i < n; i++) acc += Math.abs(mat.data[i] - mean[i]);
      this.lastDiff = acc / n;
      if (this.lastDiff > this.changeThreshold) {
        changed = true; this.changes += 1;
        this.ring = []; this.at = 0;
      }
    }
    var copy = new Uint8Array(n);
    copy.set(mat.data.subarray ? mat.data.subarray(0, n) : mat.data);
    if (this.ring.length < this.maxFrames) this.ring.push(copy);
    else { this.ring[this.at] = copy; this.at = (this.at + 1) % this.maxFrames; }
    this.pushes += 1;
    return { changed: changed, count: this.ring.length };
  };

  Accumulator.prototype._meanArray = function () {
    var n = this.w * this.h * 3, k = this.ring.length;
    var out = new Float64Array(n);
    for (var r = 0; r < k; r++) {
      var f = this.ring[r];
      for (var i = 0; i < n; i++) out[i] += f[i];
    }
    for (var j = 0; j < n; j++) out[j] /= k;
    return out;
  };

  /* 평균 이미지. inkMask 가 받는 모양({rows, cols, data})으로 돌려준다. */
  Accumulator.prototype.mean = function () {
    if (!this.ring.length) return null;
    var m = this._meanArray(), n = m.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = Math.round(m[i]);
    return { rows: this.h, cols: this.w, data: out, delete: function () {} };
  };

  /* ---- 층으로 나눈 판독기 -------------------------------------------------

     L2: 누적 평균 이미지를 **엄격한 글꼴**(허용오차 0)로 읽는다.
     L3: 실패하면 이번 프레임 한 장을 **관대한 글꼴**로 전체 탐색한다.

     순서가 핵심이다. 깨끗한 이미지를 먼저 엄격하게 읽고, 안 되면 지저분한
     이미지를 관대하게 읽는다. 반대로 하면 관대한 쪽이 먼저 모호한 답을 내서
     엄격한 경로가 쓰일 일이 없다. */
  function LayeredReader(opts) {
    opts = opts || {};
    this.strictFont = opts.strictFont || null;   // L2 용 (허용오차 0 권장)
    this.looseFont = opts.looseFont || null;     // L3 용 (현행 글꼴)
    this.acc = new Accumulator(opts);
    this.minFramesForL2 = opts.minFramesForL2 || 2;
    this.stats = { l2: 0, l3: 0, refused: 0, changes: 0, frames: 0 };
  }

  LayeredReader.prototype.reset = function () {
    this.acc.reset();
    this.stats = { l2: 0, l3: 0, refused: 0, changes: 0, frames: 0 };
  };

  /* mat 은 이미 해당 칸으로 잘린 연속 이미지여야 한다. */
  LayeredReader.prototype.read = function (mat) {
    var G = root.glyphs;
    if (!G) return { ok: false, reason: 'no_glyphs', layer: null };
    this.stats.frames += 1;
    var p = this.acc.push(mat);
    if (p.changed) this.stats.changes += 1;

    if (this.strictFont && p.count >= this.minFramesForL2) {
      var avg = this.acc.mean();
      var r2 = G.readLine(avg, null, this.strictFont, {});
      if (r2 && r2.ok) {
        r2.layer = 'L2';
        r2.averaged = p.count;
        this.stats.l2 += 1;
        return r2;
      }
    }
    if (this.looseFont) {
      var r3 = G.readLine(mat, null, this.looseFont, {});
      if (r3 && r3.ok) {
        r3.layer = 'L3';
        r3.averaged = 1;
        this.stats.l3 += 1;
        return r3;
      }
      this.stats.refused += 1;
      /* 실패에도 두 종류가 있다. 숫자꼴 띠를 찾았는데 글리프를 모르는 것과,
         띠 자체가 없는 것. 앞은 OCR 이 값을 줄 수 있고 뒤는 읽을 것이 없다.
         호출자가 그 둘을 가릴 수 있도록 sawBand 를 실어 보낸다.
         (unknownBitmaps 자체는 넘기지 않는다 - 넘기면 흰 분 글꼴이 OCR 로
         학습되기 시작하는데, 아틀라스를 넓혔을 때 판독이 2,167건에서 350건으로
         나빠진 전례가 있어 이 최적화에서 건드리지 않는다.) */
      return { ok: false, reason: r3 ? r3.reason : 'no_read', layer: null,
               sawBand: !!(r3 && r3.unknownBitmaps && r3.unknownBitmaps.length) };
    }
    this.stats.refused += 1;
    return { ok: false, reason: 'no_loose_font', layer: null };
  };

  root.accumulate = {
    Accumulator: Accumulator,
    LayeredReader: LayeredReader,
    DEFAULT_CHANGE: DEFAULT_CHANGE,
    DEFAULT_MAX: DEFAULT_MAX
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {})
                               : (this.ASTRA = this.ASTRA || {}));
