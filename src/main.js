/* Orchestration: share lifecycle, workers, judgement, rendering, recording.

   Structure (AGENT_HANDOFF.md §5.3): a worker result is judged the moment it
   arrives - validated against the current session and calibration, fed to the
   state machines, turned into events. requestAnimationFrame only draws. The
   2026-09-05 build ran every alert decision inside the rAF tick.

   Session discipline (§5.1): stopping terminates the workers and clears the
   judgement state; the next share gets a new sessionId and brand-new workers.
   Anything that arrives tagged with an older session or calibration is
   dropped, so a late result can neither alert nor pollute the new statistics.

   Booster (§4): the alert comes from ASTRA.state.BoosterUiState - the
   "남은시간" UI disappearing, plus a rune duration of 1분 50초 or more read on
   the frame where it disappeared. No booster time is measured, interpolated or
   predicted anywhere in this file. The 99 s readout on the booster card is
   ASTRA.display, a presentation-only countdown the user asked for on
   2026-09-06; it is not an input to any decision. */
(function () {
  'use strict';

  var A = window.ASTRA;
  var ROLES = ['exp', 'hud', 'buffs', 'lie'];
  var INTERVAL = { exp: 100, hud: 500, buffs: 2000, lie: 1000 };
  var FRESH = { exp: 3, hud: 3, buffs: 8, lie: 8 };      // seconds
  var STALE_FRAME_SECONDS = 0.5;
  var TIMER_HIDDEN_BELOW = 5;
  var WEALTH_DISPLAY_SECONDS = 1800;     // user-confirmed P04 duration
  var BOOSTER_DISPLAY_SECONDS = 99;
  /* 첫 판독 전에만 쓰는 명목 길이다. 첫 판독이 오면 그 값으로 다시 놓는다. */
  var RUNE_DURATION_DISPLAY_SECONDS = 600;
  var RUNE_COOLDOWN_DISPLAY_SECONDS = 3599;

  var capture = new A.Capture();
  var alerts = new A.Alerts();

  /* ---- session ---------------------------------------------------------- */

  var S = null;            // the live session, or null

  function newSession() {
    var id = 'S' + (newSession.counter = (newSession.counter || 0) + 1) + '-' + Date.now();
    return {
      id: id,
      calibrationId: 0,
      startedAt: performance.now(),
      running: false,
      shareEnded: false,
      frames: 0,               // frames counted for fps: exp results in THIS session
      lastGrabAt: 0,
      procTimes: [],
      results: {},             // role -> payload
      partials: {},            // role -> latest partial
      ready: {}, stage: {}, workerError: {}, fatal: {},
      processed: {},           // role -> last processed frame id
      exp: new A.state.ExperienceState(),
      // 정체 알림의 실제 주체. 숫자가 아니라 화면 변화를 본다.
      activity: new A.state.ExperienceActivity(),
      gates: { rune: new A.state.PresenceGate(3), lie_detector: new A.state.PresenceGate(6) },
      wealthLife: new A.state.BuffExpiry(TIMER_HIDDEN_BELOW),
      wealthTimer: new A.state.TimerState('wealth'),
      boosterUi: new A.state.BoosterUiState(),
      boosterDisplay: new A.display.DisplayCountdown({
        seconds: BOOSTER_DISPLAY_SECONDS, decimals: 2, overrunSeconds: 1, format: 'seconds'
      }),
      /* 스킬 아이콘 세 개는 같은 표시 규칙을 쓴다 (display.SkillTimer):
         화면 숫자로 타이머를 놓고, 숫자가 사라지는 마지막 5초는 타이머만으로
         5·4·3·2·1 을 세고, 0이 되어도 아이콘이 남아 있으면 서버 지연 문구를
         낸다. 판정에는 관여하지 않는다. */
      wealthTimerUi: new A.display.SkillTimer({
        seconds: WEALTH_DISPLAY_SECONDS, resolution: 60
      }),
      runeDurUi: new A.display.SkillTimer({
        seconds: RUNE_DURATION_DISPLAY_SECONDS, resolution: 1
      }),
      runeCoolUi: new A.display.SkillTimer({
        seconds: RUNE_COOLDOWN_DISPLAY_SECONDS, resolution: 60
      }),
      // Sticky presence for the presentation countdowns: a single missed
      // detection frame must not restart a 30-minute readout.
      booster: stickyPresence(2),
      wealth: stickyPresence(2),
      boosterSyncedSighting: null,
      liePosition: null,
      buffItems: {},           // id -> {item, at}
      events: [], timeline: [],
      boosterLog: [],
      reportErrors: 0,
      runeDurationStatus: null,
      lastResultAt: {}
    };
  }

  // P04's verified ceiling, so a 200분 / 250분 misread is refused outright.
  function armWealthTimer(sess) { sess.wealthTimer.maxSeconds = WEALTH_DISPLAY_SECONDS; }

  function stickyPresence(missesToDrop) { return new A.display.StickyPresence(missesToDrop); }

  var workers = {};
  var enabledRoles = { exp: true, hud: true, buffs: true, lie: true };

  /* ---- DOM -------------------------------------------------------------- */

  var el = {};
  ['status', 'shareInfo', 'calib', 'calibList', 'preview', 'expValue', 'expState', 'expRaw',
   'wealthValue', 'wealthMeta', 'boosterValue', 'boosterMeta', 'runeValue', 'runeMeta',
   'lieValue', 'lieMeta', 'buffBody', 'buffMeta', 'log', 'health', 'btnShare', 'btnStop',
   'btnSound', 'btnExport', 'chkBuffs', 'chkLie', 'fps', 'boosterState', 'runeDurationLine',
   'cropExp', 'rectExp', 'infoExp', 'srcExp',
   'cropRune', 'rectRune', 'infoRune', 'srcRune',
   'cropWealth', 'rectWealth', 'infoWealth', 'srcWealth',
   'cropBooster', 'rectBooster', 'infoBooster', 'srcBooster',
   'cropLie', 'rectLie', 'infoLie', 'srcLie', 'mapName'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  var COLOR = {
    exp: '#4fd1e0', rune: '#f06ad0', wealth: '#f0c05a',
    booster: '#5ad6a0', lie: '#f0864a', buffs: '#6aa9f0'
  };
  var STATIC = A.regions.compute(A.Capture.CLIENT_W, A.Capture.CLIENT_H);

  function now() { return performance.now() / 1000; }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(n, d) { return n === null || n === undefined ? '—' : Number(n).toFixed(d === undefined ? 2 : d); }
  function clock(sec) {
    var n = Math.max(0, Math.round(sec));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status ' + (kind || '');
  }

  function logLine(text, kind) {
    var row = document.createElement('div');
    row.className = 'logline ' + (kind || '');
    row.textContent = '[' + new Date().toLocaleTimeString('ko-KR') + '] ' + text;
    el.log.insertBefore(row, el.log.firstChild);
    while (el.log.childNodes.length > 240) el.log.removeChild(el.log.lastChild);
  }

  /* ---- workers ---------------------------------------------------------- */

  function spawn(sess, role) {
    var w = new Worker('src/worker.js');
    workers[role] = w;
    sess.ready[role] = false;
    sess.stage[role] = '시작';
    w.onmessage = function (ev) { onWorkerMessage(role, ev.data); };
    w.onerror = function (e) {
      if (!S || S !== sess) return;
      sess.workerError[role] = e.message || 'worker error';
      logLine(role + ' 워커 오류: ' + sess.workerError[role], 'bad');
    };
    w.postMessage({ type: 'init', role: role, sessionId: sess.id,
                    base: location.pathname.replace(/[^/]*$/, '') });
  }

  /* §5.1: the simple, certain restart path. Terminating leaves no loop to
     resurrect and no half-finished analysis that could alert into a session
     that has ended. */
  function killWorkers() {
    Object.keys(workers).forEach(function (role) {
      try { workers[role].postMessage({ type: 'stop' }); } catch (e) {}
      try { workers[role].terminate(); } catch (e) {}
      delete workers[role];
    });
  }

  function onWorkerMessage(role, m) {
    var sess = S;
    // §5.1: a message from a session that has ended changes nothing.
    if (!sess || !sess.running || m.session !== sess.id) return;

    if (m.type === 'status') { sess.stage[role] = m.stage; return; }
    if (m.type === 'ready') {
      sess.ready[role] = true; sess.stage[role] = 'ready';
      if (role === 'hud') {
        sess.runeDurationStatus = m.rune_duration_status;
        if (m.rune_duration_status !== 'ready') {
          logLine('룬 지속시간 버프가 등록/확인되지 않았습니다 (' + m.rune_duration_status +
                  ') — 부스터 소멸은 "종료 확인 불가"로 닫힙니다.', 'warn');
        }
      }
      if (role === 'lie' && m.lie_load_error) logLine('탐지기 자산: ' + m.lie_load_error, 'warn');
      logLine(role + ' 워커 준비 완료' + (m.matcher ? ' (탐지기 매칭: ' + m.matcher + ')' : ''), 'ok');
      return;
    }
    if (m.type === 'fatal') {
      sess.fatal[role] = m.error; sess.ready[role] = false;
      logLine(role + ' 워커 초기화 실패: ' + m.error, 'bad');
      return;
    }
    if (m.type === 'error') {
      sess.workerError[role] = m.error;
      logLine(role + ' 워커 예외(계속 실행): ' + m.error, 'warn');
      return;
    }
    if (m.type === 'need-frame') return serveFrame(sess, role);
    if (m.type === 'partial') return onPartial(sess, role, m);
    if (m.type === 'result') {
      delete sess.workerError[role];
      // §5.1: a result computed under a superseded calibration is discarded.
      if (m.calibration !== null && m.calibration !== undefined &&
          m.calibration !== sess.calibrationId) {
        sess.lastResultAt[role + ':dropped'] = now();
        return;
      }
      sess.results[role] = m.payload;
      sess.lastResultAt[role] = now();
      // Total latency from the frame being grabbed to the result being usable,
      // measured against one clock. `processing_ms` is the compute part; the
      // remainder is queueing plus transfer (§5.4).
      var latency = (now() - m.payload.stamp) * 1000;
      m.payload.latency_ms = Math.round(latency * 10) / 10;
      m.payload.overhead_ms = Math.round((latency - (m.payload.processing_ms || 0)) * 10) / 10;
      if (!sess.latency) sess.latency = {};
      var arr = sess.latency[role] || (sess.latency[role] = []);
      arr.push(m.payload.latency_ms);
      if (arr.length > 200) arr.shift();
      judge(sess, role, m.payload);
      return;
    }
  }

  function serveFrame(sess, role) {
    var w = workers[role];
    if (!w || !S || S !== sess) return;
    if (!sess.running || !enabledRoles[role]) { w.postMessage({ type: 'wait', ms: 300 }); return; }
    var t = performance.now();
    if (!sess.lastServed) sess.lastServed = {};
    var since = t - (sess.lastServed[role] || 0);
    if (since < INTERVAL[role]) { w.postMessage({ type: 'wait', ms: INTERVAL[role] - since }); return; }
    var f = capture.grab(role);
    if (!f) { w.postMessage({ type: 'wait', ms: 60 }); return; }
    sess.lastServed[role] = t;
    sess.lastGrabAt = t;
    /* lie 워커는 미니맵을 스스로 찾지 않고 hud 가 잠근 것을 받아 쓴다
       (워커마다 따로 찾으면 서로 다른 상자를 잡는다). */
    var hudRes = sess.results && sess.results.hud;
    w.postMessage({
      type: 'frame', bitmap: f.bitmap, frameId: f.frameId, stamp: f.stamp,
      sessionId: sess.id, calibrationId: sess.calibrationId, servedAt: t,
      minimapRect: (role === 'lie' && hudRes) ? hudRes.minimap_bbox : null
    }, [f.bitmap]);
  }

  /* ---- judgement (runs on result arrival, never in rAF) ------------------ */

  /* Alerts are held while the picture cannot be trusted: during calibration,
     while the share is dead, and while a worker is still coming up (§5.2). */
  function alertsHeld(sess) {
    if (!sess.running || sess.shareEnded) return 'share_inactive';
    if (calibrating) return 'calibrating';
    return null;
  }

  function emit(sess, type, extra) {
    var held = alertsHeld(sess);
    var entry = { at: new Date().toISOString(), t: now(), session: sess.id, type: type };
    Object.keys(extra || {}).forEach(function (k) { entry[k] = extra[k]; });
    if (held) {
      entry.suppressed = held;
      sess.events.push(entry);
      logLine('알림 보류(' + held + '): ' + alerts.describe(type), 'warn');
      return;
    }
    sess.events.push(entry);
    sess.lastAlert = entry;
    logLine('알림: ' + alerts.describe(type) +
      (extra && extra.disappearance_id ? ' [' + extra.disappearance_id + ']' : ''), 'alert');
    alerts.fire(type);
  }

  function onPartial(sess, role, m) {
    if (m.calibration !== null && m.calibration !== undefined && m.calibration !== sess.calibrationId) return;
    if (m.kind === 'booster') {
      // Fast path (§5.4): presence for the panel and for the presentation
      // countdown, with no OCR in front of it. The decision itself is made
      // from the full hud result, which carries the rune reading from the
      // same frame.
      sess.partials.booster = m;
      var p = m.booster_ui && m.booster_ui.presence;
      var on = sess.booster.update(p === 'PRESENT' ? true : (p === 'ABSENT' ? false : null));
      sess.boosterDisplay.sync(on, now(), sess.booster.sighting);
      if (!on) sess.boosterSyncedSighting = null;
      return;
    }
    if (m.kind === 'buff') {
      sess.buffItems[m.item.id + '@' + m.item.bbox.join(',')] = { item: m.item, at: now(), frame: m.frameId };
      return;
    }
  }

  function judge(sess, role, payload) {
    if (role === 'exp') return judgeExp(sess, payload);
    if (role === 'hud') return judgeHud(sess, payload);
    if (role === 'lie') return judgeLie(sess, payload);
    if (role === 'buffs') {
      sess.buffItems = {};
      (payload.buffs || []).forEach(function (b) {
        sess.buffItems[b.id + '@' + b.bbox.join(',')] = { item: b, at: now(), frame: payload.frame_id };
      });
      return;
    }
  }

  function judgeExp(sess, payload) {
    var exp = payload.experience;
    sess.frames += 1;                       // §6.4: fps counts this session only
    sess.procTimes.push(payload.processing_ms);
    if (sess.procTimes.length > 400) sess.procTimes.shift();

    /* 정체 알림: 화면이 변하는가만 본다 (2026-09-06 memo).
       OCR 결과는 아래에서 표시용으로만 갱신한다. */
    var act = payload.activity;
    if (act) {
      if (sess.activity.update({
        changed: act.changed, now: payload.stamp,
        observable: act.observable, reason: act.reason
      })) {
        emit(sess, 'experience_stalled', {
          idle_seconds: Math.round(sess.activity.idleSeconds * 10) / 10,
          value: exp && exp.confirmed ? exp.value : null,
          basis: 'exp_region_unchanged'
        });
      }
      sess.lastActivity = act;
    }
    // §6.1: an unconfirmed reading (edge contact, truncation mismatch, a sudden
    // loss of digits) is not an observation.
    var value = exp && exp.confirmed ? exp.value : null;
    if (exp && exp.value !== null && !exp.confirmed && exp.reject_reason) {
      if (sess._lastExpReject !== exp.reject_reason) {
        sess._lastExpReject = exp.reject_reason;
        logLine('경험치 판독 보류: ' + exp.reject_reason + ' (raw "' + (exp.raw || '') + '")', 'warn');
      }
    } else if (value !== null) { sess._lastExpReject = null; }
    // 값 추적은 화면 표시·기록용으로만 남긴다. 알림은 위의 활동 상태기계가 낸다.
    sess.exp.update(value, payload.stamp);
  }

  function judgeHud(sess, payload) {
    if (sess.processed.hud === payload.frame_id) return;    // duplicate delivery
    sess.processed.hud = payload.frame_id;

    var observable = payload.buff_visibility === 'observable';
    var t = payload.stamp;

    /* --- rune marker on the minimap (unrelated to the booster rule) --- */
    var rune = payload.rune || {};
    if (sess.gates.rune.update(rune.status === 'observed' ? rune.present : null, t)) {
      emit(sess, 'rune_appeared', {});
    }

    /* --- booster display sync (표시 전용, 판정과 무관) --- */
    var bs = payload.booster_sync;
    if (bs && bs.done && bs.seconds !== null &&
        sess.boosterSyncedSighting !== sess.booster.sighting &&
        sess.boosterDisplay.running()) {
      if (sess.boosterDisplay.syncTo(bs.seconds, now())) {
        sess.boosterSyncedSighting = sess.booster.sighting;
        logLine('부스터 표시 싱크: ' + fmt(bs.seconds, 2) + '초 (원문 "' + (bs.raw || '') +
                '") — 이후 자동 타이머', 'ok');
      }
    }

    /* --- potion (§6.2) --- */
    var wealth = payload.wealth || null;
    var wRemaining = null;
    if (wealth && wealth.remaining_seconds !== null) {
      var res = sess.wealthTimer.observe(wealth.remaining_seconds, t, wealth.resolution_seconds || 1);
      if (!res.accepted && res.reason !== 'no_reading') {
        logLine('비약 판독 거부(' + res.reason + '): ' + wealth.remaining_seconds + '초', 'warn');
      } else if (res.accepted) {
        wRemaining = wealth.remaining_seconds;
      }
    }
    // Absence only counts when the buff row was actually observable.
    var wealthSeen = wealth ? true : ((observable && payload.frame_valid) ? false : null);
    var wealthOn = sess.wealth.update(wealthSeen);

    /* 표시 타이머 세 개. 판정과는 완전히 분리돼 있다 — sess.wealth(위)는
       알림 판정용 sticky 이고 그대로 둔다. 아래는 화면에 보여줄 숫자만
       만든다.

       세 아이콘 모두 남은 시간이 5초 미만이면 게임이 숫자를 지운다. 그때는
       seconds 로 null 이 들어가고 타이머가 스스로 5·4·3·2·1 을 센 뒤,
       0에서도 아이콘이 남아 있으면 서버 지연 문구를 낸다
       (사용자 지시 2026-09-07, display.SkillTimer). */
    sess.wealthTimerUi.update(
      wealthSeen,
      wealth ? wealth.remaining_seconds : null,
      now());

    var rdObs = payload.rune_duration;
    sess.runeDurUi.update(
      !rdObs ? null : rdObs.iconPresence === 'PRESENT' ? true
        : rdObs.iconPresence === 'ABSENT' ? false : null,
      rdObs ? rdObs.observedSeconds : null,
      now());

    var rcObs = payload.rune_cooldown;
    sess.runeCoolUi.update(
      !rcObs ? null : !!rcObs.present,
      rcObs ? rcObs.remaining_seconds : null,
      now());

    /* 예전에는 여기서 wealthDisplay 를 직접 맞췄다. 그 규칙이 display.SkillTimer
       로 옮겨갔다 — 세 아이콘이 똑같은 문제를 갖는데 규칙이 흩어져 있으면
       어긋나고, 브라우저 없이 시험할 수도 없었기 때문이다. 실제로 "끊겼다
       돌아왔을 때 초를 지킨다"(사용자 보고 2026-09-07)는 옛 코드에서 **죽은
       분기**였다: stop() 이 syncedAt 을 지우므로 재연결 시 disp.synced() 가
       늘 false 라 그 가지에 들어갈 수 없었다. 지금은 끊기기 직전 값을 따로
       들고 있다가 같은 분이면 이어 붙인다 (state_tests 로 검증). */

    /* 아이콘 존재는 **한 프레임 값이 아니라 sticky 판정**을 쓴다.

       마지막 5초는 게임이 숫자를 지우므로 판독이 없다. 그 구간에서는 아이콘
       존재만이 유일한 근거인데, 정합이 한 프레임 흔들려 iconPresent 가
       false 로 튀면 BuffExpiry 가 "설명 없는 소멸" 로 수명을 닫아 버리고
       (closed=true, 기억한 잔여 삭제) 그 뒤로는 영영 알림이 나오지 않는다.
       판독이 없으니 closed 를 풀 기회도 없다.

       sess.wealth 는 stickyPresence(2) 라 두 프레임까지의 결손을 흡수한다.
       화면 표시에는 이미 이 값을 쓰고 있었고, 판정만 날것을 쓰고 있었다. */
    if (sess.wealthLife.update({
      iconPresent: wealthOn === null ? (wealth !== null) : wealthOn,
      remaining: wRemaining,
      now: t,
      observable: observable && payload.frame_valid
    })) emit(sess, 'wealth_expired', { reason: sess.wealthLife.reason });

    /* --- booster: UI presence only (§4) --- */
    var obs = boosterObservation(sess, payload);
    var r = sess.boosterUi.update(obs);
    if (r.decision) recordBoosterDecision(sess, r.decision, payload);
    if (r.event) emit(sess, 'booster_expired', r.event);
  }

  /* Turn a hud payload into a BoosterUiObservation (§4.2). Everything that
     makes absence unprovable - a dead share, a stale frame, a calibration
     change, an invalid surface - collapses to UNKNOWN here, in one place. */
  function boosterObservation(sess, payload) {
    var ui = payload.booster_ui || { presence: 'UNKNOWN', reason: 'no_booster_result' };
    var base = {
      sessionId: sess.id, calibrationId: payload.calibration,
      frameId: payload.frame_id, capturedAt: payload.stamp,
      score: ui.score === undefined ? null : ui.score,
      bbox: ui.bbox || null,
      rune: payload.rune_duration || null
    };
    var gated = A.state.gateObservation({
      presence: ui.presence,
      reason: ui.reason,
      shareInactive: !sess.running || sess.shareEnded,
      calibrating: calibrating,
      calibrationMismatch: payload.calibration !== sess.calibrationId,
      frameValid: payload.frame_valid,
      frameReason: payload.frame_reason,
      ageSeconds: now() - payload.stamp,
      maxAgeSeconds: FRESH.hud
    });
    base.presence = gated.presence;
    base.reason = gated.reason;
    return base;
  }

  function recordBoosterDecision(sess, d, payload) {
    var line = { at: new Date().toISOString(), t: now(), frame: payload ? payload.frame_id : null };
    Object.keys(d).forEach(function (k) { line[k] = d[k]; });
    sess.boosterLog.push(line);
    if (sess.boosterLog.length > 400) sess.boosterLog.shift();
    if (d.outcome === 'duplicate_frame') return;      // not worth a log line
    var kind = d.outcome === 'alerted' ? 'alert'
      : d.outcome === 'unverifiable' ? 'warn' : '';
    var text = '부스터 ' + (d.disappearance_id || '') + ' · ' + d.outcome +
      (d.rune_seconds !== undefined && d.rune_seconds !== null
        ? ' · 룬 ' + clock(d.rune_seconds) + ' (' + d.rune_from + ')' : '') +
      (d.reason ? ' · ' + d.reason : '');
    logLine(text, kind);
  }

  function judgeLie(sess, payload) {
    if (sess.processed.lie === payload.frame_id) return;
    sess.processed.lie = payload.frame_id;
    var ld = payload.lie_detector || {};
    // §6.3: consecutive confirmation must be about the same candidate position.
    var box = ld.candidate_bbox || null;
    var samePlace = true;
    if (ld.present && box) {
      if (sess.liePosition) {
        samePlace = Math.abs(sess.liePosition[0] - box[0]) < 160 &&
                    Math.abs(sess.liePosition[1] - box[1]) < 160;
      }
      if (!samePlace) sess.gates.lie_detector.reset();
      sess.liePosition = box;
    } else if (!ld.present) {
      sess.liePosition = null;
    }
    var present = ld.status === 'observed' ? ld.present : null;
    if (sess.gates.lie_detector.update(present, payload.stamp)) {
      emit(sess, 'lie_detector_appeared', { reason: ld.reason, bbox: box });
    }
  }

  /* ---- diagnostics (§6.4) ----------------------------------------------- */

  function observerState(sess) {
    if (!sess) return { kind: 'idle', text: '공유 전 — “화면 공유 시작”을 누르세요', css: '' };
    if (sess.shareEnded) return { kind: 'share_ended', text: '공유 중단됨', css: 'bad' };
    if (!sess.running) return { kind: 'stopped', text: '중지됨', css: '' };
    var fatal = ROLES.filter(function (r) { return enabledRoles[r] && sess.fatal[r]; });
    if (fatal.length) return { kind: 'worker_error', text: '워커 초기화 실패: ' + fatal.join(', '), css: 'bad' };
    var booting = ROLES.filter(function (r) { return enabledRoles[r] && !sess.ready[r]; });
    if (booting.length) {
      return { kind: 'initializing', css: 'warn',
               text: '초기화 중 — ' + booting.map(function (r) { return r + '(' + (sess.stage[r] || '대기') + ')'; }).join(' ') };
    }
    if (calibrating) return { kind: 'calibrating', text: '보정 중 — 알림 보류', css: 'warn' };
    var gap = (performance.now() - sess.lastGrabAt) / 1000;
    if (sess.lastGrabAt && gap > STALE_FRAME_SECONDS) {
      return { kind: 'no_capture', css: 'warn',
               text: '새 캡처 없음 ' + fmt(gap, 1) + '초 — 최소화/절전/프레임 유실 확인' };
    }
    var late = ROLES.filter(function (r) {
      return enabledRoles[r] && sess.results[r] && (now() - sess.results[r].stamp) > FRESH[r];
    });
    if (late.length) {
      return { kind: 'analysis_delayed', css: 'warn', text: '분석 지연: ' + late.join(', ') };
    }
    var hud = sess.results.hud;
    if (hud && hud.buff_visibility === 'obscured') {
      return { kind: 'obscured', css: 'warn', text: '정상 / 게임 내 툴팁으로 버프 영역 가림 — 버프 판정 보류' };
    }
    if (hud && hud.frame_valid === false) {
      return { kind: 'unobservable', css: 'warn', text: '관측 불가: ' + hud.frame_reason };
    }
    return { kind: 'normal', text: '정상', css: 'ok' };
  }

  /* ---- rendering (§5.3: drawing only) ------------------------------------ */

  var rafHandle = null, lastDraw = 0;

  function renderLoop(ts) {
    rafHandle = requestAnimationFrame(renderLoop);
    if (ts - lastDraw < 66) return;                 // ~15 fps of UI
    lastDraw = ts;
    try { render(); } catch (e) { if (S) S.reportErrors += 1; }
  }

  function render() {
    var sess = S;
    var st = observerState(sess);
    setStatus(st.text, st.css);
    if (!sess) { renderCrops(null, null, null, null); return; }

    var t = now();
    var exp = fresh(sess, 'exp') ? sess.results.exp.experience : null;
    var hud = fresh(sess, 'hud') ? sess.results.hud : null;
    var lie = fresh(sess, 'lie') ? sess.results.lie : null;
    var buffList = Object.keys(sess.buffItems)
      .map(function (k) { return sess.buffItems[k]; })
      .filter(function (e) { return t - e.at < FRESH.buffs + 4; })
      .sort(function (a, b) {
        var A1 = a.item.bbox, B1 = b.item.bbox;
        var ra = Math.floor(A1[1] / 12), rb = Math.floor(B1[1] / 12);
        return ra !== rb ? ra - rb : A1[0] - B1[0];
      });

    renderExperience(sess, exp, st);
    renderWealth(sess, hud, t);
    renderBooster(sess, hud, t);
    renderRune(sess, hud, t);
    renderMapName(sess, lie);
    renderLie(sess, lie, t);
    renderBuffs(sess, buffList, t);
    renderFps(sess);
    renderCrops(sess, exp, hud, lie);
    renderHealth(sess);
    recordTimeline(sess, st, exp, hud, lie, buffList.length);
  }

  function fresh(sess, role) {
    var r = sess.results[role];
    return !!(r && now() - r.stamp < FRESH[role]);
  }

  function renderExperience(sess, exp, st) {
    var confirmed = exp && exp.confirmed;
    // §6.1: an unknown or stale reading is never shown as a normal observation.
    /* 사용자 요청 2026-09-07: 백분율까지 텍스트로 보여준다.
       판독 원문에 "…[88.757%]" 형태로 들어 있으므로 거기서 꺼낸다. 원문이
       없거나 백분율이 빠졌으면 숫자만 보여준다 — 없는 값을 지어내지 않는다. */
    var pct = null;
    if (confirmed && exp && exp.raw) {
      /* 진짜 '%' 만 인정한다. parse 의 문법은 OCR 이 %를 8로 읽는 경우까지
         관용하지만([%8]), 그 관용을 여기에 그대로 쓰면 숫자 안쪽의 8이 걸려
         엉뚱한 값이 나온다 — "83.874.301.109.098[76.623%]" 에서 109.09 를
         뽑아냈다. 백분율이 안 보이면 숫자만 보여준다. 없는 값을 짓지 않는다. */
      var pm = /(\d{1,3}[.,]\d{1,3})\s*%/.exec(exp.raw);
      if (pm) pct = pm[1].replace(',', '.');
    }
    el.expValue.textContent = confirmed && exp.value
      ? A.parse.formatExp(exp.value) + (pct ? '  [' + pct + '%]' : '')
      : (exp ? '판독 보류' : (st.kind === 'normal' ? '읽기 불확실' : '대기'));
    var a = sess.activity;
    el.expState.textContent = a.status;
    el.expState.className = 'badge ' + (a.status === 'STALLED' ? 'bad'
      : a.status === 'TRACKING' ? 'ok' : 'warn');
    var act = sess.lastActivity;
    var actLine = '활동: ' + a.status +
      (act ? ' · ' + act.reason + (act.distance !== null ? ' (변화량 ' + act.distance + ')' : '') : '') +
      ' · 무변화 ' + fmt(a.idleSeconds, 1) + '초/' + a.stallSeconds + '초' +
      ' · 변화 ' + a.changes + '회' +
      (act && act.rect_source ? ' · 영역 ' + act.rect_source : '');
    if (!exp) { el.expRaw.textContent = actLine + '\n숫자: 대기 (표시용)'; return; }
    var line = (exp.raw || '—') + '  (신뢰도 ' + fmt(exp.score, 3) + ')'
      + '  ROI ' + (exp.roi_source || '—') + (exp.roi_locked ? '·고정' : '')
      + ' [' + (exp.bbox || []).join(',') + ']'
      + '  잘림검사 ' + (exp.truncation || '—')
      + (exp.confirmed ? '  근거 ' + (exp.accept_route === 'crop_agreement'
          ? '크롭 ' + (exp.agreeing_crops || 2) + '개 일치' : '단독 신뢰도') : '')
      + (exp.reject_reason ? '  보류사유 ' + exp.reject_reason : '');
    // §6.4: when nothing was confirmed, say what was actually read and why it
    // was refused, instead of showing an empty string.
    if (!exp.confirmed && exp.best_raw) {
      line += '\n최고 후보: "' + exp.best_raw + '" 신뢰도 ' + fmt(exp.best_score, 3) +
        ' @ [' + (exp.best_rect || []).join(',') + '] · 문법 ' +
        (exp.best_parsed ? '통과(' + exp.best_parsed + ')' : '불일치') +
        ' · 시도 ' + (exp.tried ? exp.tried.length : 0) + '개';
    }
    el.expRaw.textContent = actLine + '\n숫자(표시용): ' + line;
  }

  function renderWealth(sess, hud, t) {
    var wealth = hud ? hud.wealth : null;
    var life = sess.wealthLife;
    var disp = sess.wealthTimerUi;
    // Presentation countdown (user request 2026-09-06): starts the moment the
    // P04 icon is seen, ticks in whole seconds, and turns into the waiting text
    // if the icon is still there after 1800 s.
    var text = disp.text(t);
    if (text !== null) {
      el.wealthValue.textContent = text;
    } else if (life.status === 'ENDED') {
      el.wealthValue.textContent = '종료';
    } else {
      el.wealthValue.textContent = hud ? '표시 없음' : '대기';
    }
    var observed = sess.wealthTimer.read(t);
    var parts = [];
    parts.push('표시 타이머 ' + disp.state(t) +
      (disp.synced() ? ' · 싱크 ' + clock(disp.syncedTo) + ' ×' + disp.syncs : ' · 싱크 대기'));
    parts.push('아이콘 ' + (wealth ? '있음' : (hud ? '없음' : '—')) +
      (wealth ? ' 정합 ' + fmt(wealth.match_score, 3) +
        (wealth.rival_margin !== null && wealth.rival_margin !== undefined
          ? ' 판별 ' + fmt(wealth.rival_self, 3) + '>' + fmt(wealth.rival_other, 3) : '') : ''));
    if (wealth) {
      parts.push('화면숫자 ' + (wealth.raw_number || '—') +
        (wealth.remaining_seconds !== null ? ' → ' + clock(wealth.remaining_seconds) : '') +
        (wealth.reject_reason ? ' (거부 ' + wealth.reject_reason + ')' : '') +
        (wealth.verified ? ' · 마스크 일치' : ''));
    }
    if (observed.remaining_seconds !== null) {
      parts.push('검증 관측 ' + clock(observed.remaining_seconds) + ' (' + observed.source + ')');
    }
    parts.push('수명 ' + life.status + (life.reason ? '·' + life.reason : ''));
    if (life.status === 'FINAL_SECONDS') parts.push(TIMER_HIDDEN_BELOW + '초 미만 — 숫자 미표시 구간');
    el.wealthMeta.textContent = parts.join(' / ');
  }

  function renderBooster(sess, hud, t) {
    var partial = sess.partials.booster;
    var ui = partial ? partial.booster_ui : (hud ? hud.booster_ui : null);
    var m = sess.boosterUi;
    var disp = sess.boosterDisplay;

    // Presentation countdown (user request 2026-09-06): 99.00 s from the moment
    // the UI is detected, then "서버 지연 대기중 . . ." if the UI is still
    // there. Nothing here feeds the alert.
    var text = disp.text(t);
    el.boosterValue.textContent = text !== null ? text
      : (ui && ui.presence === 'ABSENT' ? 'UI 없음'
        : ui && ui.presence === 'UNKNOWN' ? '관측 불가' : '대기');

    var d = m.describe();
    var parts = [];
    parts.push('UI ' + (ui ? ui.presence : '—') +
      (ui && ui.score !== null && ui.score !== undefined ? ' (앵커 ' + fmt(ui.score, 3) + '/0.78)' : '') +
      (ui && ui.reason ? ' · ' + ui.reason : ''));
    parts.push('상태 ' + d.state + (d.reason ? '·' + d.reason : ''));
    if (d.disappearance_id) parts.push('소멸건 ' + d.disappearance_id + ' 재판독 ' + d.rune_retries + '회');
    if (d.last_decision) {
      parts.push('최근 판정 ' + d.last_decision.outcome +
        (d.last_decision.rune_seconds !== undefined && d.last_decision.rune_seconds !== null
          ? ' · 룬 ' + clock(d.last_decision.rune_seconds) : '') +
        (d.last_decision.reason ? ' · ' + d.last_decision.reason : ''));
    }
    parts.push('표시 타이머 ' + disp.state(t) +
      (disp.synced() ? ' · 싱크 ' + fmt(disp.syncedTo, 2) + '초' : ' · 싱크 대기') + ' (판정과 무관)');
    el.boosterMeta.textContent = parts.join(' / ');
    if (el.boosterState) el.boosterState.textContent = d.state;

    if (el.runeDurationLine) {
      var rd = hud ? hud.rune_duration : null;
      el.runeDurationLine.textContent = !rd
        ? '룬 지속시간: 대기'
        : '룬 지속시간: ' + rd.iconPresence +
          (rd.rawText ? ' · 원문 "' + rd.rawText + '"' : '') +
          (rd.observedSeconds !== null ? ' · ' + clock(rd.observedSeconds) +
             ' (' + rd.observedSeconds + '초, 기준 110초)' : '') +
          (rd.reason ? ' · ' + rd.reason : '') +
          (sess.runeDurationStatus && sess.runeDurationStatus !== 'ready'
            ? ' · 등록상태 ' + sess.runeDurationStatus : '');
    }
  }

  function renderMapName(sess, lie) {
    if (!el.mapName) return;
    var m = lie ? lie.map_name : null;
    /* 한 번 읽은 이름은 유지한다. 판독이 잠깐 실패했다고 화면에서 지우면
       사냥터가 바뀐 것처럼 보인다. 이름은 맵을 옮길 때만 바뀐다. */
    if (m && m.text) {
      sess.mapName = m.text;
      sess.mapConfident = !!m.confident;
      sess.mapRegion = m.region || null;
    }
    /* 표에서 찾은 이름은 사람이 적은 값이라 그대로, OCR 추정은 '(추정)'을
       붙인다. 한국어 모델이 이 글꼴에서 확신을 갖고 틀리기 때문에
       (실측: "어둠이"->"머둠미", 신뢰도 0.97) 구분해서 보여야 한다. */
    /* 지역명도 함께 보여준다 (사용자 지시 2026-09-07: "'카르시온' 이라는
       텍스트도 떠야한다"). 표에서 찾은 경우에만 있다 — OCR 은 지역명을
       "카르시폰" 으로 읽어 신뢰할 수 없다. */
    el.mapName.textContent = sess.mapName
      ? ('사냥터: ' + (sess.mapRegion ? sess.mapRegion + ' · ' : '') + sess.mapName +
         (sess.mapConfident ? '' : ' (추정)'))
      : '사냥터: 확인 중';
  }

  function renderRune(sess, hud, t) {
    var rune = hud ? hud.rune : null;
    /* 세 가지 상태를 구분해 보여준다 (사용자 지시 2026-09-07).

         룬 발동 중   - 룬 지속시간 버프가 화면에 있다 (U13/U19)
         룬 쿨타임    - 발동 중은 아니고 쿨타임 아이콘이 있다
         룬 생성 대기 - 둘 다 아니다

       미니맵의 룬 표식(rune.present)은 '맵에 룬이 떴다'는 별개의 정보라
       괄호로 덧붙인다. */
    var rd = hud ? hud.rune_duration : null;
    var cd = hud ? hud.rune_cooldown : null;
    var marker = !rune ? null
      : rune.status !== 'observed' ? '판정 불가'
      : rune.present ? '맵에 룬 있음' : '맵에 룬 없음';
    /* 시간은 **표시 타이머**에서 가져온다. 화면 숫자를 그대로 쓰면 남은
       시간이 5초 미만일 때 게임이 숫자를 지우므로 시간이 통째로 사라진다.
       타이머는 마지막 판독으로 놓인 뒤 스스로 5·4·3·2·1 을 세고, 0에서도
       아이콘이 남아 있으면 "서버 지연 대기중 ." 을 0.5초마다 돌린다
       (사용자 지시 2026-09-07). */
    var state;
    if (rd && rd.iconPresence === 'PRESENT') {
      var durText = sess.runeDurUi.text(t);
      state = '룬 발동 중' + (durText ? ' · ' + durText : '');
    } else if (cd && cd.present) {
      var coolText = sess.runeCoolUi.text(t);
      state = '룬 쿨타임' + (coolText ? ' · ' + coolText : '');
    } else if (!hud) {
      state = '대기';
    } else {
      state = '룬 생성 대기중';
    }
    el.runeValue.textContent = state + (marker ? '  (' + marker + ')' : '');
    el.runeMeta.textContent = (rune && rune.score !== undefined
      ? '정합 ' + fmt(rune.score, 3) + ' / 색상 화소 ' + (rune.colored || 0) : '—') +
      ' · 지속 ' + sess.runeDurUi.state(t) + ' · 쿨타임 ' + sess.runeCoolUi.state(t);
  }

  function renderLie(sess, lie, t) {
    var ld = lie ? lie.lie_detector : null;
    el.lieValue.textContent = !ld ? '대기'
      : ld.status !== 'observed' ? '관측 불가'
      : ld.present ? '등장' : '없음';
    el.lieMeta.textContent = ld
      ? (ld.reason || '—') +
        (ld.evidence && ld.evidence.length
          ? ' · ' + ld.evidence.map(function (e) { return e.method; }).join(', ') : '') +
        (ld.weak_evidence && ld.weak_evidence.length ? ' · 약한근거 ' + ld.weak_evidence.length + '건' : '') +
        (ld.dropped && ld.dropped.length ? ' · 제외 ' + ld.dropped.length + '건' : '') +
        ' / 결과 나이 ' + fmt(t - lie.stamp, 1) + '초'
      : '—';
  }

  function renderBuffs(sess, buffList, t) {
    var latest = sess.results.buffs;
    el.buffMeta.textContent = buffList.length
      ? buffList.length + '개 · 항목별 갱신 (최근 전체 ' +
        (latest ? fmt(t - latest.stamp, 1) + '초 전' : '진행 중') + ')'
      : (enabledRoles.buffs ? '판독 불가' : '비활성');
    var rows = buffList.map(function (e) {
      var b = e.item, display;
      if (b.remaining_seconds === null) {
        display = b.time_mode === 'stack' ? '스택 — 시간 아님'
          : b.reject_reason ? '보류 (' + b.reject_reason + ')' : '표시 없음 / 미확인';
      } else {
        display = b.resolution_seconds === 60 ? Math.floor(b.remaining_seconds / 60) + '분'
          : clock(b.remaining_seconds);
      }
      var age = t - e.at;
      return '<tr><td>' + esc(b.id) + '</td><td>' + esc(b.name || '이름 미확인') + '</td><td>' +
        esc(display) + '</td><td>' + esc(b.raw_number || '—') + '</td><td>' +
        (age > FRESH.buffs ? '<span class="dim">이전 판독 ' + fmt(age, 1) + '초</span>'
          : fmt(age, 1) + '초 전') + '</td></tr>';
    }).join('');
    el.buffBody.innerHTML = rows || '<tr><td colspan="5" class="dim">—</td></tr>';
  }

  function renderFps(sess) {
    // §6.4: numerator and denominator both belong to this session.
    var elapsed = (performance.now() - sess.startedAt) / 1000;
    var mean = sess.procTimes.length
      ? sess.procTimes.reduce(function (a, b) { return a + b; }, 0) / sess.procTimes.length : 0;
    var expAge = sess.results.exp ? now() - sess.results.exp.stamp : null;
    var stalled = expAge !== null && expAge > FRESH.exp;
    el.fps.textContent = (stalled ? '처리 정지 — ' : '') +
      fmt(sess.frames / Math.max(1, elapsed), 1) + ' fps · 경험치 처리 ' + fmt(mean, 0) + 'ms' +
      ' · 세션 ' + sess.id + ' · 보정 #' + sess.calibrationId +
      ' · 프레임 ' + sess.frames;
  }

  /* ---- per-detector crop views ------------------------------------------ */

  var CROPS = [
    ['exp', 'cropExp', 'rectExp', 'infoExp', 'srcExp', 'exp'],
    ['rune', 'cropRune', 'rectRune', 'infoRune', 'srcRune', 'hud'],
    ['wealth', 'cropWealth', 'rectWealth', 'infoWealth', 'srcWealth', 'hud'],
    ['booster', 'cropBooster', 'rectBooster', 'infoBooster', 'srcBooster', 'hud'],
    ['lie', 'cropLie', 'rectLie', 'infoLie', 'srcLie', 'lie']
  ];

  function renderCrops(sess, exp, hud, lie) {
    var plans = A.regions.cropPlan(STATIC, exp, hud, lie, now());
    CROPS.forEach(function (c) {
      var plan = plans[c[0]];
      var canvas = el[c[1]];
      // §6.4: draw from the frame the result was computed on, not from live
      // video through an old bbox.
      var view = capture.drawClientRegion(canvas, plan.rect, c[5]);
      if (view && plan.sub && plan.sub.length) {
        var g = canvas.getContext('2d');
        g.lineWidth = 1.5;
        plan.sub.forEach(function (s) {
          g.strokeStyle = COLOR[s.owner] || '#ffffff';
          g.strokeRect((s.rect[0] - view.origin[0]) * view.scale + view.ox + 0.5,
                       (s.rect[1] - view.origin[1]) * view.scale + view.oy + 0.5,
                       s.rect[2] * view.scale, s.rect[3] * view.scale);
        });
      }
      var frameOf = capture.frameIdOf(c[5]);
      var resultFrame = sess && sess.results[c[5]] ? sess.results[c[5]].frame_id : null;
      el[c[2]].textContent = plan.rect.map(Math.round).join(', ') +
        '   ' + Math.round(plan.rect[2]) + '×' + Math.round(plan.rect[3]) + 'px' +
        (frameOf ? '   frame#' + frameOf + (resultFrame && resultFrame !== frameOf
          ? ' (결과 frame#' + resultFrame + ')' : ' ✓') : '');
      el[c[3]].textContent = plan.info;
      el[c[4]].textContent = plan.src;
    });
  }

  function renderHealth(sess) {
    var parts = ROLES.map(function (role) {
      if (!enabledRoles[role]) return role + ': 꺼짐';
      if (sess.fatal[role]) return role + ': 초기화실패';
      if (sess.workerError[role]) return role + ': 오류';
      if (!sess.ready[role]) return role + ': ' + (sess.stage[role] || '대기');
      var r = sess.results[role];
      if (!r) return role + ': 결과 없음';
      var age = now() - r.stamp;
      return role + ': 처리' + Math.round(r.processing_ms) + 'ms' +
        '+대기' + Math.round(r.overhead_ms === undefined ? 0 : r.overhead_ms) + 'ms' +
        ' / 나이' + fmt(age, 1) + 's' + (age > FRESH[role] ? '(지연)' : '');
    });
    if (sess.reportErrors) parts.push('기록 오류 ' + sess.reportErrors + '회');
    el.health.textContent = parts.join('  |  ');
  }

  function recordTimeline(sess, st, exp, hud, lie, buffCount) {
    try {
      var last = sess.timeline[sess.timeline.length - 1];
      var t = Math.round(now() * 10) / 10;
      if (last && last.t === t) return;
      sess.timeline.push({
        t: t, health: st.kind,
        exp: exp && exp.confirmed ? exp.value : null,
        exp_score: exp ? exp.score : null,
        exp_reject: exp ? exp.reject_reason : null,
        state: sess.exp.status,
        buff_count: buffCount || null,
        vis: hud ? hud.buff_visibility : null,
        wealth_life: { status: sess.wealthLife.status, reason: sess.wealthLife.reason },
        booster_ui: hud && hud.booster_ui ? hud.booster_ui.presence : null,
        booster_state: sess.boosterUi.state,
        rune_duration: hud ? hud.rune_duration : null,
        rune: hud ? hud.rune : null,
        lie: lie ? lie.lie_detector : null
      });
      if (sess.timeline.length > 20000) sess.timeline.shift();
    } catch (e) {
      sess.reportErrors += 1;
    }
  }

  /* ---- calibration (§5.2) ----------------------------------------------- */

  var candidates = [], candidateIndex = 0, probeUntil = 0, calibrating = false;
  var calibStartedFor = -1;
  var candidateScores = [];
  /* Each candidate gets this long to prove itself.

     Measured 2026-09-06: the experience path runs at ~1.6 fps on the test
     machine and does not confirm on every frame, so a 3 s window was a race
     the correct candidate could lose - it did, on one run out of three. 7 s
     gives roughly ten attempts per candidate. */
  var CANDIDATE_PROBE_MS = 7000;

  function requiredReady(sess) {
    return sess && sess.ready.exp && sess.ready.hud;
  }

  function startCalibration(sess) {
    candidates = capture.candidates();
    candidateIndex = 0;
    candidateScores = candidates.map(function () { return { score: 0, notes: [], raw: null }; });
    calibrating = true;
    calibStartedFor = -1;
    el.calib.textContent = '워커 준비를 기다리는 중… (준비 전에는 후보를 평가하지 않습니다)';
    el.calib.className = 'calib';
    renderCandidates();
  }

  function applyCandidate(sess) {
    var c = candidates[candidateIndex];
    capture.setRect(c);
    bumpCalibration(sess, '후보 ' + (candidateIndex + 1));
    probeUntil = performance.now() + CANDIDATE_PROBE_MS;
    calibStartedFor = sess.calibrationId;
    el.calib.textContent = '보정 후보 ' + (candidateIndex + 1) + '/' + candidates.length +
      ': ' + (c.why || '수동') + '  [' + c.x + ',' + c.y + ' ' + c.w + 'x' + c.h + ']';
    el.calib.className = 'calib';
  }

  /* §5.2: a region change invalidates every locked ROI and every presence /
     timer state, and gets a new calibrationId so older results are dropped. */
  function bumpCalibration(sess, why) {
    sess.calibrationId += 1;
    sess.results = {};
    sess.partials = {};
    sess.buffItems = {};
    sess.processed = {};
    sess.exp = new A.state.ExperienceState();
    sess.gates.rune.reset();
    sess.gates.lie_detector.reset();
    sess.liePosition = null;
    sess.wealthLife.reset();
    sess.activity.reset();
    sess.wealthTimer.reset();
    armWealthTimer(sess);
    sess.boosterUi.interrupt('calibration_changed');
    sess.boosterDisplay.stop(); sess.booster.reset();
    sess.wealthTimerUi.reset(); sess.wealth.reset();
    sess.runeDurUi.reset(); sess.runeCoolUi.reset();
    logLine('보정 변경 #' + sess.calibrationId + ' (' + why + ') — 잠금 ROI와 상태 초기화', 'warn');
  }

  /* Grammar alone was not enough on 2026-09-05: a crop that cut off the leading
     digits still parsed. Success now needs a confirmed (non-truncated) reading
     produced under the current calibration, plus HUD layout evidence. */
  function calibrationEvidence(sess) {
    var e = sess.results.exp;
    var hud = sess.results.hud;
    var okExp = !!(e && e.calibration === sess.calibrationId &&
                   e.experience && e.experience.confirmed && e.experience.value);
    var hudSigns = 0, notes = [];
    if (hud && hud.calibration === sess.calibrationId) {
      if (hud.minimap_bbox) { hudSigns++; notes.push('미니맵'); }
      if (hud.buff_visibility === 'observable') { hudSigns++; notes.push('버프영역'); }
      if (hud.frame_valid) { hudSigns++; notes.push('유효화면'); }
    }
    // How close this candidate came, so a failed sweep can still pick the best
    // one instead of leaving whatever happened to be last.
    var parsedEver = !!(e && e.calibration === sess.calibrationId && e.experience &&
                        (e.experience.value || e.experience.best_parsed));
    var score = (okExp ? 4 : 0) + (parsedEver ? 2 : 0) + hudSigns;
    return { ok: okExp && hudSigns >= 2, exp: okExp, parsed: parsedEver,
             hudSigns: hudSigns, notes: notes, score: score,
             raw: okExp ? e.experience.raw
                : (e && e.experience ? e.experience.best_raw : null) };
  }

  function calibrationWatch() {
    var sess = S;
    if (!sess || !sess.running || !calibrating) return;
    if (!requiredReady(sess)) return;                    // §5.2: wait for workers
    if (calibStartedFor !== sess.calibrationId) { applyCandidate(sess); return; }

    var ev = calibrationEvidence(sess);
    var slot = candidateScores[candidateIndex];
    if (slot && ev.score > slot.score) {
      slot.score = ev.score; slot.notes = ev.notes; slot.raw = ev.raw;
    }
    if (ev.ok) {
      calibrating = false;
      el.calib.textContent = '보정 완료 — 경험치 전체 문자열 확인: ' + ev.raw +
        ' · HUD 근거: ' + ev.notes.join('+');
      el.calib.className = 'calib ok';
      logLine('보정 완료 #' + sess.calibrationId + ': ' + JSON.stringify(capture.getRect()) +
        ' · 근거 ' + ev.notes.join('+'), 'ok');
      renderCandidates();
      return;
    }
    if (performance.now() > probeUntil) {
      candidateIndex += 1;
      if (candidateIndex >= candidates.length) {
        calibrating = false;
        // Nothing fully confirmed. Rather than leaving the last (usually worst)
        // candidate selected, fall back to whichever gathered the most
        // evidence, and say plainly that it is a fallback.
        var bestIdx = -1, bestScore = 0;
        candidateScores.forEach(function (c, i) {
          if (c.score > bestScore) { bestScore = c.score; bestIdx = i; }
        });
        if (bestIdx >= 0 && bestScore >= 3) {
          candidateIndex = bestIdx;
          capture.setRect(candidates[bestIdx]);
          bumpCalibration(sess, '차선 후보 채택');
          el.calib.textContent = '자동 보정 차선 채택 — ' + (candidates[bestIdx].why || '후보 ' + (bestIdx + 1)) +
            ' (근거 ' + (candidateScores[bestIdx].notes.join('+') || '없음') +
            ', 경험치 확정 실패' + (candidateScores[bestIdx].raw ? ' · 최고 후보 "' + candidateScores[bestIdx].raw + '"' : '') +
            '). 빗나갔으면 아래 후보를 고르거나 미리보기에서 드래그하세요.';
          el.calib.className = 'calib warn';
          logLine('자동 보정 차선 채택: ' + JSON.stringify(candidates[bestIdx]) +
            ' · 점수 ' + bestScore, 'warn');
        } else {
          el.calib.textContent = '자동 보정 실패 — 아래 후보를 직접 고르거나 미리보기에서 게임 화면 영역을 드래그하세요.';
          el.calib.className = 'calib warn';
        }
        renderCandidates();
        return;
      }
      applyCandidate(sess);
      renderCandidates();
    }
  }

  function renderCandidates() {
    el.calibList.innerHTML = '';
    candidates.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === candidateIndex ? ' on' : '');
      b.textContent = (c.why || '수동') + ' · ' + c.w + '×' + c.h;
      b.onclick = function () {
        if (!S) return;
        calibrating = false; candidateIndex = i; capture.setRect(c);
        bumpCalibration(S, '수동 선택');
        el.calib.textContent = '수동 선택: ' + (c.why || '수동');
        el.calib.className = 'calib';
        renderCandidates();
      };
      el.calibList.appendChild(b);
    });
  }

  /* Drag on the preview to set the client rect by hand, clamped to the shared
     surface (§5.2). */
  function bindPreviewDrag() {
    var origin = null;
    el.preview.addEventListener('mousedown', function (e) {
      var r = el.preview.getBoundingClientRect();
      origin = [e.clientX - r.left, e.clientY - r.top];
    });
    window.addEventListener('mouseup', function (e) {
      if (!origin) return;
      var start = origin;
      origin = null;
      var s = capture.surfaceSize();
      if (!s.w || !s.h || !S) return;
      var r = el.preview.getBoundingClientRect();
      var x2 = e.clientX - r.left, y2 = e.clientY - r.top;
      // preview CSS pixels -> preview canvas pixels -> shared-surface pixels
      var kx = (el.preview.width / r.width) * (s.w / el.preview.width);
      var ky = (el.preview.height / r.height) * (s.h / el.preview.height);
      var rect = {
        x: Math.round(Math.min(start[0], x2) * kx),
        y: Math.round(Math.min(start[1], y2) * ky),
        w: Math.round(Math.abs(x2 - start[0]) * kx),
        h: Math.round(Math.abs(y2 - start[1]) * ky),
        why: '수동 드래그'
      };
      // Clamp inside the shared surface.
      rect.x = Math.max(0, Math.min(s.w - 1, rect.x));
      rect.y = Math.max(0, Math.min(s.h - 1, rect.y));
      rect.w = Math.max(0, Math.min(s.w - rect.x, rect.w));
      rect.h = Math.max(0, Math.min(s.h - rect.y, rect.h));
      if (rect.w < 100 || rect.h < 60) return;
      calibrating = false;
      capture.setRect(rect);
      bumpCalibration(S, '수동 드래그');
      candidates = [rect].concat(candidates);
      candidateIndex = 0;
      el.calib.textContent = '수동 지정: ' + rect.w + '×' + rect.h +
        ' [' + rect.x + ',' + rect.y + ']';
      el.calib.className = 'calib';
      renderCandidates();
    });
  }

  function previewLoop() {
    if (capture.video) {
      capture.drawPreview(el.preview);
      var r = capture.getRect(), s = capture.surfaceSize();
      if (r && s.w) {
        var g = el.preview.getContext('2d');
        g.strokeStyle = '#5ad6a0'; g.lineWidth = 2;
        g.strokeRect(r.x / s.w * el.preview.width, r.y / s.h * el.preview.height,
                     r.w / s.w * el.preview.width, r.h / s.h * el.preview.height);
      }
    }
    calibrationWatch();
    setTimeout(previewLoop, 200);
  }

  /* ---- controls --------------------------------------------------------- */

  /* §5.1: one place decides what the buttons say, for stop, share end and
     failure alike. */
  function syncControls() {
    var live = !!(S && S.running && !S.shareEnded);
    el.btnShare.disabled = live;
    el.btnStop.disabled = !live;
  }

  function teardown(reason) {
    var sess = S;
    if (!sess) { syncControls(); return; }
    sess.running = false;
    killWorkers();
    capture.stop();
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    calibrating = false;
    sess.boosterUi.interrupt(reason);
    sess.boosterDisplay.stop();
    sess.wealthTimerUi.reset();
    sess.runeDurUi.reset(); sess.runeCoolUi.reset();
    alerts.clear();
    lastSession = sess;              // kept for export
    S = null;
    syncControls();
  }

  var lastSession = null;

  el.btnShare.onclick = function () {
    alerts.unlock();
    setStatus('화면 공유 창에서 MapleStory 창을 선택하세요…', 'warn');
    capture.start().then(function () {
      var sess = newSession();
      armWealthTimer(sess);
      S = sess;
      sess.running = true;
      var s = capture.surfaceSize();
      el.shareInfo.textContent = '공유 대상: ' + (capture.label || '(이름 없음)') + ' · ' + s.w + '×' + s.h;
      logLine('세션 시작 ' + sess.id + ' · 표면 ' + s.w + '×' + s.h, 'ok');
      capture.onended = function () {
        if (!S || S !== sess) return;
        logLine('브라우저에서 공유가 중단되었습니다.', 'warn');
        sess.shareEnded = true;
        teardown('share_ended');
        setStatus('공유 중단됨 — 다시 시작하려면 화면 공유를 누르세요', 'bad');
      };
      startCalibration(sess);
      ROLES.forEach(function (role) { spawn(sess, role); });
      if (!rafHandle) rafHandle = requestAnimationFrame(renderLoop);
      syncControls();
    }).catch(function (e) {
      setStatus('공유 실패: ' + e.message, 'bad');
      logLine('공유 실패: ' + e.message, 'bad');
      teardown('share_failed');
    });
  };

  el.btnStop.onclick = function () {
    logLine('사용자 중지 — 워커 종료 및 상태 정리', 'warn');
    teardown('user_stop');
    setStatus('중지됨');
  };

  el.btnSound.onclick = function () { alerts.test('experience_stalled'); };

  el.btnExport.onclick = function () {
    var sess = S || lastSession;
    if (!sess) { logLine('내보낼 세션이 없습니다.', 'warn'); return; }
    var blob = new Blob([JSON.stringify({
      exported_at: new Date().toISOString(),
      session_id: sess.id,
      calibration_id: sess.calibrationId,
      client_rect: capture.getRect(),
      surface: capture.surfaceSize(),
      frames_analyzed: sess.frames,
      elapsed_seconds: (performance.now() - sess.startedAt) / 1000,
      rune_duration_status: sess.runeDurationStatus,
      wealth: {
        status: sess.wealthLife.status, reason: sess.wealthLife.reason,
        hide_below_seconds: sess.wealthLife.hideBelow,
        timer: { accepted: sess.wealthTimer.accepted, rejected: sess.wealthTimer.rejected,
                 max_seconds: sess.wealthTimer.maxSeconds }
      },
      booster: sess.boosterUi.describe(),
      booster_decisions: sess.boosterLog,
      events: sess.events,
      timeline: sess.timeline
    }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'astra-session-' + sess.id + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  };

  el.chkBuffs.onchange = function () { enabledRoles.buffs = el.chkBuffs.checked; };
  el.chkLie.onchange = function () { enabledRoles.lie = el.chkLie.checked; };

  bindPreviewDrag();
  previewLoop();
  if (!rafHandle) rafHandle = requestAnimationFrame(renderLoop);
  syncControls();
  setStatus('“화면 공유 시작”을 누른 뒤 MapleStory 창을 선택하세요.');

  // Exposed for the browser regression suite and for calibration diagnostics.
  window.ASTRA_APP = {
    session: function () { return S; },
    lastSession: function () { return lastSession; },
    observerState: function () { return observerState(S); },
    capture: capture,
    stickyPresence: stickyPresence,
    candidates: function () { return capture.candidates(); },
    setRect: function (rect) {
      if (!S) return null;
      capture.setRect(rect);
      calibrating = false;
      bumpCalibration(S, '진단 지정');
      el.calib.textContent = '진단 지정: ' + JSON.stringify(rect);
      el.calib.className = 'calib';
      return capture.getRect();
    },
    /* Full-resolution grab of the shared surface, for working out where the
       game client actually sits inside it. */
    surfaceImageData: function () {
      var v = capture.video;
      if (!v || v.readyState < 2) return null;
      var c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height);
    }
  };
})();
