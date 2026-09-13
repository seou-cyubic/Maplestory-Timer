/* Role-driven analysis worker.

   Roles mirror the thread split of legacy/src/astra_test/{app,workers}.py:
     exp   - experience OCR at ~10 Hz, kept on its own worker so a slow buff
             pass can never stretch the frame gap past the 0.5 s re-baseline.
     hud   - booster UI presence, rune duration, minimap/rune marker, the P04
             potion, buff-row visibility (0.5 s)
     buffs - the full buff grid (2 s), reported item by item
     lie   - CAPTCHA presence (1 s)
   Frames are pulled, never pushed, so a busy worker always skips to the
   newest frame instead of draining a backlog of stale ones.

   Session discipline (§5.1): every message in both directions carries
   sessionId / calibrationId / frameId. The worker echoes what it was given, so
   the page can drop a result that belongs to a share that has already ended.
   The page terminates workers on stop and spawns fresh ones on the next share;
   this file therefore never has to resurrect a stopped loop.

   Ordering (§5.4): the hud role posts the booster UI verdict on its own, the
   moment the template match returns, before any OCR runs. */
'use strict';

var CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js';
var ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';
var ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

var role = null, base = '', ctx = null, canvas = null, running = false;
var sessionId = null;

function waitForCv() {
  return new Promise(function (resolve, reject) {
    try {
      importScripts(CV_URL);
    } catch (e) { reject(new Error('OpenCV.js 로드 실패: ' + e.message)); return; }
    var mod = self.cv;
    if (mod && typeof mod.then === 'function') {           // newer builds resolve a promise
      mod.then(function (m) { self.cv = m; resolve(); }, reject);
      return;
    }
    if (mod && mod.Mat) { resolve(); return; }
    var timer = setInterval(function () {
      if (self.cv && self.cv.Mat) { clearInterval(timer); resolve(); }
    }, 50);
    setTimeout(function () { clearInterval(timer); if (!(self.cv && self.cv.Mat)) reject(new Error('OpenCV.js 초기화 시간 초과')); }, 60000);
  });
}

function loadOrt() {
  importScripts(ORT_URL);
  ort.env.wasm.wasmPaths = ORT_WASM;
  ort.env.wasm.numThreads = 1;      // no cross-origin isolation, so no wasm threads
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
}

function post(msg, transfer) {
  msg.role = role;
  msg.session = sessionId;
  self.postMessage(msg, transfer || []);
}

/* ---- frame pull ------------------------------------------------------- */

var pending = null;
function requestFrame() {
  return new Promise(function (resolve) {
    pending = resolve;
    post({ type: 'need-frame' });
  });
}

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.type === 'init') return init(m);
  if (m.type === 'stop') {
    running = false;
    var r0 = pending; pending = null;
    if (r0) r0({ type: 'wait', ms: 1000 });
    return;
  }
  if (m.type === 'frame' || m.type === 'wait') {
    var r = pending; pending = null;
    if (r) r(m);
  }
};

