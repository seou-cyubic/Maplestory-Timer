/* 실사냥 세션 녹화기 — 1초 간격 무손실 프레임 + 판정 색인.

   왜 필요한가
   -----------
   지금까지 회귀 시험의 실화면 표본은 손으로 고른 다섯 장뿐이다. 그 다섯 장에는
   부스터가 사라지는 순간도, 룬이 뜨는 순간도, 비약 숫자가 넘어가는 순간도
   들어 있지 않다. 네 가지 알림은 전부 **시간에 따른 변화**로 판정하므로,
   한 장짜리 표본으로는 판독만 시험할 수 있고 판정은 시험할 수 없다.

   1초 간격 연속 프레임이 있으면 그 30분을 그대로 재생해 상태기계를 통과시킬 수
   있다. 알림이 언제 몇 번 울렸는지가 재현 가능한 시험이 된다.

   쓰는 법 (관측 화면 콘솔에서)
   ---------------------------
     await fetch('tools/record_session.js').then(r=>r.text()).then(eval)
     ASTRA_REC.start()                    // 기본 30분 · 1Hz · 전체 프레임
     ASTRA_REC.status()                   // 진행 상황
     ASTRA_REC.stop()                     // 조기 종료 (색인은 자동 저장)

   콘솔을 열지 않는 방법: 관측 화면을 ?rec=30 으로 연다. 공유·보정이 끝나는
   즉시 30분 녹화가 스스로 시작된다 (index.html 이 이 파일을 불러 autoStart()
   를 호출한다). ?rec=30&hz=1&encoders=2 처럼 값을 덧붙일 수 있다.

   옵션: ASTRA_REC.start({ minutes: 30, hz: 1, mode: 'full', budgetMB: 3000,
                           encoders: 2 })

   설계상 반드시 지켜야 할 것
   -------------------------
   * **무손실 PNG만.** 글꼴 정확 대조가 화소값 그대로에 의존한다. 손실 압축은
     안티에일리어싱 가장자리를 바꿔 아틀라스 변형을 통째로 무효화한다.
     (Chrome 캔버스의 WebP 인코더에는 무손실 모드가 없다. PNG를 쓴다.)

   * **인코딩은 전용 워커에서 한다.** 같은 페이지 같은 순간에 나란히 잰 값
     (1366x768 PNG, document.hidden = true):

         메인 스레드  1037 / 1048 / 1045 / 1038 ms
         워커           39 /   31 /   28 /   27 ms

     숨은 페이지의 메인 스레드에서는 canvas.convertToBlob 이 렌더링 파이프라인
     박자에 묶여 초당 한 장으로 떨어진다. 사냥 중에는 게임이 앞에 있어 관측
     화면이 숨어 있는 것이 정상이므로, 메인 스레드 인코딩은 1Hz를 원리적으로
     못 맞춘다. 그래서 메인 스레드는 영상에서 캔버스로 그리고 ImageBitmap 을
     넘기기만 하고, 인코딩과 전송은 워커가 맡는다.

   * **박자도 워커가 준다.** 숨은 페이지의 setInterval 은 처음 몇 분은
     정확했지만(실측 999~1138 ms), Chrome 은 5분 넘게 숨어 있고 소리도 안 나는
     페이지의 타이머를 분당 1회까지 조인다. 30분 녹화는 그 구간에 들어간다.
     워커 setTimeout 은 같은 조건에서 1001~1016 ms 로 정확했고, 워커→메인
     메시지 왕복은 0~17 ms 였다. 그래서 앱 본체와 같은 방식 — 워커가 박자를
     주고 메인은 메시지에 응답만 한다 — 을 쓴다.

   * **밀리면 건너뛴다.** 인코더가 다 바쁘면 그 틱은 버리고 센다. 큐에 쌓으면
     메모리가 불어나고 시각이 뒤로 밀린다.

   * **라이브 파이프라인을 건드리지 않는다.** capture.grab() 은 프레임 번호를
     올리고 캔버스를 비우므로(transferToImageBitmap) 워커 프레임 회계와 얽힌다.
     여기서는 capture.video 와 capture.getRect() 만 읽어 자체 캔버스에 그린다. */
