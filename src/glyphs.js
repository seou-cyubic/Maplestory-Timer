/* 고정 비트맵 글꼴 정확 대조 판독기.

   왜 이것이 신경망 OCR보다 나은가 (2026-09-06 측정):

   게임 HUD는 사진 속 글자가 아니라 **고정 비트맵 글꼴**이다. 경험치 표시는
   5x7 픽셀 숫자이고, 같은 문자가 서로 다른 세 장의 실화면에서 픽셀 단위로
   완전히 동일했다(차이 0). 그런데 숫자 사이의 차이는 이렇게 작다:

       3        8        9
       .###.    .###.    .###.
       #...#    #...#    #...#
       ....#    #...#    #...#      8 vs 9 = 2 픽셀
       ..##.    .###.    .####      3 vs 8 = 3 픽셀
       ....#    #...#    ....#
       #...#    #...#    #...#
       .###.    .###.    .###.

   기존 경로는 이 그림을 4배 INTER_CUBIC으로 확대해 PP-OCR에 넣었다. 큐빅
   보간이 2~3픽셀 차이를 뭉개 버리므로 3과 8이 섞이는 것은 당연한 결과였고,
   실제로 사용자가 그 증상을 보고했다.

   정확 대조는 같은 차이를 100% 구분한다. 대신 **완전 일치만 인정**한다.
   일치하는 글리프가 없으면 그 판독을 통째로 버린다 — 가까운 것으로 추측하면
   2픽셀 차이에서 8이 9가 되기 때문이다.

   잉크 분리도 중요하다. 경험치 글자는 밝은 노란 EXP 게이지 위의 순백이라
   휘도로는 게이지(약 201)와 글자(255)가 붙어 Otsu가 깨진다. 흰 글자는
   min(R,G,B)가 높고 채도 있는 게임 색은 낮으므로 min(R,G,B) 임계가 깨끗하게
   가른다. */