function bitmapToMat(bitmap) {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ASTRA.vision.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/* ---- role setup ------------------------------------------------------- */

var engines = {}, ocr = null, buffs = null, rune = null, booster = null, lie = null;
var runeDuration = null;
var minimapLock = null;
/* 맵 이름은 lie 워커가 읽는다.

   왜 hud 가 아닌가: 한국어 인식 모델이 23 MB 인데 hud 는 부스터 존재 판정을
   지연 없이 내보내야 하는 워커다. lie 워커는 이미 한국어 모델을 들고 있고
   주기도 느리다(FRESH.lie = 8초). 맵 이름은 맵을 옮길 때만 바뀌므로 느린
   주기로 충분하다. */
var mapNameState = { lock: null, text: null, region: null, fingerprint: null,
                     reads: 0, rect: null, table: null, confident: false };
var atlas = null;
/* One sync read per continuous sighting of the booster UI (user request,
   2026-09-06). Reset whenever the UI stops being PRESENT, so the next booster
   gets its own sync. Display only - see detectors.js readNumber. */
var boosterSync = { done: false, value: null, raw: null, reason: 'not_attempted' };
var expLocator = null;
var INTERVAL = { exp: 100, hud: 500, buffs: 2000, lie: 1000 };

/* 경험치: 변화 감지가 본체, OCR은 화면 표시용 곁가지 (2026-09-06 memo).
   서명 비교는 몇 ms면 끝나므로 매 프레임 하고, OCR은 드물게만 한다. */
var expPrev = { sig: null, frame: null, at: 0 };
var EXP_OCR_EVERY_MS = 3000;      // 표시용 숫자 갱신 간격
var EXP_CHANGE_TOL = 6;           // 서명 거리 이하이면 '변화 없음'
var FRAME_FREEZE_TOL = 1;         // 화면 전체가 사실상 동일하면 스트림 정지

function init(msg) {
  role = msg.role;
  base = msg.base || '';
  sessionId = msg.sessionId === undefined ? null : msg.sessionId;
  post({ type: 'status', stage: 'opencv' });
  waitForCv().then(function () {
    post({ type: 'status', stage: 'runtime' });
    loadOrt();
    importScripts(base + 'src/parse.js', base + 'src/state.js', base + 'src/ocr.js',
                  base + 'src/vision.js', base + 'src/glyphs.js',
                  base + 'src/accumulate.js', base + 'src/detectors.js');
    post({ type: 'status', stage: 'models' });
    var need = [];
    if (role !== 'lie') {
      need.push(ASTRA.OcrEngine.create(base + 'models/rec_general.onnx', base + 'models/rec_general.charset.json', 'general')
        .then(function (e) { engines.general = e; }));
    }
    if (role === 'hud' || role === 'buffs') {
      need.push(ASTRA.OcrEngine.create(base + 'models/rec_en.onnx', base + 'models/rec_en.charset.json', 'en')
        .then(function (e) { engines.en = e; }));
    }
    if (role === 'lie') {
      need.push(ASTRA.OcrEngine.create(base + 'models/rec_korean.onnx', base + 'models/rec_korean.charset.json', 'korean')
        .then(function (e) { engines.korean = e; }));
    }
    return Promise.all(need);
  }).then(function () {
    post({ type: 'status', stage: 'assets' });
    if (role !== 'lie') ocr = new ASTRA.vision.OCR(engines.general, engines.en || engines.general);
    var after = [];
    /* 글꼴 아틀라스는 경험치와 버프 숫자가 함께 쓴다. 한 번만 읽는다. */
    var atlasReady = (role === 'exp' || role === 'hud' || role === 'buffs')
      ? ASTRA.glyphs.Atlas.load(base + 'config/glyphs.json').then(function (a) {
          atlas = a; return a;
        }, function (e) {
          // 아틀라스가 없으면 예전 OCR 경로로 계속 돈다.
          post({ type: 'error', error: '글꼴 아틀라스 로드 실패, OCR로 대체: ' + e.message });
          return null;
        })
      : Promise.resolve(null);

    if (role === 'exp') {
      after.push(atlasReady.then(function (a) {
        expLocator = new ASTRA.vision.ExpLocator(a ? a.font('exp') : null);
      }));
    }
    if (role === 'hud' || role === 'buffs') {
      buffs = new ASTRA.vision.BuffClassifier(ocr);
      after.push(buffs.reload(base + 'config/labels.json', base));
      after.push(atlasReady.then(function (a) {
        buffs.setFonts(a ? { yellow: a.font('buff_yellow'),
                             minutes: a.font('buff_minutes'),
                             minutesL2: a.font('buff_minutes_l2') } : null);
      }));
    }
    if (role === 'hud') {
      rune = new ASTRA.detectors.RuneDetector();
      booster = new ASTRA.detectors.BoosterDetector();
      after.push(rune.load(base), booster.load(base));
    }
    if (role === 'lie') {
      lie = new ASTRA.detectors.LieDetector(engines.korean);
      after.push(lie.load(base));
    }
    return Promise.all(after);
  }).then(function () {
    if (role === 'hud') {
      runeDuration = new ASTRA.vision.RuneDurationReader(buffs);
      minimapLock = new ASTRA.vision.MinimapLock(3);
    }
    if (role === 'lie') {
      mapNameState.lock = new ASTRA.vision.MinimapLock(3);
      /* 이름표는 준비 조건이 아니다. 늦게 도착해도 그 전까지 OCR 추정으로
         버티므로 여기서 기다리지 않는다.

         **`after` 를 쓰면 안 된다** — 그 배열은 앞 단계 then 안의 지역 변수라
         여기서는 없는 이름이다. 실제로 그렇게 썼다가 lie 워커가
         "after is not defined" 로 초기화에 실패했고, 거짓말 탐지기와 사냥터
         이름이 통째로 죽었다 (2026-09-07 실사용에서 발견). */
      fetch(base + 'config/maps.json').then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (doc) { mapNameState.table = doc || null; },
              function () { mapNameState.table = null; });
    }
    post({
      type: 'ready',
      matcher: lie ? (lie.hasSift ? 'sift' : 'template') : null,
      lie_load_error: lie ? lie.loadError : null,
      rune_duration_status: runeDuration ? runeDuration.status() : null,
      glyph_font: (role === 'exp' && expLocator && expLocator.font)
        ? expLocator.font.glyphs.map(function (g) { return g.ch; }).sort().join('') : null,
      glyph_fonts: atlas ? Object.keys(atlas.fonts).map(function (n) {
        var f = atlas.fonts[n], set = {};
        f.glyphs.forEach(function (g) { set[g.ch] = 1; });
        return n + ':' + Object.keys(set).sort().join('') + '(' + f.glyphs.length + ')';
      }).join(' ') : null
    });
    running = true;
    loop();
  }).catch(function (e) {
    post({ type: 'fatal', error: String(e && e.message ? e.message : e) });
  });
}

