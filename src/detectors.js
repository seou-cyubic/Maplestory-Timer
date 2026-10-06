/* Rune marker and booster UI. Presence detection only.

   Changes against the 2026-09-05 build:
     FIX-9   BoosterDetector reports UI presence only. No digits are read, so
             a number that cannot be recognised can never be mistaken for the
             UI being gone, and nothing downstream can measure booster time. */
(function (root) {
  'use strict';

  var vision = root.vision;
  var roi = vision.roi, Scope = vision.Scope;

  function loadTemplate(url) {
    return fetch(url).then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) { return b ? createImageBitmap(b) : null; })
      .then(function (bmp) {
        if (!bmp) return null;
        var c = new OffscreenCanvas(bmp.width, bmp.height);
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        var mat = vision.matFromImageData(g.getImageData(0, 0, bmp.width, bmp.height));
        bmp.close();
        return mat;
      });
  }

  /* ---- rune marker on the minimap -------------------------------------

     This answers "has a rune spawned on the map", nothing else. It is NOT the
     rune *duration* reader the booster rule needs - that lives in
     vision.RuneDurationReader and reads a buff icon (AGENT_HANDOFF.md §4.4). */

  function RuneDetector() { this.template = null; }

  RuneDetector.prototype.load = function (base) {
    var self_ = this;
    return loadTemplate((base || '') + 'assets/candidates/rune_marker.png')
      .then(function (m) { self_.template = m; return self_; });
  };

  RuneDetector.prototype.observe = function (image, minimap) {
    if (!minimap || !this.template) return { status: 'unknown', present: false };
    var s = new Scope();
    try {
      var t = this.template;
      var area = s.add(roi(image, minimap[0], minimap[1], minimap[2], minimap[3]));
      if (!area || area.rows < t.rows || area.cols < t.cols) return { status: 'unknown', present: false };
      var hsv = s.add(new cv.Mat()); cv.cvtColor(area, hsv, cv.COLOR_BGR2HSV);
      var low = s.add(new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [135, 60, 110, 0]));
      var high = s.add(new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [175, 255, 255, 0]));
      var color = s.add(new cv.Mat()); cv.inRange(hsv, low, high, color);
      var res = s.add(new cv.Mat());
      cv.matchTemplate(area, t, res, cv.TM_CCOEFF_NORMED);
      var mm = cv.minMaxLoc(res);
      var patch = roi(color, mm.maxLoc.x, mm.maxLoc.y, t.cols, t.rows);
      var colored = patch ? cv.countNonZero(patch) : 0;
      if (patch) patch.delete();
      return {
        status: 'observed',
        present: mm.maxVal >= 0.78 && colored >= 4,
        score: mm.maxVal,
        colored: colored,
        bbox: [minimap[0] + mm.maxLoc.x, minimap[1] + mm.maxLoc.y, t.cols, t.rows]
      };
    } finally { s.done(); }
  };

  /* ---- booster: "남은시간" UI presence (FIX-9) -------------------------

     The user's rule (AGENT_HANDOFF.md §4) is that the booster is judged by
     whether this UI is on screen, never by its digits, and that the existing
     anchor search - which works well - is kept exactly as it was: the same
     template crop, the same w*0.25..0.75 x top-250px window, the same 0.78
     threshold.

     What is gone is the OCR. The 2026-09-05 build read the countdown here and
     let a failed read look like the UI being absent. This function is now
     synchronous and returns in one template match, which is also what §5.4
     asks for: the presence answer must not queue behind any OCR. */

  var BOOSTER_MATCH_THRESHOLD = 0.78;

  function BoosterDetector() { this.anchor = null; this.threshold = BOOSTER_MATCH_THRESHOLD; }

  BoosterDetector.prototype.load = function (base) {
    var self_ = this;
    return loadTemplate((base || '') + 'assets/candidates/booster_timer.png')
      .then(function (m) {
        if (m) { self_.anchor = roi(m, 5, 6, 78 - 5, 27 - 6); m.delete(); }
        return self_;
      });
  };

  /* Returns a BoosterUiObservation body (§4.2):
       presence: PRESENT | ABSENT | UNKNOWN, score, bbox, reason
     `frameValid` is the caller's verdict on whether this is a usable game
     screen at all; without it, absence can never be asserted. */
  BoosterDetector.prototype.observe = function (image, frameValid) {
    if (!this.anchor) {
      return { presence: 'UNKNOWN', score: null, bbox: null, reason: 'anchor_template_missing' };
    }
    if (frameValid === false) {
      return { presence: 'UNKNOWN', score: null, bbox: null, reason: 'frame_not_valid' };
    }
    var h = image.rows, w = image.cols;
    var ax = Math.trunc(w * 0.25);
    var area = roi(image, ax, 0, Math.trunc(w * 0.75) - ax, Math.min(250, h));
    if (!area || area.rows < this.anchor.rows || area.cols < this.anchor.cols) {
      if (area) area.delete();
      return { presence: 'UNKNOWN', score: null, bbox: null, reason: 'search_area_too_small' };
    }
    var res = new cv.Mat();
    cv.matchTemplate(area, this.anchor, res, cv.TM_CCOEFF_NORMED);
    var mm = cv.minMaxLoc(res);
    res.delete(); area.delete();
    if (mm.maxVal < this.threshold) {
      return { presence: 'ABSENT', score: mm.maxVal, bbox: null, reason: 'below_threshold',
               threshold: this.threshold };
    }
    var x = mm.maxLoc.x + ax - 5, y = mm.maxLoc.y - 6;
    return {
      presence: 'PRESENT', score: mm.maxVal,
      bbox: [x, y, 202, 57],
      // Kept as geometry for the preview panel only; nothing reads it.
      number_rect: [x + 80, Math.max(0, y + 8), 183 - 80, (y + 48) - Math.max(0, y + 8)],
      reason: 'anchor_matched', threshold: this.threshold
    };
  };

  /* Read the widget's digits.

     This exists ONLY to place the on-screen countdown (user request,
     2026-09-06: "부스터는 최초 1회 싱크를 맞춘 후, 자동 타이머로 넘어간다").
     Nothing here reaches BoosterUiState: the alert is still UI presence plus
     the rune duration, and a failed read leaves the display unsynced rather
     than implying anything about the UI being gone. */
  var BOOSTER_NUMBER_RE = /^(\d{1,3})[.,](\d{1,2})$/;

  BoosterDetector.prototype.readNumber = function (image, obs, ocr) {
    if (!ocr || !obs || obs.presence !== 'PRESENT' || !obs.number_rect) {
      return Promise.resolve({ seconds: null, reason: 'not_present' });
    }
    var r = obs.number_rect;
    var crop = roi(image, r[0], r[1], r[2], r[3]);
    if (!crop) return Promise.resolve({ seconds: null, reason: 'no_crop' });
    return ocr.line(crop).then(function (res) {
      crop.delete();
      var text = (res.text || '').trim();
      var m = BOOSTER_NUMBER_RE.exec(text);
      if (!m || res.score < 0.85) {
        return { seconds: null, raw: text, score: res.score, reason: 'unreadable' };
      }
      var v = parseFloat(m[1] + '.' + m[2]);
      if (!(v >= 0 && v <= 100)) {
        return { seconds: null, raw: text, score: res.score, reason: 'out_of_range' };
      }
      return { seconds: v, raw: text, score: res.score, reason: 'read' };
    }, function (e) {
      try { crop.delete(); } catch (x) {}
      return { seconds: null, reason: 'error:' + (e && e.message ? e.message : e) };
    });
  };

  root.detectors = {
    RuneDetector: RuneDetector,
    BoosterDetector: BoosterDetector,
    BOOSTER_MATCH_THRESHOLD: BOOSTER_MATCH_THRESHOLD
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