(function (root) {
  'use strict';

  var CLIENT_W = 1366, CLIENT_H = 768;

  /* 영역 모드에서 남기는 범위. 탐지기가 실제로 훑는 창에서 나온 값이다.
       미니맵 탐색  [0, 0, 455, 384]      (vision.detectMinimap)
       부스터 탐색  [341, 0, 683, 250]    (detectors.BoosterDetector.observe)
       버프 기본    [683, 0, 683, 180]    (vision.defaultBuffRect)
     세 창의 합집합이 상단 384행 안에 들어간다. 경험치는 하단 26행이다
     (vision.ExpLocator.readByGlyph). */
  var REGION_TOP_H = 384;
  var REGION_EXP_H = 26;

  var ENCODER_SRC = [
    'self.onmessage = function (e) {',
    '  var d = e.data;',
    '  var c = new OffscreenCanvas(d.bitmap.width, d.bitmap.height);',
    '  c.getContext("2d", { alpha: false }).drawImage(d.bitmap, 0, 0);',
    '  d.bitmap.close();',
    '  var t0 = performance.now();',
    '  c.convertToBlob({ type: "image/png" }).then(function (b) {',
    '    var enc = performance.now() - t0;',
    '    return fetch(d.url, { method: "POST", body: b }).then(function (r) {',
    '      self.postMessage({ seq: d.seq, bytes: b.size, ok: r.ok,',
    '                         status: r.status, encode_ms: Math.round(enc),',
    '                         total_ms: Math.round(performance.now() - t0) });',
    '    });',
    '  }).catch(function (err) {',
    '    self.postMessage({ seq: d.seq, ok: false, error: String(err && err.message || err) });',
    '  });',
    '};'
  ].join('\n');

  /* 박자 워커. 메인 스레드 타이머를 쓰지 않는 이유는 머리말 참고. */
  var CLOCK_SRC = [
    'var on = false, period = 1000;',
    'function fire() {',
    '  if (!on) return;',
    '  self.postMessage(1);',
    '  setTimeout(fire, period);',
    '}',
    'self.onmessage = function (e) {',
    '  if (e.data && e.data.stop) { on = false; return; }',
    '  period = (e.data && e.data.period) || 1000;',
    '  if (!on) { on = true; setTimeout(fire, period); }',
    '};'
  ].join('\n');

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  function Recorder() { this._clear(); }

  Recorder.prototype._clear = function () {
    this.running = false;
    this.frames = [];
    this.seq = 0;
    this.bytes = 0;
    this.written = 0;
    this.dropped = 0;      // 인코더가 바빠 버린 틱
    this.errors = 0;
    this.encodeMs = [];
    this.dir = null;
    this.clock = null;
    this.opts = null;
    this.startedAt = null;
    this.workers = [];
    this.busy = [];
  };

  Recorder.prototype._app = function () {
    var app = root.ASTRA_APP;
    if (!app || !app.capture) throw new Error('관측 화면에서 실행해야 한다 (ASTRA_APP 없음)');
    return app;
  };

  Recorder.prototype.start = function (opts) {
    if (this.running) { console.warn('[REC] 이미 돌고 있다'); return this.status(); }
    opts = opts || {};
    var app = this._app();
    var cap = app.capture;
    if (!cap.video || !cap.getRect()) throw new Error('화면 공유와 보정이 끝난 뒤에 시작하라');

    this._clear();
    this.opts = {
      minutes: opts.minutes === undefined ? 30 : opts.minutes,
      hz: opts.hz === undefined ? 1 : opts.hz,
      mode: opts.mode === 'regions' ? 'regions' : 'full',
      budgetMB: opts.budgetMB === undefined ? 3000 : opts.budgetMB,
      encoders: Math.max(1, Math.min(4, opts.encoders === undefined ? 2 : opts.encoders))
    };
    var stamp = new Date();
    this.dir = opts.dir || ('rec_' + stamp.toISOString().slice(0, 19).replace(/[-:T]/g, ''));
    this.startedAt = stamp;

    var h = this.opts.mode === 'regions' ? (REGION_TOP_H + REGION_EXP_H) : CLIENT_H;
    this.canvas = new OffscreenCanvas(CLIENT_W, h);
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    var self_ = this;
    var url = URL.createObjectURL(new Blob([ENCODER_SRC], { type: 'text/javascript' }));
    for (var i = 0; i < this.opts.encoders; i++) {
      var w = new Worker(url);
      w.onmessage = (function (slot) {
        return function (ev) { self_._done(slot, ev.data); };
      })(i);
      this.workers.push(w);
      this.busy.push(false);
    }
    URL.revokeObjectURL(url);

    this.running = true;
    this.deadline = Date.now() + this.opts.minutes * 60000;
    var period = Math.max(100, Math.round(1000 / this.opts.hz));
    var curl = URL.createObjectURL(new Blob([CLOCK_SRC], { type: 'text/javascript' }));
    this.clock = new Worker(curl);
    URL.revokeObjectURL(curl);
    this.clock.onmessage = function () { self_._tick(); };
    this.clock.postMessage({ period: period });
    console.log('[REC] 시작 — ' + this.opts.minutes + '분 · ' + this.opts.hz + 'Hz · ' +
      this.opts.mode + ' · 인코더 ' + this.opts.encoders + '개 · assets/samples/' + this.dir + '/');
    return this.status();
  };

  /* 한 프레임: 공유 영상에서 정규화 클라이언트 좌표로 직접 그린다. */
  Recorder.prototype._draw = function (cap) {
    var r = cap.getRect();
    var v = cap.video;
    if (!v || v.readyState < 2 || !r) return false;
    var g = this.ctx;
    try {
      if (this.opts.mode === 'full') {
        g.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, CLIENT_W, CLIENT_H);
      } else {
        var sy = r.h / CLIENT_H;
        g.drawImage(v, r.x, r.y, r.w, REGION_TOP_H * sy, 0, 0, CLIENT_W, REGION_TOP_H);
        g.drawImage(v, r.x, r.y + (CLIENT_H - REGION_EXP_H) * sy, r.w, REGION_EXP_H * sy,
                    0, REGION_TOP_H, CLIENT_W, REGION_EXP_H);
      }
    } catch (e) { return false; }
    return true;
  };

  Recorder.prototype._freeSlot = function () {
    for (var i = 0; i < this.busy.length; i++) if (!this.busy[i]) return i;
    return -1;
  };

  Recorder.prototype._tick = function () {
    if (!this.running) return;
    if (Date.now() >= this.deadline) { this.stop('시간 종료'); return; }
    if (this.bytes > this.opts.budgetMB * 1024 * 1024) { this.stop('용량 상한'); return; }

    var app;
    try { app = this._app(); } catch (e) { this.stop('앱 없음'); return; }

    // 프레임 번호는 **여기서** 정한다. 인코딩이 끝난 뒤에 정하면 동시에 뜬
    // 여러 틱이 같은 번호를 받아 파일을 덮어쓴다 (예행에서 실제로 났다).
    var seq = this.seq++;
    var t = { i: seq, at: new Date().toISOString(), t: performance.now() / 1000 };

    /* 그 순간 앱이 무엇으로 판정했는지 함께 남긴다. 1800장을 눈으로 훑지 않고도
       "부스터가 사라진 프레임", "룬이 뜬 프레임"을 색인에서 바로 찾을 수 있다. */
    try {
      var st = app.observerState ? app.observerState() : null;
      t.state = st ? JSON.parse(JSON.stringify(st)) : null;
    } catch (e) { t.state = null; t.state_error = String(e && e.message || e); }
    try {
      var rect = app.capture.getRect();
      t.rect = rect ? [rect.x, rect.y, rect.w, rect.h] : null;
      t.surface = app.capture.surfaceSize ? app.capture.surfaceSize() : null;
    } catch (e) { t.rect = null; }

    var slot = this._freeSlot();
    if (slot < 0) {
      // 인코더가 전부 바쁘다. 큐에 쌓지 않고 이 틱을 버린다.
      t.file = null; t.reason = 'encoder_busy';
      this.frames.push(t); this.dropped += 1;
      return;
    }
    if (!this._draw(app.capture)) {
      t.file = null; t.reason = 'no_frame';
      this.frames.push(t); this.errors += 1;
      return;
    }

    t.file = 'f' + pad(seq, 5) + '.png';
    this.frames.push(t);
    this.busy[slot] = true;
    var bmp = this.canvas.transferToImageBitmap();
    this.workers[slot].postMessage({
      seq: seq, bitmap: bmp,
      /* 블롭 URL 워커는 기준 주소가 불투명해 상대 경로 fetch 가 실패한다
         ("Failed to parse URL from _capture?..."). 절대 주소로 넘긴다. */
      url: new URL('_capture?dir=' + encodeURIComponent(this.dir) + '&name=f' + pad(seq, 5),
                   root.location.href).href
    }, [bmp]);
  };

  Recorder.prototype._done = function (slot, msg) {
    this.busy[slot] = false;
    var f = null;
    for (var i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].i === msg.seq) { f = this.frames[i]; break; }
    }
    if (!msg.ok) {
      this.errors += 1;
      if (f) { f.file = null; f.reason = msg.error || ('http_' + msg.status); }
      return;
    }
    this.written += 1;
    this.bytes += msg.bytes || 0;
    if (msg.encode_ms !== undefined) {
      this.encodeMs.push(msg.encode_ms);
      if (this.encodeMs.length > 200) this.encodeMs.shift();
    }
    if (f) { f.bytes = msg.bytes; f.encode_ms = msg.encode_ms; }
  };

  Recorder.prototype.stop = function (why) {
    if (!this.running) return Promise.resolve(this.status());
    this.running = false;
    if (this.clock) { this.clock.postMessage({ stop: true }); }
    var self_ = this;
    var enc = this.encodeMs.slice().sort(function (a, b) { return a - b; });
    var manifest = {
      _note: '실사냥 세션 1Hz 무손실 녹화. file 이 null 인 프레임은 그 시각에 ' +
             '저장하지 못한 것이며 reason 에 이유가 있다. state 는 그 순간 관측 ' +
             '화면이 내린 판정이라 정답이 아니라 비교 대상이다.',
      dir: this.dir,
      started_at: this.startedAt ? this.startedAt.toISOString() : null,
      stopped_at: new Date().toISOString(),
      stopped_because: why || '사용자 중지',
      client: [CLIENT_W, CLIENT_H],
      mode: this.opts.mode,
      hz: this.opts.hz,
      encoders: this.opts.encoders,
      layout: this.opts.mode === 'regions'
        ? { top: [0, 0, CLIENT_W, REGION_TOP_H],
            exp: [0, CLIENT_H - REGION_EXP_H, CLIENT_W, REGION_EXP_H],
            note: '저장 이미지에서 exp 띠는 y=' + REGION_TOP_H + ' 에 붙어 있다' }
        : { full: [0, 0, CLIENT_W, CLIENT_H] },
      written: this.written, dropped_encoder_busy: this.dropped,
      errors: this.errors, bytes: this.bytes,
      encode_ms_median: enc.length ? enc[Math.floor(enc.length / 2)] : null,
      frames: this.frames
    };
    var body = JSON.stringify(manifest);
    return fetch('_manifest?dir=' + encodeURIComponent(this.dir) + '&name=manifest',
      { method: 'POST', body: body })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        self_.workers.forEach(function (w) { w.terminate(); });
        if (self_.clock) { self_.clock.terminate(); self_.clock = null; }
        self_.workers = []; self_.busy = [];
        console.log('[REC] 종료 (' + (why || '사용자 중지') + ') — ' + self_.written +
          '장 · ' + (self_.bytes / 1048576).toFixed(0) + ' MB · 버림 ' + self_.dropped +
          ' · 색인 ' + j.saved);
        return j;
      });
  };

  Recorder.prototype.status = function () {
    var enc = this.encodeMs.slice().sort(function (a, b) { return a - b; });
    return {
      running: this.running, dir: this.dir,
      ticks: this.frames.length, written: this.written,
      dropped_encoder_busy: this.dropped, errors: this.errors,
      MB: +(this.bytes / 1048576).toFixed(1),
      encode_ms_median: enc.length ? enc[Math.floor(enc.length / 2)] : null,
      remaining_min: this.running
        ? +(((this.deadline - Date.now()) / 60000).toFixed(1)) : 0
    };
  };

  /* 공유·보정이 끝나기를 기다렸다가 스스로 시작한다.

     사냥 직전에 콘솔을 열게 하지 않으려는 것이다. index.html 이 URL 에
     ?rec= 이 있을 때만 이 파일을 불러 이 함수를 호출한다 — 평소 실행에는
     아무 영향이 없다.

     보정 전에 시작하면 좌표계가 달라 프레임을 못 쓰므로, capture.getRect()
     가 나오고 영상이 준비될 때까지 기다린다. */
  Recorder.prototype.autoStart = function (opts) {
    var self_ = this;
    opts = opts || {};
    var waited = 0, every = 1000;
    var giveUp = (opts.waitMinutes === undefined ? 20 : opts.waitMinutes) * 60000;
    /* 보정은 공유 직후 한 번에 끝나지 않는다. main.js 는 CANDIDATE_PROBE_MS =
       7000 동안 후보를 재본 뒤 좌표를 바꿀 수 있다. 그 전에 시작하면 좌표계가
       다른 프레임이 앞부분에 섞인다. 그래서 영상이 준비된 지 10초가 지나고
       클라이언트 사각형이 4초 동안 그대로일 때만 시작한다. */
    var readySince = null, rectKey = null, rectSince = null;
    var STABLE_MS = 4000, SETTLE_MS = 10000;
    console.log('[REC] 자동 시작 대기 — 화면 공유와 보정이 끝나면 녹화를 시작한다');
    (function poll() {
      if (self_.running) return;
      var app = root.ASTRA_APP;
      var cap = app && app.capture;
      var rect = cap && cap.getRect ? cap.getRect() : null;
      var live = !!(cap && cap.video && cap.video.readyState >= 2 && rect);
      var nowMs = Date.now();
      if (!live) { readySince = null; rectKey = null; rectSince = null; }
      else {
        if (readySince === null) readySince = nowMs;
        var key = [rect.x, rect.y, rect.w, rect.h].join(',');
        if (key !== rectKey) { rectKey = key; rectSince = nowMs; }
      }
      var ready = live && (nowMs - readySince >= SETTLE_MS) && (nowMs - rectSince >= STABLE_MS);
      if (ready) {
        try {
          self_.start(opts);
          if (root.ASTRA_REC_ONSTART) root.ASTRA_REC_ONSTART(self_.status());
        } catch (e) {
          console.warn('[REC] 자동 시작 실패, 1초 뒤 다시 시도: ' + (e && e.message || e));
          setTimeout(poll, every);
        }
        return;
      }
      waited += every;
      if (waited >= giveUp) { console.warn('[REC] 자동 시작 포기 (공유가 시작되지 않음)'); return; }
      setTimeout(poll, every);
    })();
    return '대기 중';
  };

  root.ASTRA_REC = new Recorder();
  console.log('[REC] 준비됨 — ASTRA_REC.start() / .status() / .stop()');
})(typeof window !== 'undefined' ? window : self);