/* ---- main loop -------------------------------------------------------- */

function loop() {
  if (!running) return;
  requestFrame().then(function (msg) {
    if (!running) return;
    if (msg.type === 'wait') {
      setTimeout(loop, Math.max(10, msg.ms || 30));
      return;
    }
    var t0 = performance.now();
    var mat = bitmapToMat(msg.bitmap);
    var meta = {
      frame_id: msg.frameId, stamp: msg.stamp,
      calibration: msg.calibrationId === undefined ? null : msg.calibrationId
    };
    return analyse(mat, msg, meta).then(function (payload) {
      mat.delete();
      payload.processing_ms = Math.round((performance.now() - t0) * 100) / 100;
      payload.stamp = msg.stamp;
      payload.frame_id = msg.frameId;
      payload.calibration = meta.calibration;
      // NOTE: a worker's performance.now() has its own time origin, so the
      // page's servedAt cannot be subtracted here. Delivery latency is
      // measured on the page instead, against msg.stamp which the page set.
      post({ type: 'result', payload: payload, frameId: msg.frameId, calibration: meta.calibration });
      var spent = performance.now() - t0;
      setTimeout(loop, Math.max(0, INTERVAL[role] - spent));
    }, function (e) {
      try { mat.delete(); } catch (x) {}
      post({ type: 'error', error: String(e && e.message ? e.message : e), stamp: msg.stamp });
      setTimeout(loop, INTERVAL[role]);       // recoverable: keep the worker alive
    });
  }).catch(function (e) {
    post({ type: 'error', error: String(e && e.message ? e.message : e) });
    setTimeout(loop, INTERVAL[role]);
  });
}

/* 미니맵 UI 안의 이름 띠를 읽는다.

   매번 OCR 을 돌리지 않는다. 띠의 지문이 바뀌었을 때만 읽는다 — 맵을 옮기지
   않는 한 같은 그림이 계속 들어오기 때문이다. 읽지 못하면 마지막으로 읽은
   이름을 그대로 유지하고, 지어내지 않는다. */
