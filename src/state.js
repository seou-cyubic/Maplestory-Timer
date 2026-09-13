/* Time-domain state machines.

   Origin: legacy/src/astra_test/state.py, then reworked against the
   2026-09-05 live run and the 2026-09-06 handoff (AGENT_HANDOFF.md).

   Deliberate departures, each with a regression test in tools/state_tests.js
   and src/selftest.js:

     FIX-1  a capture gap must not re-arm the experience stall alert
     FIX-2  countdown readings that contradict elapsed time are rejected
            (kept for the potion; the booster no longer uses timers at all)
     FIX-6  a buff icon that keeps its place with the number painted out is in
            its final seconds; the ending is the icon going away
     FIX-7  a decrease in the experience value no longer re-arms the stall
            alert - only a confirmed increase does
     FIX-8  a buff icon that vanishes with plenty of time left closes the
            lifetime as unverifiable; the stale deadline can never fire later
     FIX-9  the booster is judged purely on whether its "남은시간" UI is on
            screen. No elapsed-time measurement, no interpolation, no
            predicted expiry, no dependency on reading its digits. */
(function (root) {
  'use strict';

  var parse = root.parse;
  var options = {
    // FIX-1: the 2026-09-05 live run produced three experience_stalled alerts
    // inside one continuous idle period because every >0.5 s frame gap
    // cleared `alerted`.
    rearmOnlyOnIncrease: true,
    // FIX-2: reject timer readings that contradict elapsed time. The same run
    // reported "1.19s" while the booster really had ~17 s left. Still used by
    // the potion path; the booster path no longer feeds it.
    timerConsistencyFilter: true,
    stallSeconds: 7,
    /* How long a hole between experience observations may be before tracking
       restarts from a new baseline.

       The legacy 0.5 s assumed the ~10 Hz experience loop of the Python build.
       Measured 2026-09-06 on the user's machine the browser pipeline delivers
       1.5-3 readings per second, so a 0.5 s tolerance re-baselined on almost
       every frame and the state never left BASELINING - the stall alert could
       never fire at all. 2.0 s comfortably covers that cadence while staying
       far below the 7 s stall window.

       Widening this cannot bring back the 2026-09-05 duplicate alerts:
       FIX-1/FIX-7 mean re-baselining never clears `alerted`; only a confirmed
       increase does. */
    maxGapSeconds: 2.0
  };

  function ExperienceState() {
    this.value = null;      // digit string
    this.lastSeen = null;
    this.since = null;
    this.pending = null;    // [digitString, time]
    this.alerted = false;
    this.status = 'BASELINING';
  }

  ExperienceState.prototype.update = function (value, now) {
    if (value === null || value === undefined) {
      this.lastSeen = null;
      this.pending = null;
      this.since = null;
      this.status = 'UNKNOWN';
      return false;
    }
    if (this.lastSeen === null || now - this.lastSeen > options.maxGapSeconds) {
      this.pending = [value, now];
      this.value = null;
      this.since = now;
      if (!options.rearmOnlyOnIncrease) this.alerted = false;
      this.status = 'BASELINING';
    }
    this.lastSeen = now;

    if (this.value === null) {
      if (this.pending && parse.cmpExp(value, this.pending[0]) >= 0 && now > this.pending[1]) {
        this.value = value;
        this.since = now;
        this.pending = null;
        this.status = 'TRACKING';
      } else {
        this.pending = [value, now];
      }
      return false;
    }
    var c = parse.cmpExp(value, this.value);
    if (c < 0) {
      // FIX-7: a decrease is unexplained - a misread, a level change, or a
      // different character. Take a new baseline and mark it for re-checking,
      // but do NOT clear `alerted`: only a confirmed increase means the hunt
      // actually resumed, and the 2026-09-05 run fired a second stall alert
      // purely because a misread dropped the value.
      this.value = null;
      this.pending = [value, now];
      this.since = now;
      this.status = 'RECHECK';
      return false;
    }
    if (c > 0) {                       // increase: confirm before trusting it
      if (this.pending && parse.cmpExp(value, this.pending[0]) >= 0) {
        this.value = value;
        this.since = this.pending[1];
        this.pending = null;
        this.alerted = false;          // the only legitimate re-arm
        this.status = 'TRACKING';
      } else {
        this.pending = [value, now];
      }
      return false;
    }
    this.pending = null;
    if (now - this.since >= options.stallSeconds && !this.alerted) {
      this.alerted = true;
      this.status = 'STALLED';
      return true;
    }
    return false;
  };

  /* 경험치 활동 상태기계 (2026-09-06).

     숫자를 보지 않는다. '경험치 글자 영역이 변했는가'만 본다.
       변함        -> 사냥 중, 정체 시계를 0으로
       변하지 않음 -> 정체 시계 누적, stallSeconds 넘으면 1회 알림
       관측 불가   -> 아무것도 누적하지 않음 (화면 정지·가림·무효 프레임)

     재무장은 '실제 변화'에서만 일어난다. FIX-1/FIX-7과 같은 규칙이라
     한 번 울린 정체가 관측 공백 때문에 다시 울리는 일은 없다. */
  function ExperienceActivity(stallSeconds) {
    this.stallSeconds = stallSeconds === undefined ? options.stallSeconds : stallSeconds;
    this.reset();
  }

  ExperienceActivity.prototype.reset = function () {
    this.status = 'UNKNOWN';
    this.lastChangeAt = null;
    this.alerted = false;
    this.reason = null;
    this.idleSeconds = 0;
    this.changes = 0;
  };

  // o: {changed: bool|null, now, observable}
  ExperienceActivity.prototype.update = function (o) {
    var now = o.now;
    if (!o.observable || o.changed === null || o.changed === undefined) {
      this.status = 'UNKNOWN';
      this.reason = o.reason || 'not_observable';
      // 관측할 수 없던 시간은 정체로 세지 않는다.
      if (this.lastChangeAt !== null) this.lastChangeAt = now - this.idleSeconds;
      return false;
    }
    if (o.changed) {
      this.lastChangeAt = now;
      this.idleSeconds = 0;
      this.alerted = false;              // 실제 변화만이 재무장한다
      this.status = 'TRACKING';
      this.reason = 'changed';
      this.changes += 1;
      return false;
    }
    if (this.lastChangeAt === null) {
      // 아직 변화를 한 번도 못 봤다. 기준선을 잡는다.
      this.lastChangeAt = now;
      this.status = 'BASELINING';
      this.reason = 'first_observation';
      return false;
    }
    this.idleSeconds = now - this.lastChangeAt;
    this.reason = 'unchanged';
    if (this.idleSeconds >= this.stallSeconds) {
      this.status = 'STALLED';
      if (!this.alerted) { this.alerted = true; return true; }
      return false;
    }
    this.status = 'TRACKING';
    return false;
  };

  /* Countdown filter. Legacy defined this class but never called it; the live
     run showed exactly the failure it prevents, so it is wired in here.
     Used by the potion only - see BoosterUiState for why the booster does not. */
  function TimerState(name) {
    this.name = name || 'timer';
    this.deadline = null;
    this.lastSeen = null;
    this.resolution = null;
    this.lastRaw = null;
    this.rejected = 0;
    this.accepted = 0;
    this.maxSeconds = null;      // per-buff verified ceiling, e.g. P04 = 1800
  }

  TimerState.prototype.observe = function (remaining, now, resolution) {
    if (remaining === null || remaining === undefined) return { accepted: false, reason: 'no_reading' };
    // FIX-4 (potion): a verified ceiling rejects the 200분 / 250분 class of
    // misread outright instead of letting it become the new baseline.
    if (this.maxSeconds !== null && remaining > this.maxSeconds) {
      this.rejected += 1;
      return { accepted: false, reason: 'above_max', max: this.maxSeconds, got: remaining };
    }
    // The check must survive a resolution change: a potion legitimately goes
    // 10분(600, step 60) -> 9:59(599, step 1), but a hallucinated "8" read off
    // icon art while 29 minutes remain must still be thrown out. Comparing
    // against elapsed time with the coarser of the two display steps does both.
    if (options.timerConsistencyFilter && this.lastSeen !== null) {
      var elapsed = now - this.lastSeen;
      if (elapsed <= 6) {
        var expected = this.lastRaw - elapsed;
        var tolerance = Math.max(this.resolution || 1, resolution || 1) + 2;
        if (remaining > this.lastRaw + tolerance || remaining < expected - tolerance) {
          this.rejected += 1;
          return { accepted: false, reason: 'inconsistent', expected: expected, got: remaining };
        }
      }
    }
    this.deadline = now + remaining;
    this.lastSeen = now;
    this.lastRaw = remaining;
    this.resolution = resolution;
    this.accepted += 1;
    return { accepted: true };
  };

  TimerState.prototype.read = function (now) {
    if (this.lastSeen === null || now - this.lastSeen > 2) {
      return { remaining_seconds: null, source: 'unknown', resolution_seconds: this.resolution };
    }
    var remaining = Math.max(0, this.deadline - now);
    var age = now - this.lastSeen;
    return {
      remaining_seconds: remaining,
      resolution_seconds: this.resolution,
      source: age <= 0.001 ? 'observed' : 'propagated',
      observed_at: this.lastSeen,
      uncertainty_seconds: (this.resolution || 1) + age,
      lower_bound: Math.max(0, remaining - ((this.resolution || 1) + age)),
      upper_bound: remaining + (this.resolution || 1)
    };
  };

  TimerState.prototype.reset = function () {
    this.deadline = null; this.lastSeen = null; this.lastRaw = null; this.resolution = null;
  };

  /* Two consecutive confirmations; an unknown observation never means absent. */
  function PresenceGate(maxGap) {
    this.maxGap = maxGap === undefined ? 3 : maxGap;
    this.count = 0; this.active = false; this.last = null;
  }
  PresenceGate.prototype.update = function (present, now) {
    if (this.last !== null && now - this.last > this.maxGap) this.count = 0;
    this.last = now;
    if (present === null || present === undefined) { this.count = 0; return false; }
    if (!present) { this.count = 0; this.active = false; return false; }
    this.count += 1;
    if (this.count >= 2 && !this.active) { this.active = true; return true; }
    return false;
  };
  PresenceGate.prototype.reset = function () { this.count = 0; this.active = false; this.last = null; };

  /* Expiration is only inferred from a recently observed final-seconds
     countdown. Retained for reference and for the legacy comparison tests; the
     booster no longer uses it (FIX-9). */
  function ExpirationGate() {
    this.last = null; this.remaining = null; this.armed = false; this.alerted = false;
  }
  ExpirationGate.prototype.update = function (remaining, resolution, now, visible) {
    if (visible === undefined) visible = true;
    if (!visible) { this.last = null; this.armed = false; return false; }
    if (remaining !== null && remaining !== undefined) {
      if (remaining > 5) this.alerted = false;
      if (remaining === 0 && this.armed && !this.alerted) { this.alerted = true; return true; }
      var consistent = this.last !== null && now - this.last <= 3 && this.remaining !== null &&
        Math.abs((this.remaining - remaining) - (now - this.last)) <= 2;
      this.last = now;
      this.remaining = remaining;
      this.armed = consistent && resolution === 1 && remaining > 0 && remaining <= 5;
      return false;
    }
    if (this.armed && this.last !== null) {
      var elapsed = now - this.last;
      if (elapsed > 8) this.armed = false;
      else if (elapsed >= this.remaining + 1 && !this.alerted) { this.alerted = true; return true; }
    }
    return false;
  };

  /* Buff-icon lifetime.

     MapleStory stops drawing the number on a buff icon once it drops below
     ~5 seconds, so "icon on screen, no readable timer" is *evidence of the
     final seconds*, not a loss of observation. The ending is the moment the
     icon itself goes away after that final phase.

       UNSEEN -> ACTIVE -> FINAL_SECONDS -> ENDED
                    \-> UNKNOWN (covered, or vanished unexplained)

     FIX-8: once a lifetime is closed as unexplained the remembered deadline is
     dropped. The 2026-09-05 build kept it and announced "expired" 893 s after
     an icon vanished with 900 s left. */
  function BuffExpiry(hideBelow) {
    this.hideBelow = hideBelow === undefined ? 5 : hideBelow;
    this.reset();
  }

  BuffExpiry.prototype.reset = function () {
    this.status = 'UNSEEN';
    this.lastRemaining = null;
    this.lastReadAt = null;
    this.hiddenSince = null;
    this.missingSince = null;
    this.alerted = false;
    this.closed = false;
    this.interrupted = false;
    this.blindRun = 0;
    this.reason = null;
  };

  // A remembered reading is only usable while it is still fresh; an old one
  // says nothing about a screen we stopped watching.
  BuffExpiry.prototype.predicted = function (now) {
    if (this.lastReadAt === null) return null;
    return this.lastRemaining - (now - this.lastReadAt);
  };
  BuffExpiry.prototype._usablePrediction = function (now) {
    if (this.lastReadAt === null) return null;
    if (now - this.lastReadAt > this.hideBelow + 5) return null;
    return this.lastRemaining - (now - this.lastReadAt);
  };

  // o: {iconPresent, remaining, now, observable}
  BuffExpiry.prototype.update = function (o) {
    var now = o.now;

    if (!o.observable) {
      /* 관측 불가가 **이어질 때만** 중단으로 본다.

         FIX-8 의 취지는 "보지 못한 사이에 일어난 일을 소멸로 추정하지 말라"
         이고 그건 옳다. 그런데 한 프레임만 튀어도 곧바로 interrupted 를
         세우면, 판독이 없는 마지막 5초 구간에서는 그것을 풀 방법이 없어
         (interrupted 는 유효한 판독에서만 풀린다) 알림이 영영 사라진다.
         사용자가 반복해서 보고한 "비약 알림이 안 울린다"가 이것이다.

         그래서 연속 2회부터 중단으로 본다. 한 프레임 결손은 흡수하고,
         진짜 가림·단절은 그대로 걸러진다. */
      this.blindRun = (this.blindRun || 0) + 1;
      if (this.status !== 'ENDED') this.status = 'UNKNOWN';
      this.missingSince = null;
      this.hiddenSince = null;
      this.reason = 'not_observable';
      if (this.blindRun >= 2) this.interrupted = true;
      return false;
    }
    this.blindRun = 0;

    if (o.iconPresent) {
      this.missingSince = null;
      if (o.remaining !== null && o.remaining !== undefined) {
        this.lastRemaining = o.remaining;
        this.lastReadAt = now;
        this.hiddenSince = null;
        this.status = 'ACTIVE';
        this.alerted = false;
        this.closed = false;
        this.interrupted = false;
        this.reason = 'reading';
        return false;
      }
      // Icon present, no trustworthy number.
      if (this.hiddenSince === null) this.hiddenSince = now;
      if (this.closed || this.interrupted) {
        this.status = 'UNKNOWN';
        this.reason = this.closed ? 'closed_unverifiable' : 'interrupted';
        return false;
      }
      var predicted = this._usablePrediction(now);
      if (predicted !== null && predicted <= this.hideBelow + 1.5) {
        this.status = 'FINAL_SECONDS';
        this.reason = 'timer_hidden';
      } else if (this.status === 'FINAL_SECONDS' &&
                 now - this.hiddenSince <= this.hideBelow + 3) {
        this.reason = 'timer_hidden';       // stay in the final phase briefly
      } else {
        this.status = 'UNKNOWN';            // unreadable for some other reason
        this.reason = 'unreadable';
      }
      return false;
    }

    // Icon gone.
    if (this.status === 'UNSEEN' || this.status === 'ENDED' || this.closed) {
      this.missingSince = null;
      return false;
    }
    if (this.missingSince === null) this.missingSince = now;
    if (now - this.missingSince < 0.8) return false;   // one bad frame is not an ending
    if (this.alerted) return false;

    if (this.interrupted) {
      // FIX-8: the icon went away across an unobservable spell. Whatever
      // happened is not evidence of an ending.
      this.status = 'UNKNOWN';
      this.closed = true;
      this.lastReadAt = null;
      this.lastRemaining = null;
      this.reason = 'icon_gone_after_interruption';
      return false;
    }

    var pred = this._usablePrediction(now);
    if (this.status === 'FINAL_SECONDS' || (pred !== null && pred <= this.hideBelow + 2)) {
      this.status = 'ENDED';
      this.alerted = true;
      this.reason = 'icon_gone_after_final_seconds';
      return true;
    }
    // FIX-8: disappeared with plenty of time left - cancelled, moved, or
    // mis-detected. Close the lifetime and forget the deadline so it can never
    // fire later.
    this.status = 'UNKNOWN';
    this.closed = true;
    this.lastReadAt = null;
    this.lastRemaining = null;
    this.reason = 'icon_gone_unexplained';
    return false;
  };

  /* ---- booster: UI presence only (FIX-9) --------------------------------

     The user's rule, verbatim from AGENT_HANDOFF.md §4:

       1. Do not measure time. What matters is whether the "남은시간" UI is
          there or not.
       2. When a "남은시간" that was there disappears, check the rune duration.
       3. If the rune duration is 1분 50초 or more, sound the booster-expired
          alert.
       4. The current UI detection works well - keep it, change only the
          trigger.

     So this machine never sees a booster countdown value. It consumes a
     presence tri-state and, at the moment of a disappearance, one rune
     duration reading taken from the very frame the disappearance was first
     seen in.

       UNSEEN -> VISIBLE -> DISAPPEARANCE_CANDIDATE -> CHECK_RUNE -> RESOLVED

     UNKNOWN (share stopped, calibrating, stale result, invalid frame) never
     counts as a disappearance and drops the arming, so a blink or a covered
     frame cannot produce an alert. */

  var RUNE_THRESHOLD_SECONDS = 110;          // 1분 50초

  function BoosterUiState(opts) {
    opts = opts || {};
    this.thresholdSeconds = opts.thresholdSeconds === undefined
      ? RUNE_THRESHOLD_SECONDS : opts.thresholdSeconds;
    this.confirmPresent = opts.confirmPresent === undefined ? 2 : opts.confirmPresent;
    this.confirmAbsent = opts.confirmAbsent === undefined ? 2 : opts.confirmAbsent;
    this.maxRuneRetries = opts.maxRuneRetries === undefined ? 3 : opts.maxRuneRetries;
    this.counter = 0;
    this.history = [];
    this.reset('init');
  }

  BoosterUiState.prototype.reset = function (reason) {
    this.state = 'UNSEEN';
    this.presentRun = 0;
    this.absentRun = 0;
    this.candidate = null;
    this.reason = reason || null;
    this.lastFrameId = null;
    this.lastDecision = null;
  };

  BoosterUiState.prototype.describe = function () {
    return {
      state: this.state,
      reason: this.reason,
      present_run: this.presentRun,
      disappearance_id: this.candidate ? this.candidate.id : null,
      candidate_rune: this.candidate ? this.candidate.rune : null,
      rune_retries: this.candidate ? this.candidate.retries : 0,
      last_decision: this.lastDecision
    };
  };

  /* Anything that breaks observation continuity: share stopped, session or
     calibration change, worker restart. Cancels a pending disappearance and
     de-arms, so a return to ABSENT alone can never end the booster (§4.3.9). */
  BoosterUiState.prototype.interrupt = function (reason) {
    var had = this.candidate;
    this.reset(reason || 'interrupted');
    if (had) {
      this.lastDecision = { disappearance_id: had.id, outcome: 'cancelled', reason: reason || 'interrupted' };
      return this.lastDecision;
    }
    return null;
  };

  /* o: { presence: 'PRESENT'|'ABSENT'|'UNKNOWN',
          frameId, capturedAt, score, reason,
          rune: RuneDurationObservation | null }

     Returns { event, decision } - `event` is non-null exactly once per
     disappearance that clears the rune threshold. */
  BoosterUiState.prototype.update = function (o) {
    var out = { event: null, decision: null };
    var presence = o && o.presence;
    // Duplicate delivery of the same frame is not new evidence (§8.1).
    if (o && o.frameId !== undefined && o.frameId !== null && o.frameId === this.lastFrameId) {
      out.decision = { outcome: 'duplicate_frame', frame_id: o.frameId };
      this.lastDecision = out.decision;
      return out;
    }
    if (o && o.frameId !== undefined) this.lastFrameId = o.frameId;

    if (presence !== 'PRESENT' && presence !== 'ABSENT') {
      // UNKNOWN: uncertain, never a disappearance. §4.3.1 / §4.3.9.
      var cancelled = this.candidate;
      this.presentRun = 0;
      this.absentRun = 0;
      this.candidate = null;
      if (this.state !== 'UNSEEN') this.reason = 'unknown_observation:' + (o && o.reason ? o.reason : 'unknown');
      this.state = 'UNSEEN';
      if (cancelled) {
        out.decision = { disappearance_id: cancelled.id, outcome: 'cancelled', reason: 'unknown_observation' };
        this.lastDecision = out.decision;
      }
      return out;
    }

    if (presence === 'PRESENT') {
      this.absentRun = 0;
      if (this.candidate) {
        // §4.3.4: back on screen, the disappearance never happened.
        out.decision = { disappearance_id: this.candidate.id, outcome: 'cancelled', reason: 'ui_returned' };
        this.lastDecision = out.decision;
        this.candidate = null;
      }
      this.presentRun += 1;
      if (this.presentRun >= this.confirmPresent) {
        this.state = 'VISIBLE';
        this.reason = 'present_confirmed';
      } else if (this.state !== 'VISIBLE') {
        this.state = 'UNSEEN';
        this.reason = 'present_pending';
      }
      return out;
    }

    // presence === 'ABSENT'
    this.presentRun = 0;
    if (this.state === 'UNSEEN' || this.state === 'RESOLVED') {
      // §4.3.1: never seen (or already resolved and not re-armed) - nothing to end.
      this.absentRun += 1;
      this.reason = this.state === 'UNSEEN' ? 'absent_without_prior_presence' : 'absent_after_resolved';
      return out;
    }

    if (this.state === 'VISIBLE') {
      this.counter += 1;
      this.candidate = {
        id: 'D' + this.counter,
        frameId: o.frameId === undefined ? null : o.frameId,
        capturedAt: o.capturedAt === undefined ? null : o.capturedAt,
        rune: normaliseRune(o.rune),          // §4.3.3: keep the candidate frame's reading
        retries: 0
      };
      this.absentRun = 1;
      this.state = 'DISAPPEARANCE_CANDIDATE';
      this.reason = 'disappearance_candidate';
      out.decision = { disappearance_id: this.candidate.id, outcome: 'candidate', frame_id: this.candidate.frameId };
      this.lastDecision = out.decision;
      return out;
    }

    if (this.state === 'DISAPPEARANCE_CANDIDATE') {
      this.absentRun += 1;
      if (this.candidate.rune === null || this.candidate.rune.observedSeconds === null) {
        // §4.3.6: the candidate frame did not yield a duration - a bounded
        // number of later valid observations may still supply one.
        var later = normaliseRune(o.rune);
        if (later && later.observedSeconds !== null) {
          this.candidate.rune = later;
          this.candidate.runeFromRetry = true;
        }
      }
      if (this.absentRun >= this.confirmAbsent) {
        this.state = 'CHECK_RUNE';
        this.reason = 'disappearance_confirmed';
        return this._checkRune(o, out);
      }
      return out;
    }

    if (this.state === 'CHECK_RUNE') {
      this.absentRun += 1;
      return this._checkRune(o, out);
    }
    return out;
  };

  BoosterUiState.prototype._checkRune = function (o, out) {
    var c = this.candidate;
    if (!c) { this.state = 'UNSEEN'; return out; }

    // Prefer the reading taken on the candidate frame (§4.3, "후보 프레임
    // 근거 보존": a 1:50 that has ticked to 1:49 by the confirming frame must
    // still count as 1:50).
    var rune = c.rune;
    if ((!rune || rune.observedSeconds === null)) {
      var later = normaliseRune(o.rune);
      if (later && later.observedSeconds !== null) {
        rune = c.rune = later;
        c.runeFromRetry = true;
      }
    }

    if (rune && rune.observedSeconds !== null) {
      var fired = rune.observedSeconds >= this.thresholdSeconds;
      this.state = 'RESOLVED';
      this.reason = fired ? 'rune_over_threshold' : 'rune_under_threshold';
      out.decision = {
        disappearance_id: c.id, outcome: fired ? 'alerted' : 'suppressed',
        rune_seconds: rune.observedSeconds, rune_raw: rune.rawText,
        rune_from: c.runeFromRetry ? 'retry_frame' : 'candidate_frame',
        threshold: this.thresholdSeconds
      };
      this.lastDecision = out.decision;
      if (fired) {
        out.event = {
          type: 'booster_expired',
          disappearance_id: c.id,
          frame_id: c.frameId,
          rune_seconds: rune.observedSeconds,
          rune_raw: rune.rawText,
          rune_from: out.decision.rune_from,
          threshold: this.thresholdSeconds
        };
      }
      this.candidate = null;
      return out;
    }

    // No duration yet. §4.3.5: a confirmed *absent* rune buff closes the case
    // quietly; anything else is retried a bounded number of times (§4.3.6-7).
    var absentRune = normaliseRune(o.rune) || rune;
    if (absentRune && absentRune.iconPresence === 'ABSENT') {
      this.state = 'RESOLVED';
      this.reason = 'rune_absent';
      out.decision = { disappearance_id: c.id, outcome: 'suppressed', reason: 'no_rune_buff' };
      this.lastDecision = out.decision;
      this.candidate = null;
      return out;
    }

    c.retries += 1;
    if (c.retries >= this.maxRuneRetries) {
      this.state = 'RESOLVED';
      this.reason = 'rune_unverifiable';
      out.decision = {
        disappearance_id: c.id, outcome: 'unverifiable',
        reason: (absentRune && absentRune.reason) || 'rune_duration_unreadable',
        retries: c.retries
      };
      this.lastDecision = out.decision;
      this.candidate = null;
    }
    return out;
  };

  /* Pure gate that turns a raw detector verdict into the tri-state the machine
     consumes. Everything that makes absence unprovable collapses to UNKNOWN in
     this one place, so the rule "가림·단절·오래된 결과는 소멸이 아니다" is a
     single testable function rather than scattered conditions (§4.2). */
  function gateObservation(input) {
    var maxAge = input.maxAgeSeconds === undefined ? 3 : input.maxAgeSeconds;
    if (input.shareInactive) return { presence: 'UNKNOWN', reason: 'share_inactive' };
    if (input.calibrating) return { presence: 'UNKNOWN', reason: 'calibrating' };
    if (input.sessionMismatch) return { presence: 'UNKNOWN', reason: 'session_changed' };
    if (input.calibrationMismatch) return { presence: 'UNKNOWN', reason: 'calibration_changed' };
    if (input.frameValid === false) return { presence: 'UNKNOWN', reason: 'frame_' + (input.frameReason || 'invalid') };
    if (input.ageSeconds !== undefined && input.ageSeconds !== null && input.ageSeconds > maxAge) {
      return { presence: 'UNKNOWN', reason: 'result_stale' };
    }
    if (input.presence !== 'PRESENT' && input.presence !== 'ABSENT') {
      return { presence: 'UNKNOWN', reason: input.reason || 'detector_unknown' };
    }
    return { presence: input.presence, reason: input.reason || null };
  }

  function normaliseRune(r) {
    if (!r) return null;
    var secs = r.observedSeconds;
    if (secs === undefined) secs = null;
    return {
      iconPresence: r.iconPresence || 'UNKNOWN',
      observedSeconds: (secs === null || isNaN(secs)) ? null : Number(secs),
      rawText: r.rawText === undefined ? null : r.rawText,
      resolution: r.resolution === undefined ? null : r.resolution,
      confidence: r.confidence === undefined ? null : r.confidence,
      frameId: r.frameId === undefined ? null : r.frameId,
      reason: r.reason === undefined ? null : r.reason
    };
  }

  root.state = {
    options: options,
    RUNE_THRESHOLD_SECONDS: RUNE_THRESHOLD_SECONDS,
    ExperienceState: ExperienceState,
    ExperienceActivity: ExperienceActivity,
    TimerState: TimerState,
    PresenceGate: PresenceGate,
    ExpirationGate: ExpirationGate,
    BuffExpiry: BuffExpiry,
    BoosterUiState: BoosterUiState,
    gateObservation: gateObservation
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
