/* Presentation-only countdowns.

   IMPORTANT - these do NOT feed any judgement.

   AGENT_HANDOFF.md §4 forbids measuring, interpolating or predicting booster
   time as a *trigger*. The booster alert is produced solely by
   state.BoosterUiState from UI presence plus a rune duration reading, and the
   potion alert solely by state.BuffExpiry from icon presence. Nothing in this
   file is an input to either.

   What lives here is the visual readout the user asked for on 2026-09-06:

     booster : the moment the "남은시간" UI is detected, read its number ONCE
               to sync, then run free. If the synced countdown passes zero and
               the UI is still on screen, show "서버 지연 대기중 . . .".
     potion  : the same - sync once from the icon's number, then run free.
               Additionally the number area is watched about once a second;
               the moment it changes the display re-syncs from the new reading
               and goes back to running free. That self-corrects the minute
               display, whose "29" only tells you 1740..1799 s remain, because
               the instant it flips to "28" the value is exactly 1680.

   The number is used ONLY to place these readouts. The booster alert is still
   produced solely by state.BoosterUiState from UI presence plus the rune
   duration, and the potion alert solely by state.BuffExpiry from icon
   presence; neither ever reads a countdown value.

   The dots cycle . -> . . -> . . . -> . once every 0.5 s. */