function readMapName(mat, stamp, sharedRect) {
  var V = ASTRA.vision;
  var out = { text: mapNameState.text, region: mapNameState.region, rect: null,
              source: 'kept', confident: !!mapNameState.confident,
              reads: mapNameState.reads };
  if (!engines.korean) { out.source = 'unavailable'; return out; }
  /* hud 워커가 이미 잠근 미니맵을 그대로 쓴다.

     예전에는 lie 워커가 자기 잠금을 따로 들었는데, 두 워커가 각자 탐색하니
     **서로 다른 상자를 잡는 일이 생겼다** (실사용 2026-09-07: hud 가
     [0,58,212,131], lie 가 [8,69,171,...]). 하나만 옳을 수 있으므로 같은 것을
     써야 한다. hud 가 없으면 예전처럼 스스로 찾는다. */
  var box = sharedRect || null;
  if (!box) {
    if (!mapNameState.lock) { out.source = 'unavailable'; return out; }
    var mm = mapNameState.lock.locate(mat, stamp);
    box = mm.bbox;
  }
  if (!box) { out.source = 'no_minimap'; return out; }
  out.minimap_from = sharedRect ? 'hud' : 'own';
  var ui = V.minimapUiRect(mat, box);
  var band = V.minimapNameRect(ui, box);
  if (!band) { out.source = 'no_name_band'; return out; }
  out.rect = band;
  mapNameState.rect = band;
  var fp = V.cellFingerprint(mat, band);
  /* 그림이 그대로면 **OCR 은** 다시 돌리지 않는다. 다만 이미 표에서 찾은
     이름이 아닐 때는 표 대조는 계속 해봐야 한다.

     실사용에서 이걸 놓쳤다(2026-09-07): 이름표는 비동기로 늦게 도착하는데,
     첫 프레임에서 표가 아직 없어 OCR 추정값을 쓴 뒤로는 지문이 그대로라
     여기서 매번 일찍 돌아가 **표를 영영 다시 보지 않았다.** 그래서 표에
     있는 맵인데도 "머둠미내리는나무줄기1 (추정)" 이 계속 나왔다.
     표 대조는 벡터 비교 한 번이라 비용이 없다. */
  var unchanged = fp && mapNameState.fingerprint &&
    !V.fingerprintChanged(mapNameState.fingerprint, fp, 40);
  if (unchanged && mapNameState.confident) {
    return out;
  }
  mapNameState.fingerprint = fp;

  /* 이름표와 먼저 맞춰 본다. 맞으면 사람이 적은 정확한 이름이다.
     OCR 은 표에 없을 때만 쓰고, 그 값은 '추정'으로 표시된다. */
  var tbl = mapNameState.table;
  if (fp && tbl && tbl.maps) {
    var lim = tbl.match_max_distance === undefined ? 150 : tbl.match_max_distance;
    var shift = tbl.match_max_shift === undefined ? 4 : tbl.match_max_shift;
    /* 좌우로 밀어 가며 맞춘다. 지문은 열별 개수라 띠가 몇 화소만 밀려도
       전체가 어긋난다 — 실측에서 안쪽 미니맵 상자가 2px 움직이자 거리가
       0에서 819로 튀었다. 겹치는 구간만 비교하고 길이로 정규화한다. */
    var best = null;
    for (var i = 0; i < tbl.maps.length; i++) {
      var e = tbl.maps[i];
      if (!e.fingerprint || !e.fingerprint.length) continue;
      var mine = e.fingerprint, bestShift = null;
      for (var sh = -shift; sh <= shift; sh++) {
        var sum = 0, n = 0;
        for (var k = 0; k < fp.length; k++) {
          var j = k + sh;
          if (j < 0 || j >= mine.length) continue;
          sum += Math.abs(fp[k] - mine[j]); n++;
        }
        if (!n) continue;
        var d = sum * fp.length / n;         // 겹친 구간만 봤으니 길이로 되돌린다
        if (bestShift === null || d < bestShift) bestShift = d;
      }
      if (bestShift !== null && (!best || bestShift < best[0])) best = [Math.round(bestShift), e];
    }
    if (best && best[0] <= lim) {
      mapNameState.text = best[1].name;
      mapNameState.region = best[1].region || null;
      mapNameState.confident = true;
      mapNameState.reads += 1;
      out.text = best[1].name;
      out.confident = true;
      out.region = mapNameState.region;
      out.distance = best[0];
      out.source = 'table';
      return out;
    }
    out.distance = best ? best[0] : null;
  }

  if (unchanged) { out.source = 'kept_uncertain'; return out; }   // OCR 재시도는 무의미
  var crop = V.roi(mat, band[0], band[1], band[2], band[3]);
  if (!crop) { out.source = 'no_crop'; return out; }
  try {
    /* 두 줄(지역 이름 + 맵 이름) 중 **아래 줄**이 맵 이름이다. */
    var half = Math.max(8, Math.trunc(crop.rows / 2));
    var lower = V.roi(crop, 0, crop.rows - half, crop.cols, half);
    if (lower) {
      mapNameState.pending = true;
      ocrMapName(lower);
    }
  } finally { crop.delete(); }
  out.source = 'reading';
  return out;
}

