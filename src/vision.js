/* Port of legacy/src/astra_test/vision.py onto OpenCV.js, reworked against the
   2026-09-05 live run and AGENT_HANDOFF.md.

   Frames are CV_8UC3 in BGR order, normalised to the calibrated 1366x768
   client, matching what cv2 handed the Python code.

   Changes carried in this file, each with a regression test:
     FIX-3  the experience readout is validated as one whole string and is
            re-read wider whenever glyphs touch the crop edge, so a value with
            its leading digits cut off is never accepted (§6.1)
     FIX-4  the potion's colour-mask agreement can no longer be bypassed by a
            high raw confidence, a verified reading is never overwritten by a
            later OCR pass, and a per-buff verified ceiling rejects the
            200분 / 250분 class of misread outright (§6.2)
     FIX-5  confusable icons are separated by an explicit signature instead of
            a 0.0006 template margin. 소형 재물 획득의 비약 (P04, gold droplet)
            and 소형 경험 축적의 비약 (P05, no gold) score 0.9973 / 0.9970 on
            the same cell with the old top-rows patch, so the app hooked onto
            whichever won the coin flip (measured 2026-09-06 on
            assets/samples/live_booster.png)
     FIX-10 buff classification reports item by item and yields between items,
            so one slow full-buff pass can no longer stall the worker or blow
            past the freshness window (§5.4) */