(function (root) {
  'use strict';

  var WAITING_LABEL = '서버 지연 대기중';
  var DOT_PERIOD = 0.5;                 // seconds per dot step
  var DOT_STEPS = ['.', '. .', '. . .'];

  /* `waitedSeconds` is time since the waiting state began, not wall clock, so
     the cycle always starts at a single dot. */
  function waitingText(waitedSeconds) {
    var k = Math.floor(Math.max(0, waitedSeconds) / DOT_PERIOD) % DOT_STEPS.length;
    return WAITING_LABEL + ' ' + DOT_STEPS[k];
  }

  /* opts: { seconds, decimals, overrunSeconds, format } */
  function DisplayCountdown(opts) {
    opts = opts || {};
    this.seconds = opts.seconds === undefined ? 99 : opts.seconds;
    this.decimals = opts.decimals === undefined ? 2 : opts.decimals;
    // How long after t=0 we keep showing 0 before calling it a server delay.
    this.overrunSeconds = opts.overrunSeconds === undefined ? 1 : opts.overrunSeconds;
    this.format = opts.format || 'seconds';      // 'seconds' | 'clock'
    this.startedAt = null;
    this.token = null;
  }

  DisplayCountdown.prototype.start = function (now, token) {
    this.startedAt = now;
    this.token = token === undefined ? null : token;
    this.syncedAt = null;
    this.syncedTo = null;
    this.syncs = 0;
  };

  /* Place the countdown so that `remaining(now)` is exactly `seconds`.
     Everything else - the overrun/waiting behaviour - follows unchanged. */
  DisplayCountdown.prototype.syncTo = function (seconds, now) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return false;
    this.startedAt = now - (this.seconds - seconds);
    this.syncedAt = now;
    this.syncedTo = seconds;
    this.syncs = (this.syncs || 0) + 1;
    return true;
  };
  DisplayCountdown.prototype.synced = function () { return this.syncedAt !== null && this.syncedAt !== undefined; };
  DisplayCountdown.prototype.stop = function () {
    this.startedAt = null; this.token = null;
    this.syncedAt = null; this.syncedTo = null; this.syncs = 0;
  };
  DisplayCountdown.prototype.running = function () { return this.startedAt !== null; };

  /* Restart only when a genuinely new subject appears. `token` identifies the
     current sighting (a presence-run id / a lifetime id), so a frame where the
     detector blinks does not reset the display. */
  DisplayCountdown.prototype.sync = function (present, now, token) {
    if (!present) { this.stop(); return; }
    if (this.startedAt === null || token !== this.token) this.start(now, token);
  };

  DisplayCountdown.prototype.elapsed = function (now) {
    return this.startedAt === null ? null : Math.max(0, now - this.startedAt);
  };

  DisplayCountdown.prototype.remaining = function (now) {
    var e = this.elapsed(now);
    return e === null ? null : Math.max(0, this.seconds - e);
  };

  DisplayCountdown.prototype.overrun = function (now) {
    var e = this.elapsed(now);
    return e !== null && e >= this.seconds + this.overrunSeconds;
  };

  /* The string the panel shows. `present` is the live detection; when the
     subject is gone there is nothing to display. */
  DisplayCountdown.prototype.text = function (now) {
    if (this.startedAt === null) return null;
    if (this.overrun(now)) {
      return waitingText(this.elapsed(now) - (this.seconds + this.overrunSeconds));
    }
    var r = this.remaining(now);
    if (this.format === 'clock') {
      var n = Math.floor(r);
      /* 1분 미만은 맨 숫자로 쓴다 - 게임이 그렇게 그린다 (녹화 전수조사:
         노란 가운데 맨숫자는 언제나 1분 미만의 초). 사용자 지시 2026-09-07
         "5, 4, 3, 2, 1 초가 전부 표시되어야" 를 그대로 읽히게 하는 표기이기도
         하다. */
      if (n < 60) return n + '초';
      return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
    }
    return r.toFixed(this.decimals) + '초';
  };

  DisplayCountdown.prototype.state = function (now) {
    if (this.startedAt === null) return 'idle';
    if (this.overrun(now)) return 'server_delay';
    return this.synced() ? 'counting' : 'counting_unsynced';
  };

  /* "Detected" for display purposes.

     The countdowns start the moment a thing is detected, so they follow raw
     presence rather than the confirmed state machine - but detectors blink,
     and restarting a 30:00 readout because one frame missed the icon would be
     worse than useless. Presence therefore sticks until `missesToDrop`
     consecutive absences, and `sighting` only advances when the subject
     genuinely comes back after having gone.

     `update(null)` means "could not tell" and never drops presence. */
  function StickyPresence(missesToDrop) {
    this.on = false;
    this.misses = 0;
    this.sighting = 0;
    this.missesToDrop = missesToDrop === undefined ? 2 : missesToDrop;
  }
  StickyPresence.prototype.update = function (observed) {
    if (observed === null || observed === undefined) return this.on;
    if (observed) {
      this.misses = 0;
      if (!this.on) { this.on = true; this.sighting += 1; }
      return true;
    }
    this.misses += 1;
    if (this.misses >= this.missesToDrop) this.on = false;
    return this.on;
  };
  StickyPresence.prototype.reset = function () { this.on = false; this.misses = 0; };

  /* ---- 스킬 아이콘의 표시 타이머 ---------------------------------------

     소형 재물 획득의 비약 · 룬 지속시간 · 룬 쿨타임은 전부 스킬 아이콘이고
     같은 문제를 공유한다.

       1. 남은 시간이 5초 미만이면 메이플스토리가 **숫자를 지운다.**
          그 구간에는 판독이 없으므로 타이머만 남는다.
       2. 분 표시는 해상도가 60초다. "26" 은 26:00~26:59 어디든 될 수 있다.
       3. 탐지는 가끔 한두 프레임 깜빡인다.

     그래서 화면 숫자는 타이머를 **놓는 데만** 쓰고 그 뒤로는 스스로 흐르게
     한다. 이 규칙이 세 곳에 흩어져 있으면 어긋나므로 여기 한 곳에 둔다
     (그리고 브라우저 없이 시험할 수 있다).

     판정에는 관여하지 않는다 - 이 파일 첫머리의 경고 그대로다. */
  function SkillTimer(opts) {
    opts = opts || {};
    this.resolution = opts.resolution === undefined ? 1 : opts.resolution;
    this.disp = new DisplayCountdown({
      seconds: opts.seconds === undefined ? 1800 : opts.seconds,
      decimals: 0, overrunSeconds: 0, format: 'clock'
    });
    this.sticky = new StickyPresence(opts.missesToDrop === undefined ? 2 : opts.missesToDrop);
    this.syncedSighting = null;
    this.lastShown = null;        // 끊기기 직전에 보여주던 잔여
    this.lastShownAt = null;
  }

  /* observed: true(있다) / false(없다) / null(판정 불가 - 존재를 떨어뜨리지 않는다)
     seconds : 이번에 화면에서 읽은 잔여. 없으면 null (마지막 5초가 여기다)

     예전에는 판독기의 number_changed 를 인자로 받아 재싱크 방아쇠로 썼다.
     그것은 **칸 지문이 달라졌다**는 신호이지 값이 달라졌다는 신호가 아니어서
     비약 표시가 계속 되돌아갔다 (아래 재싱크 규칙 주석 참고). 지금은 값만
     본다 - 받지 않는 편이 잘못 배선될 여지가 없다. */
  SkillTimer.prototype.update = function (observed, seconds, now) {
    var on = this.sticky.update(observed);
    if (!on) {
      if (this.disp.running()) {
        this.lastShown = this.disp.remaining(now);
        this.lastShownAt = now;
      }
      this.disp.sync(false, now, this.sticky.sighting);
      this.syncedSighting = null;
      return false;
    }
    this.disp.sync(true, now, this.sticky.sighting);
    if (seconds === null || seconds === undefined) return true;   // 자유 주행
    var first = this.syncedSighting !== this.sticky.sighting;
    if (first) {
      /* 끊겼다 돌아왔을 때 초를 버리지 않는다 (사용자 보고 2026-09-07:
         "26분 n초일 때 잠깐 끊겼다가 다시 연결되면 여전히 26분이라면 초를
         유지"). 화면은 분만 주므로 그대로 다시 놓으면 26:59 로 되돌아가
         초가 사라진다. 우리가 들고 있던 초 단위 표시가 더 정확하다.
         **같은 분일 때만** 그렇게 한다. */
      if (this.resolution > 1 && this.lastShown !== null) {
        var carried = this.lastShown - (now - this.lastShownAt);
        if (carried > 0 &&
            Math.floor(carried / this.resolution) === Math.floor(seconds / this.resolution)) {
          this.disp.syncTo(carried, now);
          this.syncedSighting = this.sticky.sighting;
          this.carriedSeconds = true;
          return true;
        }
      }
      this.carriedSeconds = false;
      this.disp.syncTo(seconds, now);
      this.syncedSighting = this.sticky.sighting;
      return true;
    }
    /* 1초 해상도는 매 판독이 정확하므로 그대로 따라간다. */
    if (this.resolution === 1) { this.disp.syncTo(seconds, now); return true; }

    /* 분 해상도에서는 **값으로** 판단한다.

       예전에는 `changed`(= 판독기의 number_changed)를 믿고 다시 놓았다.
       그런데 그것은 칸 지문이 달라졌다는 신호이지 값이 달라졌다는 신호가
       아니다. 공유 스트림이 손실 압축이라 **값이 그대로인 칸의 7.9% 가
       "바뀌었다"로 나온다**(녹화 300프레임 실측). 그래서 몇 초에 한 번씩
       표시가 n:59 로 되돌아갔다 (사용자 보고 2026-09-08:
       "소형 재물 획득의 비약의 타이머가 계속 초기화된다").

       규칙은 사용자가 준 그대로다.
         - 화면 분이 표시 분보다 **작아졌을 때만** n:59 로 다시 놓는다.
           그 순간이 실제로 분:59 인 지점이라 정확해진다.
         - 화면 분이 표시와 **같으면 그대로 둔다.** n분 m초를 n분 59초로
           되돌리지 않는다.

       예외가 하나 필요하다: 버프를 다시 걸면 (비약을 새로 마시면) 화면 분이
       크게 뛴다. 그건 새 지속시간이므로 따라가야 한다. 표시가 앞서 흘러
       생기는 어긋남은 최대 1분이므로, **1.5분을 넘게 클 때만** 새로 걸린
       것으로 본다. 그 아래는 표시가 조금 앞선 것으로 보고 두는 편이 안전하다
       - 여기서 따라가면 표시가 거꾸로 뛴다. */
    var shown = this.disp.remaining(now);
    if (shown === null) { this.disp.syncTo(seconds, now); return true; }
    var shownStep = Math.floor(shown / this.resolution);
    var readStep = Math.floor(seconds / this.resolution);
    if (readStep < shownStep) {
      this.disp.syncTo(seconds, now);              // 분이 넘어갔다 - 정확해지는 지점
    } else if (seconds > shown + this.resolution * 1.5) {
      this.disp.syncTo(seconds, now);              // 버프가 새로 걸렸다
    }
    return true;
  };

  SkillTimer.prototype.present = function () { return this.sticky.on; };
  SkillTimer.prototype.text = function (now) { return this.disp.text(now); };
  SkillTimer.prototype.state = function (now) { return this.disp.state(now); };
  SkillTimer.prototype.remaining = function (now) { return this.disp.remaining(now); };
  SkillTimer.prototype.synced = function () { return this.disp.synced(); };
  SkillTimer.prototype.reset = function () {
    this.disp.stop(); this.sticky.reset();
    this.syncedSighting = null; this.lastShown = null; this.lastShownAt = null;
  };

  root.display = {
    SkillTimer: SkillTimer,
    StickyPresence: StickyPresence,
    WAITING_LABEL: WAITING_LABEL,
    DOT_PERIOD: DOT_PERIOD,
    DOT_STEPS: DOT_STEPS,
    waitingText: waitingText,
    DisplayCountdown: DisplayCountdown
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
