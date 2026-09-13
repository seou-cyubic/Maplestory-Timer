/* PaddleOCR-style text recognition on onnxruntime-web.
   Byte-for-byte port of the RapidOCR recognition path used by the legacy
   Python app (rec only; `use_det=False`), so the same models produce the same
   strings and the same confidence scores.

   Pipeline (legacy/.venv/.../rapidocr/ch_ppocr_rec/main.py):
     rec_img_shape = [3, 48, 320]
     max_wh_ratio  = max(320/48, w/h)
     img_width     = int(48 * max_wh_ratio)
     resized_w     = min(ceil(48 * w/h), img_width)
     resize -> (resized_w, 48) INTER_LINEAR, keep BGR channel order
     CHW, /255, -0.5, /0.5, zero-pad right to img_width
   Decode: CTC greedy, blank = class 0, score = mean of kept max-probs. */
(function (root) {
  'use strict';

  var REC_H = 48, REC_W = 320;
  var MIN_SIDE = 30, MAX_SIDE = 2000;   // rapidocr Global.use_preprocess_img bounds

  function OcrEngine(session, vocab, name) {
    this.session = session;
    this.vocab = vocab;
    this.name = name;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.calls = 0;
    this.totalMs = 0;
  }

  OcrEngine.create = function (modelUrl, charsetUrl, name) {
    return Promise.all([
      ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
      fetch(charsetUrl).then(function (r) {
        if (!r.ok) throw new Error('charset ' + charsetUrl + ' -> HTTP ' + r.status);
        return r.json();
      })
    ]).then(function (parts) {
      return new OcrEngine(parts[0], parts[1], name);
    });
  };

  /* rapidocr resize_image_within_bounds: only kicks in for very small/large crops. */
  function boundSides(mat) {
    var h = mat.rows, w = mat.cols;
    var maxV = Math.max(h, w), minV = Math.min(h, w);
    if (maxV <= MAX_SIDE && minV >= MIN_SIDE) return null;
    var ratio = 1.0;
    if (maxV > MAX_SIDE) ratio = MAX_SIDE / maxV;
    var nh = Math.round(h * ratio), nw = Math.round(w * ratio);
    if (Math.min(nh, nw) < MIN_SIDE) {
      var r2 = MIN_SIDE / Math.min(nh, nw);
      nh = Math.round(nh * r2); nw = Math.round(nw * r2);
    }
    var out = new cv.Mat();
    cv.resize(mat, out, new cv.Size(Math.max(1, nw), Math.max(1, nh)), 0, 0, cv.INTER_LINEAR);
    return out;
  }

  /* mat: cv.Mat, CV_8UC3, BGR (same convention the Python code feeds in). */
  OcrEngine.prototype.run = function (mat) {
    var t0 = (self.performance || Date).now();
    var self_ = this;
    if (!mat || mat.rows === 0 || mat.cols === 0) return Promise.resolve({ text: '', score: 0 });

    var bounded = boundSides(mat);
    var srcMat = bounded || mat;

    var h = srcMat.rows, w = srcMat.cols;
    var maxWhRatio = Math.max(REC_W / REC_H, w / h);
    var imgWidth = Math.trunc(REC_H * maxWhRatio);
    var wanted = Math.ceil(REC_H * (w / h));
    var resizedW = wanted > imgWidth ? imgWidth : Math.trunc(wanted);
    resizedW = Math.max(1, resizedW);

    var resized = new cv.Mat();
    cv.resize(srcMat, resized, new cv.Size(resizedW, REC_H), 0, 0, cv.INTER_LINEAR);

    var plane = REC_H * imgWidth;
    var data = new Float32Array(3 * plane);          // zero-padded by construction
    var px = resized.data;                            // BGR, row-major, 3 channels
    var step = resized.cols * 3;
    for (var y = 0; y < REC_H; y++) {
      var rowOff = y * step, outRow = y * imgWidth;
      for (var x = 0; x < resizedW; x++) {
        var i = rowOff + x * 3, o = outRow + x;
        data[o] = (px[i] / 255 - 0.5) / 0.5;                    // B
        data[plane + o] = (px[i + 1] / 255 - 0.5) / 0.5;        // G
        data[2 * plane + o] = (px[i + 2] / 255 - 0.5) / 0.5;    // R
      }
    }
    resized.delete();
    if (bounded) bounded.delete();

    var feeds = {};
    feeds[this.inputName] = new ort.Tensor('float32', data, [1, 3, REC_H, imgWidth]);
    return this.session.run(feeds).then(function (out) {
      var t = out[self_.outputName];
      var res = self_.decode(t.data, t.dims);
      self_.calls += 1;
      self_.totalMs += (self.performance || Date).now() - t0;
      return res;
    });
  };

  /* CTC greedy decode with duplicate removal; class 0 is blank. */
  OcrEngine.prototype.decode = function (buf, dims) {
    var T = dims[1], C = dims[2];
    var chars = [], confs = [], prev = -1;
    var needSoftmax = false;
    for (var t = 0; t < T; t++) {
      var base = t * C, best = 0, bestVal = -Infinity, sum = 0;
      for (var c = 0; c < C; c++) {
        var v = buf[base + c];
        if (v > bestVal) { bestVal = v; best = c; }
      }
      if (bestVal > 1.5 || bestVal < 0) {
        // Model emits logits: normalise this step so scores stay comparable.
        needSoftmax = true;
        var mx = bestVal;
        for (var k = 0; k < C; k++) sum += Math.exp(buf[base + k] - mx);
        bestVal = 1 / sum;
      }
      if (best !== 0 && best !== prev) {
        chars.push(this.vocab[best] === undefined ? '' : this.vocab[best]);
        confs.push(Math.round(bestVal * 100000) / 100000);
      }
      prev = best;
    }
    if (!confs.length) return { text: '', score: 0, softmax: needSoftmax };
    var mean = 0;
    for (var j = 0; j < confs.length; j++) mean += confs[j];
    mean = Math.round((mean / confs.length) * 100000) / 100000;
    return { text: chars.join(''), score: mean, softmax: needSoftmax };
  };

  root.OcrEngine = OcrEngine;
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
