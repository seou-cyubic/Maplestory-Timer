/* Rune marker, booster UI, lie-detector popup.
   Presence detection only: never decodes or answers a CAPTCHA challenge.

   Two parts cannot be carried over verbatim from the Python build and are
   substituted explicitly:
     * SIFT  - not present in every OpenCV.js build. Detected at runtime; when
               missing, multi-scale TM_CCOEFF_NORMED on the same reference
               regions is used instead (the popup is axis-aligned in practice).
     * DB text detection - the Python fallback ran full PP-OCR (det+rec) over
               the centre crop. Only the recogniser is ported, so text lines are
               proposed with a morphological pass instead of the DB network.
   Both substitutions are reported in the observation as `method`.

   Changes against the 2026-09-05 build:
     FIX-9   BoosterDetector reports UI presence only. No digits are read, so
             a number that cannot be recognised can never be mistaken for the
             UI being gone, and nothing downstream can measure booster time.
     FIX-11  LieDetector requires structurally consistent evidence at one
             candidate position. A single thin instruction strip, or two
             unrelated hits in different corners of the screen, no longer make
             a popup. Load/analysis failure is UNKNOWN, not "absent". */
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

  /* ---- lie detector ---------------------------------------------------- */

  // Only stable instruction regions, excluding challenge text and answers.
  // `thin` marks a strip that carries too little structure to stand alone.
  var LIE_REGIONS = [
    { file: 'user_type_1.webp', box: [20, 48, 220, 117], thin: false },
    { file: 'user_type_2.webp', box: [20, 62, 218, 215], thin: false },
    { file: 'user_type_3.webp', box: [24, 42, 329, 244], thin: false },
    { file: 'user_type_4.webp', box: [45, 55, 284, 89], thin: false },
    { file: 'video_frame_0.png', box: [0, 0, 460, 24], thin: true },
    { file: 'video_frame_0.png', box: [75, 323, 432, 360], thin: true },
    { file: 'violet_controls.png', box: [0, 0, 519, 51], thin: true }
  ];
  var PHRASES = ['거짓말탐지기', '입력을위해먼저', '올바른문장을선택', '아래이미지안의한글',
                 '마우스를움직여따라가', '매크로로적발', 'LIEDETECTOR'];
  var GENERIC = ['거짓말탐지기', '매크로로적발'];
  var SCALES = [0.7, 0.85, 1.0, 1.15, 1.3];

  // A popup is a dialog, not the whole screen: evidence has to sit together.
  var CLUSTER_RADIUS = 360;
  var TITLE_BAR_ROWS = 8;

  function LieDetector(koreanEngine, opts) {
    opts = opts || {};
    this.ocr = koreanEngine;
    this.references = [];
    this.hasSift = false;
    this.sift = null;
    this.matcher = null;
    this.loadError = null;
    this.ocrEveryN = opts.ocrEveryN === undefined ? 3 : opts.ocrEveryN;
    this.calls = 0;
  }

  LieDetector.prototype.load = function (base) {
    var self_ = this;
    this.hasSift = typeof cv.SIFT === 'function';
    if (this.hasSift) {
      try {
        this.sift = new cv.SIFT(1800, 3, 0.02);
        this.matcher = new cv.BFMatcher();
      } catch (e) { this.hasSift = false; this.sift = null; this.matcher = null; }
    }
    return Promise.all(LIE_REGIONS.map(function (entry, idx) {
      return loadTemplate((base || '') + 'assets/lie_detector/' + entry.file).then(function (m) {
        if (!m) return null;
        var b = entry.box;
        var crop = roi(m, b[0], b[1], b[2] - b[0], b[3] - b[1]);
        m.delete();
        if (!crop) return null;
        var gray = new cv.Mat();
        cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
        crop.delete();
        // Each *region* is an independent UI element, so it needs its own key:
        // two regions of the same popup image are two pieces of evidence, and
        // the offset between them is a structural check (see confirmCluster).
        var ref = { name: entry.file + '#' + idx, file: entry.file, thin: entry.thin,
                    gray: gray, region: b, origin: [b[0], b[1]] };
        if (self_.hasSift) {
          ref.kp = new cv.KeyPointVector();
          ref.desc = new cv.Mat();
          var none = new cv.Mat();
          self_.sift.detectAndCompute(gray, none, ref.kp, ref.desc);
          none.delete();
          if (ref.desc.rows === 0) { ref.kp.delete(); ref.desc.delete(); ref.kp = null; ref.desc = null; }
        }
        return ref;
      }).catch(function () { return null; });
    })).then(function (refs) {
      self_.references = refs.filter(Boolean);
      // FIX-11: assets that failed to load must show up as an inability to
      // observe, not as a clean "nothing there".
      if (self_.references.length < LIE_REGIONS.length) {
        self_.loadError = self_.references.length + '/' + LIE_REGIONS.length + ' 참조만 로드됨';
      }
      if (!self_.references.length) self_.loadError = '탐지기 참조 자산을 로드하지 못했습니다.';
      return self_;
    });
  };

  // Scale-swept normalised cross-correlation; the substitute for planar SIFT.
  LieDetector.prototype._templateEvidence = function (gray) {
    var evidence = [];
    for (var i = 0; i < this.references.length; i++) {
      var ref = this.references[i];
      var best = 0, bestScale = null, bestLoc = null;
      for (var s = 0; s < SCALES.length; s++) {
        var sc = SCALES[s];
        var tw = Math.round(ref.gray.cols * sc), th = Math.round(ref.gray.rows * sc);
        if (tw < 12 || th < 8 || tw > gray.cols || th > gray.rows) continue;
        var scaled = new cv.Mat();
        cv.resize(ref.gray, scaled, new cv.Size(tw, th), 0, 0, cv.INTER_AREA);
        var res = new cv.Mat();
        cv.matchTemplate(gray, scaled, res, cv.TM_CCOEFF_NORMED);
        var mm = cv.minMaxLoc(res);
        res.delete(); scaled.delete();
        if (mm.maxVal > best) { best = mm.maxVal; bestScale = sc; bestLoc = [mm.maxLoc.x, mm.maxLoc.y]; }
      }
      if (best >= 0.72) {
        evidence.push({
          method: 'instruction_template', type: ref.name, file: ref.file, thin: ref.thin,
          origin: ref.origin, score: best, scale: bestScale, at: bestLoc,
          bbox: [bestLoc[0], bestLoc[1],
                 Math.round(ref.gray.cols * bestScale), Math.round(ref.gray.rows * bestScale)]
        });
      }
    }
    return evidence;
  };

  LieDetector.prototype._siftEvidence = function (gray) {
    var evidence = [];
    var kp = new cv.KeyPointVector(), desc = new cv.Mat(), none = new cv.Mat();
    try {
      this.sift.detectAndCompute(gray, none, kp, desc);
      if (desc.rows === 0) return evidence;
      for (var i = 0; i < this.references.length; i++) {
        var ref = this.references[i];
        if (!ref.desc) continue;
        var matches = new cv.DMatchVectorVector();
        this.matcher.knnMatch(ref.desc, desc, matches, 2);
        var srcPts = [], dstPts = [];
        for (var m = 0; m < matches.size(); m++) {
          var pair = matches.get(m);
          if (pair.size() !== 2) { pair.delete && pair.delete(); continue; }
          var a = pair.get(0), b = pair.get(1);
          if (a.distance < 0.70 * b.distance) {
            var p = ref.kp.get(a.queryIdx).pt, q = kp.get(a.trainIdx).pt;
            srcPts.push(p.x, p.y); dstPts.push(q.x, q.y);
          }
        }
        matches.delete();
        var good = srcPts.length / 2;
        if (good < 6) continue;
        var src = cv.matFromArray(good, 1, cv.CV_32FC2, srcPts);
        var dst = cv.matFromArray(good, 1, cv.CV_32FC2, dstPts);
        var mask = new cv.Mat();
        var H = cv.findHomography(src, dst, cv.RANSAC, 4, mask);
        var inliers = 0;
        for (var k = 0; k < mask.rows; k++) if (mask.data[k]) inliers++;
        var ratio = inliers / good;
        var ok = H && !H.empty() && inliers >= 6 && ratio >= 0.65;
        var bbox = null;
        if (ok) {
          // Same plausibility gate as the Python build: projected area within
          // 0.2x..6x of the reference, and a convex quadrilateral.
          var corners = cv.matFromArray(4, 1, cv.CV_32FC2,
            [0, 0, ref.gray.cols, 0, ref.gray.cols, ref.gray.rows, 0, ref.gray.rows]);
          var proj = new cv.Mat();
          cv.perspectiveTransform(corners, proj, H);
          var pts = [], xs = [], ys = [];
          for (var q = 0; q < 4; q++) {
            var px = proj.data32F[q * 2], py = proj.data32F[q * 2 + 1];
            pts.push(px, py); xs.push(px); ys.push(py);
          }
          var quad = cv.matFromArray(4, 1, cv.CV_32SC2, pts.map(Math.round));
          var areaAbs = Math.abs(cv.contourArea(quad));
          var scale = areaAbs / (ref.gray.rows * ref.gray.cols);
          if (!(scale > 0.2 && scale < 6 && cv.isContourConvex(quad))) ok = false;
          else bbox = [Math.round(Math.min.apply(null, xs)), Math.round(Math.min.apply(null, ys)),
                       Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)),
                       Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys))];
          corners.delete(); proj.delete(); quad.delete();
        }
        src.delete(); dst.delete(); mask.delete(); if (H) H.delete();
        if (ok) evidence.push({ method: 'instruction_features', type: ref.name, file: ref.file,
                                thin: ref.thin, origin: ref.origin, scale: 1,
                                inliers: inliers, ratio: ratio, bbox: bbox });
      }
    } finally { kp.delete(); desc.delete(); none.delete(); }
    return evidence;
  };

  /* Morphological line proposal, standing in for the DB text detector. */
  function proposeTextLines(gray) {
    var s = new Scope();
    try {
      var bin = s.add(new cv.Mat());
      cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      var kernel = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(17, 3)));
      var closed = s.add(new cv.Mat());
      cv.morphologyEx(bin, closed, cv.MORPH_CLOSE, kernel);
      var contours = vision.contourList(closed); s.add(contours);
      var boxes = [];
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        var r = cv.boundingRect(c);
        c.delete();
        if (r.width >= 24 && r.height >= 9 && r.height <= 64 && r.width / r.height >= 1.2) {
          boxes.push([r.x, r.y, r.width, r.height]);
        }
      }
      boxes.sort(function (a, b) { return b[2] * b[3] - a[2] * a[3]; });
      return boxes.slice(0, 24);
    } finally { s.done(); }
  }

  // difflib.SequenceMatcher.ratio() approximated by 2*LCS/(len(a)+len(b)).
  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    var prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
    for (var i = 1; i <= a.length; i++) {
      for (var j = 1; j <= b.length; j++) {
        cur[j] = a.charAt(i - 1) === b.charAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      prev.set(cur); cur.fill(0);
    }
    return (2 * prev[b.length]) / (a.length + b.length);
  }

  /* FIX-11: structural gate.

     The 2026-09-05 run raised the popup on ordinary combat scenery and on the
     window title bar, scoring 0.726..0.765 against `video_frame_0.png` and
     `user_type_1.webp`. Those are the thin strips. The fix is not a higher
     threshold - that would lose real positives - but a requirement that the
     evidence describe one dialog:

       * anything sitting in the window title-bar band is dropped outright;
       * evidence is clustered by position, a popup being one place on screen;
       * a cluster counts only with two distinct references, or one
         information-rich reference plus the fixed instruction text found in
         the same place. */
  function centreOf(b) { return [b[0] + b[2] / 2, b[1] + b[3] / 2]; }
  function weakOf(cl) {
    return { bbox: cl.bbox, types: Object.keys(cl.types), strong: cl.strong.length,
             why: cl.verdict ? cl.verdict.detail : null };
  }

  function clusterEvidence(evidence) {
    var clusters = [];
    evidence.forEach(function (e) {
      if (!e.bbox) return;
      var c = centreOf(e.bbox);
      for (var i = 0; i < clusters.length; i++) {
        var cc = clusters[i].centre;
        if (Math.abs(cc[0] - c[0]) <= CLUSTER_RADIUS && Math.abs(cc[1] - c[1]) <= CLUSTER_RADIUS) {
          clusters[i].items.push(e);
          var n = clusters[i].items.length;
          clusters[i].centre = [(cc[0] * (n - 1) + c[0]) / n, (cc[1] * (n - 1) + c[1]) / n];
          return;
        }
      }
      clusters.push({ centre: c, items: [e] });
    });
    clusters.forEach(function (cl) {
      var xs = [], ys = [], xe = [], ye = [];
      cl.items.forEach(function (e) {
        xs.push(e.bbox[0]); ys.push(e.bbox[1]);
        xe.push(e.bbox[0] + e.bbox[2]); ye.push(e.bbox[1] + e.bbox[3]);
      });
      var x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
      cl.bbox = [x, y, Math.max.apply(null, xe) - x, Math.max.apply(null, ye) - y];
      cl.types = {};
      cl.files = {};
      cl.items.forEach(function (e) { cl.types[e.type] = 1; cl.files[e.file || e.type] = 1; });
      cl.distinctTypes = Object.keys(cl.types).length;
      cl.distinctFiles = Object.keys(cl.files).length;
      cl.strong = cl.items.filter(function (e) { return !e.thin; });
      cl.geometry = geometryAgreement(cl.items);
    });
    return clusters;
  }

  /* Do two regions of the SAME reference image appear at the offset they have
     in that image? Measured 2026-09-06: video_frame_0.png regions 0 and 1 sit
     at (0,0) and (75,323) and a genuine popup reproduces that offset, whereas
     two coincidental scenery matches do not. */
  function geometryAgreement(items) {
    for (var i = 0; i < items.length; i++) {
      for (var j = i + 1; j < items.length; j++) {
        var a = items[i], b = items[j];
        if (!a.file || a.file !== b.file || a.type === b.type) continue;
        if (!a.origin || !b.origin || !a.bbox || !b.bbox) continue;
        var scale = ((a.scale || 1) + (b.scale || 1)) / 2;
        var wantX = (b.origin[0] - a.origin[0]) * scale;
        var wantY = (b.origin[1] - a.origin[1]) * scale;
        var gotX = b.bbox[0] - a.bbox[0];
        var gotY = b.bbox[1] - a.bbox[1];
        var dist = Math.sqrt(wantX * wantX + wantY * wantY);
        var tol = Math.max(24, dist * 0.20);
        var dx = gotX - wantX, dy = gotY - wantY;
        if (Math.sqrt(dx * dx + dy * dy) <= tol) {
          return { pair: [a.type, b.type], want: [Math.round(wantX), Math.round(wantY)],
                   got: [gotX, gotY], tolerance: Math.round(tol) };
        }
      }
    }
    return null;
  }

  /* Acceptance routes for a cluster. Deliberately several routes rather than
     one raised threshold, so real positives are not thrown away (6.3):

       A  two regions of the same reference at their true relative offset
       B  two different references in one place, with a convincing non-thin one
       D  one large, information-rich instruction block matched near-exactly
       C  the caller handles the fixed instruction text, alone or with support

     A single *thin* strip never confirms on its own - that is what raised the
     popup on combat scenery and on the window title bar on 2026-09-05, where
     the evidence scored 0.726..0.765. Route D exists because some popups have
     exactly one registered region (user_type_3 is 305x202 px of instruction
     art); refusing those outright would be the "raise the threshold and lose
     real positives" mistake §6.3 warns about. Its 0.90 floor sits well above
     the 2026-09-05 false positives and well below a genuine match.

     Note on evidence: the only popup images in this project are the reference
     assets themselves, so route D's floor is calibrated against those plus the
     real combat frames as negatives. It has not been checked against an
     independent live popup capture. */
  var STRONG_SCORE = 0.80;
  var SOLO_SCORE = 0.90;
  var SOLO_MIN_AREA = 12000;
  function confirmCluster(cl) {
    if (cl.geometry) return { ok: true, route: 'A_same_reference_geometry', detail: cl.geometry };
    if (cl.distinctFiles >= 2) {
      var convincing = cl.strong.filter(function (e) {
        return e.score === undefined || e.score >= STRONG_SCORE;
      });
      if (convincing.length >= 1) {
        return { ok: true, route: 'B_multiple_references_same_place',
                 detail: { files: Object.keys(cl.files), strong: convincing.length } };
      }
      return { ok: false, route: null, detail: { reason: 'no_convincing_strong_region' } };
    }
    var solo = cl.strong.filter(function (e) {
      var area = e.bbox ? e.bbox[2] * e.bbox[3] : 0;
      return area >= SOLO_MIN_AREA && (e.score === undefined || e.score >= SOLO_SCORE);
    });
    if (solo.length) {
      return { ok: true, route: 'D_single_rich_instruction_block',
               detail: { type: solo[0].type, score: solo[0].score,
                         area: solo[0].bbox[2] * solo[0].bbox[3] } };
    }
    return { ok: false, route: null,
             detail: { reason: cl.strong.length ? 'single_region_below_solo_floor' : 'thin_strip_only',
                       best: cl.strong.length ? cl.strong[0].score : null } };
  }

  LieDetector.prototype.observe = function (image) {
    var self_ = this;
    self_.calls += 1;
    if (!self_.references.length) {
      return Promise.resolve({ present: false, status: 'unknown', evidence: [],
                               reason: self_.loadError || 'no_references',
                               matcher: self_.hasSift ? 'sift' : 'template' });
    }
    var gray = new cv.Mat();
    cv.cvtColor(image, gray, cv.COLOR_BGR2GRAY);
    var raw;
    try {
      raw = self_.hasSift ? self_._siftEvidence(gray) : self_._templateEvidence(gray);
    } catch (e) {
      gray.delete();
      return Promise.resolve({ present: false, status: 'unknown', evidence: [],
                               reason: 'match_failed:' + (e && e.message ? e.message : e),
                               matcher: self_.hasSift ? 'sift' : 'template' });
    }

    // §6.3: the window title bar and border belong outside the calibrated game
    // area. If calibration let them in, a full-width strip at the very top is
    // never popup evidence.
    var dropped = [];
    var evidence = raw.filter(function (e) {
      if (!e.bbox) { dropped.push({ type: e.type, reason: 'no_bbox' }); return false; }
      // Only meaningful on a real client-sized frame; a small reference image
      // is not a game window with a title bar.
      if (image.cols >= 900 && e.bbox[1] <= TITLE_BAR_ROWS &&
          e.bbox[2] >= image.cols * 0.85 && e.bbox[3] <= 60) {
        dropped.push({ type: e.type, reason: 'title_bar_band', bbox: e.bbox });
        return false;
      }
      return true;
    });

    var clusters = clusterEvidence(evidence);
    clusters.forEach(function (cl) { cl.verdict = confirmCluster(cl); });
    var confirmed = clusters.filter(function (cl) { return cl.verdict.ok; });
    var needsOcr = confirmed.length === 0 &&
      (clusters.length > 0 || (self_.ocrEveryN > 0 && self_.calls % self_.ocrEveryN === 1));

    if (confirmed.length) {
      gray.delete();
      var best = confirmed.sort(function (a, b) { return b.distinctTypes - a.distinctTypes; })[0];
      return Promise.resolve({
        present: true, status: 'observed',
        evidence: best.items, candidate_bbox: best.bbox,
        reason: best.verdict.route, verdict: best.verdict.detail,
        clusters: clusters.length, dropped: dropped,
        matcher: self_.hasSift ? 'sift' : 'template'
      });
    }

    if (!needsOcr) {
      gray.delete();
      return Promise.resolve({
        present: false, status: 'observed', evidence: [],
        weak_evidence: clusters.map(weakOf),
        reason: clusters.length ? 'evidence_not_structurally_consistent' : 'no_evidence',
        dropped: dropped,
        matcher: self_.hasSift ? 'sift' : 'template'
      });
    }

    // Semantic fallback handles instruction noise and layout changes.
    // OCR output is used transiently; challenge contents are not logged or returned.
    var work = gray, scale = 1, ox = 0, oy = 0;
    if (image.cols > 960) {
      var ih = image.rows, iw = image.cols;
      ox = Math.trunc(iw * 0.12); oy = Math.trunc(ih * 0.04);
      var sub = roi(gray, ox, oy, Math.trunc(iw * 0.88) - ox, Math.trunc(ih * 0.82) - oy);
      if (sub) {
        scale = 800 / sub.cols;
        work = new cv.Mat();
        cv.resize(sub, work, new cv.Size(800, Math.round(sub.rows * scale)), 0, 0, cv.INTER_AREA);
        sub.delete(); gray.delete();
      }
    }
    var boxes = proposeTextLines(work);
    var strings = [], hitBoxes = [];
    var chain = Promise.resolve();
    boxes.forEach(function (b) {
      chain = chain.then(function () {
        var pad = 2;
        var line = roi(work, b[0] - pad, b[1] - pad, b[2] + 2 * pad, b[3] + 2 * pad);
        if (!line) return;
        var bgr = new cv.Mat();
        cv.cvtColor(line, bgr, cv.COLOR_GRAY2BGR);
        line.delete();
        return self_.ocr.run(bgr).then(function (r) {
          bgr.delete();
          if (r.score > 0.45 && r.text) {
            strings.push(r.text.replace(/\s+/g, ''));
            hitBoxes.push([Math.round(ox + b[0] / scale), Math.round(oy + b[1] / scale),
                           Math.round(b[2] / scale), Math.round(b[3] / scale)]);
          }
        }, function (e) { bgr.delete(); throw e; });
      });
    });
    return chain.then(function () {
      work.delete();
      var joined = strings.join('');
      var hits = [], hitIdx = [];
      PHRASES.forEach(function (p) {
        if (joined.indexOf(p) !== -1) { hits.push(p); return; }
        for (var i = 0; i < strings.length; i++) {
          if (similarity(p, strings[i]) > 0.72) { hits.push(p); hitIdx.push(i); return; }
        }
      });
      // Generic name alone can occur in chat; require a task-specific instruction.
      var strong = hits.length >= 2 || hits.some(function (h) { return GENERIC.indexOf(h) === -1; });
      if (!(hits.length && strong)) {
        return { present: false, status: 'observed', evidence: [],
                 weak_evidence: clusters.map(weakOf),
                 reason: hits.length ? 'only_generic_phrases' : 'no_instruction_text',
                 ocr_lines: strings.length, dropped: dropped,
                 matcher: self_.hasSift ? 'sift' : 'template' };
      }

      var textBox = null;
      if (hitIdx.length) {
        var xs = [], ys = [], xe = [], ye = [];
        hitIdx.forEach(function (i) {
          var b = hitBoxes[i];
          if (!b) return;
          xs.push(b[0]); ys.push(b[1]); xe.push(b[0] + b[2]); ye.push(b[1] + b[3]);
        });
        if (xs.length) {
          var bx = Math.min.apply(null, xs), by = Math.min.apply(null, ys);
          textBox = [bx, by, Math.max.apply(null, xe) - bx, Math.max.apply(null, ye) - by];
        }
      }

      // §6.3: the instruction text alone is accepted (it is specific and
      // information-rich), or it corroborates a template cluster in the same
      // place. Evidence from a different part of the screen is not combined.
      var support = null;
      if (textBox) {
        var tc = centreOf(textBox);
        support = clusters.filter(function (cl) {
          return Math.abs(cl.centre[0] - tc[0]) <= CLUSTER_RADIUS &&
                 Math.abs(cl.centre[1] - tc[1]) <= CLUSTER_RADIUS;
        })[0] || null;
      }
      var ev = [{ method: 'fixed_instruction_ocr', matched_prompts: hits, lines: strings.length,
                  bbox: textBox, type: 'instruction_text', thin: false }];
      if (support) support.items.forEach(function (e) { ev.push(e); });
      return {
        present: true, status: 'observed', evidence: ev,
        candidate_bbox: support ? support.bbox : textBox,
        reason: support ? 'instruction_text_with_template_support' : 'fixed_instruction_text',
        dropped: dropped,
        matcher: self_.hasSift ? 'sift' : 'template'
      };
    }, function (e) {
      try { work.delete(); } catch (x) {}
      return { present: false, status: 'unknown', evidence: [],
               reason: 'ocr_failed:' + (e && e.message ? e.message : e),
               matcher: self_.hasSift ? 'sift' : 'template' };
    });
  };

  root.detectors = {
    RuneDetector: RuneDetector,
    BoosterDetector: BoosterDetector,
    LieDetector: LieDetector,
    similarity: similarity,
    clusterEvidence: clusterEvidence,
    confirmCluster: confirmCluster,
    geometryAgreement: geometryAgreement,
    BOOSTER_MATCH_THRESHOLD: BOOSTER_MATCH_THRESHOLD
  };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