(function (root) {
  'use strict';

  // vision 은 로드 순서에 따라 아직 없을 수 있으므로 호출 시점에 찾는다.
  function V() { return root.vision; }

  /* ---- 잉크 마스크 ---------------------------------------------------- */

  /* mat: CV_8UC3 BGR. 반환: 폭*높이 Uint8Array (1 = 잉크). */
  function inkMask(mat, ink) {
    var d = mat.data, n = mat.rows * mat.cols;
    var out = new Uint8Array(n);
    var kind = (ink && ink.kind) || 'min_rgb';
    if (kind === 'min_rgb') {
      var lo = (ink && ink.min !== undefined) ? ink.min : 200;
      for (var i = 0; i < n; i++) {
        var b = d[i * 3], g = d[i * 3 + 1], r = d[i * 3 + 2];
        var m = b < g ? (b < r ? b : r) : (g < r ? g : r);
        out[i] = m >= lo ? 1 : 0;
      }
      return out;
    }
    if (kind === 'rgb') {
      /* 채널별 하한. 밝은 게이지 위의 흰 글자처럼 '순백이 아닌 흰색'을 잡는다.
         실측: 경험치 글자 획은 255/255/190 이고 게이지 배경은 95/107/15 이라
         B 한 채널만으로도 3배 여유로 갈린다. min(R,G,B)>=200 은 획의 절반을
         버려 라이브 436장에서 판독률 0% 였다. */
      var rl = (ink.r_min === undefined) ? 0 : ink.r_min;
      var gl = (ink.g_min === undefined) ? 0 : ink.g_min;
      var bl = (ink.b_min === undefined) ? 0 : ink.b_min;
      for (var q = 0; q < n; q++) {
        out[q] = (d[q * 3 + 2] >= rl && d[q * 3 + 1] >= gl && d[q * 3] >= bl) ? 1 : 0;
      }
      return out;
    }
    if (kind === 'yellow') {
      /* 노란 글자: R,G 높고 B 낮다.

         처음에는 B의 절대 상한(<=120)으로 잘랐는데, 파란 아이콘 위에 그려진
         숫자는 가장자리 화소의 B가 128까지 올라가 통째로 잘려 나갔다
         ("1:51"의 획 대부분이 사라졌다). 배경이 B를 밀어 올리므로 절대값이
         아니라 **R과 B의 격차**로 봐야 한다. 회색 아이콘 그림은 R-B가 0 근처
         이거나 음수이고(184/181/196 -> -12), 노란 글자는 99였다. */
      var rmin = (ink.r_min !== undefined) ? ink.r_min
        : ((ink.rg_min !== undefined) ? ink.rg_min : 170);
      var gmin = (ink.g_min !== undefined) ? ink.g_min
        : ((ink.rg_min !== undefined) ? ink.rg_min : 170);
      var bmax = (ink.b_max === undefined) ? 255 : ink.b_max;
      var gap = (ink.rb_gap === undefined) ? 0 : ink.rb_gap;
      for (var j = 0; j < n; j++) {
        var bb = d[j * 3], gg = d[j * 3 + 1], rr = d[j * 3 + 2];
        out[j] = (rr >= rmin && gg >= gmin && bb <= bmax && (rr - bb) >= gap) ? 1 : 0;
      }
      return out;
    }
    // 알 수 없는 방식이면 밝기
    var th = (ink && ink.min !== undefined) ? ink.min : 200;
    for (var k = 0; k < n; k++) {
      var v = (d[k * 3 + 2] * 299 + d[k * 3 + 1] * 587 + d[k * 3] * 114) / 1000;
      out[k] = v >= th ? 1 : 0;
    }
    return out;
  }

  /* ---- 글꼴 ------------------------------------------------------------ */

  function Font(name, spec) {
    this.name = name;
    this.height = spec.height;
    this.ink = spec.ink || { kind: 'min_rgb', min: 200 };

    /* 판독 방식. 기본값은 경험치 글꼴이 쓰던 것 그대로다 —
       완전 일치(tolerance 0) + 되추적 분할. 버프 아이콘 숫자만 값을 바꾼다. */
    this.segmentation = spec.segmentation || 'backtrack';
    this.tolerance = spec.tolerance || 0;      // 허용 픽셀 차이
    this.margin = (spec.margin === undefined) ? 1 : spec.margin;  // 2등과의 차이
    this.colonGap = spec.colon_gap || 0;       // 이 이상 벌어지면 ':' 를 넣는다
    this.fullHeightRuns = !!spec.full_height_runs;
    this.minRunWidth = spec.min_run_width;     // undefined 면 호출자 기본값
    this.runWidth = spec.run_width || [1, 8];
    this.bandWindow = spec.band_window || null;
    /* 글자를 한 덩어리로 묶는 최대 간격. 시계 표기는 콜론 자리가 7px라
       기본값 6으로는 "1:51"이 둘로 쪼개졌다. */
    this.groupGap = (spec.group_gap === undefined) ? 6 : spec.group_gap;
    this.learnVariants = !!spec.learn_variants;
    /* 칸 가장자에 잉크가 닿으면 글자가 잘렸다는 신호다. 단, 버프
       좌측하단 분 숫자는 원래 왼쪽 끝에 붙어 그려지므로 오른쪽만 본다. */
    this.edgeGuard = spec.edge_guard || 'none';
    this.glyphs = [];
    var chars = spec.glyphs || {};
    /* 같은 문자가 폭이 다른 변형으로 그려질 수 있다. 실측: 천 단위 구분점은
       2px, 백분율 소수점은 1px였다. 키에 "#폭"을 붙여 변형을 등록하고, 앞부분만
       실제 문자로 쓴다. */
    Object.keys(chars).forEach(function (key) {
      var ch = key.split('#')[0];
      var rows = chars[key];
      if (!rows || !rows.length) return;
      var w = rows[0].length, h = rows.length;
      var bits = new Uint8Array(w * h);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) bits[y * w + x] = rows[y].charAt(x) === '1' ? 1 : 0;
      }
      this.glyphs.push({ ch: ch, w: w, h: h, bits: bits });
    }, this);
    // 넓은 글리프를 먼저 시도해야 '1'이 '4'의 일부를 가로채지 않는다.
    this.glyphs.sort(function (a, b) { return b.w - a.w; });
    this.maxWidth = this.glyphs.reduce(function (m, g) { return Math.max(m, g.w); }, 0);
  }

  Font.prototype.has = function (ch) {
    return this.glyphs.some(function (g) { return g.ch === ch; });
  };

  // 같은 비트맵이 이미 등록돼 있는가 (변형 중복 방지).
  Font.prototype.hasBitmap = function (bits, w, h) {
    return this.glyphs.some(function (g) {
      if (g.w !== w || g.h !== h) return false;
      for (var i = 0; i < bits.length; i++) if (g.bits[i] !== bits[i]) return false;
      return true;
    });
  };

  Font.prototype.add = function (ch, bits, w, h) {
    this.glyphs.push({ ch: ch, w: w, h: h, bits: bits });
    this.glyphs.sort(function (a, b) { return b.w - a.w; });
    this.maxWidth = Math.max(this.maxWidth, w);
  };

  Font.prototype.toJSON = function () {
    var out = {}, seen = {};
    this.glyphs.slice().sort(function (a, b) { return a.ch < b.ch ? -1 : 1; })
      .forEach(function (g) {
        var key = seen[g.ch] ? g.ch + '#' + g.w : g.ch;
        seen[g.ch] = 1;
        g = { ch: key, w: g.w, h: g.h, bits: g.bits };
        var rows = [];
        for (var y = 0; y < g.h; y++) {
          var s = '';
          for (var x = 0; x < g.w; x++) s += g.bits[y * g.w + x] ? '1' : '0';
          rows.push(s);
        }
        out[g.ch] = rows;
      });
    return { height: this.height, ink: this.ink, glyphs: out };
  };

  /* ---- 열 구간 / 띠 찾기 ----------------------------------------------- */

  function columnRuns(mask, W, H, from, to) {
    var runs = [], start = -1;
    for (var x = from; x < to; x++) {
      var any = 0;
      for (var y = 0; y < H; y++) { if (mask[y * W + x]) { any = 1; break; } }
      if (any && start < 0) start = x;
      else if (!any && start >= 0) { runs.push([start, x]); start = -1; }
    }
    if (start >= 0) runs.push([start, to]);
    return runs;
  }

  /* 잉크가 있는 행 구간 중 글자 높이에 맞고 글리프가 가장 잘 분리되는 창.

     실측: 창을 몇 행만 넓게 잡아도 게이지 테두리가 걸려 글자가 세로로 이어져
     붙고, 27개여야 할 구간이 20개로 뭉개졌다. 폭이 글리프 범위에 드는 구간의
     개수를 점수로 삼으면 정확한 행을 고른다. */
  function findTextBand(mask, W, H, glyphHeight, minRunWidth, font) {
    var all = bandCandidates(mask, W, H, glyphHeight, minRunWidth, font);
    return all.length ? all[0] : null;
  }

  /* 점수 높은 순으로 정렬된 띠 후보 전부.

     후보를 하나만 고르면 아이콘 그림이 우연히 더 높은 점수를 받는 순간
     판독을 통째로 놓친다. 실측(버프 아이콘 30칸): 최고점 하나만 쓰면
     여러 칸이 미확인으로 떨어졌지만, 점수순으로 시도해 처음 성공하는 띠를
     쓰면 30/30이 됐다. 완전 일치라 잘못된 띠가 성공할 일은 없다. */
  function bandCandidates(mask, W, H, glyphHeight, minRunWidth, font) {
    var out = [];
    var wlo = (font && font.runWidth) ? font.runWidth[0] : 1;
    var whi = (font && font.runWidth) ? font.runWidth[1] : 8;
    var fullHeight = !!(font && font.fullHeightRuns);
    var yFrom = 0, yTo = H - glyphHeight;
    if (font && font.bandWindow) {
      yFrom = Math.max(yFrom, font.bandWindow[0]);
      yTo = Math.min(yTo, font.bandWindow[1]);
    }
    for (var y = yFrom; y <= yTo; y++) {
      var sub = mask.subarray(y * W, (y + glyphHeight) * W);
      var runs = columnRuns(sub, W, glyphHeight, 0, W);
      if (!runs.length) continue;
      // 가장 넓은 덩어리 (6px 이하 간격은 같은 덩어리)
      var groups = [], cur = null;
      for (var i = 0; i < runs.length; i++) {
        var gmax = (font && font.groupGap !== undefined) ? font.groupGap : 6;
        if (cur && runs[i][0] - cur[1] <= gmax) cur[1] = runs[i][1];
        else { if (cur) groups.push(cur); cur = [runs[i][0], runs[i][1]]; }
      }
      if (cur) groups.push(cur);
      var wide = groups.reduce(function (a, b) { return (b[1] - b[0]) > (a[1] - a[0]) ? b : a; });
      var need = (minRunWidth !== undefined && minRunWidth !== null) ? minRunWidth : 40;
      if (wide[1] - wide[0] < need) continue;
      /* 세로 정렬을 고정하는 조건.

         구간이 잘 나뉘는 것만으로는 정렬이 정해지지 않는다 — 글자를 위아래
         어디서 잘라도 가로로는 여전히 분리되기 때문이다. 실측에서 이 때문에
         두 행 어긋난 창이 뽑혀 글리프가 잘린 채 전부 미확인이 됐다.
         제대로 맞은 창은 첫 행과 끝 행 모두에 잉크가 있다(숫자의 위아래 획). */
      var topInk = 0, botInk = 0;
      for (var t = wide[0]; t < wide[1]; t++) {
        if (sub[t]) topInk++;
        if (sub[(glyphHeight - 1) * W + t]) botInk++;
      }
      if (topInk === 0 || botInk === 0) continue;

      var raw = columnRuns(sub, W, glyphHeight, wide[0], wide[1]);
      /* 글리프 최소 폭보다 좁은 구간은 글자가 아니다 — 시계 표기의
         콜론 점(1~2px)이거나 아이콘 그림의 부스러기다. 세로로 띠를 꾫지
         않으므로 여기서 버린다. 콜론은 남은 숫자 구간의 간격으로 복원한다. */
      var inner = [];
      for (var f = 0; f < raw.length; f++) {
        if (raw[f][1] - raw[f][0] >= wlo) inner.push(raw[f]);
      }
      if (!inner.length) continue;
      var good = 0, bad = 0, broken = 0;
      for (var k = 0; k < inner.length; k++) {
        var wdt = inner[k][1] - inner[k][0];
        if (wdt >= wlo && wdt <= whi) good++; else if (wdt > whi) bad++;
        /* 버프 아이콘 숫자는 모든 글리프가 띠 높이를 꽉 채운다. 구간마다
           위/아래 획을 요구하면 아이콘 그림이 만든 가짜 띠가 걸러진다. */
        if (fullHeight) {
          var tk = 0, bk = 0;
          for (var c = inner[k][0]; c < inner[k][1]; c++) {
            if (sub[c]) tk++;
            if (sub[(glyphHeight - 1) * W + c]) bk++;
          }
          if (!tk || !bk) broken++;
        }
      }
      if (fullHeight && broken) continue;
      // 같은 점수면 잉크가 많은 쪽이 진짜 글자 띠다.
      var ink = 0;
      for (var q = 0; q < glyphHeight * W; q++) ink += sub[q];
      out.push({ score: (good - 3 * bad) * 1000 + ink, y: y,
                 x0: wide[0], x1: wide[1], runs: inner });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /* ---- 한 구간을 글리프로 쪼개기 --------------------------------------- */

  function exactAt(mask, W, H, ox, glyph) {
    if (ox + glyph.w > W || glyph.h !== H) return false;
    for (var y = 0; y < H; y++) {
      var mr = y * W + ox, gr = y * glyph.w;
      for (var x = 0; x < glyph.w; x++) {
        if (mask[mr + x] !== glyph.bits[gr + x]) return false;
      }
    }
    return true;
  }

  /* ---- 구간 = 글리프 하나 (버프 아이콘 숫자) --------------------------

     경험치 막대는 어두운 배경 위 순백이라 같은 글자가 프레임이 달라도 픽셀까지
     같았다. 버프 아이콘 숫자는 사정이 다르다 — 임의의 아이콘 그림 위에
     안티에일리어싱된 가장자리가 얹히므로, 획 안쪽은 같아도 테두리 한두 화소가
     프레임마다 흔들린다.

     측정(실화면 5장 30칸, 프레임 단위 leave-one-out):

       허용오차 0 : 맞음 21 · 거부 9 · **틀림 0**
       허용오차 1 : 맞음 24 · 거부 6 · **틀림 0**
       허용오차 2 : 맞음 25 · 거부 5 · **틀림 0**
       허용오차 4 : 맞음 25 · 거부 5 · **틀림 0**

     허용오차를 줘도 틀린 판독이 하나도 생기지 않는다. 2등 문자와의 차이를
     margin 이상 요구하기 때문이다 — 8과 9처럼 2픽셀 차이인 쌍은 둘 다
     허용오차 안에 들어오는 순간 격차가 사라져 판독을 거부한다. 즉 이 완화는
     "비슷하니까 찍는다"가 아니라 "테두리 흔들림은 봐주되 애매하면 버린다"다. */

  function runBits(mask, W, H, x0, x1) {
    var w = x1 - x0, bits = new Uint8Array(w * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < w; x++) bits[y * w + x] = mask[y * W + x0 + x];
    }
    return { w: w, h: H, bits: bits };
  }

  /* 두 비트맵의 다른 화소 수. 폭이 1 다르면 좁은 쪽을 좌/우로 밀어 보고
     더 나은 쪽을 쓴다 (가장자리 한 열이 임계에 걸렸다 말았다 하기 때문). */
  function bitDistance(a, g) {
    if (a.h !== g.h) return null;
    var dw = a.w - g.w;
    if (dw > 1 || dw < -1) return null;
    var i;
    if (dw === 0) {
      var d = 0;
      for (i = 0; i < a.bits.length; i++) if (a.bits[i] !== g.bits[i]) d++;
      return d;
    }
    var wide = dw > 0 ? a : g, nar = dw > 0 ? g : a, best = null;
    for (var off = 0; off <= 1; off++) {
      var dd = 0;
      for (var y = 0; y < wide.h; y++) {
        for (var x = 0; x < wide.w; x++) {
          var nx = x - off;
          var nv = (nx >= 0 && nx < nar.w) ? nar.bits[y * nar.w + nx] : 0;
          if (wide.bits[y * wide.w + x] !== nv) dd++;
        }
      }
      if (best === null || dd < best) best = dd;
    }
    return best;
  }

  /* 문자별 최소 거리를 구하고, 1등이 허용오차 안이며 2등 문자와 margin 이상
     벌어질 때만 인정한다. 아니면 null — 추측하지 않는다. */
  function matchGlyph(a, font) {
    var per = {}, i, g, d;
    for (i = 0; i < font.glyphs.length; i++) {
      g = font.glyphs[i];
      d = bitDistance(a, g);
      if (d === null) continue;
      if (per[g.ch] === undefined || d < per[g.ch]) per[g.ch] = d;
    }
    var bestCh = null, bestD = Infinity, secD = Infinity;
    Object.keys(per).forEach(function (ch) {
      var v = per[ch];
      if (v < bestD) { secD = bestD; bestD = v; bestCh = ch; }
      else if (v < secD) { secD = v; }
    });
    if (bestCh === null || bestD > font.tolerance) return null;
    if (secD - bestD < font.margin) return null;
    return bestCh;
  }

  /* 붙어 있는 글자도 다루기 위해 되추적으로 쪼갠다. 구간이 30px를 넘지
     않으므로 비용은 무시할 수 있다. 완전 일치만 인정하므로 애매한 해가
     여러 개 나오는 일은 사실상 없다. */
  function decodeRun(mask, W, H, x0, x1, font) {
    var width = x1 - x0;
    var memo = new Array(width + 1);
    function walk(pos) {
      if (pos === width) return '';
      if (memo[pos] !== undefined) return memo[pos];
      var res = null;
      for (var i = 0; i < font.glyphs.length; i++) {
        var g = font.glyphs[i];
        if (pos + g.w > width) continue;
        if (!exactAt(mask, W, H, x0 + pos, g)) continue;
        var rest = walk(pos + g.w);
        if (rest !== null) { res = g.ch + rest; break; }
      }
      memo[pos] = res;
      return res;
    }
    return walk(0);
  }

  /* ---- 한 줄 읽기 ------------------------------------------------------ */

  /* mat: BGR, rect: [x,y,w,h] (없으면 mat 전체). 반환:
       { text, ok, runs, unknownRuns, band, unknownBitmaps } */
  function readLine(mat, rect, font, opts) {
    opts = opts || {};
    var Vi = V();
    var s = new Vi.Scope();
    try {
      var base = rect ? s.add(Vi.roi(mat, rect[0], rect[1], rect[2], rect[3])) : mat;
      if (!base) return { ok: false, text: '', reason: 'no_crop' };
      /* 비연속 ROI 를 그대로 훑으면 행이 어긋난다 (vision.contiguous 주석 참고). */
      var copy = Vi.contiguous ? Vi.contiguous(base) : null;
      var crop = copy ? s.add(copy) : base;
      var W = crop.cols, H = crop.rows;
      var mask = inkMask(crop, font.ink);
      var minRunWidth = (opts.minRunWidth !== undefined) ? opts.minRunWidth : font.minRunWidth;
      var cands = bandCandidates(mask, W, H, font.height, minRunWidth, font);
      if (!cands.length) return { ok: false, text: '', reason: 'no_text_band' };

      /* 점수순으로 시도하고 처음으로 전부 읽히는 띠를 쓴다. 하나도 못 읽으면
         가장 좋았던 시도를 돌려준다 — OCR이 라벨을 붙여 줄 대상이 된다. */
      /* 모든 후보를 보고 **가장 긴** 판독을 채택한다.

         점수 1위를 바로 쓰면 아이콘 그림이 만든 한 글자짜리 띠가 먼저
         성공해 버린다 — 실측에서 "11"이 "1"로 잎혔다. 글자가 더 많은 띠가
         진짜 숫자이므로 길이를 먼저 보고, 같으면 점수로 가른다. */
      var fallback = null, bestOk = null;
      for (var c = 0; c < cands.length; c++) {
        var got = decodeBand(mask, W, font, cands[c], rect);
        if (got.ok) {
          if (!bestOk || got.text.length > bestOk.text.length) bestOk = got;
          continue;
        }
        var lit = got.text.replace(/ /g, '').length;
        if (!fallback || lit > fallback.text.replace(/ /g, '').length) fallback = got;
      }
      return bestOk || fallback;
    } finally { s.done(); }
  }

  /* 한 띠를 글자열로. segmentation 이 'runs' 면 열 구간 하나가 글리프 하나이고
     (버프 아이콘 숫자), 아니면 되추적으로 쪼개다 (경험치 막대). */
  function decodeBand(mask, W, font, band, rect) {
    var H = font.height;
    var sub = mask.subarray(band.y * W, (band.y + H) * W);
    var text = '', unknown = 0, bitmaps = [];
    for (var i = 0; i < band.runs.length; i++) {
      var r = band.runs[i];
      /* 콜론은 1~2 화소짜리 점 두 개라서 배경에 따라 통째로 사라진다
         (실측: "1:51"에서 완전 소실, "3:21"에서 절반만 남음). 그래서 잉크로
         찾지 않고 **글자 사이 간격**으로 넣는다. 실측 간격 분포는
         숫자-숫자 2~3, 숫자-콜론-숫자 6~7로 겹치지 않는다. */
      if (i > 0 && font.colonGap && (r[0] - band.runs[i - 1][1]) >= font.colonGap) text += ':';
      var piece;
      if (font.segmentation === 'runs') {
        piece = matchGlyph(runBits(sub, W, H, r[0], r[1]), font);
      } else {
        piece = decodeRun(sub, W, H, r[0], r[1], font);
      }
      if (piece === null) {
        unknown++;
        var w = r[1] - r[0], bits = new Uint8Array(w * H);
        for (var y = 0; y < H; y++) {
          for (var x = 0; x < w; x++) bits[y * w + x] = sub[y * W + r[0] + x];
        }
        // textIndex: 콜론이 끼어들 수 있으므로 구간 번호와 별개로 기록한다.
        bitmaps.push({ index: i, textIndex: text.length, w: w, h: H, bits: bits });
        text += ' ';
      } else {
        text += piece;
      }
    }
    /* 끝에 붙은 잉크 = 칸 밖으로 잘렸을 수 있다.

       실측: 버프 칸 상자가 2px 오른쪽으로 치우치자 "11"의 앞 글자가
       잘려 나가 남은 한 글자만 "1"로 깔끔하게 읽혔다. 글자가 짤려도
       남은 조각이 다른 글자와 정확히 같을 수 있으므로, 이건 맞추기로는
       걸러낼 수 없고 기하로 막아야 한다. 글자에는 검은 테두리가 있어
       온전히 보이면 양 끝 열은 비어 있다. */
    var guard = font.edgeGuard || 'none';
    var clipped = !!band.runs.length && (
      ((guard === 'both' || guard === 'left') && band.runs[0][0] <= 0) ||
      ((guard === 'both' || guard === 'right') && band.runs[band.runs.length - 1][1] >= W));

    return {
      ok: unknown === 0 && text.length > 0 && !clipped,
      clipped: !!clipped,
      text: text, reason: unknown ? 'unknown_glyph' : (clipped ? 'clipped' : 'read'),
      runs: band.runs.length, unknownRuns: unknown, unknownBitmaps: bitmaps,
      band: { x: (rect ? rect[0] : 0) + band.x0, y: (rect ? rect[1] : 0) + band.y,
              w: band.x1 - band.x0, h: H },
      score: band.score
    };
  }

  /* ---- 부트스트랩 -------------------------------------------------------

     아틀라스에 없는 글자를 만나면 그 프레임은 버린다. 대신 기존 OCR이 문법을
     통과하는 문자열을 내고 그 길이가 이 판독의 구간 수와 정확히 같으면, 모르는
     글리프에 라벨을 붙여 아틀라스를 넓힌다. 이렇게 하면 '6'처럼 표본에 없던
     글자나 글꼴 변경을 스스로 메운다. 길이가 다르면 대응이 어긋날 수 있으므로
     아무것도 배우지 않는다. */
  function learnFrom(result, truth, font) {
    if (!result || !truth) return 0;
    if (result.text.length !== truth.length) return 0;
    var learned = 0;
    result.unknownBitmaps.forEach(function (u) {
      var at = (u.textIndex === undefined) ? u.index : u.textIndex;
      var ch = truth.charAt(at);
      if (!ch || ch === ' ' || ch === ':') return;
      if (font.hasBitmap(u.bits, u.w, u.h)) return;
      /* 경험치 글꼴은 새 '문자'만 배운다 (배경이 균일해 변형이 생기지 않는다).
         버프 글꼴은 배경마다 테두리가 달라지므로 같은 문자의 새 변형도 배운다. */
      if (!font.learnVariants && font.has(ch)) return;
      font.add(ch, u.bits, u.w, u.h);
      learned += 1;
    });
    return learned;
  }

  /* ---- 적재 ------------------------------------------------------------ */

  function Atlas(doc) {
    this.fonts = {};
    var specs = (doc && doc.fonts) || {};
    Object.keys(specs).forEach(function (name) {
      this.fonts[name] = new Font(name, specs[name]);
    }, this);
  }
  Atlas.prototype.font = function (name) { return this.fonts[name] || null; };

  Atlas.load = function (url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('glyphs ' + url + ' -> HTTP ' + r.status);
      return r.json();
    }).then(function (doc) { return new Atlas(doc); });
  };

  root.glyphs = {
    inkMask: inkMask,
    Font: Font,
    Atlas: Atlas,
    columnRuns: columnRuns,
    findTextBand: findTextBand,
    bandCandidates: bandCandidates,
    runBits: runBits,
    bitDistance: bitDistance,
    matchGlyph: matchGlyph,
    decodeBand: decodeBand,
    decodeRun: decodeRun,
    exactAt: exactAt,
    readLine: readLine,
    learnFrom: learnFrom
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
