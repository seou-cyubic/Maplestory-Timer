/* Alert sounds. Replaces winsound.Beep with WebAudio.

   Legacy behaviour: 1500 Hz x3 for the CAPTCHA, 1100 Hz x2 otherwise, each
   beep 180 ms with a 120 ms gap, fired on a fresh daemon thread per event so
   simultaneous events overlapped. Here the events go through a priority queue
   instead, so a CAPTCHA alert is heard first and beeps never pile on top of
   each other - DESIGN.md §6 asked for that and the Python build never did it. */
(function (root) {
  'use strict';

  var TONE = {
    lie_detector_appeared: { freq: 1500, beeps: 3, priority: 0, label: '거짓말 탐지기 등장' },
    experience_stalled:    { freq: 1100, beeps: 2, priority: 1, label: '사냥 일시 정지' },
    rune_appeared:         { freq: 1250, beeps: 2, priority: 2, label: '룬 등장' },
    wealth_expired:        { freq: 900,  beeps: 2, priority: 3, label: '비약 종료' },
    booster_expired:       { freq: 800,  beeps: 2, priority: 3, label: '부스터 종료' }
  };

  function Alerts() {
    this.audio = null;
    this.queue = [];
    this.playing = false;
    this.enabled = true;
    this.muted = {};
  }

  Alerts.prototype.unlock = function () {
    if (!this.audio) {
      var Ctx = self.AudioContext || self.webkitAudioContext;
      if (!Ctx) return Promise.resolve(false);
      this.audio = new Ctx();
    }
    return this.audio.state === 'suspended' ? this.audio.resume().then(function () { return true; })
                                            : Promise.resolve(true);
  };

  Alerts.prototype.describe = function (type) {
    return (TONE[type] && TONE[type].label) || type;
  };

  Alerts.prototype.fire = function (type) {
    if (!this.enabled || this.muted[type]) return;
    var tone = TONE[type] || { freq: 1000, beeps: 2, priority: 5 };
    this.queue.push({ type: type, tone: tone });
    this.queue.sort(function (a, b) { return a.tone.priority - b.tone.priority; });
    this._drain();
  };

  Alerts.prototype._drain = function () {
    var self_ = this;
    if (this.playing || !this.queue.length) return;
    if (!this.audio) return;                       // not unlocked yet; drop silently
    var item = this.queue.shift();
    this.playing = true;
    var ctx = this.audio, t = ctx.currentTime, dur = 0.18, gap = 0.12;
    for (var i = 0; i < item.tone.beeps; i++) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = item.tone.freq;
      // Short ramps keep the square wave from clicking.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.setValueAtTime(0.25, t + dur - 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + dur);
      t += dur + gap;
    }
    var total = (dur + gap) * item.tone.beeps * 1000;
    setTimeout(function () { self_.playing = false; self_._drain(); }, total);
  };

  /* Drop everything still queued. Called when a session ends so a beep
     scheduled by the old share cannot sound into the next one (§5.1). */
  Alerts.prototype.clear = function () {
    this.queue.length = 0;
  };

  Alerts.prototype.test = function (type) {
    var self_ = this;
    return this.unlock().then(function () { self_.fire(type || 'experience_stalled'); });
  };

  Alerts.TONE = TONE;
  root.Alerts = Alerts;
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