(function (root) {
  'use strict';

  var parse = root.parse;

  /* ---- small helpers -------------------------------------------------- */

  function Scope() { this.items = []; }
  Scope.prototype.add = function (m) { this.items.push(m); return m; };
  Scope.prototype.done = function () {
    for (var i = 0; i < this.items.length; i++) { try { this.items[i].delete(); } catch (e) { /* already freed */ } }
    this.items.length = 0;
  };

  // numpy-style slicing that clips to the image instead of throwing.
  function roi(mat, x, y, w, h) {
    var x0 = Math.max(0, Math.trunc(x)), y0 = Math.max(0, Math.trunc(y));
    var x1 = Math.min(mat.cols, Math.trunc(x + w)), y1 = Math.min(mat.rows, Math.trunc(y + h));
    if (x1 <= x0 || y1 <= y0) return null;
    return mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
  }

  /* roi() 는 부모 버퍼를 그대로 가리키는 **비연속** 뷰다. 행 보폭이 부모의
     step 이므로 data[(y*cols+x)*ch] 로 읽으면 두 번째 행부터 어긋난다.

     전폭 ROI 는 step 이 cols*ch 와 같아 우연히 맞는다 — 그래서 경험치 막대
     판독(전폭 띠)은 멀쩡했고, 32px 버프 칸만 잉크가 0으로 나왔다. 화소를
     직접 훑는 코드에 넘기기 전에는 반드시 연속 사본으로 만든다. */
  function contiguous(mat) {
    if (!mat) return null;
    /* cv.Mat 이 아니면 우리가 만든 평면 객체({rows, cols, data})이고, 그건
       정의상 이미 연속이다. 이 가드가 없으면 L2 누적 평균 이미지를 readLine 에
       넘길 때 "mat.copyTo is not a function" 으로 hud/buffs 워커가 죽는다
       (2026-09-07 실사용에서 발생). */
    if (typeof mat.copyTo !== 'function') return null;
    if (typeof mat.isContinuous === 'function' && mat.isContinuous()) return null;
    var out = new cv.Mat();
    mat.copyTo(out);
    return out;
  }

  function matFromImageData(imageData) {
    var rgba = cv.matFromImageData(imageData);
    var bgr = new cv.Mat();
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    rgba.delete();
    return bgr;
  }

  function contourList(binary) {
    var contours = new cv.MatVector(), hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    hierarchy.delete();
    return contours;
  }

  /* 양보는 하되 기다리지는 않는다.

     setTimeout(0) 은 **탭이 뒤로 가면 1초로 묶인다**. 사냥 중에는 브라우저가
     항상 뒤에 있으므로 이 양보 하나하나가 1초가 된다. 실측(selftest, 창이
     가려진 상태): 9칸 판독에 8,606ms 가 걸렸는데 그중 정합은 383ms 였고
     나머지는 전부 이 대기였다.

     MessageChannel 은 같은 '다음 차례에 돌려준다'를 하면서 타이머 제한을
     받지 않는다. 없는 환경에서만 setTimeout 으로 내려간다. */
  var yieldChannel = (typeof MessageChannel === 'function') ? new MessageChannel() : null;
  var yieldQueue = [];
  if (yieldChannel) {
    yieldChannel.port1.onmessage = function () {
      var fn = yieldQueue.shift();
      if (fn) fn();
    };
  }
  function nextTask() {
    if (!yieldChannel) {
      return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    return new Promise(function (resolve) {
      yieldQueue.push(resolve);
      yieldChannel.port2.postMessage(0);
    });
  }

  /* ---- frame validity --------------------------------------------------

     §4.2 needs ABSENT ("the anchor is not on a screen we can actually read")
     kept apart from UNKNOWN ("we cannot tell"). A frozen scene is still a
     valid screen, so sameness is never the test; a black, blank or degenerate
     surface is not. */
  function frameValidity(image) {
    if (!image || image.cols < 400 || image.rows < 240) {
      return { valid: false, reason: 'frame_too_small' };
    }
    var s = new Scope();
    try {
      var small = s.add(new cv.Mat());
      cv.resize(image, small, new cv.Size(64, 36), 0, 0, cv.INTER_AREA);
      var gray = s.add(new cv.Mat());
      cv.cvtColor(small, gray, cv.COLOR_BGR2GRAY);
      var mean = new cv.Mat(), sd = new cv.Mat();
      s.add(mean); s.add(sd);
      cv.meanStdDev(gray, mean, sd);
      var m = mean.data64F[0], d = sd.data64F[0];
      if (d < 3.0) return { valid: false, reason: 'flat_surface', mean: m, stddev: d };
      if (m < 4) return { valid: false, reason: 'black_surface', mean: m, stddev: d };
      return { valid: true, reason: 'ok', mean: m, stddev: d };
    } finally { s.done(); }
  }

  /* ---- OCR facade (mirrors vision.py class OCR) ------------------------ */

  function OCR(generalEngine, digitEngine) {
    this.engine = generalEngine;   // PP-OCRv6 small, same as RapidOCR() default
    this.digits = digitEngine;     // en PP-OCRv4 mobile
    this.calls = 0;
  }

  // vision.py OCR.line: 4x INTER_CUBIC upscale, then the general recogniser.
  OCR.prototype.line = function (crop) {
    if (!crop || crop.rows === 0 || crop.cols === 0) return Promise.resolve({ text: '', score: 0 });
    var self_ = this;
    var big = new cv.Mat();
    cv.resize(crop, big, new cv.Size(0, 0), 4, 4, cv.INTER_CUBIC);
    this.calls += 1;
    return this.engine.run(big).then(function (r) { big.delete(); return r; },
      function (e) { big.delete(); throw e; });
  };

  var MINUTE_OFFSETS = [
    [-2, 12, 33, 20], [-2, 15, 22, 17], [0, 14, 24, 16],
    [0, 18, 18, -18], [0, 22, 18, -22], [0, 22, 22, -22],
    [0, 16, 26, 20], [0, 18, 26, 18], [-3, 20, 27, 16], [-2, 20, 24, 16]
  ];
  // Entries whose height is negative mean "icon height + value", as in h-18.

  /* FIX-10: the legacy pass always ran all ten offsets. Two agreeing readings
     are already the consensus the caller checks, so stop there - this alone
     removed most of the full-buff OCR cost. */
  OCR.prototype.minutes = function (image, box) {
    var self_ = this, x = box[0], y = box[1], h = box[3];
    var readings = [], counts = {};
    var chain = Promise.resolve();
    var stop = false;
    MINUTE_OFFSETS.forEach(function (o) {
      chain = chain.then(function () {
        if (stop) return;
        var ch = o[3] < 0 ? h + o[3] : o[3];
        var crop = roi(image, Math.max(0, x + o[0]), Math.max(0, y + o[1]), o[2], ch);
        if (!crop) return;
        var big = new cv.Mat();
        cv.resize(crop, big, new cv.Size(0, 0), 4, 4, cv.INTER_LINEAR);   // cv2 default
        crop.delete();
        self_.calls += 1;
        return self_.digits.run(big).then(function (z) {
          big.delete();
          if (z.text && /^\d+$/.test(z.text) && z.score >= 0.35) {
            readings.push([z.text, z.score]);
            counts[z.text] = (counts[z.text] || 0) + 1;
            if (counts[z.text] >= 2) stop = true;
          }
        }, function (e) { big.delete(); throw e; });
      });
    });
    return chain.then(function () {
      if (!readings.length) return { text: '', score: 0, consensus: false, samples: 0 };
      var bestText = null, bestCount = -1;
      // Counter.most_common(1) keeps first-insertion order on ties.
      readings.forEach(function (r) {
        if (counts[r[0]] > bestCount) { bestCount = counts[r[0]]; bestText = r[0]; }
      });
      var scores = readings.filter(function (r) { return r[0] === bestText; }).map(function (r) { return r[1]; });
      var mean = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
      return { text: bestText, score: mean, consensus: bestCount >= 2, samples: readings.length };
    });
  };

  var TIMER_BANDS = [[5, 25], [8, 26], [6, 29], [3, 27]];

  OCR.prototype.timer = function (crop, mode) {
    var self_ = this, readings = [], early = null;
    var chain = Promise.resolve();
    TIMER_BANDS.forEach(function (band) {
      chain = chain.then(function () {
        if (early) return;
        var band_ = roi(crop, 0, band[0], crop.cols, band[1] - band[0]);
        if (!band_) return;
        return self_.line(band_).then(function (r) {
          band_.delete();
          var value = parse.parseTime(r.text, mode);
          if (value !== null && r.score >= 0.85 && (mode !== 'seconds' || value < 60)) {
            if (r.score >= 0.95) { early = r; return; }
            readings.push([r.text, r.score]);
          }
        }, function (e) { band_.delete(); throw e; });
      });
    });
    return chain.then(function () {
      if (early) return { text: early.text, score: early.score };
      if (!readings.length) return { text: '', score: 0 };
      var counts = {};
      readings.forEach(function (r) { counts[r[0]] = (counts[r[0]] || 0) + 1; });
      var best = readings[0];
      readings.forEach(function (r) {
        if (counts[r[0]] > counts[best[0]] || (counts[r[0]] === counts[best[0]] && r[1] > best[1])) best = r;
      });
      return { text: best[0], score: best[1] };
    });
  };

  /* ---- geometry detectors --------------------------------------------- */

  /* 미니맵도 같은 규칙으로 잠근다.

     실측상 Canny+윤곽 검출은 프레임에 따라 간헐적으로 실패한다(사용자 지적:
     "룬은 작동시간의 일부분이 미니맵 미검출 상태"). 한 번 찾은 위치를 그대로
     쓰고, 그 자리에서 n초 이상 확인되지 않을 때만 다시 찾는다. */
  /* 미니맵은 사냥 중에 움직이지 않는다 (실측: 29분 동안 이동 0픽셀). 그러니
     한 번 찾으면 그대로 쓰면 된다. 문제는 **검증이 무력했다**는 것이다.

     예전 검증은 "표준편차 > 8" 뿐이었다. 사실상 어떤 영역이든 통과하므로
     잘못 잠긴 것을 걸러내지 못했고, 반대로 detectMinimap 이 자주 실패하는
     탓에(실측: 87프레임 중 22프레임 미검출, 서로 다른 상자 17개) 잠금이
     풀리고 다시 찾기를 반복해 화면이 흔들렸다.

     이제는 잠글 때의 모습을 기억해 두고 상관계수로 확인한다. 정지한 UI 라
     매 프레임 0.9 근처가 나오고, 엉뚱한 곳이면 뚝 떨어진다. 그리고 한 번
     실패했다고 바로 풀지 않는다 — 연속 실패가 쌓여야 다시 찾는다. */
  var MINIMAP_VERIFY_MIN = 0.55;
  var MINIMAP_MISS_STREAK = 5;

  /* ---- 미니맵을 시간으로 찾기 -------------------------------------------

     윤곽 하나를 통째로 잡으려 하면 반투명 UI 위로 배경이 움직여 테두리가
     조각나고, 프레임마다 다른 상자가 나온다 (실측 87프레임: 미검출 22,
     서로 다른 상자 17개).

     테두리를 이을 필요가 없다. **UI 는 정지해 있고 월드는 움직인다**는 것이
     훨씬 강한 신호다 (실측: 미니맵 영역 시간 표준편차 7.1 대 월드 37.5).
     여러 프레임에서 '늘 경계인 화소'만 남기면 월드 경계는 사라지고 UI 틀만
     남는다. 그 위에서 가로/세로 직선을 세고, 네 변이 실제로 이어져 있는
     상자를 고른다 (실측: 미검출 0/17).

     쌓는 비용은 프레임당 Canny 한 번이고, 잠근 뒤에는 아예 돌지 않는다. */
  var EDGE_FRAMES = 10;          // 이만큼 쌓고 찾는다
  var EDGE_PERSIST = 0.7;        // 이 비율 이상 프레임에서 경계인 화소만
  var LINE_MIN_V = 60;           // 세로선으로 칠 최소 길이
  var LINE_MIN_H = 80;           // 가로선으로 칠 최소 길이
  var MM_W = [120, 260];         // 미니맵 폭 범위
  var MM_H = [70, 200];          // 미니맵 높이 범위
  var MM_BORDER_MIN = 0.55;      // 네 변 중 가장 약한 변의 경계 비율

  function EdgeAccumulator() { this.sum = null; this.n = 0; this.w = 0; this.h = 0; }

  EdgeAccumulator.prototype.reset = function () { this.sum = null; this.n = 0; };

  EdgeAccumulator.prototype.push = function (image, sw, sh) {
    var s = new Scope();
    try {
      var area = s.add(roi(image, 0, 0, sw, sh));
      if (!area) return 0;
      var gray = s.add(new cv.Mat()); cv.cvtColor(area, gray, cv.COLOR_BGR2GRAY);
      var e = s.add(new cv.Mat()); cv.Canny(gray, e, 60, 150);
      var n = e.rows * e.cols;
      if (!this.sum || this.w !== e.cols || this.h !== e.rows) {
        this.sum = new Uint16Array(n); this.n = 0; this.w = e.cols; this.h = e.rows;
      }
      for (var i = 0; i < n; i++) if (e.data[i]) this.sum[i] += 1;
      this.n += 1;
      return this.n;
    } catch (err) {
      return this.n;
    } finally { s.done(); }
  };

  /* 늘 경계인 화소만 남긴 마스크에서 미니맵 상자를 고른다. */
  EdgeAccumulator.prototype.detect = function () {
    if (!this.sum || this.n < 3) return null;
    var W = this.w, H = this.h, need = Math.max(2, Math.round(this.n * EDGE_PERSIST));
    var keep = new Uint8Array(W * H);
    for (var i = 0; i < keep.length; i++) keep[i] = this.sum[i] >= need ? 1 : 0;

    var colCount = new Int32Array(W), rowCount = new Int32Array(H);
    for (var y = 0; y < H; y++) {
      var base = y * W;
      for (var x = 0; x < W; x++) {
        if (keep[base + x]) { colCount[x]++; rowCount[y]++; }
      }
    }
    function peaks(counts, minLen) {
      var out = [], run = null;
      for (var k = 0; k < counts.length; k++) {
        if (counts[k] >= minLen) { if (run === null) run = [k, k]; else run[1] = k; }
        else if (run !== null) {
          if (k - run[1] > 2) { out.push((run[0] + run[1]) >> 1); run = null; }
        }
      }
      if (run !== null) out.push((run[0] + run[1]) >> 1);
      return out;
    }
    var cx = peaks(colCount, LINE_MIN_V), ry = peaks(rowCount, LINE_MIN_H);
    if (cx.length < 2 || ry.length < 2) return null;

    function frac(fn, from, to) {
      var on = 0, tot = 0;
      for (var t = from; t <= to; t++) { tot++; if (fn(t)) on++; }
      return tot ? on / tot : 0;
    }
    var best = null;
    for (var a = 0; a < cx.length; a++) {
      for (var b = a + 1; b < cx.length; b++) {
        var x0 = cx[a], x1 = cx[b], w = x1 - x0;
        if (w < MM_W[0] || w > MM_W[1]) continue;
        for (var c = 0; c < ry.length; c++) {
          for (var d = c + 1; d < ry.length; d++) {
            var y0 = ry[c], y1 = ry[d], h = y1 - y0;
            if (h < MM_H[0] || h > MM_H[1]) continue;
            /* 네 변이 실제로 이어져 있는가. 가장 약한 변을 점수로 삼는다 —
               서로 무관한 직선 두 쌍은 잇는 변에서 무너진다. */
            var top = frac(function (t) { return keep[y0 * W + t]; }, x0, x1);
            var bot = frac(function (t) { return keep[y1 * W + t]; }, x0, x1);
            var lef = frac(function (t) { return keep[t * W + x0]; }, y0, y1);
            var rig = frac(function (t) { return keep[t * W + x1]; }, y0, y1);
            var score = Math.min(top, Math.min(bot, Math.min(lef, rig)));
            if (score < MM_BORDER_MIN) continue;
            if (!best || score > best.score) {
              best = { score: score, box: [x0, y0, w, h] };
            }
          }
        }
      }
    }
    return best;
  };

  function MinimapLock(researchAfterSeconds) {
    this.rect = null;
    this.missAt = null;
    this.researchAfter = researchAfterSeconds === undefined ? 3 : researchAfterSeconds;
    this.searches = 0;
    this.ref = null;          // 잠글 때의 모습
    this.missStreak = 0;
    this.lastScore = null;
    this.edges = new EdgeAccumulator();
    this.borderScore = null;
  }
  MinimapLock.prototype.reset = function () {
    this.rect = null; this.missAt = null; this.missStreak = 0;
    if (this.edges) this.edges.reset();
    if (this.ref) { try { this.ref.delete(); } catch (e) {} this.ref = null; }
  };
  MinimapLock.prototype.locate = function (image, nowSeconds) {
    if (this.rect) {
      var score = this.verify(image);
      this.lastScore = score;
      if (score === null || score >= MINIMAP_VERIFY_MIN) {
        this.missAt = null; this.missStreak = 0;
        return { bbox: this.rect, source: 'locked', score: score };
      }
      this.missStreak += 1;
      if (this.missAt === null) this.missAt = nowSeconds;
      /* 연속 실패가 쌓이고 시간도 지나야 놓는다. 한 프레임 튀었다고 놓으면
         찾기와 놓기를 반복하며 화면이 흔들린다. */
      if (this.missStreak < MINIMAP_MISS_STREAK ||
          nowSeconds - this.missAt <= this.researchAfter) {
        return { bbox: this.rect, source: 'locked_unverified', score: score };
      }
      this.reset();
    }
    /* 최초 탐색은 아직 윤곽 방식이다.

       '시간 지속 경계 + 테두리 연속성' 으로 바꿔 보았으나 문턱을 넘지 못했다
       (실측: 진짜 미니맵 상자조차 가장 약한 변이 0.32, 후보 544개 중 최고
       0.32). 테두리가 늘 경계로 잡히지는 않기 때문이다 — 반투명 UI 위로
       배경이 지나가면 대비가 낮은 구간에서 Canny 가 끊긴다.
       EdgeAccumulator 는 그 실험의 잔재로 남겨 두었고 판정 경로에는 없다.

       그래서 여기는 예전 그대로다. 대신 **잠금 검증**을 상관계수로 바꿔
       한 번 제대로 잡으면 놓지 않게 했다 (실측: 상자 17개 -> 1개).
       남은 위험은 최초 탐색이 틀리면 오래 문다는 것이다. */
    this.searches += 1;
    var found = detectMinimap(image);
    if (found) {
      this.rect = found;
      this.missAt = null; this.missStreak = 0;
      this.remember(image, found);
      return { bbox: found, source: 'searched', score: null };
    }
    return { bbox: null, source: 'not_found', score: null };
  };

  MinimapLock.prototype.remember = function (image, rect) {
    if (this.ref) { try { this.ref.delete(); } catch (e) {} this.ref = null; }
    var c = roi(image, rect[0], rect[1], rect[2], rect[3]);
    if (!c) return;
    var g = new cv.Mat();
    try { cv.cvtColor(c, g, cv.COLOR_BGR2GRAY); this.ref = g; }
    catch (e) { g.delete(); }
    finally { c.delete(); }
  };

  /* 기억한 모습과의 상관계수. 기억이 없으면 null (판정 보류). */
  MinimapLock.prototype.verify = function (image) {
    if (!this.ref || !this.rect) return null;
    var s = new Scope();
    try {
      var c = s.add(roi(image, this.rect[0], this.rect[1], this.rect[2], this.rect[3]));
      if (!c || c.rows !== this.ref.rows || c.cols !== this.ref.cols) return null;
      var g = s.add(new cv.Mat()); cv.cvtColor(c, g, cv.COLOR_BGR2GRAY);
      var res = s.add(new cv.Mat());
      cv.matchTemplate(g, this.ref, res, cv.TM_CCOEFF_NORMED);
      return cv.minMaxLoc(res).maxVal;
    } catch (e) {
      return null;
    } finally { s.done(); }
  };

  // 잠근 사각형이 여전히 테두리 있는 상자로 보이는지 (윤곽 재탐색보다 훨씬 싸다).
  function looksLikeMinimap(image, rect) {
    var s = new Scope();
    try {
      var crop = s.add(roi(image, rect[0], rect[1], rect[2], rect[3]));
      if (!crop) return false;
      var gray = s.add(new cv.Mat()); cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
      var mean = s.add(new cv.Mat()), sd = s.add(new cv.Mat());
      cv.meanStdDev(gray, mean, sd);
      return sd.data64F[0] > 8;      // 완전히 평평하면 미니맵이 아니다
    } catch (e) { return false; } finally { s.done(); }
  }

  function detectMinimap(image) {
    var s = new Scope();
    try {
      var h = image.rows, w = image.cols;
      var search = s.add(roi(image, 0, 0, Math.min(w, Math.max(300, Math.trunc(w / 3))),
        Math.min(h, Math.max(240, Math.trunc(h / 2)))));
      if (!search) return null;
      var gray = s.add(new cv.Mat()); cv.cvtColor(search, gray, cv.COLOR_BGR2GRAY);
      var edges = s.add(new cv.Mat()); cv.Canny(gray, edges, 60, 150);
      var contours = contourList(edges); s.add(contours);
      var best = null;
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        var r = cv.boundingRect(c);
        if (r.width >= 100 && r.width <= Math.min(w, 400) &&
            r.height >= 60 && r.height <= Math.min(h, 220) &&
            r.y > 40 && r.y < 140 && r.x < 40) {
          var peri = cv.arcLength(c, true);
          var poly = new cv.Mat();
          cv.approxPolyDP(c, poly, peri * 0.025, true);
          var n = poly.rows; poly.delete();
          if (n >= 4 && n <= 8) {
            var area = r.width * r.height;
            var box = [r.x, r.y, r.width, r.height];
            if (!best || area > best[0] || (area === best[0] && cmpBox(box, best[1]) > 0)) best = [area, box];
          }
        }
        c.delete();
      }
      return best ? best[1] : null;
    } finally { s.done(); }
  }

  /* 미니맵 **UI 패널 전체**. 순수 미니맵(detectMinimap)보다 넓다.

     사용자 지시 2026-09-07: "룬이 검색하는 미니맵 범위는 순수 미니맵을 넘어,
     미니맵 UI 전체여야 한다."

     패널 안에는 확대/축소 버튼, 지역 이름, **맵 이름**, 그리고 미니맵 본체가
     들어 있다. 맵 이름 줄 수에 따라 위쪽 높이가 달라지므로 상수로 둘 수 없다.

     찾는 방법: 안쪽 미니맵 상자를 **감싸는** 윤곽 상자 중에서, 위로 20px
     이상 더 올라가(이름 영역을 포함한다는 뜻) 넓이가 지나치지 않은 것 중
     가장 작은 것. 절대 좌표 조건은 쓰지 않는다 — 감싸는지 여부만 본다.

     못 찾으면 안쪽 상자에서 실측 여백만큼 넓힌다 (실측 f900: 안쪽
     [8,69,173,109], 패널 [2,0,197,183] -> 좌우 6~7, 아래 8). */
  var MINIMAP_UI_SIDE = 7;
  var MINIMAP_UI_TOP = 69;
  var MINIMAP_UI_BOTTOM = 10;
  /* 이름 영역이 대략 40px 이다. 위로 그만큼 못 올라간 상자는 이름을 잘라낸
     것이므로 받지 않는다 (실측: y=40/46 짜리 상자들이 이름 줄을 잘랐다). */
  var MINIMAP_UI_MIN_TOP = 40;
  var MINIMAP_UI_MAX_W = 1.6;      // 안쪽 폭 대비 (실측에서 390px 짜리가 걸렸다)

  function minimapUiRect(image, inner) {
    if (!inner) return null;
    /* **안쪽 미니맵에서 산술로 계산한다.** 윤곽으로 매 프레임 다시 찾지 않는다.

       처음에는 윤곽으로 패널을 찾았는데, 안쪽 상자가 잠겨 있어도 패널 상자가
       프레임마다 달라져 화면의 인식 범위가 계속 요동쳤다 (실측: 87프레임에서
       서로 다른 상자 13개). 패널과 미니맵의 상대 위치는 고정이므로 굳이 찾을
       이유가 없다 — 잠긴 상자에서 더하면 그만이고, 그러면 안쪽이 안정된
       만큼 바깥도 안정된다.

       여백은 실측이다 (f900: 안쪽 [8,69,173,109], 패널 [2,0,197,183]):
         좌 6 · 우 7 · 아래 8 · 위 69 (버튼 줄 + 지역명 + 맵 이름) */
    var x = Math.max(0, inner[0] - MINIMAP_UI_SIDE);
    var y = Math.max(0, inner[1] - MINIMAP_UI_TOP);
    var right = Math.min(image.cols, inner[0] + inner[2] + MINIMAP_UI_SIDE);
    var bottom = Math.min(image.rows, inner[1] + inner[3] + MINIMAP_UI_BOTTOM);
    if (right - x < 8 || bottom - y < 8) return null;
    return [x, y, right - x, bottom - y];
  }

  /* 패널에서 맵 이름이 적힌 띠. 미니맵 본체 위, 패널 안쪽이다.
     버튼 줄을 피하려고 위쪽 일부는 뺀다 (실측: 버튼 줄이 대략 28px). */
  var MINIMAP_BUTTON_ROWS = 28;

  function minimapNameRect(ui, inner) {
    if (!inner) return null;
    /* **안쪽 미니맵 기준**으로 잡는다. UI 패널 상자는 프레임마다 몇 픽셀씩
       흔들려서 그걸 기준으로 하면 띠의 크기가 달라지고, 크기가 달라지면
       지문을 비교할 수 없다. 안쪽 상자는 안정적이다(실측: 폭 173 고정). */
    var x = Math.max(0, inner[0] - 4);
    var y = Math.max(0, inner[1] - 41);
    var h = Math.min(39, inner[1] - y);
    if (h < 12) return null;
    return [x, y, inner[2] + 24, h];
  }

  function cmpBox(a, b) {
    for (var i = 0; i < 4; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
    return 0;
  }

  /* Fixed-prior read, kept because the legacy suite pins its numbers. The live
     path uses ExpLocator. */
  function detectExp(image, ocr) {
    var h = image.rows, w = image.cols;
    var x1 = Math.trunc(w * 0.435), x2 = Math.trunc(w * 0.574), y1 = h - 12;
    var crop = roi(image, x1, y1, x2 - x1, h - y1);
    var bbox = [x1, y1, x2 - x1, h - y1];
    if (!crop) return Promise.resolve({ bbox: bbox, raw: '', score: 0, value: null, valid: false });
    return ocr.line(crop).then(function (r) {
      crop.delete();
      var value = r.score >= 0.90 ? parse.parseExperience(r.text) : null;
      return { bbox: bbox, raw: r.text, score: r.score, value: value, valid: value !== null,
               roi_source: 'prior' };
    }, function (e) { crop.delete(); throw e; });
  }

  /* Locate the experience readout instead of assuming where it sits.

     The readout is drawn as near-white glyphs inside the bottom HUD bar, so a
     column projection of the brightest pixels in that strip isolates it: the
     widest glyph run is the number. Its x position and width therefore come
     from the image (they shift as the value gains digits), and the row band
     comes from the same projection. */
  var EXP_BAND_H = 18;
  var EXP_THRESHOLDS = [240, 225, 210];

  function expTextRuns(image) {
    var h = image.rows, w = image.cols, out = [], seen = {};
    for (var ti = 0; ti < EXP_THRESHOLDS.length; ti++) {
      var s = new Scope();
      try {
        var band = s.add(roi(image, 0, h - EXP_BAND_H, w, EXP_BAND_H));
        if (!band) continue;
        var gray = s.add(new cv.Mat()); cv.cvtColor(band, gray, cv.COLOR_BGR2GRAY);
        var bin = s.add(new cv.Mat());
        cv.threshold(gray, bin, EXP_THRESHOLDS[ti], 255, cv.THRESH_BINARY);
        var d = bin.data, W = bin.cols, H = bin.rows;
        var col = new Int32Array(W), rowCnt = new Int32Array(H);
        for (var y = 0; y < H; y++) {
          for (var x = 0; x < W; x++) {
            if (d[y * W + x]) { col[x]++; rowCnt[y]++; }
          }
        }
        var runs = [], start = -1, blank = 0;
        for (var x2 = 0; x2 < W; x2++) {
          if (col[x2] > 0) { if (start < 0) start = x2; blank = 0; }
          else if (start >= 0 && ++blank > 6) { runs.push([start, x2 - blank]); start = -1; blank = 0; }
        }
        if (start >= 0) runs.push([start, W - 1]);
        var yTop = 0, yBot = H - 1;
        while (yTop < H && rowCnt[yTop] === 0) yTop++;
        while (yBot > yTop && rowCnt[yBot] === 0) yBot--;

        runs.map(function (r) { return { x: r[0], w: r[1] - r[0] + 1 }; })
          .filter(function (r) { return r.w >= 90 && r.w <= w * 0.55; })
          .sort(function (a, b) { return b.w - a.w; })
          .slice(0, 3)
          .forEach(function (r) {
            var item = {
              x: Math.max(0, r.x - 8), w: Math.min(w, r.w + 30),
              yTop: h - EXP_BAND_H + yTop, yBot: h - EXP_BAND_H + yBot
            };
            var key = item.x + ',' + item.w;
            if (!seen[key]) { seen[key] = 1; out.push(item); }
          });
      } finally { s.done(); }
    }
    return out;
  }

  // Crops to try for one located glyph run: the measured band first, then two
  // fixed heights that suit the recogniser when the band is a little generous.
  function expRects(run, h) {
    var glyphH = run.yBot - run.yTop + 1;
    return [
      [run.x, Math.max(0, run.yTop - 1), run.w, glyphH + 3],
      [run.x, Math.max(0, h - 12), run.w, 12],
      [run.x, Math.max(0, h - 14), run.w, 14],
      [run.x, Math.max(0, run.yTop), run.w, glyphH + 1]
    ];
  }

  /* FIX-3: do the glyphs run into the crop edge?

     The 2026-09-05 run accepted `304,720,906,205` - a value whose leading
     digits were outside the crop - at high confidence, because integer +
     percent grammar says nothing about whether the string is complete. A
     bright pixel column hard against the border is the evidence that it is not. */
  /* Measured 2026-09-06 on assets/candidates/client.png, exp run [592,749,197,20]:

       threshold   correct crop (L/R)   crop with leading digits cut (L/R)
          200          2 / 9                 5 / 9      <- HUD bar glow, useless
          225          0 / 0                 5 / 0      <- clean separation
          235          0 / 0                 5 / 0

     The readout glyphs are near-white; the HUD bar behind them is not. 230 with
     a two-pixel floor therefore sees cut digits and ignores the bar. */
  var EXP_EDGE_THRESHOLD = 230;
  var EXP_EDGE_MIN_PIXELS = 2;
  function edgeContact(image, rect) {
    var s = new Scope();
    try {
      var crop = s.add(roi(image, rect[0], rect[1], rect[2], rect[3]));
      if (!crop) return { left: false, right: false, ok: false };
      var gray = s.add(new cv.Mat()); cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
      var bin = s.add(new cv.Mat());
      cv.threshold(gray, bin, EXP_EDGE_THRESHOLD, 255, cv.THRESH_BINARY);
      var d = bin.data, W = bin.cols, H = bin.rows;
      var left = 0, right = 0;
      for (var y = 0; y < H; y++) {
        if (d[y * W]) left++;
        if (d[y * W + (W - 1)]) right++;
      }
      return { left: left >= EXP_EDGE_MIN_PIXELS, right: right >= EXP_EDGE_MIN_PIXELS,
               ok: true, leftPixels: left, rightPixels: right };
    } finally { s.done(); }
  }

  var EXP_EXPAND_STEPS = [14, 30, 52];

  /* ---- 경험치: 판독이 아니라 변화 감지 --------------------------------

     사용자 지적(2026-09-06 memo): "해당 섹션의 목적은 '이미지가 변하는가
     변하지 않는가'에 대한 탐색이다. 인식이 어찌되었든, 이미지가 변함 =
     사냥을 하는 중, 이미지가 변하지 않았음 = 사냥을 하고 있지 않음."

     실측상 이 화면의 경험치 OCR은 프레임마다 0.84~0.92로 흔들리고 값이 한
     자리씩 달라져, 정체 판정을 숫자에 걸면 대부분의 시간이 '판독 보류'가
     된다. 숫자는 정체 판정에 필요하지 않으므로 알림 경로에서 뺀다.

     서명은 밝은 글자 화소의 열별 개수다. 회색 축소본보다 한 자리 변화에
     민감하고, 압축 잡음에는 둔하다. */
  var ACT_THRESHOLD = 200;      // 글자로 볼 밝기
  var ACT_BUCKETS = 64;

  function activitySignature(image, rect) {
    var s = new Scope();
    try {
      var crop = s.add(roi(image, rect[0], rect[1], rect[2], rect[3]));
      if (!crop) return null;
      var gray = s.add(new cv.Mat()); cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
      var bin = s.add(new cv.Mat());
      cv.threshold(gray, bin, ACT_THRESHOLD, 255, cv.THRESH_BINARY);
      var d = bin.data, W = bin.cols, H = bin.rows;
      var out = new Uint16Array(ACT_BUCKETS);
      for (var y = 0; y < H; y++) {
        var row = y * W;
        for (var x = 0; x < W; x++) {
          if (d[row + x]) out[Math.min(ACT_BUCKETS - 1, Math.floor(x * ACT_BUCKETS / W))]++;
        }
      }
      return out;
    } finally { s.done(); }
  }

  // 두 서명의 총 차이. 한 자리만 바뀌어도 수십이 나오고, 잡음은 한 자리수다.
  function signatureDistance(a, b) {
    if (!a || !b || a.length !== b.length) return null;
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum;
  }

  /* 화면 전체가 얼어붙었는지. 스트림이 멈추면 같은 프레임이 계속 들어오므로
     frameId만으로는 알 수 없다. 게임 화면은 버프 숫자·미니맵·캐릭터 때문에
     사실상 완전히 정지하지 않으므로, '완전 동일'만 정지로 본다. */
  function frameSignature(image) {
    var s = new Scope();
    try {
      var small = s.add(new cv.Mat());
      cv.resize(image, small, new cv.Size(32, 18), 0, 0, cv.INTER_AREA);
      var gray = s.add(new cv.Mat()); cv.cvtColor(small, gray, cv.COLOR_BGR2GRAY);
      var out = new Uint8Array(gray.rows * gray.cols);
      out.set(gray.data.subarray(0, out.length));
      return out;
    } finally { s.done(); }
  }

  /* 경험치 글자가 있는 사각형. OCR을 쓰지 않는다.
     픽셀 투영으로 찾고, 못 찾으면 memo가 허용한 '화면 최하단 중앙' prior. */
  function expActivityRect(image) {
    var h = image.rows, w = image.cols;
    var runs = expTextRuns(image);
    if (runs && runs.length) {
      var r = runs[0];
      return { rect: [r.x, Math.max(0, r.yTop - 2), r.w, (r.yBot - r.yTop) + 5], source: 'projection' };
    }
    var x = Math.trunc(w * 0.40);
    return { rect: [x, h - 20, Math.trunc(w * 0.20), 20], source: 'bottom_center_prior' };
  }

  function ExpLocator(font) {
    /* 글꼴 아틀라스가 있으면 그것이 본 경로다. 신경망 OCR은 아틀라스가 모르는
       글자를 만났을 때의 대비책이자, 새 글리프에 라벨을 붙여 주는 교사다. */
    this.font = font || null;
    this.glyphReads = 0;
    this.glyphMisses = 0;
    this.learned = 0;
    this.rect = null;
    this.misses = 0;
    this.searches = 0;
    this.attempts = 0;
    this.confirmedDigits = 0;     // digit count of the last confirmed value
    this.shrinkPending = null;    // [value, count] while a shorter value is re-checked
    this.tried = [];              // what the last search actually read (§6.4)
    // Which preprocessing this screen actually responds to. Learned from the
    // first success and tried first afterwards, so the common case stays one
    // OCR call per frame instead of two or three.
    this.preferredVariant = 'raw';
  }

  ExpLocator.prototype.reset = function () {
    this.rect = null; this.misses = 0; this.confirmedDigits = 0; this.shrinkPending = null;
  };

  /* Acceptance thresholds.

     Measured 2026-09-06 on the user's live screen: the readout parses cleanly
     but every crop scores 0.85..0.86, under the old flat 0.90 gate, so the
     experience was never read at all. Two crops of the same frame also
     disagreed by one digit (…088… vs …086…), which is exactly why simply
     lowering the gate would be wrong.

     So a value is accepted either because one read is confident, or because
     two *different crops of the same frame* independently produce the same
     string. The second route is stronger evidence than the first, and it is
     the same discipline §6.1/§6.2 already ask for elsewhere. */
  var EXP_ACCEPT_SCORE = 0.90;      // one read is enough
  var EXP_CONSENSUS_SCORE = 0.80;   // needs a second crop to agree
  var EXP_MAX_SURVEY = 6;

  /* A second preprocessing of the same crop.

     The readout is near-white glyphs on the dark HUD bar, while the recogniser
     was trained mostly on dark-on-light text. Measured 2026-09-06 on the
     user's screen, the raw crop produced 0.85..0.86 readings that disagreed on
     one digit (…088… vs …086…) and dropped the decimal point out of the
     percent ("84398%"). Inverting to black-on-white gives the recogniser the
     polarity it expects, and it is an independent reading, so agreement
     between the two is real corroboration rather than the same mistake twice. */
  function expInverted(crop) {
    var gray = new cv.Mat();
    cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
    var bin = new cv.Mat();
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    gray.delete();
    var out = new cv.Mat();
    cv.cvtColor(bin, out, cv.COLOR_GRAY2BGR);
    bin.delete();
    return out;
  }

  // variant: 'raw' | 'inverted'
  ExpLocator.prototype.read = function (image, ocr, rect, variant) {
    var crop = roi(image, rect[0], rect[1], rect[2], rect[3]);
    if (!crop) return Promise.resolve(null);
    var use = crop, extra = null;
    if (variant === 'inverted') {
      extra = expInverted(crop);
      use = extra;
    }
    function done(v) {
      try { crop.delete(); } catch (e) {}
      if (extra) { try { extra.delete(); } catch (e) {} }
      return v;
    }
    return ocr.line(use).then(function (r) {
      var parsed = parse.parseExperience(r.text);
      return done({
        raw: r.text, score: r.score, rect: rect, parsed: parsed,
        variant: variant || 'raw',
        // `value` keeps the old meaning: good enough on its own.
        value: (parsed !== null && r.score >= EXP_ACCEPT_SCORE) ? parsed : null
      });
    }, function (e) { done(null); throw e; });
  };

  // A second crop of the same frame, offset from `rect`, for the agreement route.
  function altRect(rect, h) {
    var y = (rect[1] === h - 12) ? Math.max(0, h - 14) : Math.max(0, h - 12);
    var hh = (rect[1] === h - 12) ? 14 : 12;
    return [rect[0], y, rect[2], hh];
  }

  /* Read `rect`, and if the glyphs touch an edge widen that side and read
     again. A value only counts as confirmed when a wider crop reproduces it
     with no edge contact left. A disagreement is reported, never silently
     preferred one way or the other. */
  /* `expected` (optional) is a value already established for this frame by the
     agreement route; the edge/widening check then verifies that value rather
     than re-deciding it. */
  ExpLocator.prototype.readChecked = function (image, ocr, rect, expected) {
    var self_ = this;
    var w = image.cols;
    var variant = this.preferredVariant;
    return this.read(image, ocr, rect, variant).then(function (r0) {
      var r = r0;
      if (r && expected && r.value === null && r.parsed === expected) {
        r = { raw: r.raw, score: r.score, rect: r.rect, parsed: r.parsed, value: expected };
      }
      if (!r || r.value === null) return { r: r, rect: rect, truncation: 'n/a', confirmed: false };
      var contact = edgeContact(image, rect);
      if (!contact.left && !contact.right) {
        return { r: r, rect: rect, truncation: 'clear', confirmed: true };
      }
      var step = 0;
      function widen() {
        if (step >= EXP_EXPAND_STEPS.length) {
          return { r: r, rect: rect, truncation: 'unresolved', confirmed: false,
                   reason: 'edge_contact_persists' };
        }
        var grow = EXP_EXPAND_STEPS[step++];
        var nx = Math.max(0, rect[0] - (contact.left ? grow : 0));
        var nw = Math.min(w - nx, rect[2] + (contact.left ? rect[0] - nx : 0) + (contact.right ? grow : 0));
        var wider = [nx, rect[1], nw, rect[3]];
        return self_.read(image, ocr, wider, variant).then(function (r2) {
          var c2 = edgeContact(image, wider);
          if (r2 && r2.value === null && r2.parsed !== null &&
              r2.parsed === r.value && r2.score >= EXP_CONSENSUS_SCORE) {
            r2 = { raw: r2.raw, score: r2.score, rect: r2.rect, parsed: r2.parsed, value: r2.parsed };
          }
          if (!r2 || r2.value === null) {
            // The wider crop could not be parsed at all - keep widening, and
            // never fall back to the narrow reading that may be cut off.
            return widen();
          }
          if (r2.value !== r.value) {
            // FIX-3: the numbers disagree, so the narrow one was truncated (or
            // the wide one picked up a neighbour). Nothing is confirmed.
            return { r: r2, rect: wider, truncation: 'mismatch', confirmed: false,
                     narrow: r.value, wide: r2.value };
          }
          // §6.1 asks for "확장 전후 숫자가 다르면 확정하지 않는다": agreement
          // under a wider crop is the evidence that nothing was cut off. A
          // still-touching edge on the wider crop is usually the HUD bar, and
          // demanding it clear would reject every legitimate reading.
          return { r: r2, rect: wider,
                   truncation: (!c2.left && !c2.right) ? 'confirmed_wider' : 'confirmed_agreed',
                   confirmed: true };
        });
      }
      return widen();
    });
  };

  /* 글꼴 대조로 한 번에 읽는다. 성공하면 OCR을 아예 부르지 않는다.

     잘림 검사가 따로 필요 없다: 글자가 잘리면 그 글리프가 어떤 아틀라스
     항목과도 완전 일치하지 않아 판독 자체가 거부된다. 부분 글리프를 억지로
     맞추는 경로가 없다. */
  ExpLocator.prototype.readByGlyph = function (image) {
    if (!this.font) return null;
    var G = root.glyphs;
    if (!G) return null;
    var h = image.rows, w = image.cols;
    var rect = [0, Math.max(0, h - 26), w, Math.min(26, h)];
    var res = G.readLine(image, rect, this.font, { minRunWidth: 60 });
    this.glyphReads += 1;
    if (!res.ok) { this.glyphMisses += 1; return res; }
    res.value = parse.parseExperience(res.text);
    return res;
  };

  ExpLocator.prototype.locate = function (image, ocr) {
    var self_ = this;
    var h = image.rows, w = image.cols;

    // 1) 글꼴 대조
    var gl = this.readByGlyph(image);
    if (gl && gl.ok && gl.value !== null) {
      var gate = (function () {
        if (!self_.confirmedDigits || gl.value.length >= self_.confirmedDigits) {
          self_.confirmedDigits = gl.value.length; self_.shrinkPending = null;
          return { accept: true, reason: null };
        }
        if (self_.shrinkPending && self_.shrinkPending[0] === gl.value) {
          self_.shrinkPending[1] += 1;
          if (self_.shrinkPending[1] >= 2) {
            self_.confirmedDigits = gl.value.length; self_.shrinkPending = null;
            return { accept: true, reason: 'shrink_confirmed' };
          }
        } else { self_.shrinkPending = [gl.value, 1]; }
        return { accept: false, reason: 'digit_count_dropped' };
      })();
      var box = [gl.band.x, gl.band.y, gl.band.w, gl.band.h];
      self_.rect = box;
      return Promise.resolve({
        bbox: box, raw: gl.text, score: 1, value: gate.accept ? gl.value : null,
        valid: gate.accept, roi_source: 'glyph', roi_locked: false,
        searches: self_.searches, attempts: self_.attempts,
        truncation: 'glyph_exact', confirmed: gate.accept,
        reject_reason: gate.accept ? null : gate.reason,
        accept_route: 'glyph_atlas', agreeing_crops: 1,
        glyph_runs: gl.runs
      });
    }

    /* 2) 아틀라스가 모르는 글자가 있다. OCR로 읽고, 문법을 통과하며 글자 수가
          구간 수와 정확히 맞으면 그 글자로 아틀라스를 넓힌다. */
    var pending = gl;
    // Only ever used when the search finds nothing, and reported as 'prior'
    // so the UI never presents a guess as a detection.
    var prior = [Math.trunc(w * 0.435), h - 12,
                 Math.trunc(w * 0.574) - Math.trunc(w * 0.435), 12];

    /* `roi_source` says where the rectangle came from and survives locking;
       `locked` says whether the rectangle is being reused. Keeping them apart
       is what the 2026-09-05 crop panel got wrong (§5.2). */
    function result(rect, r, source, locked, extra) {
      // §6.4: "정상 판독"과 실패를 구분하려면 실패했을 때 무엇을 읽었는지가
      // 보여야 한다. The 2026-09-05 build reported an empty string for every
      // unsuccessful search, which made a grammar mismatch, a low score and a
      // crop that found nothing look identical.
      var best = null;
      self_.tried.forEach(function (t) {
        if (!best || t.score > best.score) best = t;
      });
      var out = {
        bbox: rect, raw: r ? r.raw : '', score: r ? r.score : 0,
        value: r ? r.value : null, valid: !!(r && r.value !== null),
        roi_source: source, roi_locked: !!locked,
        searches: self_.searches, attempts: self_.attempts,
        truncation: 'n/a', confirmed: false, reject_reason: null,
        best_raw: best ? best.raw : null,
        best_score: best ? best.score : null,
        best_rect: best ? best.rect : null,
        best_parsed: best ? parse.parseExperience(best.raw) : null,
        tried: self_.tried.slice(0, 6)
      };
      Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }

    /* FIX-3: a sudden loss of digits against a confirmed value is treated as a
       suspected misread - re-search and require a second agreeing observation
       before it becomes the new value. */
    function acceptDigits(value) {
      if (value === null) return { accept: false, reason: 'no_value' };
      if (!self_.confirmedDigits || value.length >= self_.confirmedDigits) {
        self_.confirmedDigits = value.length;
        self_.shrinkPending = null;
        return { accept: true, reason: null };
      }
      if (self_.shrinkPending && self_.shrinkPending[0] === value) {
        self_.shrinkPending[1] += 1;
        if (self_.shrinkPending[1] >= 2) {
          self_.confirmedDigits = value.length;
          self_.shrinkPending = null;
          return { accept: true, reason: 'shrink_confirmed' };
        }
      } else {
        self_.shrinkPending = [value, 1];
      }
      return { accept: false, reason: 'digit_count_dropped' };
    }

    function finish(checked, source, locked, route, agree) {
      var r = checked.r;
      if (!checked.confirmed) {
        return result(checked.rect, r, source, locked, {
          truncation: checked.truncation,
          confirmed: false,
          valid: false,
          value: null,
          reject_reason: checked.reason || checked.truncation,
          narrow_value: checked.narrow || null,
          wide_value: checked.wide || null
        });
      }
      var gate = acceptDigits(r.value);
      if (!gate.accept) {
        return result(checked.rect, r, source, locked, {
          truncation: checked.truncation, confirmed: false, valid: false, value: null,
          reject_reason: gate.reason, pending_value: r.value
        });
      }
      return result(checked.rect, r, source, locked,
        { truncation: checked.truncation, confirmed: true,
          accept_reason: gate.reason, accept_route: route || 'single_read',
          agreeing_crops: agree || 1 });
    }

    if (this.rect) {
      self_.tried = [];
      var locked = this.rect;
      var first = this.preferredVariant;
      var second = first === 'raw' ? 'inverted' : 'raw';
      return this.read(image, ocr, locked, first).then(function (r) {
        if (r) self_.tried.push({ rect: locked, raw: r.raw, score: r.score, parsed: r.parsed,
                                  variant: first, truncation: 'pending', confirmed: false });
        if (r && r.value !== null) return null;                       // confident on its own
        if (!r || r.parsed === null || r.score < EXP_CONSENSUS_SCORE) return null;
        // Marginal but grammatical: ask for an independent reading of the same
        // frame - the other preprocessing first, then a different crop.
        return self_.read(image, ocr, locked, second).then(function (r2) {
          if (r2) self_.tried.push({ rect: locked, raw: r2.raw, score: r2.score, parsed: r2.parsed,
                                     variant: second, truncation: 'agreement_probe',
                                     confirmed: false });
          if (r2 && r2.parsed === r.parsed && r2.score >= EXP_CONSENSUS_SCORE) return r.parsed;
          var alt = altRect(locked, h);
          return self_.read(image, ocr, alt).then(function (r3) {
            if (r3) self_.tried.push({ rect: alt, raw: r3.raw, score: r3.score, parsed: r3.parsed,
                                       variant: 'raw', truncation: 'agreement_probe',
                                       confirmed: false });
            return (r3 && r3.parsed === r.parsed && r3.score >= EXP_CONSENSUS_SCORE) ? r.parsed : null;
          });
        });
      }).then(function (agreed) {
        return self_.readChecked(image, ocr, locked, agreed).then(function (checked) {
          if (checked.confirmed) {
            self_.misses = 0;
            if (checked.rect !== self_.rect) self_.rect = checked.rect;   // keep the widened crop
            return finish(checked, 'searched', true, agreed ? 'crop_agreement' : 'single_read');
          }
          self_.misses += 1;
          if (self_.misses < 12) return finish(checked, 'searched', true);  // brief occlusion
          self_.rect = null;
          self_.misses = 0;
          return self_.locate(image, ocr);
        });
      });
    }

    this.searches += 1;
    this.tried = [];
    var tries = [];
    expTextRuns(image).forEach(function (run) {
      expRects(run, h).forEach(function (rect) { tries.push(rect); });
    });
    var searched = tries.length;
    tries.push(prior);

    // Survey every candidate crop first (cheap reads, no widening), then decide
    // once with all of them in hand.
    var survey = [];
    function sweep(variant) {
      var chain = Promise.resolve();
      var confident = false;
      tries.slice(0, EXP_MAX_SURVEY).forEach(function (rect, index) {
        chain = chain.then(function () {
          // A read that is confident on its own settles it; no need to pay for
          // the rest of the sweep. This keeps the fast path as quick as it was
          // before the agreement route existed.
          if (confident) return;
          self_.attempts += 1;
          return self_.read(image, ocr, rect, variant).then(function (r) {
            if (!r) return;
            if (r.value !== null) confident = true;
            survey.push({ r: r, rect: rect, index: index, variant: variant });
            self_.tried.push({ rect: rect, raw: r.raw, score: r.score, parsed: r.parsed,
                               variant: variant, truncation: 'survey', confirmed: false });
          });
        });
      });
      return chain;
    }

    function decide() {
      var pick = null, route = null;
      // Route 1: a single confident read.
      survey.forEach(function (s2) {
        if (s2.r.value !== null && (!pick || s2.r.score > pick.r.score)) { pick = s2; route = 'single_read'; }
      });
      if (!pick) {
        // Route 2: two independent reads of this frame agreeing on the string.
        var byValue = {};
        survey.forEach(function (s2) {
          if (s2.r.parsed === null || s2.r.score < EXP_CONSENSUS_SCORE) return;
          (byValue[s2.r.parsed] = byValue[s2.r.parsed] || []).push(s2);
        });
        Object.keys(byValue).forEach(function (v) {
          var group = byValue[v];
          // Two reads of the identical crop with the identical preprocessing
          // would be the same evidence twice; require a different rect or a
          // different preprocessing.
          var distinct = {};
          group.forEach(function (g) { distinct[g.rect.join(',') + '|' + g.variant] = 1; });
          if (Object.keys(distinct).length < 2) return;
          var best = group.reduce(function (a, b) { return b.r.score > a.r.score ? b : a; });
          if (!pick || best.r.score > pick.r.score) {
            pick = { r: { raw: best.r.raw, score: best.r.score, rect: best.rect,
                          parsed: best.r.parsed, value: v, variant: best.variant },
                     rect: best.rect, index: best.index, variant: best.variant,
                     agreedValue: v, agree: group.length };
            route = 'crop_agreement';
          }
        });
      }
      return pick ? { pick: pick, route: route } : null;
    }

    /* Only the ordinary preprocessing is swept.

       An inverted (black-on-white) variant was tried on 2026-09-06 because the
       readout is white-on-dark and the recogniser is trained mostly the other
       way round. Measured on the user's live screen it was decisively worse -
       0.52..0.63 with mangled text ("802,7,12,858,03 184185%") against
       0.84..0.92 for the ordinary crop - so it is not in the path. The
       function is kept in `expInverted` with this note rather than silently
       deleted, since "we tried it and it lost" is the useful record. */
    return sweep('raw').then(function () {
      return decide();
    }).then(function (chosen) {
      var pick = chosen && chosen.pick, route = chosen && chosen.route;
      if (!pick) {
        return result(tries[0] || prior, null, 'searching', false, { reject_reason: 'no_candidate' });
      }
      return self_.readChecked(image, ocr, pick.rect, pick.agreedValue || null).then(function (checked) {
        if (!checked.confirmed) {
          return result(pick.rect, checked.r, 'searching', false,
            { reject_reason: checked.reason || checked.truncation, truncation: checked.truncation });
        }
        self_.rect = checked.rect;
        self_.misses = 0;
        if (pick.r && pick.r.variant) self_.preferredVariant = pick.r.variant;
        else if (pick.variant) self_.preferredVariant = pick.variant;
        // 아틀라스 넓히기: OCR이 확신한 문자열로 모르는 글리프에 라벨을 붙인다.
        if (pending && pending.unknownBitmaps && pending.unknownBitmaps.length &&
            self_.font && root.glyphs && checked.r && checked.r.raw) {
          var got = root.glyphs.learnFrom(pending, checked.r.raw.trim(), self_.font);
          if (got) self_.learned += got;
        }
        return finish(checked, pick.index < searched ? 'searched' : 'prior', false, route,
                      pick.agree || 1);
      });
    });
  };

  /* 버프 격자의 실제 경계.

     사용자 제안(2026-09-06 memo):
       우측 끝 최상단 = 게임 화면의 우측 최상단
       최하단        = 버프 아이콘 중 가장 밑에 있는 것의 최하단
       좌측 끝       = 버프 아이콘 중 가장 왼쪽에 있는 것의 좌측 끝

     기존 고정 범위(우측 절반 x 상단 180px)는 버프가 다섯 줄을 넘으면 아래를
     놓치고, 적을 때는 쓸데없이 넓다. 아이콘이 하나도 없으면 확정할 수 없으므로
     기본 범위를 그대로 쓴다. */
  var BUFF_GRID_MARGIN = 6;

  function defaultBuffRect(image) {
    var x0 = Math.trunc(image.cols * 0.5);
    return [x0, 0, image.cols - x0, Math.min(180, Math.trunc(image.rows / 3))];
  }

  function buffGridRect(image, boxes) {
    if (!boxes || !boxes.length) return null;
    var left = Infinity, bottom = 0;
    boxes.forEach(function (b) {
      if (b[0] < left) left = b[0];
      if (b[1] + b[3] > bottom) bottom = b[1] + b[3];
    });
    if (!isFinite(left)) return null;
    var x = Math.max(0, left - BUFF_GRID_MARGIN);
    var h = Math.min(image.rows, bottom + BUFF_GRID_MARGIN);
    if (image.cols - x < 40 || h < 20) return null;
    return [x, 0, image.cols - x, h];       // 우상단 고정, 좌/하단은 아이콘에서
  }

  /* 격자 범위는 넓히는 데만 쓴다.

     memo의 제안은 버프 격자의 실제 경계로 범위를 잡자는 것이고, 고정 180px가
     버프 줄이 늘어나면 아래를 놓친다는 지적은 옳다. 다만 이 경계를 그대로
     '좁히는' 데 쓰면 안 된다는 것이 시험에서 드러났다: 나란히 붙은 두 아이콘의
     윤곽이 하나로 합쳐지면 iconCandidates가 한 개만 돌려주고, 그 하나로 만든
     범위가 나머지 아이콘을 잘라내 영원히 못 찾게 된다(실제 재현됨).

     그래서 기본 범위와 합집합을 취한다. 넓어지기만 하므로 놓치는 일이 없고,
     버프가 180px 아래로 내려가면 자동으로 따라 내려간다. */
  function unionBuffRect(image, boxes) {
    var base = defaultBuffRect(image);
    var derived = buffGridRect(image, boxes);
    if (!derived) return base;
    var x = Math.min(base[0], derived[0]);
    var bottom = Math.max(base[1] + base[3], derived[1] + derived[3]);
    return [x, 0, image.cols - x, Math.min(image.rows, bottom)];
  }

  function iconCandidates(image, searchRect) {
    var s = new Scope();
    try {
      var sr = searchRect || defaultBuffRect(image);
      var x0 = sr[0];
      var region = s.add(roi(image, sr[0], sr[1], sr[2], sr[3]));
      if (!region) return [];
      var gray = s.add(new cv.Mat()); cv.cvtColor(region, gray, cv.COLOR_BGR2GRAY);
      var edges = s.add(new cv.Mat()); cv.Canny(gray, edges, 70, 160);
      var contours = contourList(edges); s.add(contours);
      var boxes = [];
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        var r = cv.boundingRect(c);
        c.delete();
        if (r.width >= 27 && r.width <= 36 && r.height >= 27 && r.height <= 36 &&
            Math.abs(r.width - r.height) <= 3) {
          var box = [r.x + x0, r.y + sr[1], r.width, r.height];
          var dup = boxes.some(function (b) {
            return Math.abs(box[0] - b[0]) < 8 && Math.abs(box[1] - b[1]) < 8;
          });
          if (!dup) boxes.push(box);
        }
      }
      boxes.sort(function (a, b) {
        var ra = Math.floor(a[1] / 12), rb = Math.floor(b[1] / 12);
        return ra !== rb ? ra - rb : a[0] - b[0];
      });
      return boxes;
    } finally { s.done(); }
  }

  /* Yellow timer glyphs isolated as white-on-black, so the recogniser sees the
     digits instead of the icon art behind them. */
  function yellowGlyphs(crop) {
    if (!crop || !crop.rows) return null;
    var hsv = new cv.Mat();
    cv.cvtColor(crop, hsv, cv.COLOR_BGR2HSV);
    var low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [18, 90, 160, 0]);
    var high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 255, 255, 0]);
    var mask = new cv.Mat();
    cv.inRange(hsv, low, high, mask);
    var out = new cv.Mat();
    cv.cvtColor(mask, out, cv.COLOR_GRAY2BGR);
    hsv.delete(); low.delete(); high.delete(); mask.delete();
    return out;
  }

  function buffVisibility(image) {
    // A large dark in-game tooltip can cover the buff row even under WGC.
    if (image.cols < 700) return 'unknown';
    var region = roi(image, image.cols - 380, 30, 380, 130);
    if (!region) return 'unknown';
    var hsv = new cv.Mat();
    cv.cvtColor(region, hsv, cv.COLOR_BGR2HSV);
    var d = hsv.data, n = hsv.rows * hsv.cols, covered = 0;
    for (var i = 0; i < n; i++) {
      if (d[i * 3 + 2] < 140 && d[i * 3 + 1] < 130) covered++;
    }
    hsv.delete(); region.delete();
    return (covered / n) > 0.8 ? 'obscured' : 'observable';
  }

  /* ---- icon signatures (FIX-5) ----------------------------------------

     Two icons can be identical everywhere the template patch looks. Measured
     on assets/samples/live_booster.png, 2026-09-06:

       cell @1203 (재물, gold droplet)  P04 rows2-9 = 0.9973 | P05 = 0.9970
       cell @1235 (경험, no droplet)    P04 rows2-9 = 0.9967 | P05 = 0.9986

     A 0.0006 margin is a coin flip, and the live app duly hooked the wrong
     potion. The gold droplet separates them cleanly in both the stored
     template and the live capture:

       gold pixels in x3..12 y9..20   재물 = 14 / 14   경험 = 0 / 0

     A label may therefore carry a `signature`, checked on the candidate cell
     before the label is accepted. */
  function hsvSignatureCount(crop, sig) {
    if (!crop || !crop.rows) return 0;
    var r = sig.rect || [0, 0, crop.cols, crop.rows];
    var sub = roi(crop, r[0], r[1], r[2], r[3]);
    if (!sub) return 0;
    var hsv = new cv.Mat();
    cv.cvtColor(sub, hsv, cv.COLOR_BGR2HSV);
    var d = hsv.data, n = hsv.rows * hsv.cols, count = 0;
    var h0 = sig.hue ? sig.hue[0] : 0, h1 = sig.hue ? sig.hue[1] : 179;
    var sMin = sig.sat_min === undefined ? 0 : sig.sat_min;
    var vMin = sig.val_min === undefined ? 0 : sig.val_min;
    for (var i = 0; i < n; i++) {
      var H = d[i * 3], S = d[i * 3 + 1], V = d[i * 3 + 2];
      if (H >= h0 && H <= h1 && S >= sMin && V >= vMin) count++;
    }
    hsv.delete(); sub.delete();
    return count;
  }

  function signatureVerdict(crop, sig) {
    if (!sig) return { pass: true, reason: 'no_signature', count: null };
    if (sig.kind !== 'hsv_count') return { pass: true, reason: 'unknown_signature_kind', count: null };
    var count = hsvSignatureCount(crop, sig);
    var pass = true, reason = 'ok';
    if (sig.min_count !== undefined && count < sig.min_count) { pass = false; reason = 'below_min'; }
    if (sig.max_count !== undefined && count > sig.max_count) { pass = false; reason = 'above_max'; }
    return { pass: pass, reason: reason, count: count };
  }

  /* A cheap fingerprint of the area of a buff icon where its number is drawn.

     Used to answer "did the number change?" about once a second without
     paying for OCR. Only when it changes does the reading get taken again
     (user request, 2026-09-06). */
  /* 숫자 띠의 '밝은 화소 열별 개수'.

     처음에는 10x6 축소본을 썼는데, 측정해 보니 한 자리가 바뀌어도 평균차가
     8.37로 허용오차 6을 겨우 넘겼다(1.4배). 압축 잡음이 조금만 끼면 변화를
     놓치고, 그러면 OCR을 건너뛰어 옛 값이 그대로 남는다 — 사용자가 본
     "시간이 지나갔는데 텍스트 값이 변화가 없다"가 이것이다.

     밝은 화소를 열별로 세면 같은 한 자리 변화가 합계차 21로 잡혀
     임계 3의 7배가 된다. 축소 평균이 지워버리던 신호가 그대로 남는다.

       동일                 축소 0.00 / 서명   0
       한 자리 교체(29->22) 축소 8.37 / 서명  21
       숫자 전체 제거       축소 18.9 / 서명  67   */
  var CELL_GLYPH_THRESHOLD = 170;

  function cellFingerprint(image, box) {
    var s = new Scope();
    try {
      var crop = s.add(roi(image, box[0], box[1] + 6, box[2], Math.max(1, box[3] - 8)));
      if (!crop) return null;
      var gray = s.add(new cv.Mat()); cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
      var bin = s.add(new cv.Mat());
      cv.threshold(gray, bin, CELL_GLYPH_THRESHOLD, 255, cv.THRESH_BINARY);
      var d = bin.data, W = bin.cols, H = bin.rows;
      var out = new Uint16Array(W);
      for (var y = 0; y < H; y++) {
        var row = y * W;
        for (var x = 0; x < W; x++) if (d[row + x]) out[x]++;
      }
      return out;
    } catch (e) {
      return null;
    } finally { s.done(); }
  }

  // 합계 차이. 잡음은 한 자리수, 숫자 한 자리 변화는 20 이상.
  function fingerprintChanged(a, b, tol) {
    if (!a || !b || a.length !== b.length) return true;
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum > (tol === undefined ? 3 : tol);
  }

  /* Correlation of one small rectangle of a candidate cell against the same
     rectangle of a template. Used to tell two icons apart on a patch that the
     number overlay never covers (FIX-12). */
  function rectCorrelation(cell, template, rect) {
    var a = roi(cell, rect[0], rect[1], rect[2], rect[3]);
    var b = roi(template, rect[0], rect[1], rect[2], rect[3]);
    if (!a || !b || a.rows !== b.rows || a.cols !== b.cols) {
      if (a) a.delete(); if (b) b.delete();
      return null;
    }
    var af = new cv.Mat(), bf = new cv.Mat();
    a.convertTo(af, cv.CV_32F); b.convertTo(bf, cv.CV_32F);
    var res = new cv.Mat();
    var v = null;
    try {
      cv.matchTemplate(af, bf, res, cv.TM_CCOEFF_NORMED);
      v = res.data32F[0];
    } catch (e) { v = null; }
    a.delete(); b.delete(); af.delete(); bf.delete(); res.delete();
    return (v === null || isNaN(v)) ? null : v;
  }

  // Best correlation of `rect` against any registered rendering of `item`.
  function bestRectCorrelation(cell, item, rect) {
    var best = null;
    var list = (item && item._templates) || [];
    for (var i = 0; i < list.length; i++) {
      var v = rectCorrelation(cell, list[i], rect);
      if (v !== null && (best === null || v > best)) best = v;
    }
    return best;
  }

  /* Top-K non-overlapping peaks of a match result. The old code took only the
     global maximum, which is why a 0.0006 margin decided the answer. */
  function matchPeaks(area, patch, k, minScore) {
    var res = new cv.Mat();
    cv.matchTemplate(area, patch, res, cv.TM_CCOEFF_NORMED);
    var out = [];
    for (var i = 0; i < k; i++) {
      var mm = cv.minMaxLoc(res);
      if (!(mm.maxVal >= minScore)) break;
      out.push({ score: mm.maxVal, x: mm.maxLoc.x, y: mm.maxLoc.y });
      // Blank a cell-sized neighbourhood so the next peak is a different icon.
      var x0 = Math.max(0, mm.maxLoc.x - 14), y0 = Math.max(0, mm.maxLoc.y - 8);
      var x1 = Math.min(res.cols, mm.maxLoc.x + 15), y1 = Math.min(res.rows, mm.maxLoc.y + 9);
      var blank = res.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      blank.setTo(new cv.Scalar(-1));
      blank.delete();
    }
    res.delete();
    return out;
  }

  /* 버프 격자에서 아이콘이 앉을 수 있는 자리들.

     버프 아이콘은 32px 격자에 오른쪽 정렬로 붙는다. 윤곽으로 찾은 상자들에서
     행을 뽑고, 그 행의 모든 칸을 채워 후보 자리를 만든다. 윤곽이 이웃과
     붙어 하나로 합쳐진 칸도 이렇게 하면 자리로는 남는다.

     실측(녹화 175프레임): 이 방식이 실제 아이콘 칸의 99.8%를 덮었다.
     행을 '최솟값으로 갱신'하면 y가 0쪽으로 흘러내려 덮는 비율이 80%로
     떨어졌다 - 마지막 관측값을 그대로 쓴다. */
  function latticeCells(image, boxes, searchRect) {
    var anchor = image.cols - 34;
    var rows = [];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var slot = Math.round((anchor - b[0]) / 32);
      if (slot < 0 || slot > 12) continue;
      if (Math.abs(anchor - slot * 32 - b[0]) > 4) continue;   // 격자에 앉지 않은 상자
      var hit = null;
      for (var r = 0; r < rows.length; r++) {
        if (Math.abs(rows[r].y - b[1]) <= 3) { hit = rows[r]; break; }
      }
      if (hit) { hit.y = b[1]; hit.n += 1; }
      else rows.push({ y: b[1], n: 1 });
    }
    var cells = [];
    function add(x, y) {
      if (x < searchRect[0] || y < searchRect[1]) return;
      if (x + 32 > image.cols || y + 32 > searchRect[1] + searchRect[3]) return;
      for (var q = 0; q < cells.length; q++) {
        if (Math.abs(cells[q][0] - x) < 4 && Math.abs(cells[q][1] - y) < 4) return;
      }
      cells.push([x, y]);
    }
    rows.forEach(function (row) {
      /* 한 상자만 있는 행은 배경의 네모일 수 있다. 격자에 둘 이상 앉아야
         버프 줄로 본다 (실측: 이 조건이 배경 행을 걸러 검사 칸 수를 절반으로
         줄였다). */
      if (row.n < 2) return;
      for (var sl = 0; sl <= 12; sl++) add(anchor - sl * 32, row.y);
    });
    boxes.forEach(function (b) { add(b[0], b[1]); });
    return cells;
  }

  /* ---- buff classification -------------------------------------------- */

  /* 버프 아이콘 숫자 판독.

     숫자는 두 자리에 두 종류로 그려진다.
       - 아이콘 중앙의 노란 숫자: "29" 또는 "1:51"
       - 아이콘 좌측 하단의 흰 분 숫자: "13"
     둘 다 고정 비트맵 글꼴이므로 경험치 막대와 같은 정확 대조로 읽는다.
     OCR은 아틀라스가 모르는 글리프를 만났을 때만 돌고, 그때 읽은 값으로
     새 변형에 라벨을 붙여 아틀라스를 넓힌다.

     부스터 숫자는 이 경로를 타지 않는다 — 부스터는 버프 아이콘이 아니라
     HUD 앵커라서 BuffClassifier 를 거치지 않으며, 사용자 지시대로 OCR을
     그대로 쓴다. */
  function BuffClassifier(ocr, fonts) {
    this.ocr = ocr;
    this.registry = [];
    this.byId = {};
    this.fonts = fonts || null;   // {yellow, minutes, minutesL2} 글꼴 아틀라스
    /* 칸마다 L2 누적기를 하나씩 둔다 (키는 아래 _describe 의 캐시 키와 같다).
       흰 분 숫자만 L2 를 쓴다 — 값이 60초에 한 번 바뀌므로 버프 패스가 몇 초에
       한 번 돌아도 같은 값의 프레임이 여러 장 쌓인다. 노란 시계는 1초마다
       바뀌어서 지금 패스 주기로는 쌓일 틈이 없다. */
    this.readers = {};
    this._glyphPending = null;    // 실패한 글꼴 판독 (OCR이 라벨을 붙여 줄 대상)
    this.glyphReads = 0; this.glyphHits = 0; this.glyphLearned = 0;
    this.cells = {};        // id -> {bbox, fingerprint, entry} for the OCR skip
    this.passNo = 0;        // 캐시 가지치기용 패스 번호
    this.glyphNoBand = 0;   // 숫자가 그려지지 않아 OCR 을 건너뛴 칸 수
    this.lastGridRect = null;   // 진단용으로만 보관 (판정에 재사용하지 않는다)
  }

  /* 캐시 키에 자리가 들어 있으므로, 버프 줄이 밀릴 때마다 새 키가 생긴다.
     라벨 없는 칸까지 캐시하면서 키 수가 늘었으니 오래된 것은 버린다. */
  var CELL_CACHE_MAX = 400;
  BuffClassifier.prototype.pruneCells = function (pass) {
    var keys = Object.keys(this.cells);
    if (keys.length <= CELL_CACHE_MAX) return;
    var self_ = this;
    keys.sort(function (a, b) {
      return (self_.cells[a].pass || 0) - (self_.cells[b].pass || 0);
    });
    for (var i = 0; i < keys.length - CELL_CACHE_MAX; i++) {
      delete this.cells[keys[i]];
      if (this.readers) delete this.readers[keys[i]];
    }
  };

  BuffClassifier.prototype.resetCells = function () {
    this.cells = {}; this.lastGridRect = null;
  };

  BuffClassifier.prototype.reload = function (labelsUrl, assetBase) {
    var self_ = this;
    return fetch(labelsUrl).then(function (r) {
      if (!r.ok) throw new Error('labels ' + labelsUrl + ' -> HTTP ' + r.status);
      return r.json();
    }).then(function (items) {
      return Promise.all(items.map(function (item) {
        // A slot may exist before its icon does - the rune-duration entry is
        // registered unidentified on purpose (§4.4).
        if (!item.image) { item._template = null; item._templates = []; return Promise.resolve(item); }
        // FIX-12: one icon can be drawn several ways. The potion's top rows
        // change completely between its minute display and its clock display,
        // so each rendering is registered as its own template and the best one
        // wins. Same idea as the two rune-duration variants.
        var urls = [item.image].concat(item.variant_images || []);
        return Promise.all(urls.map(function (u) {
          return fetch((assetBase || '') + u).then(function (r) { return r.ok ? r.blob() : null; })
            .then(function (b) { return b ? createImageBitmap(b) : null; })
            .then(function (bmp) {
              if (!bmp) return null;
              var c = new OffscreenCanvas(bmp.width, bmp.height);
              var g = c.getContext('2d', { willReadFrequently: true });
              g.drawImage(bmp, 0, 0);
              var m = matFromImageData(g.getImageData(0, 0, bmp.width, bmp.height));
              bmp.close();
              return m;
            }).catch(function () { return null; });
        })).then(function (mats) {
          item._templates = mats.filter(Boolean);
          item._template = item._templates.length ? item._templates[0] : null;
          return item;
        });
      }));
    }).then(function (items) {
      self_.registry = items;
      self_.byId = {};
      items.forEach(function (it) { self_.byId[it.id] = it; });
      return items.length;
    });
  };

  BuffClassifier.prototype.find = function (id) { return this.byId[id] || null; };

  BuffClassifier.prototype.setFonts = function (fonts) {
    this.fonts = fonts || null;
    this.readers = {};
    return this;
  };

  BuffClassifier.prototype.resetReaders = function () { this.readers = {}; };

  /* 이 칸의 L2 판독기. 없으면 만든다. */
  BuffClassifier.prototype._reader = function (key) {
    if (!key || !root.accumulate || !this.fonts || !this.fonts.minutesL2) return null;
    if (!this.readers[key]) {
      this.readers[key] = new root.accumulate.LayeredReader({
        strictFont: this.fonts.minutesL2,
        looseFont: this.fonts.minutes,
        maxFrames: 8
      });
    }
    return this.readers[key];
  };

  /* 글꼴 대조로 한 칸의 숫자를 읽는다. 성공하면 {text, mode, font}, 실패하면
     null 을 돌려주고 실패한 판독 결과는 학습용으로 남긴다.

     노란 글꼴과 흰 글꼴은 잉크 규칙이 서로를 배제한다 — 흰 글자는 R-B 가
     0 근처라 노란 규칙(>=50)에 걸리지 않고, 노란 글자는 B가 낮아 흰 규칙
     (min(R,G,B)>=150)에 걸리지 않는다. 그래서 순서대로 시도해도 섞이지 않는다. */
  BuffClassifier.prototype._readGlyph = function (crop, item, key) {
    var G = root.glyphs;
    if (!G || !this.fonts) return null;
    var declared = (item && item.time_mode) ? item.time_mode : 'unknown';
    var tries = [];
    if (this.fonts.yellow) tries.push(['yellow', this.fonts.yellow]);
    if (this.fonts.minutes) tries.push(['minutes', this.fonts.minutes]);
    this._glyphPending = null;
    /* 이번 판독에서 숫자꼴 띠를 하나라도 봤는가. _describe 가 OCR 을 부를지
       말지 정하는 데 쓴다 - 아래 주석 참고. */
    this._glyphSawBand = false;
    for (var i = 0; i < tries.length; i++) {
      var r;
      if (tries[i][0] === 'minutes') {
        /* L2 -> L3. 누적기는 연속 프레임을 받아야 하므로 연속 사본을 넘긴다
           (roi 는 비연속 뷰다 — vision.contiguous 주석 참고). */
        var rd = this._reader(key);
        if (rd) {
          var copy = contiguous(crop);
          var flat = copy || crop;
          r = rd.read({ rows: flat.rows, cols: flat.cols, data: flat.data });
          if (copy) copy.delete();
        } else {
          r = G.readLine(crop, null, tries[i][1], {});
        }
      } else {
        r = G.readLine(crop, null, tries[i][1], {});
      }
      if (!r) continue;
      if (!r.ok) {
        if (r.sawBand || (r.unknownBitmaps && r.unknownBitmaps.length)) {
          this._glyphSawBand = true;
        }
        if (r.unknownBitmaps && r.unknownBitmaps.length && !this._glyphPending) {
          this._glyphPending = { result: r, font: tries[i][1] };
        }
        continue;
      }
      /* 단위는 **어느 글꼴로 읽혔는지**로 정한다. 라벨의 time_mode 로 정하면
         안 된다 — 같은 라벨이 남은 시간에 따라 표기를 바꾸기 때문이다.

         사용자 보고 2026-09-07: "8분 n초 남았을 때와 8초 남았을 때를 구별하지
         못한다". 실제로 그랬다. P04(time_mode 'wealth')가 노란 맨숫자 "8" 을
         내면 아래 else 로 떨어져 **8분(=8:59, 539초)** 으로 읽혔다. 실제로는
         8초다.

         녹화 전체로 확인한 규칙 (맨숫자 판독의 움직임을 센 것):

             노란 맨숫자  초처럼 움직임 5,888회 · 분처럼 0회
             흰  맨숫자  초처럼    18회 · 분처럼 30회

         즉 **노란 가운데 맨숫자는 언제나 1분 미만의 초**이고, 분은 흰 좌측
         하단 숫자로만 표시된다. P04 도 같다 — 10분 이상은 흰 분, 10분 미만은
         노란 m:ss, 1분 미만은 노란 맨숫자다 (f1123 흰 "10" -> f1124 노란
         "9:59", f1662 "1:00" -> "59" 로 확인). */
      var mode;
      if (tries[i][0] === 'minutes') {
        mode = 'minutes';                       // 흰 좌측 하단 = 분 (분:59 규칙)
      } else if (r.text.indexOf(':') >= 0) {
        mode = 'clock';                         // 노란 가운데 m:ss
      } else {
        mode = 'seconds';                       // 노란 가운데 맨숫자 = 1분 미만 초
      }
      return { text: r.text, mode: mode, font: tries[i][0], band: r.band,
               layer: r.layer || 'L3', averaged: r.averaged || 1 };
    }
    return null;
  };

  BuffClassifier.prototype.roleItems = function (role) {
    return this.registry.filter(function (it) { return it.role === role; });
  };

  /* opts: { onItem(entry), yieldEvery, aborted() } */
  BuffClassifier.prototype.classify = function (image, ids, opts) {
    var self_ = this;
    opts = opts || {};
    /* 아이콘 후보는 항상 기본 범위 전체에서 찾는다. 격자 범위를 프레임 사이로
       들고 다니면, 나중에 생긴 버프 줄이 그 범위 밖이라 영원히 안 보이게 된다
       (시험에서 실제로 재현됨). 그래서 범위는 매 프레임 이 프레임의 아이콘에서
       다시 만들고, 비싼 템플릿 정합의 범위를 좁히는 데만 쓴다. */
    self_.passNo += 1;
    var clock_ = (root.performance && root.performance.now)
      ? function () { return root.performance.now(); }
      : function () { return Date.now(); };
    var tStart = clock_(), tContour = 0, tMatch = 0, nMatch = 0;
    var scanRect = defaultBuffRect(image);
    var boxes = iconCandidates(image, scanRect);
    var searchRect = unionBuffRect(image, boxes);
    tContour = clock_() - tStart;
    // 격자가 기본 범위보다 아래로 내려갔으면 그만큼 다시 훑는다.
    if (searchRect[3] > scanRect[3] || searchRect[0] < scanRect[0]) {
      boxes = iconCandidates(image, searchRect);
      searchRect = unionBuffRect(image, boxes);
    }
    self_.lastGridRect = searchRect;
    var half = searchRect[0];
    /* 라벨을 지정하지 않은 **표시용 전체 격자 패스**에서만 격자 자리로 좁힌다.

       이 패스는 39개 라벨을 전부 훑기 때문에 비싸다 (실측 selftest: 한 번에
       9.0초). 반면 알림 경로(hud)는 라벨을 지정해 두세 개만 보므로 싸고, 한
       칸이라도 놓치면 알림이 사라지므로 전면 탐색을 그대로 둔다.

       표시용 격자는 어차피 윤곽 상자에서 만든 행·칸만 보여 준다. 그 바깥에서
       라벨을 맞혀도 화면에 나올 자리가 없으므로, 좁혀도 보이는 결과가 달라지지
       않는다. */
    /* 실패한 실험: 격자 자리에서만 정합하기.

       39개 라벨을 전면에서 훑는 대신 후보 칸(약 50곳)에서만 훑으면 훑는
       위치가 46배 줄어든다. 네이티브 OpenCV 로 재면 실제로 2.4배 빨랐다
       (6.1ms -> 2.5ms).

       그런데 wasm 에서는 **전혀 빨라지지 않았다** (8.0초 그대로). 작은 cv.Mat
       을 2,000번 만들고 지우는 비용이 정합 자체보다 컸다. 게다가 앵커를
       image.cols-34 로 가정하는 바람에 client.png 에서 B01 칸을 통째로
       놓쳤다 (9칸 -> 8칸). latticeCells 는 아이콘 자리를 뽑는 도구로는
       쓸모가 있어 남겨 두지만, 판정 경로에서는 뺀다. */
    var area = roi(image, searchRect[0], searchRect[1], searchRect[2], searchRect[3]);
    var matched = [];
    var rejected = [];
    if (area) {
      for (var i = 0; i < self_.registry.length; i++) {
        var item = self_.registry[i];
        if (ids && ids.indexOf(item.id) === -1) continue;
        // An alias is the same icon art registered a second time (U12 is U13
        // below a minute). Matching both would make two labels fight over one
        // cell, so only the canonical entry competes.
        if (item.alias_of && !(ids && ids.indexOf(item.id) !== -1)) continue;
        var variants = item._templates && item._templates.length
          ? item._templates : (item._template ? [item._template] : []);
        if (!variants.length) continue;
        // FIX-12: a per-label floor. The potion is allowed a lower one because
        // the rival check below, not the raw score, is what decides identity.
        var minScore = item.match_min === undefined ? 0.90 : item.match_min;
        /* FIX-13: 같은 아이콘이 화면에 여러 개 있을 수 있다.
           실화면에서 룬이 두 개일 때 최고 peak 하나만 취해 프레임마다 다른
           쪽이 잡혔고, "남은 시간이 가장 긴 것을 채용" 규칙이 비교할 상대가
           없어 무너졌다. 여러 개를 허용한 라벨은 겹치지 않는 셀을 모두 모은다. */
        var maxInstances = item.max_instances === undefined ? 1 : item.max_instances;
        var wantPeaks = Math.max(maxInstances, (item.rival || item.signature) ? 4 : 1);
        var found = [];
        for (var vi = 0; vi < variants.length && found.length < maxInstances; vi++) {
          var template = variants[vi];
          // Top rows only: they avoid the numeric stacks/timers lower in the icon.
          var end = (item.time_mode === 'clock' || item.time_mode === 'wealth' ||
                     item.id.charAt(0) === 'P' || item.id.charAt(0) === 'U') ? 9 : 14;
          var patch = roi(template, 2, 2, template.cols - 4, end - 2);
          if (!patch) continue;
          if (patch.rows > area.rows || patch.cols > area.cols) { patch.delete(); continue; }
          var tm = clock_();
          var peaks = matchPeaks(area, patch, wantPeaks, minScore);
          tMatch += clock_() - tm; nMatch += 1;
          patch.delete();
          for (var p = 0; p < peaks.length && found.length < maxInstances; p++) {
            var x = peaks[p].x + half - 2, y = peaks[p].y + searchRect[1] - 2;
            if (x < 0 || y < 0) continue;
            // 이미 잡은 셀과 같은 자리면 건너뛴다.
            var dup = false;
            for (var q = 0; q < found.length; q++) {
              if (Math.abs(found[q][0][0] - x) < 8 && Math.abs(found[q][0][1] - y) < 8) { dup = true; break; }
            }
            if (dup) continue;
            var cell = roi(image, x, y, template.cols, template.rows);
            if (!cell) continue;
            var verdict = null, reject = null;
            if (item.rival && item.discriminator_rect) {
              /* FIX-12: two icons whose top rows are identical are told apart
                 on a patch the number overlay never covers - the pouch. The
                 cell is correlated against every rendering of this label and
                 every rendering of its rival; the label only takes the cell if
                 it fits better than the rival does. */
              var rivalItem = self_.byId[item.rival];
              var mine = bestRectCorrelation(cell, item, item.discriminator_rect);
              var theirs = rivalItem ? bestRectCorrelation(cell, rivalItem, item.discriminator_rect) : null;
              verdict = { kind: 'rival', self: mine, rival: theirs,
                          margin: (mine !== null && theirs !== null) ? mine - theirs : null };
              if (mine === null) reject = 'discriminator_unavailable';
              else if (theirs !== null && mine <= theirs) reject = 'rival_fits_better';
            } else if (item.signature) {
              verdict = signatureVerdict(cell, item.signature);
              if (!verdict.pass) reject = verdict.reason;
            }
            cell.delete();
            if (reject) {
              rejected.push({ id: item.id, at: [x, y], score: peaks[p].score,
                              reason: reject, verdict: verdict });
              continue;
            }
            found.push([[x, y, template.cols, template.rows], item, peaks[p].score, verdict]);
          }
        }
        if (!found.length) continue;
        found.forEach(function (taken) {
          matched.push(taken);
          var tx = taken[0][0], ty = taken[0][1];
          boxes = boxes.filter(function (b) {
            return Math.abs(b[0] - tx) > 8 || Math.abs(b[1] - ty) > 8;
          });
        });
      }
      area.delete();
    }

    var entries = boxes.map(function (b) { return [b, null, 0, null]; }).concat(matched);

    // Buff rows are contiguous 32-pixel cells anchored at the right HUD edge.
    // Reject isolated scenery contours and recover cells with broken borders.
    var grid = [], used = [];
    var anchors = entries.slice().sort(function (a, b) { return a[0][1] - b[0][1]; });
    anchors.forEach(function (anchor) {
      var ab = anchor[0];
      if (ab[0] < image.cols - 40) return;
      if (used.some(function (yy) { return Math.abs(ab[1] - yy) < 6; })) return;
      var ax = ab[0], ay = ab[1];
      used.push(ay);
      var row = {};
      entries.forEach(function (entry) {
        var b = entry[0];
        var slot = Math.round((ax - b[0]) / 32);
        if (slot >= 0 && Math.abs(b[1] - ay) <= 5 && Math.abs(ax - slot * 32 - b[0]) <= 3) {
          if (!(slot in row) || entry[2] > row[slot][2]) row[slot] = entry;
        }
      });
      // Stop at a gap larger than three cells; distant scene squares are not buffs.
      var slots = Object.keys(row).map(Number).sort(function (a, b) { return a - b; });
      var extent = 0;
      for (var k = 0; k < slots.length; k++) {
        if (slots[k] - extent > 4) break;
        extent = slots[k];
      }
      var rowY = null;
      slots.forEach(function (sl) {
        if (sl <= extent) { var yv = row[sl][0][1]; if (rowY === null || yv < rowY) rowY = yv; }
      });
      if (rowY === null) rowY = ay;
      for (var slot2 = 0; slot2 <= extent; slot2++) {
        var entry2 = row[slot2];
        if (!entry2) entry2 = [[ax - slot2 * 32, ay, 32, 32], null, 0, null];
        if (entry2[1] === null) entry2 = [[ax - slot2 * 32, rowY, 32, 32], null, 0, null];
        grid.push(entry2);
      }
    });

    entries = ids ? matched : grid;
    entries.sort(function (a, b) {
      var ra = Math.floor(a[0][1] / 12), rb = Math.floor(b[0][1] / 12);
      return ra !== rb ? ra - rb : a[0][0] - b[0][0];
    });

    var result = [];
    result.rejected = rejected;
    var chain = Promise.resolve();
    var yieldEvery = opts.yieldEvery === undefined ? 1 : opts.yieldEvery;
    entries.forEach(function (entry, index) {
      chain = chain.then(function () {
        if (opts.aborted && opts.aborted()) return;
        return self_._describe(image, entry, index, result).then(function () {
          // FIX-10: hand back each item as it lands and let the worker's
          // message queue run, instead of blocking for the whole grid.
          if (opts.onItem && result.length) opts.onItem(result[result.length - 1], index, entries.length);
          if (yieldEvery && (index % yieldEvery === yieldEvery - 1)) return nextTask();
        });
      });
    });
    var tMatchDone = clock_();
    return chain.then(function () {
      self_.pruneCells(self_.passNo);
      /* 어디에 시간이 가는지 남긴다. 최적화를 눈대중으로 하지 않기 위한 것이고
         진단 패널에서도 읽는다. */
      self_.timing = {
        total_ms: clock_() - tStart,
        contour_ms: tContour,
        match_ms: tMatch,
        match_calls: nMatch,
        describe_ms: clock_() - tMatchDone,
        cells: entries.length
      };
      return result;
    });
  };

  BuffClassifier.prototype._describe = function (image, entry, index, out) {
    var self_ = this;
    var box = entry[0], item = entry[1], score = entry[2], verdict = entry[3];
    var mode = item && item.time_mode ? item.time_mode : 'unknown';

    /* Skip the OCR when the number area has not changed since the last look.
       This is what makes "watch once a second, re-read only on change"
       affordable, and it is also the main cost saving on the hud pass. */
    /* 같은 라벨이 여러 셀에 있을 수 있으므로 캐시 키에 위치를 넣는다.

       라벨이 없는 칸도 **자리로 캐시한다**. 예전에는 여기서 키가 null 이라
       캐시를 아예 쓰지 않았고, 그래서 이름 모르는 버프 아이콘 수십 개를 매
       패스마다 다시 읽었다. 버프 아이콘 그림은 정지해 있고 바뀌는 것은 숫자
       뿐이라, 이 칸들은 거의 언제나 캐시에 맞는다.

       실측(녹화 360프레임 · 프레임당 52칸): 이 캐시와 아래의 OCR 관문을 합쳐
       프레임당 OCR 호출이 41.3회에서 3.0회로 줄었다 (92.7% 감소). 패스가
       1.4~2.1초 걸리던 주된 이유가 이것이었다. */
    var key = (item ? item.id : '?') + '@' + box.join(',');
    var fp = key ? cellFingerprint(image, box) : null;
    if (key && fp) {
      var prev = self_.cells[key];
      if (prev && !fingerprintChanged(prev.fingerprint, fp)) {
        prev.pass = self_.passNo;
        var reused = {};
        Object.keys(prev.entry).forEach(function (k) { reused[k] = prev.entry[k]; });
        reused.bbox = box;
        reused.match_score = score;
        reused.number_changed = false;
        reused.from_cache = true;
        out.push(reused);
        return Promise.resolve();
      }
    }

    var crop = roi(image, box[0], box[1], box[2], box[3]);
    if (!crop) return Promise.resolve();

    // FIX-10: nothing numeric to read on these, so do not pay for OCR.
    if (mode === 'none' || mode === 'stack') {
      crop.delete();
      var madeN = describeEntry(item, box, score, verdict, {
        text: '', confidence: 0, mode: mode, consensus: false, verified: false
      }, index);
      madeN.number_changed = true;
      madeN.from_cache = false;
      // 이 칸들도 캐시에 넣는다. 값이 없다고 캐시를 건너뛰면 다음 패스에서
      // 지문을 다시 계산하게 되고, 캐시 명중률 통계도 이 칸들 때문에 낮게
      // 나온다 (client.png 9칸 중 7칸이 여기였다).
      if (fp) self_.cells[key] = { fingerprint: fp, entry: madeN, pass: self_.passNo };
      out.push(madeN);
      return Promise.resolve();
    }

    /* 글꼴 대조가 본 경로다. 성공하면 OCR을 한 번도 부르지 않는다.

       측정(실화면 5장 41칸): 정답 41 · 거부 0 · 오판독 0.
       거부하더라도 틀린 값을 내는 일이 없으므로, 실패 시 아래 OCR 경로로
       내려가도 잘못된 값이 굳어지지 않는다. */
    var glyphState = null;
    self_.glyphReads += 1;
    var gl = self_._readGlyph(crop, item, key);
    if (gl) {
      self_.glyphHits += 1;
      crop.delete();
      glyphState = { text: gl.text, confidence: 1, mode: gl.mode, consensus: false,
                     verified: true, mask_agree: false, reject_reason: null,
                     number_source: 'glyph_atlas', glyph_font: gl.font,
                     glyph_layer: gl.layer, glyph_averaged: gl.averaged };
      var madeG = describeEntry(item, box, score, verdict, glyphState, index);
      madeG.number_changed = true;
      madeG.from_cache = false;
      if (key && fp) self_.cells[key] = { fingerprint: fp, entry: madeG, pass: self_.passNo };
      out.push(madeG);
      return Promise.resolve();
    }
    var pendingGlyph = self_._glyphPending;

    /* 글꼴 대조가 실패했다고 곧바로 OCR 로 내려가지 않는다.

       실패에는 두 종류가 있다.
         (가) 숫자꼴 띠 자체가 없다 - 게임이 숫자를 안 그린 칸이다
         (나) 띠는 찾았는데 글리프를 모른다 - OCR 이 값을 줄 수 있는 유일한 경우

       (가)에서 OCR 을 부르는 것은 낭비일 뿐 아니라 위험하다. 2026-09-05 에
       숫자가 없는 아이콘 그림을 OCR 이 0.98 확신으로 "8" 이라고 읽은 적이
       있다(FIX-4). 읽을 것이 없는 칸은 읽지 않는 편이 빠르고 안전하다.

       실측(녹화 30,160칸): (가) 40.8% · (나) 34.5% · 글꼴 성공 24.7%.
       (가)로 분류된 12,308칸 중 글꼴이 값을 낸 칸은 0개였다. */
    if (!self_._glyphSawBand) {
      self_.glyphNoBand = (self_.glyphNoBand || 0) + 1;
      crop.delete();
      var blankState = { text: '', confidence: 0, mode: mode, consensus: false,
                         verified: false, mask_agree: false,
                         reject_reason: 'no_number_drawn', number_source: 'none' };
      var madeB = describeEntry(item, box, score, verdict, blankState, index);
      madeB.number_changed = true;
      madeB.from_cache = false;
      if (fp) self_.cells[key] = { fingerprint: fp, entry: madeB, pass: self_.passNo };
      out.push(madeB);
      return Promise.resolve();
    }

    var hsv = new cv.Mat();
    cv.cvtColor(crop, hsv, cv.COLOR_BGR2HSV);
    var low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [18, 90, 160, 0]);
    var high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 255, 255, 0]);
    var yellow = new cv.Mat();
    cv.inRange(hsv, low, high, yellow);
    var center = roi(yellow, 2, 8, Math.max(0, yellow.cols - 4), 19);
    var yellowCount = center ? cv.countNonZero(center) : 0;
    if (center) center.delete();
    hsv.delete(); low.delete(); high.delete(); yellow.delete();

    var state = { text: '', confidence: 0, mode: mode, consensus: false,
                  verified: false, mask_agree: false, reject_reason: null };

    var bottom = roi(crop, 0, 12, crop.cols, crop.rows - 12);
    var step = bottom ? self_.ocr.line(bottom).then(function (r) {
      bottom.delete();
      state.text = r.text; state.confidence = r.score;
    }) : Promise.resolve();

    return step.then(function () {
      if (yellowCount > 12 && mode !== 'stack' && mode !== 'none') {
        // The icon art is itself yellow-ish, so a raw-crop read alone will
        // happily invent a countdown once the game stops drawing one (proven
        // on 2026-09-05: bare art scored 0.98 as "8").
        // FIX-4: agreement with the colour-split reading is now the ONLY way
        // through. The old `|| r.score >= 0.97` bypass is what let that 0.98
        // hallucination in.
        var masked = yellowGlyphs(crop);
        var band = roi(crop, 0, 8, crop.cols, 18);
        var maskBand = masked ? roi(masked, 0, 8, masked.cols, 18) : null;
        if (!band) { if (masked) masked.delete(); if (maskBand) maskBand.delete(); return; }
        return self_.ocr.line(band).then(function (r) {
          band.delete();
          var rawClock = parse.parseTime(r.text, 'clock');
          if (r.score >= 0.90 && rawClock !== null) {
            return (maskBand ? self_.ocr.line(maskBand) : Promise.resolve(null)).then(function (m) {
              if (maskBand) maskBand.delete();
              var agree = !!(m && parse.parseTime(m.text, 'clock') === rawClock);
              if (agree) {
                state.text = r.text; state.confidence = r.score; state.mode = 'clock';
                state.mask_agree = true;
                state.verified = true;      // FIX-4: do not overwrite later
              } else {
                state.reject_reason = 'mask_disagreement';
              }
            });
          }
          if (mode === 'minutes' || mode === 'wealth') {
            return self_.ocr.timer(crop, 'seconds').then(function (t) {
              if (t.score < 0.95) { if (maskBand) maskBand.delete(); return; }
              return (masked ? self_.ocr.timer(masked, 'seconds') : Promise.resolve(null)).then(function (m) {
                if (maskBand) maskBand.delete();
                if (m && m.text === t.text) {
                  state.text = t.text; state.confidence = t.score; state.mode = 'seconds';
                  state.mask_agree = true;
                  state.verified = true;
                } else {
                  state.reject_reason = 'mask_disagreement';
                }
              });
            });
          }
          if (maskBand) maskBand.delete();
        }).then(function (v) { if (masked) masked.delete(); return v; },
                function (e) { if (masked) masked.delete(); throw e; });
      }
    }).then(function () {
      // FIX-4: a value that passed the colour-mask check is final. The
      // 2026-09-05 build ran these follow-up passes unconditionally and
      // overwrote the verified number with whatever came back.
      if (state.verified) return;
      if (state.mode === 'clock' || state.mode === 'seconds') {
        return self_.ocr.timer(crop, state.mode).then(function (t) {
          state.text = t.text; state.confidence = t.score;
        });
      }
    }).then(function () {
      if (state.verified) return;
      if (state.mode === 'minutes') {
        return self_.ocr.minutes(image, box).then(function (m) {
          state.text = m.text; state.confidence = m.score; state.consensus = m.consensus;
        });
      }
    }).then(function () {
      if (state.verified) return;
      if (state.mode === 'wealth') {
        return self_.ocr.minutes(image, box).then(function (m) {
          state.text = m.text; state.confidence = m.score; state.consensus = m.consensus;
          state.mode = 'minutes';
        });
      }
    }).then(function () {
      /* 아틀라스 넓히기. OCR이 확신하고(0.9 이상) 문법을 통과한 값일 때만,
         모르는 글리프에 그 글자를 붙인다. 글자 수가 구간 수와 어긋나면
         learnFrom 이 스스로 아무것도 배우지 않는다. */
      if (pendingGlyph && root.glyphs && state.confidence >= 0.9 && state.text &&
          parse.parseTime(state.text, state.mode) !== null) {
        var n = root.glyphs.learnFrom(pendingGlyph.result, state.text.trim(), pendingGlyph.font);
        if (n) self_.glyphLearned += n;
      }
      crop.delete();
      var built = describeEntry(item, box, score, verdict, state, index);
      built.number_changed = true;
      built.from_cache = false;
      if (key && fp) self_.cells[key] = { fingerprint: fp, entry: built, pass: self_.passNo };
      out.push(built);
    }, function (e) { try { crop.delete(); } catch (x) {} throw e; });
  };

  function describeEntry(item, box, score, verdict, state, index) {
    var remaining = (state.confidence >= 0.9 || state.consensus)
      ? parse.parseTime(state.text, state.mode) : null;
    var approved = !!(item && item.approved);
    var reject = state.reject_reason;
    if (!approved && state.mode !== 'clock') { remaining = null; if (!reject) reject = 'not_approved'; }
    // FIX-4: a verified ceiling for this specific buff. P04's duration is a
    // user-confirmed 1800 s, so the 200분 / 250분 readings of 2026-09-05 are
    // rejected outright instead of being smoothed over later.
    if (remaining !== null && item && item.max_seconds !== undefined && remaining > item.max_seconds) {
      reject = 'above_max_seconds';
      remaining = null;
    }
    return {
      id: item ? item.id : 'unknown-' + index,
      name: item ? (item.name === undefined ? null : item.name) : null,
      role: item && item.role ? item.role : null,
      bbox: box,
      match_score: score,
      signature_count: (verdict && verdict.count !== undefined) ? verdict.count : null,
      rival_self: (verdict && verdict.kind === 'rival') ? verdict.self : null,
      rival_other: (verdict && verdict.kind === 'rival') ? verdict.rival : null,
      rival_margin: (verdict && verdict.kind === 'rival') ? verdict.margin : null,
      approved: approved,
      raw_number: (state.confidence >= 0.85 || state.consensus) ? state.text : null,
      number_source: state.number_source || 'ocr',
      glyph_font: state.glyph_font || null,
      glyph_layer: state.glyph_layer || null,
      glyph_averaged: state.glyph_averaged || null,
      ocr_score: state.confidence,
      time_mode: state.mode,
      minute_consensus: state.consensus,
      mask_agree: !!state.mask_agree,
      verified: !!state.verified,
      reject_reason: reject || null,
      remaining_seconds: remaining,
      resolution_seconds: state.mode === 'minutes' ? 60
        : (state.mode === 'clock' || state.mode === 'seconds') ? 1 : null,
      time_status: remaining !== null ? 'observed' : 'not_visible_or_unconfirmed'
    };
  }

  /* ---- rune duration ---------------------------------------------------

     AGENT_HANDOFF.md §4.4: the booster decision needs the *rune duration buff*
     read off the screen. It is emphatically NOT the minimap rune marker, and
     not "whatever unnamed buff happens to be there".

     A label opts in by carrying `"role": "rune_duration"`. Until such a label
     exists and is marked `identified: true`, this reader reports UNKNOWN with
     reason `rune_buff_not_identified`, and the booster machine closes each
     disappearance as "종료 확인 불가" instead of guessing. That is the honest
     behaviour while the icon is unconfirmed, and it is exercised by a test. */
  /* One alternative preprocessing of the same capture: the seconds grammar
     instead of the clock grammar, with the colour-split reading required to
     agree so icon art cannot invent a number. */
  function reReadSeconds(ocr, image, bbox) {
    if (!ocr || !bbox) return Promise.resolve(null);
    var crop = roi(image, bbox[0], bbox[1], bbox[2], bbox[3]);
    if (!crop) return Promise.resolve(null);
    var masked = yellowGlyphs(crop);
    function done(v) {
      try { crop.delete(); } catch (e) {}
      if (masked) { try { masked.delete(); } catch (e) {} }
      return v;
    }
    return ocr.timer(crop, 'seconds').then(function (t) {
      if (!t.text || t.score < 0.90) return done(null);
      if (!masked) return done(null);
      return ocr.timer(masked, 'seconds').then(function (m) {
        if (!m || m.text !== t.text) return done(null);
        var v = parse.parseTime(t.text, 'seconds');
        return done(v !== null && v >= 0 && v < 60 ? v : null);
      }, function () { return done(null); });
    }, function () { return done(null); });
  }

  /* 룬 아이콘의 우선순위 (사용자 지시 2026-09-07):

       1순위  룬 활성화(지속시간) 아이콘
       2순위  룬 쿨타임 아이콘

     활성화 아이콘이 여럿이면 **지속시간이 더 긴 쪽**을 채용한다.

     이 파일은 1순위 안쪽만 다룬다 - 활성화 아이콘들 중 가장 긴 것을 고른다
     (resolveLongest). 활성화 대 쿨타임의 우선순위는 화면 쪽에서 갈린다
     (main.js renderRune, regions.js cropPlan): 활성화가 있으면 쿨타임은
     보지 않는다. */
  function RuneDurationReader(classifier) {
    this.classifier = classifier;
    this.lastChosen = null;     // 숫자를 못 읽을 때 붙들 아이콘
  }

  /* There is more than one rune-duration icon: the same cloud art comes in a
     light and a deep blue variant (user, 2026-09-06). Every identified one is
     read. */
  RuneDurationReader.prototype.items = function () {
    return this.classifier.roleItems('rune_duration').filter(function (it) {
      return it.identified && it._template;
    });
  };

  RuneDurationReader.prototype.item = function () {
    var usable = this.items();
    if (usable.length) return usable[0];
    var all = this.classifier.roleItems('rune_duration');
    return all.length ? all[0] : null;
  };

  RuneDurationReader.prototype.status = function () {
    var all = this.classifier.roleItems('rune_duration');
    if (!all.length) return 'not_registered';
    if (this.items().length) return 'ready';
    var it = all[0];
    if (!it.identified) return 'not_identified';
    return 'template_missing';
  };

  /* Returns a RuneDurationObservation (§4.2). */
  RuneDurationReader.prototype.observe = function (image, visibility, frameId) {
    var self_ = this;
    var base = {
      frameId: frameId === undefined ? null : frameId,
      iconPresence: 'UNKNOWN', rawText: null, observedSeconds: null,
      resolution: null, confidence: null, bbox: null, reason: null
    };
    var st = this.status();
    if (st !== 'ready') {
      base.reason = st === 'not_registered' || st === 'not_identified'
        ? 'rune_buff_not_identified' : 'rune_template_missing';
      return Promise.resolve(base);
    }
    if (visibility === 'obscured' || visibility === 'unknown') {
      base.reason = 'buff_row_' + visibility;
      return Promise.resolve(base);
    }
    var usable = this.items();
    var ids = usable.map(function (it) { return it.id; });
    return this.classifier.classify(image, ids, { yieldEvery: 0 }).then(function (list) {
      if (!list.length) {
        base.iconPresence = 'ABSENT';
        base.reason = 'rune_icon_absent';
        return base;
      }
      base.candidates = list.map(function (x) {
        return { id: x.id, bbox: x.bbox, raw: x.raw_number,
                 seconds: x.remaining_seconds, score: x.match_score };
      });
      /* User rule, 2026-09-06: "경우에 따라서 룬 아이콘이 여러개 인 경우도
         있다. 그럴 때는 남은 시간이 가장 긴 것의 시간을 채용한다."
         Resolve every icon first, then take the longest. */
      return resolveLongest(self_, image, list, base);
    }, function (err) {
      base.reason = 'rune_read_error:' + (err && err.message ? err.message : err);
      return base;
    });
  };

  function resolveLongest(reader, image, list, base) {
    var ocr = reader.classifier.ocr;
    var resolved = [];
    var chain = Promise.resolve();
    list.forEach(function (e) {
      chain = chain.then(function () {
        var item = reader.classifier.find(e.id) || {};
        if (e.remaining_seconds !== null && e.resolution_seconds === 1) {
          resolved.push({ e: e, seconds: e.remaining_seconds, raw: e.raw_number, how: 'read' });
          return;
        }
        if (!item.seconds_below_minute) {
          resolved.push({ e: e, seconds: null, raw: e.raw_number,
                          how: e.reject_reason || 'rune_number_unreadable' });
          return;
        }
        // §4.3.6: another preprocessing of the same capture - the seconds
        // grammar for the sub-minute form, with colour-mask agreement.
        return reReadSeconds(ocr, image, e.bbox).then(function (sec) {
          resolved.push(sec !== null
            ? { e: e, seconds: sec, raw: String(sec), how: 'read_seconds_below_minute' }
            : { e: e, seconds: null, raw: e.raw_number,
                how: e.reject_reason || 'rune_number_unreadable' });
        });
      });
    });
    return chain.then(function () {
      base.candidates = resolved.map(function (r) {
        return { id: r.e.id, bbox: r.e.bbox, raw: r.raw, seconds: r.seconds,
                 score: r.e.match_score, how: r.how };
      });
      base.iconPresence = 'PRESENT';
      var best = null;
      resolved.forEach(function (r) {
        if (r.seconds === null) return;
        if (!best || r.seconds > best.seconds) best = r;
      });
      if (best) {
        base.bbox = best.e.bbox;
        base.rawText = best.raw;
        base.confidence = best.e.ocr_score;
        base.resolution = 1;
        base.observedSeconds = best.seconds;
        base.chosenId = best.e.id;
        base.reason = resolved.length > 1 ? 'longest_of_' + resolved.length : best.how;
        reader.lastChosen = { id: best.e.id, bbox: best.e.bbox };
        return base;
      }
      /* 숫자를 하나도 못 읽었다 - 남은 시간이 5초 미만이면 게임이 숫자를
         지우므로 룬이 둘이면 둘 다 여기로 온다. 이때 "가장 긴 것" 은 이
         프레임만으로는 알 수 없다.

         그래도 **직전에 고른 아이콘을 그대로 붙든다.** 임의로 첫 번째를
         집으면 프레임마다 다른 아이콘으로 튀어 화면의 룬 칸이 깜빡인다.
         판정에는 영향이 없다 - observedSeconds 는 어차피 null 이라 부스터
         판정(룬 지속 >= 110초)은 이 갈래에서 아무 값도 받지 않는다. */
      var first = null;
      var lc = reader.lastChosen;
      if (lc) {
        for (var i = 0; i < resolved.length; i++) {
          if (resolved[i].e.id === lc.id) { first = resolved[i]; break; }
        }
      }
      if (!first) first = resolved[0];
      base.bbox = first ? first.e.bbox : null;
      base.rawText = first ? first.raw : null;
      base.confidence = first ? first.e.ocr_score : null;
      base.reason = first ? first.how : 'rune_number_unreadable';
      if (first) base.chosenId = first.e.id;
      return base;
    });
  }

  root.vision = {
    Scope: Scope,
    roi: roi,
    matFromImageData: matFromImageData,
    contiguous: contiguous,
    contourList: contourList,
    nextTask: nextTask,
    frameValidity: frameValidity,
    activitySignature: activitySignature,
    signatureDistance: signatureDistance,
    frameSignature: frameSignature,
    expActivityRect: expActivityRect,
    OCR: OCR,
    detectMinimap: detectMinimap,
    latticeCells: latticeCells,
    EdgeAccumulator: EdgeAccumulator,
    minimapUiRect: minimapUiRect,
    minimapNameRect: minimapNameRect,
    MinimapLock: MinimapLock,
    looksLikeMinimap: looksLikeMinimap,
    detectExp: detectExp,
    expTextRuns: expTextRuns,
    edgeContact: edgeContact,
    ExpLocator: ExpLocator,
    expInverted: expInverted,
    EXP_ACCEPT_SCORE: EXP_ACCEPT_SCORE,
    EXP_CONSENSUS_SCORE: EXP_CONSENSUS_SCORE,
    yellowGlyphs: yellowGlyphs,
    iconCandidates: iconCandidates,
    defaultBuffRect: defaultBuffRect,
    buffGridRect: buffGridRect,
    unionBuffRect: unionBuffRect,
    buffVisibility: buffVisibility,
    matchPeaks: matchPeaks,
    cellFingerprint: cellFingerprint,
    fingerprintChanged: fingerprintChanged,
    rectCorrelation: rectCorrelation,
    bestRectCorrelation: bestRectCorrelation,
    reReadSeconds: reReadSeconds,
    hsvSignatureCount: hsvSignatureCount,
    signatureVerdict: signatureVerdict,
    BuffClassifier: BuffClassifier,
    RuneDurationReader: RuneDurationReader
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