function ocrMapName(crop) {
  var ocrK = new ASTRA.vision.OCR(engines.korean, engines.korean);
  ocrK.line(crop).then(function (r) {
    crop.delete();
    var t = (r.text || '').trim();
    /* 신뢰도가 낮거나 빈 문자열이면 이전 이름을 지우지 않는다. */
    if (t && r.score >= 0.60) {
      mapNameState.text = t;
      mapNameState.region = null;       // OCR 로는 지역명을 따로 읽지 않는다
      mapNameState.confident = false;   // OCR 은 이 글꼴에서 체계적으로 틀린다
      mapNameState.reads += 1;
    }
  }, function () { try { crop.delete(); } catch (e) {} });
}

function aborted() { return !running; }

function analyse(mat, msg, meta) {
  var V = ASTRA.vision;
  if (role === 'exp') {
    var V2 = ASTRA.vision;
    var act = V2.expActivityRect(mat);
    var sig = V2.activitySignature(mat, act.rect);
    var frameSig = V2.frameSignature(mat);
    var validity = V2.frameValidity(mat);

    var dist = V2.signatureDistance(expPrev.sig, sig);
    var frameDist = V2.signatureDistance(expPrev.frame, frameSig);
    var frozen = frameDist !== null && frameDist <= FRAME_FREEZE_TOL;

    var changed = null, reason = 'first_frame';
    if (!validity.valid) { changed = null; reason = 'frame_' + validity.reason; }
    else if (dist === null) { changed = null; reason = 'no_previous'; }
    else if (frozen) { changed = null; reason = 'stream_frozen'; }
    else { changed = dist > EXP_CHANGE_TOL; reason = changed ? 'changed' : 'unchanged'; }

    expPrev = { sig: sig, frame: frameSig, at: msg.stamp };

    var activity = {
      changed: changed, reason: reason, distance: dist, frame_distance: frameDist,
      frozen: frozen, rect: act.rect, rect_source: act.source,
      observable: validity.valid && !frozen
    };

    // 숫자는 표시용. 실패해도 정체 판정에는 영향이 없다.
    if (!analyse._ocrAt || (msg.stamp * 1000 - analyse._ocrAt) > EXP_OCR_EVERY_MS) {
      analyse._ocrAt = msg.stamp * 1000;
      return expLocator.locate(mat, ocr).then(function (exp) {
        exp.glyph_reads = expLocator.glyphReads;
        exp.glyph_misses = expLocator.glyphMisses;
        exp.glyph_learned = expLocator.learned;
        analyse._lastExp = exp;
        return { experience: exp, activity: activity, exp_ocr_fresh: true };
      }, function () {
        return { experience: analyse._lastExp || null, activity: activity, exp_ocr_fresh: false };
      });
    }
    return Promise.resolve({ experience: analyse._lastExp || null, activity: activity,
                             exp_ocr_fresh: false });
  }
  if (role === 'buffs') {
    // FIX-10: report each buff as it is read, so the page shows fresh entries
    // instead of waiting 8-13 s for the whole grid.
    return buffs.classify(mat, null, {
      yieldEvery: 2,
      aborted: aborted,
      onItem: function (item, index, total) {
        post({ type: 'partial', kind: 'buff', item: item, index: index, total: total,
               frameId: msg.frameId, stamp: msg.stamp, calibration: meta.calibration });
      }
    }).then(function (list) { return { buffs: list, buffs_rejected: list.rejected || [] }; });
  }
  if (role === 'lie') {
    var mapInfo = readMapName(mat, msg.stamp, msg.minimapRect || null);
    return lie.observe(mat).then(function (r) {
      return { lie_detector: r, map_name: mapInfo };
    });
  }

  // hud
  var validity = V.frameValidity(mat);

  /* §5.4: the booster UI verdict goes out on its own, before any OCR. On the
     test machine this is one template match over a 683x250 window. */
  var boosterUi = booster.observe(mat, validity.valid);
  var visibility = V.buffVisibility(mat);
  post({
    type: 'partial', kind: 'booster',
    booster_ui: boosterUi,
    frame_valid: validity.valid, frame_reason: validity.reason,
    buff_visibility: visibility,
    frameId: msg.frameId, stamp: msg.stamp, calibration: meta.calibration
  });

  // A run of PRESENT frames is one sighting; anything else ends it.
  if (boosterUi.presence !== 'PRESENT') {
    boosterSync = { done: false, value: null, raw: null, reason: 'ui_not_present' };
  }

  var out = {
    frame_valid: validity.valid,
    frame_reason: validity.reason,
    buff_visibility: visibility,
    booster_ui: boosterUi,
    minimap_bbox: null,
    rune: null,
    rune_duration: null,
    wealth: null,
    rune_cooldown: null,
    booster_sync: null,
    rune_duration_status: runeDuration.status()
  };

  var mm = minimapLock.locate(mat, msg.stamp);
  var minimap = mm.bbox;
  out.minimap_bbox = minimap;
  out.minimap_source = mm.source;
  out.minimap_searches = minimapLock.searches;
  /* 룬은 순수 미니맵이 아니라 **미니맵 UI 전체**에서 찾는다
     (사용자 지시 2026-09-07). 패널을 못 찾으면 안쪽 상자로 되돌아간다. */
  var ui = minimap ? ASTRA.vision.minimapUiRect(mat, minimap) : null;
  out.minimap_ui_bbox = ui;
  out.minimap_name_bbox = ui ? ASTRA.vision.minimapNameRect(ui, minimap) : null;
  out.rune = rune.observe(mat, ui || minimap);

  // The rune duration is read on every hud frame so the reading that belongs
  // to a disappearance frame already exists when that frame turns out to be
  // one (§4.3.3). While no rune-duration label is identified this returns
  // UNKNOWN immediately and costs nothing.
  return Promise.resolve().then(function () {
    // Sync read: at most once per sighting, and never on the fast presence path.
    if (boosterSync.done || boosterUi.presence !== 'PRESENT') return null;
    return booster.readNumber(mat, boosterUi, ocr).then(function (r) {
      if (r.seconds !== null) {
        boosterSync = { done: true, value: r.seconds, raw: r.raw, reason: 'read' };
      } else {
        boosterSync = { done: false, value: null, raw: r.raw || null, reason: r.reason };
      }
      return null;
    }, function () { return null; });
  }).then(function () {
    out.booster_sync = {
      done: boosterSync.done, seconds: boosterSync.value,
      raw: boosterSync.raw, reason: boosterSync.reason
    };
    return runeDuration.observe(mat, visibility, msg.frameId);
  }).then(function (rd) {
    out.rune_duration = rd;
    if (aborted()) return [];
    /* 비약(P04)과 룬 쿨타임(U20)을 **한 번에** 찾는다.

       예전에는 classify 를 두 번 불렀는데, 그러면 윤곽 검출과 격자 구성을
       두 번씩 하게 된다. 두 라벨이 서로 다투는 일은 없으므로(서로 rival 이
       아니고 max_instances 도 1) 한 패스에서 같이 찾아도 결과가 달라지지
       않는다. 룬 쿨타임 아이콘은 룬이 발동 중이 아닐 때 '쿨타임인가 생성
       대기인가'를 가르는 데만 쓰고 알림에는 관여하지 않는다. */
    return buffs.classify(mat, ['P04', 'U20'], { yieldEvery: 0, aborted: aborted });
  }).then(function (list) {
    var byId = function (id) {
      for (var i = 0; i < (list ? list.length : 0); i++) {
        if (list[i].id === id) return list[i];
      }
      return null;
    };
    out.wealth = byId('P04');
    out.wealth_rejected = (list && list.rejected) || [];
    var c = byId('U20');
    out.rune_cooldown = c
      ? { present: true, remaining_seconds: c.remaining_seconds,
          raw: c.raw_number, match_score: c.match_score, bbox: c.bbox }
      : { present: false, remaining_seconds: null, raw: null,
          match_score: null, bbox: null };
    return out;
  });
}
