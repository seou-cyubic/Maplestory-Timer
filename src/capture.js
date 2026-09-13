/* Screen-share capture and client-rect calibration.

   The legacy build asked Windows Graphics Capture for the game's client area
   directly and refused anything that was not exactly 1366x768. A shared
   surface from getDisplayMedia has no such guarantee: Chrome hands over the
   whole window, frame and title bar included, at whatever size the compositor
   used. So the client rectangle is located inside the shared surface and every
   frame is resampled to the calibrated 1366x768 the ROI constants assume. */
(function (root) {
  'use strict';

  var CLIENT_W = 1366, CLIENT_H = 768;
  var TARGET_ASPECT = CLIENT_W / CLIENT_H;

  function Capture() {
    this.stream = null;
    this.video = null;
    this.rect = null;          // {x,y,w,h} inside the shared surface
    this.canvas = null;
    this.ctx = null;
    this.frameId = 0;
    this.startedAt = 0;
    this.label = '';
    this.history = {};        // role -> the last frame that role was served
  }

  Capture.prototype.start = function () {
    var self_ = this;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('이 브라우저는 화면 공유(getDisplayMedia)를 지원하지 않습니다.'));
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false
    }).then(function (stream) {
      self_.stream = stream;
      var track = stream.getVideoTracks()[0];
      self_.label = track.label || '';
      track.addEventListener('ended', function () {
        if (self_.onended) self_.onended();
      });
      var v = document.createElement('video');
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      self_.video = v;
      return v.play().then(function () { return self_._waitForSize(); });
    }).then(function () {
      self_.canvas = new OffscreenCanvas(CLIENT_W, CLIENT_H);
      self_.ctx = self_.canvas.getContext('2d', { alpha: false, willReadFrequently: false });
      self_.startedAt = performance.now();
      self_.rect = self_.candidates()[0];
      return self_;
    });
  };

  Capture.prototype._waitForSize = function () {
    var v = this.video;
    return new Promise(function (resolve, reject) {
      var tries = 0;
      var timer = setInterval(function () {
        if (v.videoWidth && v.videoHeight) { clearInterval(timer); resolve(); }
        else if (++tries > 100) { clearInterval(timer); reject(new Error('공유 화면 크기를 읽지 못했습니다.')); }
      }, 50);
    });
  };

  Capture.prototype.stop = function () {
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null; this.video = null;
    // A new share must not be able to render the previous session's pixels.
    this.history = {};
    this.rect = null;
    this.frameId = 0;
    this.onended = null;
  };

  Capture.prototype.surfaceSize = function () {
    return this.video ? { w: this.video.videoWidth, h: this.video.videoHeight } : { w: 0, h: 0 };
  };

  /* Candidate client rectangles, best guess first. */
  Capture.prototype.candidates = function () {
    var s = this.surfaceSize();
    var list = [];
    if (!s.w || !s.h) return [{ x: 0, y: 0, w: 1, h: 1 }];
    var aspect = s.w / s.h;

    // 1. The share is already the client area (aspect matches within 1.5%).
    if (Math.abs(aspect - TARGET_ASPECT) / TARGET_ASPECT < 0.015) {
      list.push({ x: 0, y: 0, w: s.w, h: s.h, why: '공유 화면 전체 (비율 일치)' });
    }
    /* 1b. The window frame around an unscaled client, derived from the surface
       instead of guessed.

       Measured 2026-09-06: Chrome handed over the MapleStory window at
       1368x800 for a 1366x768 client - 1 px side borders and a 31 px title
       bar. The old "8 px / 39 px" guess produced 1352x760, which scaled the
       whole frame and left the experience readout, the potion icon and the
       booster anchor all unfindable. Windows border thickness varies by theme
       and DPI, so the border is computed from the difference rather than
       assumed: side borders are symmetric and the bottom border matches them,
       which leaves the title bar as the remainder. */
    var side = (s.w - CLIENT_W) / 2;
    if (s.w >= CLIENT_W && s.h >= CLIENT_H &&
        s.w - CLIENT_W <= 48 && s.h - CLIENT_H <= 140 && side === Math.round(side)) {
      var titleH = s.h - CLIENT_H - side;
      if (titleH >= 0) {
        list.push({ x: side, y: titleH, w: CLIENT_W, h: CLIENT_H,
                    why: '클라이언트 1366×768 + 테두리 ' + side + 'px / 제목 ' + titleH + 'px' });
      }
      // Same client, sitting flush with the bottom of the surface.
      list.push({ x: side, y: s.h - CLIENT_H, w: CLIENT_W, h: CLIENT_H,
                  why: '클라이언트 1366×768 (하단 정렬)' });
    }
    // 2. Content bounding box: strips flat window borders and the title bar.
    var content = this.contentRect();
    if (content) content.why = '테두리 제거 (내용 경계 자동 검출)';
    if (content) list.push(content);
    // 3. Standard Windows 11 chrome around a 1366x768 client at 100% scaling.
    var scale = s.w / (CLIENT_W + 16);
    if (scale > 0.5 && scale < 2.5) {
      list.push({
        x: Math.round(8 * scale), y: Math.round(39 * scale),
        w: Math.round(CLIENT_W * scale), h: Math.round(CLIENT_H * scale),
        why: '표준 창 테두리 추정 (좌우 8px / 제목 39px)'
      });
    }
    // 4. Last resort: use everything and let the resample handle it.
    list.push({ x: 0, y: 0, w: s.w, h: s.h, why: '공유 화면 전체' });

    var seen = {};
    return list.filter(function (r) {
      if (!r || r.w < 200 || r.h < 120) return false;
      var k = [r.x, r.y, r.w, r.h].join(',');
      if (seen[k]) return false;
      seen[k] = 1; return true;
    });
  };

  /* Find where real content starts by looking for rows/columns that stop being
     a flat colour. Window borders and title bars are near-uniform; the game is not. */
  Capture.prototype.contentRect = function () {
    var s = this.surfaceSize();
    if (!s.w || !s.h) return null;
    var W = 240, H = Math.max(1, Math.round(W * s.h / s.w));
    var c = new OffscreenCanvas(W, H);
    var g = c.getContext('2d', { willReadFrequently: true });
    try { g.drawImage(this.video, 0, 0, W, H); } catch (e) { return null; }
    var d = g.getImageData(0, 0, W, H).data;

    function rowVar(y) {
      var n = 0, mean = 0, m2 = 0;
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        var v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        n++; var delta = v - mean; mean += delta / n; m2 += delta * (v - mean);
      }
      return m2 / n;
    }
    function colVar(x) {
      var n = 0, mean = 0, m2 = 0;
      for (var y = 0; y < H; y++) {
        var i = (y * W + x) * 4;
        var v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        n++; var delta = v - mean; mean += delta / n; m2 += delta * (v - mean);
      }
      return m2 / n;
    }
    var TH = 40;   // variance floor that a flat border never reaches
    var top = 0, bottom = H - 1, left = 0, right = W - 1;
    while (top < H - 1 && rowVar(top) < TH) top++;
    while (bottom > top && rowVar(bottom) < TH) bottom--;
    while (left < W - 1 && colVar(left) < TH) left++;
    while (right > left && colVar(right) < TH) right--;
    if (bottom - top < 10 || right - left < 20) return null;
    var sx = s.w / W, sy = s.h / H;
    return {
      x: Math.round(left * sx), y: Math.round(top * sy),
      w: Math.round((right - left + 1) * sx), h: Math.round((bottom - top + 1) * sy)
    };
  };

  Capture.prototype.setRect = function (rect) { this.rect = rect; };
  Capture.prototype.getRect = function () { return this.rect; };

  /* One normalised 1366x768 frame, transferable to a worker.

     A copy is kept per role (§6.4): the crop panels must show the frame the
     detector actually read, not live video re-cropped through an old bbox.
     One 1366x768 RGBA buffer per role is ~4 MB; four roles is the whole cost. */
  Capture.prototype.grab = function (role) {
    if (!this.video || !this.rect || this.video.readyState < 2) return null;
    var r = this.rect;
    try {
      this.ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, CLIENT_W, CLIENT_H);
    } catch (e) { return null; }
    this.frameId += 1;
    if (role) {
      if (!this.history[role]) {
        var c = new OffscreenCanvas(CLIENT_W, CLIENT_H);
        this.history[role] = { canvas: c, ctx: c.getContext('2d', { alpha: false }), frameId: 0 };
      }
      var h = this.history[role];
      try {
        h.ctx.drawImage(this.canvas, 0, 0);
        h.frameId = this.frameId;
      } catch (e) { /* keep the previous copy */ }
    }
    return {
      bitmap: this.canvas.transferToImageBitmap(),
      frameId: this.frameId,
      stamp: performance.now() / 1000
    };
  };

  Capture.prototype.frameIdOf = function (role) {
    var h = this.history[role];
    return h ? h.frameId : null;
  };

  /* Draw one client-coordinate rectangle into its own canvas, scaled to fit
     and centred. Nearest-neighbour so a 32x32 buff icon stays legible when
     blown up. Returns the transform so callers can place sub-boxes inside. */
  Capture.prototype.drawClientRegion = function (canvasEl, rect, role) {
    var g = canvasEl.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (!rect || rect[2] <= 0 || rect[3] <= 0) {
      g.fillStyle = '#0c131c';
      g.fillRect(0, 0, canvasEl.width, canvasEl.height);
      return null;
    }

    /* 캔버스 버퍼를 영역과 **똑같은 크기**로 맞춘다 (2026-09-07 사용자 요청:
       "각 화면 영역에 유격을 제거하고, 감지한 요소와 영역만을 보여준다").

       예전에는 고정 크기 캔버스에 영역을 축소해 넣고 남는 자리를 배경색으로
       채웠다. 그래서 세로로 긴 영역은 좌우에, 가로로 긴 영역은 위아래에 빈
       띠가 생겼다. 버퍼를 영역 크기로 두면 화소가 1:1 로 들어가 빈자리가
       아예 없다. 칸에 맞추는 일은 CSS(max-width/max-height)가 하므로 칸에
       할당된 크기는 그대로다.

       덤으로 겹쳐 그리는 사각형 좌표가 단순해진다 — 배율 1, 오프셋 0. */
    var rw = Math.max(1, Math.round(rect[2])), rh = Math.max(1, Math.round(rect[3]));
    /* 배율은 **정수**로 고른다. CSS 로 늘리면 max-width 와 height 가 각각
       걸려 비율이 깨진다 (실측: 197x20 영역이 641x128 로 늘어났다). 버퍼를
       정수배로 키우고 CSS 는 줄이기만 하게 두면 비율이 정확하고, 확대해도
       화소가 뭉개지지 않는다. */
    var box = canvasEl.parentElement;
    var maxW = box && box.clientWidth ? box.clientWidth : rw;
    var maxH = box && box.clientHeight ? box.clientHeight : rh;
    var k = Math.floor(Math.min(maxW / rw, maxH / rh));
    if (!(k >= 1)) k = 1;
    if (k > 8) k = 8;
    var bw = rw * k, bh = rh * k;
    if (canvasEl.width !== bw || canvasEl.height !== bh) {
      canvasEl.width = bw; canvasEl.height = bh;
      g = canvasEl.getContext('2d');       // 버퍼를 바꾸면 상태가 초기화된다
      g.imageSmoothingEnabled = false;
    }
    var scale = k, dw = bw, dh = bh, ox = 0, oy = 0;
    var view = { scale: scale, ox: ox, oy: oy, origin: [rect[0], rect[1]],
                 drawn: false, source: null };

    // Preferred source: the exact frame this role analysed, already normalised
    // to client coordinates, so no rescaling guesswork is involved.
    var hist = role ? this.history[role] : null;
    if (hist && hist.frameId) {
      try {
        g.drawImage(hist.canvas, rect[0], rect[1], rect[2], rect[3], ox, oy, dw, dh);
        view.drawn = true;
        view.source = 'analysed_frame';
      } catch (e) { /* fall through to live video */ }
    }
    if (!view.drawn && this.video && this.rect && this.video.readyState >= 2) {
      var r = this.rect;
      var kx = r.w / CLIENT_W, ky = r.h / CLIENT_H;
      try {
        g.drawImage(this.video,
          r.x + rect[0] * kx, r.y + rect[1] * ky, rect[2] * kx, rect[3] * ky,
          ox, oy, dw, dh);
        view.drawn = true;
        view.source = 'live_video';
      } catch (e) { /* frame not ready */ }
    }
    if (!view.drawn) {
      g.fillStyle = '#0c131c';
      g.fillRect(0, 0, canvasEl.width, canvasEl.height);
      g.fillStyle = '#2f425a';
      g.font = '13px "Malgun Gothic", sans-serif';
      g.textAlign = 'center';
      g.fillText('공유 대기', canvasEl.width / 2, canvasEl.height / 2);
      g.textAlign = 'left';
    }
    return view;
  };

  /* The calibrated client area drawn to a visible canvas, letterbox-free, so
     detector overlays can be placed in 1366x768 coordinates. */
  Capture.prototype.drawClient = function (canvasEl) {
    if (!this.video || !this.rect || this.video.readyState < 2) return false;
    var r = this.rect;
    try {
      canvasEl.getContext('2d').drawImage(this.video, r.x, r.y, r.w, r.h,
        0, 0, canvasEl.width, canvasEl.height);
    } catch (e) { return false; }
    return true;
  };

  /* Preview for the calibration panel, drawn at the caller's size. */
  Capture.prototype.drawPreview = function (canvasEl) {
    if (!this.video || this.video.readyState < 2) return false;
    var g = canvasEl.getContext('2d');
    g.drawImage(this.video, 0, 0, canvasEl.width, canvasEl.height);
    return true;
  };

  Capture.CLIENT_W = CLIENT_W;
  Capture.CLIENT_H = CLIENT_H;
  root.Capture = Capture;
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
