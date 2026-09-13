/* Image regression suite.

   Runs the browser vision pipeline over stored screenshots and compares
   against known values. Three kinds of row appear, and they are NOT the same
   kind of evidence:

     [실화면]  a real MapleStory capture stored in this repo
     [합성]    an image this file edits on purpose to create a condition
     [정보]    a measurement, not a pass/fail assertion

   The pure decision logic lives in tools/state_tests.js (node) and is not
   repeated here.

   Two legacy expectations were deliberately replaced, per AGENT_HANDOFF.md §7:
     * the booster's "read 69 seconds" test is gone. The booster no longer
       reads digits at all (§4.1); it is now an anchor presence test.
     * the exp crop test asserted `locked` for a fixed-prior read. `locked`
       now means "this rectangle is being reused", which a first prior read is
       not. The contract is checked both ways below. */
(function () {
  'use strict';

  var out = document.getElementById('out');
  var summary = document.getElementById('summary');
  var pass = 0, fail = 0, info = 0;

  function row(name, ok, got, want) {
    if (ok) pass++; else fail++;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (ok ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>') +
      '</td><td>' + name + '</td><td>' + esc(got) + '</td><td class="dim">' + esc(want) + '</td>';
    out.appendChild(tr);
    tally();
  }
  function measure(name, got) {
    info++;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="dim">정보</span></td><td>' + name +
      '</td><td>' + esc(got) + '</td><td class="dim">—</td>';
    out.appendChild(tr);
    tally();
  }
  function tally() {
    summary.textContent = pass + ' passed, ' + fail + ' failed, ' + info + ' 정보';
    summary.className = fail ? 'bad' : 'ok';
  }
  function esc(v) {
    return String(v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function note(text) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" class="head">' + esc(text) + '</td>';
    out.appendChild(tr);
  }

  function waitForCv() {
    return new Promise(function (resolve, reject) {
      var mod = window.cv;
      if (mod && typeof mod.then === 'function') { mod.then(function (m) { window.cv = m; resolve(); }, reject); return; }
      if (mod && mod.Mat) return resolve();
      var t = setInterval(function () {
        if (window.cv && window.cv.Mat) { clearInterval(t); resolve(); }
      }, 50);
      setTimeout(function () { clearInterval(t); reject(new Error('OpenCV.js 초기화 시간 초과')); }, 60000);
    });
  }

  function loadMat(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return r.blob();
    }).then(createImageBitmap).then(function (bmp) {
      var c = new OffscreenCanvas(bmp.width, bmp.height);
      var g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      var m = ASTRA.vision.matFromImageData(g.getImageData(0, 0, bmp.width, bmp.height));
      bmp.close();
      return m;
    });
  }

  /* ---- pure sanity (the full table is tools/state_tests.js) ------------- */

  function pureTests() {
    var P = ASTRA.parse, S = ASTRA.state, D = ASTRA.display;
    note('순수 로직 요약 — 전체 표는 node tools/state_tests.js');
    row('parse_experience 점 구분자', P.parseExperience('79.580.389.573.127[72.700%]') === '79580389573127',
      P.parseExperience('79.580.389.573.127[72.700%]'), '79580389573127');
    row('parse_experience 불완전 문자열 거부', P.parseExperience('79,58 [72.7%]') === null,
      String(P.parseExperience('79,58 [72.7%]')), 'null');
    row('1:50 = 110초 / 1:49 = 109초',
      P.parseTime('1:50', 'clock') === 110 && P.parseTime('1:49', 'clock') === 109,
      P.parseTime('1:50', 'clock') + '/' + P.parseTime('1:49', 'clock'), '110/109');

    function boost(seq) {
      var m = new S.BoosterUiState(), fired = 0, f = 0;
      seq.forEach(function (s) {
        f++;
        var r = m.update({ presence: s[0], frameId: f, capturedAt: f * 0.5,
          rune: s[1] === undefined ? null : { iconPresence: 'PRESENT', observedSeconds: s[1] } });
        if (r.event) fired++;
      });
      return { fired: fired, state: m.state, decision: m.lastDecision };
    }
    var r149 = boost([['PRESENT'], ['PRESENT'], ['ABSENT', 109], ['ABSENT', 109], ['ABSENT', 109]]);
    var r150 = boost([['PRESENT'], ['PRESENT'], ['ABSENT', 110], ['ABSENT', 110], ['ABSENT', 110]]);
    var r151 = boost([['PRESENT'], ['PRESENT'], ['ABSENT', 111], ['ABSENT', 111], ['ABSENT', 111]]);
    row('부스터 경계 1:49 / 1:50 / 1:51 → 0 / 1 / 1회',
      r149.fired === 0 && r150.fired === 1 && r151.fired === 1,
      r149.fired + '/' + r150.fired + '/' + r151.fired, '0/1/1');
    var never = boost([['ABSENT', 120], ['ABSENT', 120], ['ABSENT', 120]]);
    row('최초부터 UI 없음 → 알림 없음', never.fired === 0 && never.state === 'UNSEEN',
      never.fired + '회 · ' + never.state, '0회 · UNSEEN');

    var d = new D.DisplayCountdown({ seconds: 99, decimals: 2, overrunSeconds: 1 });
    d.start(0, 'x');
    row('표시 전용 부스터 카운트다운 99.00 → 서버 지연',
      d.text(0) === '99.00초' && d.text(12.34) === '86.66초' &&
      d.text(100).indexOf('서버 지연 대기중') === 0,
      d.text(0) + ' / ' + d.text(12.34) + ' / ' + d.text(100),
      '99.00초 / 86.66초 / 서버 지연 대기중 .');
  }

  /* ---- image regression ------------------------------------------------- */

  function fmtN(v) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(3); }

  function visionTests() {
    var V = ASTRA.vision;
    var ocr, classifier, rune, booster, runeReader;
    note('모델 및 자산 로딩');
    var t0 = performance.now();
    return Promise.all([
      ASTRA.OcrEngine.create('models/rec_general.onnx', 'models/rec_general.charset.json', 'general'),
      ASTRA.OcrEngine.create('models/rec_en.onnx', 'models/rec_en.charset.json', 'en')
    ]).then(function (engines) {
      measure('OCR 모델 2종 로드 시간', Math.round(performance.now() - t0) + 'ms');
      ocr = new V.OCR(engines[0], engines[1]);
      classifier = new V.BuffClassifier(ocr);
      rune = new ASTRA.detectors.RuneDetector();
      booster = new ASTRA.detectors.BoosterDetector();
      return Promise.all([classifier.reload('config/labels.json', ''), rune.load(''), booster.load(''),
        ASTRA.glyphs.Atlas.load('config/glyphs.json').then(function (a) {
          // 운영에서와 똑같이 버프 숫자를 글꼴 대조로 읽게 한다.
          /* L2 글꼴까지 넘겨야 운영과 같은 경로가 돈다. 이걸 빼놓았더니
             L2 경로가 자체시험에서 한 번도 실행되지 않아
             "mat.copyTo is not a function" 을 놓쳤다 (2026-09-07). */
          classifier.setFonts({ yellow: a.font('buff_yellow'),
                                minutes: a.font('buff_minutes'),
                                minutesL2: a.font('buff_minutes_l2') });
          return a;
        })]);
    }).then(function (r) {
      row('labels.json + 템플릿 로드', r[0] === 39, r[0] + ' entries', '39 entries');
      /* 아이콘 템플릿이 **칸에 맞게 잘렸는가.**

         U20(룬 쿨타임)을 처음 만들 때 참 칸보다 1px 오른쪽에서 잘랐다. 정합
         점수는 0.97 로 멀쩡했고 탐지도 됐지만, 룬 칸 크롭에 옆 아이콘이 물려
         들어와 사용자가 "지저분하다"고 지적했다. 점수만 보면 안 잡히는
         결함이라 모양으로 잡는다.

         버프 아이콘은 어두운 외곽선 안에 밝은 테두리가 있다. 그래서 맨 바깥
         열은 그 안쪽 열보다 반드시 어둡다. 1px 어긋나면 왼쪽 외곽선이 잘려
         나가고 오른쪽에 옆 칸이 물려 들어 이 관계가 깨진다.

         실측(템플릿 36개): 왼쪽 여유 c1-c0 최소 72.4 · 오른쪽 c30-c31 최소 59.8.
         어긋난 판은 -0.9 / -13.1 이었다. 임계 30 은 양쪽으로 2배 여유다. */
      var FRAME_MARGIN = 30;
      var badFrames = [];
      classifier.registry.forEach(function (item) {
        var t = item._template;
        if (!t || t.cols !== 32 || t.rows !== 32) return;
        var g = new cv.Mat();
        cv.cvtColor(t, g, cv.COLOR_BGR2GRAY);
        function colMean(x) {
          var sum = 0;
          for (var y = 0; y < g.rows; y++) sum += g.data[y * g.cols + x];
          return sum / g.rows;
        }
        var left = colMean(1) - colMean(0), right = colMean(30) - colMean(31);
        g.delete();
        if (left < FRAME_MARGIN || right < FRAME_MARGIN) {
          badFrames.push(item.id + '(좌' + left.toFixed(0) + '/우' + right.toFixed(0) + ')');
        }
      });
      row('아이콘 템플릿이 전부 칸 경계에 맞게 잘렸다 (테두리 검사)',
        badFrames.length === 0, badFrames.length ? badFrames.join(' ') : '36종 모두 통과',
        '어긋난 템플릿 0종');

      runeReader = new V.RuneDurationReader(classifier);
      measure('탐지기 매칭 방식', typeof cv.SIFT === 'function' ? 'SIFT' : '템플릿 대체');

      note('§4.4 룬 지속시간 버프 — 사용자 확인 아이콘 U13(밝은 파랑) / U19(짙은 파랑)');
      var runeItems = runeReader.items().map(function (i) { return i.id; }).sort();
      row('룬 지속시간 버프가 U13 + U19 두 종으로 등록·확인됨',
        runeReader.status() === 'ready' && runeItems.join(',') === 'U13,U19',
        runeReader.status() + ' · ' + runeItems.join(','), 'ready · U13,U19');
      row('U12는 같은 아이콘의 1분 미만 표시라 별칭 처리',
        classifier.find('U12') && classifier.find('U12').alias_of === 'U13',
        classifier.find('U12') ? String(classifier.find('U12').alias_of) : 'missing', 'U13');

      note('[실화면] client.png — 경험치·미니맵·버프 격자');
      return loadMat('assets/candidates/client.png');
    }).then(function (img) {
      var mm = V.detectMinimap(img);
      row('[실화면] detect_minimap', mm && Math.abs(mm[0] - 7) < 4 && Math.abs(mm[1] - 68) < 4 &&
        Math.abs(mm[2] - 195) < 5 && Math.abs(mm[3] - 121) < 5, JSON.stringify(mm), '[7,68,195,121] ±4/±5');

      note('§경험치 — 고정 비트맵 글꼴 정확 대조 (제안 A)');
      var glyphAtlas = null, expFont = null;
      var glyphChecks = ASTRA.glyphs.Atlas.load('config/glyphs.json').then(function (a) {
        glyphAtlas = a; expFont = a.font('exp');
        row('글꼴 아틀라스 적재', !!expFont && expFont.height === 7,
          expFont ? expFont.glyphs.map(function (g) { return g.ch; }).sort().join('') +
            ' (높이 ' + expFont.height + ')' : 'none', '높이 7');
        var t0 = performance.now();
        var r = ASTRA.glyphs.readLine(img, [0, img.rows - 26, img.cols, 26], expFont,
                                      { minRunWidth: 60 });
        var ms = performance.now() - t0;
        row('[실화면] client.png 경험치를 글꼴 대조로 정확히 판독',
          r.ok && r.text === '79.580.389.573.127[72.700%]',
          r.text + ' (' + r.reason + ')', '79.580.389.573.127[72.700%]');
        row('[실화면] 그 문자열이 문법을 통과',
          ASTRA.parse.parseExperience(r.text) === '79580389573127',
          String(ASTRA.parse.parseExperience(r.text)), '79580389573127');
        measure('글꼴 대조 판독 시간 (신경망 없음)', ms.toFixed(2) + 'ms');
        // 통합 경로: ExpLocator 가 글꼴을 받으면 OCR을 아예 부르지 않는다
        var locG = new V.ExpLocator(expFont);
        var ocrCalls = ocr.calls;
        return locG.locate(img, ocr).then(function (e2) {
          row('[실화면] ExpLocator 가 글꼴 경로로 판독하고 OCR을 부르지 않음',
            e2.roi_source === 'glyph' && e2.confirmed === true &&
            e2.value === '79580389573127' && ocr.calls === ocrCalls,
            e2.roi_source + ' · ' + e2.value + ' · OCR 호출 ' + (ocr.calls - ocrCalls) + '회',
            'glyph · 79580389573127 · OCR 0회');
          row('[실화면] 글꼴 경로는 잘림검사를 별도로 하지 않아도 된다',
            e2.truncation === 'glyph_exact' && e2.accept_route === 'glyph_atlas',
            e2.truncation + ' / ' + e2.accept_route, 'glyph_exact / glyph_atlas');
          return null;
        }).then(function () {
        // 잘림은 문법이 아니라 '완전 일치 실패'로 걸린다
        var cut = ASTRA.glyphs.readLine(img, [640, img.rows - 26, img.cols - 640, 26], expFont,
                                        { minRunWidth: 40 });
        row('[합성] 앞을 자른 크롭은 값이 달라지거나 거부됨',
          !cut.ok || ASTRA.parse.parseExperience(cut.text) !== '79580389573127',
          (cut.ok ? cut.text : '거부(' + cut.reason + ')'), '전체 값과 달라야 함');
        return null;
        });
      });

      note('§경험치 — 변화 감지 (숫자 판독과 무관, 2026-09-06 memo)');
      var act = V.expActivityRect(img);
      row('[실화면] 경험치 영역을 OCR 없이 픽셀 투영으로 찾음',
        act.source === 'projection' && act.rect[2] >= 90,
        act.source + ' rect=' + act.rect.join(','), 'projection · 폭 ≥90');
      var sigA = V.activitySignature(img, act.rect);
      row('[실화면] 같은 프레임을 두 번 보면 변화 없음',
        V.signatureDistance(sigA, V.activitySignature(img, act.rect)) === 0,
        String(V.signatureDistance(sigA, V.activitySignature(img, act.rect))), '0');
      var blankAct = new cv.Mat.zeros(img.rows, img.cols, cv.CV_8UC3);
      row('[합성] 글자가 사라지면 큰 변화로 잡힘',
        V.signatureDistance(sigA, V.activitySignature(blankAct, act.rect)) > 50,
        String(V.signatureDistance(sigA, V.activitySignature(blankAct, act.rect))), '> 50');
      row('[합성] 화면 전체 서명은 정지 판별에 쓸 만큼 민감',
        V.signatureDistance(V.frameSignature(img), V.frameSignature(blankAct)) > 100 &&
        V.signatureDistance(V.frameSignature(img), V.frameSignature(img)) === 0,
        V.signatureDistance(V.frameSignature(img), V.frameSignature(blankAct)) + ' / 0', '> 100 / 0');
      blankAct.delete();

      var loc = new V.ExpLocator();
      var priorX = Math.trunc(img.cols * 0.435);
      var priorW = Math.trunc(img.cols * 0.574) - priorX;
      var found = null;
      return loc.locate(img, ocr).then(function (f) {
        found = f;
        row('[실화면] 경험치 ROI 자동 탐색 + 전체 문자열 확정',
          f.value === '79580389573127' && f.roi_source === 'searched' && f.confirmed === true,
          f.value + ' @ [' + f.bbox.join(',') + '] · ' + f.roi_source +
            ' · 확정 ' + f.confirmed + ' · 잘림 ' + f.truncation,
          '79580389573127 · searched · 확정 true');
        row('[실화면] ROI가 상수 prior가 아니라 픽셀에서 도출됨',
          f.bbox[0] !== priorX || f.bbox[2] !== priorW,
          '탐색 ' + f.bbox.join(',') + ' / prior ' + [priorX, img.rows - 12, priorW, 12].join(','),
          'prior와 달라야 함');
        return loc.locate(img, ocr);
      }).then(function (again) {
        // §5.2: `locked` = the rectangle is being reused. `roi_source` = where
        // it came from. The 2026-09-05 build collapsed the two.
        row('[실화면] 두 번째부터 ROI 재사용 (출처는 보존)',
          again.roi_locked === true && again.roi_source === 'searched' && again.searches === 1,
          'locked=' + again.roi_locked + ' 출처=' + again.roi_source + ' 탐색 ' + again.searches + '회',
          'locked=true 출처=searched 탐색 1회');

        // FIX-3: a crop that cuts the leading digits must never be accepted as
        // a complete value. Either the widened re-read reproduces the full
        // number, or nothing is confirmed.
        var narrow = [found.bbox[0] + 44, found.bbox[1], found.bbox[2] - 44, found.bbox[3]];
        var contact = V.edgeContact(img, narrow);
        row('[합성] 앞자리를 자른 크롭에서 글자가 경계에 닿는 것을 검출',
          contact.left === true, 'left=' + contact.left + ' (' + contact.leftPixels + 'px)', 'left=true');
        var probe = new V.ExpLocator();
        return probe.readChecked(img, ocr, narrow).then(function (checked) {
          var value = checked.r ? checked.r.value : null;
          row('[합성] 잘린 크롭을 확정값으로 수용하지 않음 (확장 재판독 또는 미확정)',
            !(checked.confirmed && value !== '79580389573127'),
            '확정 ' + checked.confirmed + ' · 값 ' + value + ' · ' + checked.truncation,
            '확정 false 또는 값 79580389573127');
          measure('잘림 재판독 결과', checked.truncation + ' / ' + value);
        });
      }).then(function () {
        return classifier.classify(img);
      }).then(function (entries) {
        row('[실화면] 버프 격자 개수', entries.length === 9, entries.length, '9');
        var b01 = entries.filter(function (e) { return e.id === 'B01'; })[0];
        var b03 = entries.filter(function (e) { return e.id === 'B03'; })[0];
        // 분 표시는 그 분의 끝을 뜻한다: "28" -> 28*60+59 (사용자 확인 2026-09-06)
        row('[실화면] B01 분 단위 잔여시간 (분:59 규칙)', b01 && b01.remaining_seconds === 1739,
          b01 ? b01.remaining_seconds + ' (raw ' + b01.raw_number + ')' : 'missing', '1739 = 28:59');
        row('[실화면] B03 스택은 시간 아님', b03 && b03.remaining_seconds === null,
          b03 ? String(b03.remaining_seconds) : 'missing', 'null');
        var uniq = {}; entries.forEach(function (e) { uniq[e.bbox[0] + ',' + e.bbox[1]] = 1; });
        row('[실화면] bbox 중복 없음', Object.keys(uniq).length === entries.length,
          Object.keys(uniq).length + '/' + entries.length, '동일');

        note('[실화면] buffs 최적화 — 같은 화면을 다시 봐도 다시 읽지 않는다');
        /* 최적화 두 가지가 실제로 값을 바꾸지 않는지 본다.
             (1) 라벨 없는 칸도 자리로 캐시한다
             (2) 숫자꼴 띠가 없으면 OCR 을 부르지 않는다
           같은 이미지를 두 번 분류해서, 값이 같고 두 번째는 캐시에서 나오는지
           확인한다. 값이 달라지면 최적화가 판정을 바꾼 것이므로 실패다. */
        var firstOcr = classifier.glyphReads;
        var t0 = (self.performance || Date).now();
        return classifier.classify(img).then(function (again) {
          var t1 = (self.performance || Date).now();
          var same = again.length === entries.length;
          for (var i = 0; same && i < again.length; i++) {
            same = again[i].id === entries[i].id &&
                   again[i].remaining_seconds === entries[i].remaining_seconds;
          }
          row('[실화면] 두 번째 분류가 첫 번째와 같은 값을 낸다', same,
            again.length + '칸 일치 ' + same, entries.length + '칸 동일');
          var cached = again.filter(function (e) { return e.from_cache; }).length;
          row('[실화면] 두 번째 분류는 대부분 캐시에서 나온다 (라벨 없는 칸 포함)',
            cached >= Math.ceil(again.length * 0.8), cached + '/' + again.length,
            '80% 이상');
          measure('두 번째 분류 소요', (t1 - t0).toFixed(1) + 'ms');
          var tg = classifier.timing || {};
          measure('두 번째 분류 구간', '윤곽 ' + Math.round(tg.contour_ms) + 'ms · 정합 ' +
            Math.round(tg.match_ms) + 'ms(' + tg.match_calls + '회) · 판독 ' +
            Math.round(tg.describe_ms) + 'ms · 칸 ' + tg.cells);
          measure('칸별 캐시', again.map(function (e) {
            return e.id + ':' + (e.from_cache ? 'C' : e.number_source) + ':' + e.time_mode;
          }).join(' '));
          measure('숫자 미표시로 OCR 을 건너뛴 칸(누적)', String(classifier.glyphNoBand || 0));
          return again;
        }).then(function () { return entries; });
      }).then(function (entries) {

        note('[실화면] 부스터 UI 앵커 — 음성 (부스터 없는 화면)');
        var b = booster.observe(img, true);
        row('[실화면] client.png 부스터 UI 없음', b.presence === 'ABSENT',
          b.presence + ' 정합 ' + Number(b.score).toFixed(4), 'ABSENT');
        img.delete();

        note('[실화면] timed_client.png');
        return loadMat('assets/candidates/timed_client.png');
      });
    }).then(function (img) {
      return classifier.classify(img).then(function (entries) {
        row('[실화면] 버프 격자 개수', entries.length === 10, entries.length, '10');
        var t01 = entries.filter(function (e) { return e.id === 'T01'; })[0];
        var t02 = entries.filter(function (e) { return e.id === 'T02'; })[0];
        row('[실화면] T01 m:ss 초 단위', t01 && t01.remaining_seconds === 165,
          t01 ? t01.remaining_seconds + ' (raw ' + t01.raw_number + ')' : 'missing', '165');
        row('[실화면] T02 분 단위 (분:59 규칙)', t02 && t02.remaining_seconds === 2399,
          t02 ? t02.remaining_seconds + ' (raw ' + t02.raw_number + ')' : 'missing', '2399 = 39:59');
        var b = booster.observe(img, true);
        row('[실화면] timed_client.png 부스터 UI 없음', b.presence === 'ABSENT',
          b.presence + ' 정합 ' + Number(b.score).toFixed(4), 'ABSENT');
        img.delete();

        note('[합성] 빈 화면');
        var blank = new cv.Mat.zeros(768, 1366, cv.CV_8UC3);
        row('[합성] 빈 화면은 유효 프레임이 아님 (ABSENT가 아니라 판정 보류 근거)',
          V.frameValidity(blank).valid === false,
          V.frameValidity(blank).reason, 'flat/black');
        row('[합성] 빈 화면 부스터 = UNKNOWN (frameValid=false)',
          booster.observe(blank, false).presence === 'UNKNOWN',
          booster.observe(blank, false).presence + '/' + booster.observe(blank, false).reason,
          'UNKNOWN');
        row('[합성] 빈 화면 미니맵 없음', V.detectMinimap(blank) === null, String(V.detectMinimap(blank)), 'null');
        return V.detectExp(blank, ocr).then(function (e) {
          row('[합성] 빈 화면 경험치 없음', e.value === null, String(e.value), 'null');
          return classifier.classify(blank);
        }).then(function (list) {
          row('[합성] 빈 화면 버프 없음', list.length === 0, list.length, '0');
          blank.delete();
          note('[실화면] live_booster.png — 실사냥 전체 화면 (부스터 UI 있음)');
          return loadMat('assets/samples/live_booster.png');
        }).then(function (img2) {
          return liveTests(img2);
        });
      });
    });

    function liveTests(img) {
      window.__liveImg = img;
      var mm = V.detectMinimap(img);
      var runeObs = rune.observe(img, mm);
      var expResult = null, wealth = null, boosterObs = null, runeDur = null;

      var tExp = performance.now();
      var loc = new V.ExpLocator();
      return loc.locate(img, ocr).then(function (exp) {
        expResult = exp;
        measure('경험치 판독 시간 (모델 예열 후 1회)', Math.round(performance.now() - tExp) + 'ms');
        row('[실화면] 실사냥 경험치 전체 문자열',
          exp.value === '83874301109098' && exp.confirmed === true,
          exp.value + ' · 확정 ' + exp.confirmed + ' · ' + exp.truncation, '83874301109098 · 확정 true');
        row('[실화면] 룬 마커 음성 (미니맵)', runeObs.present === false,
          runeObs.present + ' (정합 ' + Number(runeObs.score).toFixed(3) + ')', 'false');

        note('§4 부스터 — UI 존재 판정 (숫자 판독 없음)');
        var tB = performance.now();
        boosterObs = booster.observe(img, true);
        var boosterMs = performance.now() - tB;
        measure('부스터 UI 판정 시간 (OCR 없음)', boosterMs.toFixed(1) + 'ms');
        row('[실화면] 부스터 UI PRESENT',
          boosterObs.presence === 'PRESENT' && !!boosterObs.bbox,
          boosterObs.presence + ' 정합 ' + Number(boosterObs.score).toFixed(4) +
            ' bbox ' + (boosterObs.bbox || []).join(','), 'PRESENT');
        row('[실화면] 부스터 결과에 잔여시간/만료시각 필드가 없음 (§4.1)',
          boosterObs.remaining_seconds === undefined && boosterObs.deadline === undefined &&
          boosterObs.resolution_seconds === undefined,
          Object.keys(boosterObs).join(','), 'remaining_seconds 없음');
        row('[실화면] UI 판정이 0.5초 이내', boosterMs < 500, boosterMs.toFixed(1) + 'ms', '< 500ms');
        // The anchor template was cropped from this very image, so 1.0 here is
        // self-referential. The evidence that matters is the margin against the
        // real screens above, which score ~0.26-0.29.
        measure('앵커 정합 (자기참조 양성)', Number(boosterObs.score).toFixed(4) + ' · 임계 0.78');

        note('§6.2 비약 — 소형 재물 획득의 비약 vs 소형 경험 축적의 비약');
        return classifier.classify(img, ['P04']);
      }).then(function (list4) {
        wealth = list4.length ? list4[0] : null;
        window.__wealthBbox = wealth ? wealth.bbox : null;
        return classifier.classify(img, ['P05']).then(function (list5) {
          var expPotion = list5.length ? list5[0] : null;
          // Measured 2026-09-06: the 재물 potion sits at x=1203 and the 경험
          // potion at x=1235 on this frame; the old top-rows patch separated
          // them by 0.0006 and hooked whichever won.
          row('[실화면] P04(재물)와 P05(경험)이 서로 다른 아이콘에 매칭됨',
            wealth && expPotion && wealth.bbox[0] !== expPotion.bbox[0],
            'P04 x=' + (wealth ? wealth.bbox[0] : '—') + ' / P05 x=' + (expPotion ? expPotion.bbox[0] : '—'),
            '서로 다른 x');
          row('[실화면] P04(재물)는 x=1203, 경쟁 판별에서 P05보다 우세',
            wealth && wealth.bbox[0] === 1203 && wealth.rival_margin > 0,
            (wealth ? 'x=' + wealth.bbox[0] + ' 자기 ' + fmtN(wealth.rival_self) +
              ' vs 상대 ' + fmtN(wealth.rival_other) : 'missing'), 'x=1203 · 마진 > 0');
          row('[실화면] P05(경험)는 x=1235, 경쟁 판별에서 P04보다 우세',
            expPotion && expPotion.bbox[0] === 1235 && expPotion.rival_margin > 0,
            (expPotion ? 'x=' + expPotion.bbox[0] + ' 자기 ' + fmtN(expPotion.rival_self) +
              ' vs 상대 ' + fmtN(expPotion.rival_other) : 'missing'), 'x=1235 · 마진 > 0');
          row('[실화면] 비약 P04 잔여시간 (분:59 규칙)', wealth && wealth.remaining_seconds === 1799,
            wealth ? wealth.remaining_seconds + ' (raw ' + wealth.raw_number + ')' : 'missing', '1799 = 29:59');
          row('[실화면] P04 잔여시간이 검증 상한 1859초(30:59) 이내',
            wealth && wealth.remaining_seconds !== null && wealth.remaining_seconds <= 1859,
            wealth ? String(wealth.remaining_seconds) : 'missing', '≤ 1859');
          return runeReader.observe(img, V.buffVisibility(img), 1);
        });
      }).then(function (rd) {
        runeDur = rd;
        // Verified 2026-09-06 by cropping the cell: live_booster.png really
        // does carry the rune duration buff at x=1043,y=40 showing 3:52, the
        // same icon art as U13.png (top-rows patch 0.9992). This is the only
        // real-screen reading of the rune duration this project has.
        row('[실화면] 실사냥 화면의 룬 지속시간을 3:52 = 232초로 판독',
          rd.iconPresence === 'PRESENT' && rd.observedSeconds === 232 &&
          rd.bbox && rd.bbox[0] === 1043,
          rd.iconPresence + ' @ x=' + (rd.bbox ? rd.bbox[0] : '—') +
            ' · 원문 "' + rd.rawText + '" → ' + rd.observedSeconds + '초',
          'PRESENT @ x=1043 · 232초');
        row('[실화면] 232초 ≥ 110초 — 이 판독이면 소멸 시 알림 대상',
          rd.observedSeconds >= ASTRA.state.RUNE_THRESHOLD_SECONDS,
          rd.observedSeconds + ' ≥ ' + ASTRA.state.RUNE_THRESHOLD_SECONDS, 'true');

        note('§6.4 크롭 계획 — 결과의 프레임/출처 계약');
        var statics = ASTRA.regions.compute(img.cols, img.rows);
        var hud = {
          minimap_bbox: mm, buff_visibility: V.buffVisibility(img), frame_valid: true,
          rune: runeObs, wealth: wealth, booster_ui: boosterObs, rune_duration: runeDur
        };
        var plans = ASTRA.regions.cropPlan(statics, expResult, hud, null, 0);
        function shows(key) { return plans[key].rect.join(', '); }

        // First search on this image: the rectangle came from the pixels
        // (roi_source = searched) but is not yet being reused (locked = false).
        // The reuse half of the contract is asserted on client.png above.
        row('크롭: 경험치 = 탐색으로 찾은 ROI, 재사용 표시는 별도',
          plans.exp.locked === false && shows('exp') === expResult.bbox.join(', ') &&
          plans.exp.src.indexOf('자동 탐색') === 0,
          shows('exp') + ' · locked=' + plans.exp.locked + ' · ' + plans.exp.src,
          expResult.bbox.join(', ') + ' · locked=false(최초 탐색) · 자동 탐색…');

        // The replaced legacy contract: a first prior read is not "locked".
        return V.detectExp(img, ocr).then(function (priorExp) {
          var priorPlan = ASTRA.regions.cropPlan(statics, priorExp, hud, null, 0);
          row('크롭: prior로 읽은 경험치는 고정(locked)이 아니고 출처가 prior로 남음',
            priorPlan.exp.locked === false && priorPlan.exp.src.indexOf('prior') !== -1 &&
            priorPlan.exp.rect.join(', ') === priorExp.bbox.join(', '),
            priorPlan.exp.rect.join(', ') + ' · locked=' + priorPlan.exp.locked +
              ' · ' + priorPlan.exp.src,
            'prior 사각형 · locked=false · prior 출처');

          /* 룬 칸은 **지금 무엇을 근거로 판정하는지**를 보여준다
             (사용자 지시 2026-09-07). 글로 쓰는 세 상태와 순서가 같아야 하므로
             세 경우를 모두 건다 — 하나만 걸면 우선순위가 뒤집혀도 안 잡힌다.
             이 화면(live_rune_dark.png)에는 룬 지속시간 아이콘이 실제로 있다. */
          row('크롭: 룬 발동 중이면 룬 지속시간 아이콘을 보여준다',
            !!runeDur && runeDur.iconPresence === 'PRESENT' &&
            plans.rune.locked && shows('rune') === runeDur.bbox.join(', '),
            shows('rune') + ' · ' + plans.rune.src,
            (runeDur && runeDur.bbox ? runeDur.bbox.join(', ') : '?') + ' · 룬 지속시간 버프 아이콘');

          var coolHud = {
            minimap_bbox: mm, buff_visibility: hud.buff_visibility, frame_valid: true,
            rune: runeObs, wealth: wealth, booster_ui: boosterObs,
            rune_duration: { iconPresence: 'ABSENT', bbox: null, observedSeconds: null },
            rune_cooldown: { present: true, remaining_seconds: 659, raw: '10',
                             match_score: 0.9997, bbox: [1108, 41, 32, 32] }
          };
          var coolPlan = ASTRA.regions.cropPlan(statics, expResult, coolHud, null, 0);
          row('크롭: 발동 중이 아니고 쿨타임이면 쿨타임 아이콘을 보여준다',
            coolPlan.rune.locked && coolPlan.rune.rect.join(', ') === '1108, 41, 32, 32',
            coolPlan.rune.rect.join(', ') + ' · ' + coolPlan.rune.src,
            '1108, 41, 32, 32 · 룬 쿨타임 아이콘 (U20)');

          var idleHud = {
            minimap_bbox: mm, buff_visibility: hud.buff_visibility, frame_valid: true,
            rune: runeObs, wealth: wealth, booster_ui: boosterObs,
            rune_duration: { iconPresence: 'ABSENT', bbox: null, observedSeconds: null },
            rune_cooldown: { present: false, bbox: null }
          };
          var idlePlan = ASTRA.regions.cropPlan(statics, expResult, idleHud, null, 0);
          row('크롭: 둘 다 없으면 미니맵으로 되돌아온다 (룬 표식을 찾는 범위)',
            idlePlan.rune.locked && idlePlan.rune.rect.join(', ') === mm.join(', ') &&
            idlePlan.rune.sub.length === 1,
            idlePlan.rune.rect.join(', ') + ' · 하위 ' + idlePlan.rune.sub.length + '개',
            mm.join(', ') + ' · 하위 1개');
          // null이 들어와도 스위트 전체가 중단되지 않게 한다. 앞선 회귀에서
          // P04가 안 잡히자 여기서 예외가 나 나머지 시험이 아예 실행되지
          // 못했다 — 실패는 실패로 보고되어야 한다.
          row('크롭: 비약 = P04 아이콘으로 좁혀짐',
            !!wealth && plans.wealth.locked && shows('wealth') === wealth.bbox.join(', '),
            shows('wealth'), wealth ? wealth.bbox.join(', ') : 'P04 미검출');
          // sub[0] is the widget's digit area (drawn, never read); sub[1] is
          // the rune duration icon when one was located on the same frame.
          row('크롭: 부스터 = 앵커 bbox, 하위는 숫자 영역(판독 안 함) + 룬 아이콘',
            plans.booster.locked && shows('booster') === boosterObs.bbox.join(', ') &&
            plans.booster.sub.length >= 1 &&
            plans.booster.sub[0].rect.join(',') === boosterObs.number_rect.join(',') &&
            plans.booster.info.indexOf('숫자 판독 안 함') !== -1,
            shows('booster') + ' · 하위 ' + plans.booster.sub.length + '개 · ' +
              plans.booster.info.slice(0, 48),
            boosterObs.bbox.join(', ') + ' · 하위 ≥1 · 숫자 판독 안 함');
          row('크롭: 탐지기 = 미등장이라 탐색 범위로 대체',
            plans.lie.locked === false && shows('lie') === statics.lie_ocr.rect.join(', '),
            shows('lie') + ' · ' + plans.lie.src, statics.lie_ocr.rect.join(', ') + ' · 탐색 범위');

          var idle = ASTRA.regions.cropPlan(statics, null, null, null, 0);
          row('크롭: HUD 없음이면 전부 탐색 범위',
            !idle.rune.locked && !idle.wealth.locked && !idle.booster.locked && !idle.lie.locked &&
            idle.rune.rect.join(',') === statics.minimap_search.rect.join(',') &&
            idle.wealth.rect.join(',') === statics.buff_search.rect.join(',') &&
            idle.booster.rect.join(',') === statics.booster_search.rect.join(','),
            [idle.rune, idle.wealth, idle.booster, idle.lie].map(function (p) { return p.locked; }).join('/'),
            'false/false/false/false');

          note('§4.4 룬 지속시간 실판독 — 실제 아이콘 크롭 및 실화면');
          return runeIconTests(img);
        }).then(function () {
          /* FIX-12 회귀. 이 캡처는 템플릿의 출처가 아닌 독립 실화면이고, 비약이
             시계 표시(4:24)라 상단 patch 정합이 0.852까지 떨어진다. 예전 코드는
             임계 0.90에 걸려 두 비약을 모두 놓쳤고, 금색 signature도 35 vs 33으로
             무력화됐다. 시험이 템플릿 출처 이미지만 봐서 이 결함을 놓쳤으므로,
             독립 캡처 회귀를 여기에 둔다. */
          note('§6.2 비약 — 시계 표시 실화면 (독립 캡처, FIX-12 회귀)');
          return loadMat('assets/samples/live_rune_dark.png').then(function (m2) {
            return classifier.classify(m2, ['P04']).then(function (w2) {
              return classifier.classify(m2, ['P05']).then(function (e2) {
                var W = w2[0], E = e2[0];
                row('[실화면] 시계 표시에서도 두 비약을 모두 검출',
                  !!W && !!E, (W ? 'P04 있음' : 'P04 없음') + ' / ' + (E ? 'P05 있음' : 'P05 없음'),
                  '둘 다 검출');
                row('[실화면] 시계 표시 P04(재물) = x1203',
                  W && W.bbox[0] === 1203 && W.rival_margin > 0,
                  W ? 'x=' + W.bbox[0] + ' 마진 ' + fmtN(W.rival_margin) : 'missing', 'x=1203');
                row('[실화면] 시계 표시 P05(경험) = x1235',
                  E && E.bbox[0] === 1235 && E.rival_margin > 0,
                  E ? 'x=' + E.bbox[0] + ' 마진 ' + fmtN(E.rival_margin) : 'missing', 'x=1235');
                measure('시계 표시 정합 점수', (W ? 'P04 ' + fmtN(W.match_score) : '') +
                  (E ? ' / P05 ' + fmtN(E.match_score) : ''));
                m2.delete();
              });
            });
          }).then(function () {
          // Real capture supplied by the user on 2026-09-06; the dark-blue rune
          // is on screen at x=1075 showing 2:12.
          return loadMat('assets/samples/live_rune_dark.png').then(function (m) {
            return runeReader.observe(m, V.buffVisibility(m), 200).then(function (rd) {
              row('[실화면] 새 실사냥 화면(짙은 파랑 룬)에서 2:12 = 132초 판독',
                rd.iconPresence === 'PRESENT' && rd.observedSeconds === 132 &&
                rd.bbox && rd.bbox[0] === 1075,
                rd.iconPresence + ' @ x=' + (rd.bbox ? rd.bbox[0] : '—') + ' · ' +
                  rd.chosenId + ' "' + rd.rawText + '" → ' + rd.observedSeconds + '초',
                'PRESENT @ x=1075 · 132초');
              m.delete();
            });
          });
          });
        }).then(function () {
          note('§6.2 비약 — 숫자가 없는 아이콘');
          return noNumberProbe(window.__liveImg, window.__wealthBbox);
        });
      }).then(function (probe) {
        row('[합성] 숫자 없는 아이콘에서 시간 만들어내지 않음',
          probe.after.remaining_seconds === null,
          '숫자 있음 ' + probe.before.remaining_seconds + ' → 숫자 없음 ' + probe.after.remaining_seconds +
            ' (raw ' + probe.after.raw_number + ')', 'null');
        row('[합성] 숫자 지워도 아이콘 정합은 유지',
          probe.after.match_score > 0.9, probe.after.match_score.toFixed(4), '> 0.9');
        note('§버프 아이콘 숫자 — 글꼴 대조 통합 (분류기 경로)');
        /* 라벨을 좁혀 부른다. ids 없이 전 라벨을 돌리면 한 프레임에 30초가
           넘는다 (글꼴을 꺼도 마찬가지 — 이 시험과 무관한 기존 비용이다). */
        return fetch('tools/fixtures/buff_cells.json').then(function (rr) { return rr.json(); })
          .then(function (man) {
            var frames = ['live_buffs_a', 'live_buffs_b', 'live_buffs_c'];
            var ids = ['P04', 'P05', 'U13', 'U19'];
            var agreed = 0, disagreed = [], glyphSourced = 0, total = 0, seen = [];
            return frames.reduce(function (chain, name) {
              return chain.then(function () {
                return loadMat('assets/samples/' + name + '.png').then(function (m) {
                  classifier.resetCells();
                  return classifier.classify(m, ids).then(function (list) {
                    m.delete();
                    list.forEach(function (e) {
                      if (!e.raw_number) return;
                      total += 1;
                      if (e.number_source === 'glyph_atlas') glyphSourced += 1;
                      /* 같은 칸의 정답과 대조한다. bbox 는 윤곽에서 나오므로
                         격자 x 와 몇 픽셀 어긋날 수 있어 ±3 안에서 찾는다. */
                      var truth = null;
                      man.cells.forEach(function (c) {
                        if (c.source !== name) return;
                        if (Math.abs(c.x - e.bbox[0]) <= 3 && Math.abs(c.y - e.bbox[1]) <= 3) truth = c;
                      });
                      seen.push(name.slice(-1) + ':' + e.id + '="' + e.raw_number + '"' +
                        (truth ? '' : '(정답표 없음)'));
                      if (!truth) return;
                      if (truth.text === e.raw_number) agreed += 1;
                      else disagreed.push(name + '@' + e.bbox[0] + ' ' + e.id +
                        ' 정답 "' + truth.text + '" 판독 "' + e.raw_number + '"');
                    });
                  });
                });
              });
            }, Promise.resolve()).then(function () {
              row('[실화면] 분류기가 읽은 버프 숫자가 정답과 어긋나지 않음',
                disagreed.length === 0 && agreed > 0,
                disagreed.length ? disagreed.join(' · ') : (agreed + '칸 일치 · ' + seen.join(' ')),
                '어긋남 0, 대조 1칸 이상');
              /* L2 는 같은 칸을 여러 프레임 보아야 쌓인다. 여기서는 한 프레임만
                 분류하므로 L2 가 값을 낼 필요는 없다. 확인할 것은 **그 경로가
                 예외 없이 돈다는 것** 이다 — 운영에서 워커를 죽인 것이
                 정확히 이 경로였다. */
              row('[실화면] L2 누적 경로가 예외 없이 돈다',
                classifier.readers && Object.keys(classifier.readers).length > 0,
                Object.keys(classifier.readers || {}).length + '칸에 누적기 생성',
                '1칸 이상');
              row('[실화면] 버프 숫자를 OCR이 아니라 글꼴 대조로 읽는다',
                total > 0 && glyphSourced === total,
                glyphSourced + '/' + total + ' 글꼴', '전부 글꼴');
              measure('버프 숫자 판독 출처',
                glyphSourced + '/' + total + ' 글꼴 · 정답 대조 ' + agreed + '칸');
            });
          }).then(function () {
        note('§경험치 — 다른 실화면에서도 글꼴 대조');
        return ASTRA.glyphs.Atlas.load('config/glyphs.json').then(function (a) {
          var f = a.font('exp');
          var r1 = ASTRA.glyphs.readLine(img, [0, img.rows - 26, img.cols, 26], f, { minRunWidth: 60 });
          row('[실화면] live_booster.png 경험치 글꼴 대조',
            r1.ok && ASTRA.parse.parseExperience(r1.text) === '83874301109098',
            r1.text + ' → ' + ASTRA.parse.parseExperience(r1.text) + ' (' + r1.reason + ')',
            '83874301109098');
          return loadMat('assets/samples/live_rune_dark.png').then(function (m4) {
            var r2 = ASTRA.glyphs.readLine(m4, [0, m4.rows - 26, m4.cols, 26], f, { minRunWidth: 60 });
            var v2 = ASTRA.parse.parseExperience(r2.text);
            row('[실화면] live_rune_dark.png 경험치 글꼴 대조',
              r2.ok && v2 !== null, r2.text + ' → ' + v2 + ' (' + r2.reason + ')',
              '문법 통과');
            measure('세 번째 실화면 판독', r2.text);
            m4.delete();
          });
        }); }).then(function () {
        note('§경험치 — 서로 다른 실화면 두 장 사이의 변화');
        return loadMat('assets/samples/live_rune_dark.png').then(function (m3) {
          var a1 = V.expActivityRect(img), a2 = V.expActivityRect(m3);
          var d = V.signatureDistance(V.activitySignature(img, a1.rect),
                                      V.activitySignature(m3, a2.rect));
          row('[실화면] 경험치가 다른 두 캡처는 변화로 판정됨 (임계 6)',
            d !== null && d > 6, '변화량 ' + d, '> 6');
          measure('두 실화면의 경험치 영역 변화량', String(d));
          m3.delete();
          return lieTests(img);
        });
        });
      });
    }

    /* §4.4 boundary evidence.

       The stored icons are the only rune-duration captures this project has:
       U13.png shows 4:07 and U12.png is the same art showing 22. Pasting them
       into a client-sized frame is a SYNTHETIC arrangement of REAL pixels - it
       proves the reader parses those glyphs and that the threshold acts on the
       parsed value, not that a live rune reads correctly at every duration. */
    function runeFrame(iconUrl) {
      return loadMat(iconUrl).then(function (icon) {
        var c = new OffscreenCanvas(1366, 768);
        var g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = '#6a7f9a';                 // light enough to stay 'observable'
        g.fillRect(0, 0, 1366, 768);
        var rgba = new cv.Mat();
        cv.cvtColor(icon, rgba, cv.COLOR_BGR2RGBA);
        var tmp = new OffscreenCanvas(icon.cols, icon.rows);
        tmp.getContext('2d').putImageData(
          new ImageData(new Uint8ClampedArray(rgba.data), icon.cols, icon.rows), 0, 0);
        rgba.delete();
        g.drawImage(tmp, 1334 - 32, 3);
        icon.delete();
        return V.matFromImageData(g.getImageData(0, 0, 1366, 768));
      });
    }

    // FIX-13 회귀: 같은 종류의 룬 아이콘이 두 개일 때도 둘 다 찾아야
    // "가장 긴 것 채용"이 성립한다. 실화면에서 하나만 잡혀 채택값이
    // 16~35초와 242~246초 사이를 오간 적이 있다.
    function runeSameVariantPair() {
      return loadMat('assets/candidates/U13.png').then(function (icon) {
        var c = new OffscreenCanvas(1366, 768);
        var g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = '#6a7f9a'; g.fillRect(0, 0, 1366, 768);
        var rgba = new cv.Mat();
        cv.cvtColor(icon, rgba, cv.COLOR_BGR2RGBA);
        var tmp = new OffscreenCanvas(icon.cols, icon.rows);
        tmp.getContext('2d').putImageData(
          new ImageData(new Uint8ClampedArray(rgba.data), icon.cols, icon.rows), 0, 0);
        rgba.delete(); icon.delete();
        // 같은 아이콘을 떨어뜨려 두 개 배치 (윤곽이 합쳐지지 않도록)
        g.drawImage(tmp, 1302, 3);
        g.drawImage(tmp, 1180, 3);
        return V.matFromImageData(g.getImageData(0, 0, 1366, 768));
      });
    }

    // Two icons side by side in the buff row.
    function runeFramePair(urlA, urlB) {
      return Promise.all([loadMat(urlA), loadMat(urlB)]).then(function (icons) {
        var c = new OffscreenCanvas(1366, 768);
        var g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = '#6a7f9a';
        g.fillRect(0, 0, 1366, 768);
        icons.forEach(function (icon, i) {
          var rgba = new cv.Mat();
          cv.cvtColor(icon, rgba, cv.COLOR_BGR2RGBA);
          var tmp = new OffscreenCanvas(icon.cols, icon.rows);
          tmp.getContext('2d').putImageData(
            new ImageData(new Uint8ClampedArray(rgba.data), icon.cols, icon.rows), 0, 0);
          rgba.delete();
          g.drawImage(tmp, 1334 - 32 - i * 32, 3);
          icon.delete();
        });
        return V.matFromImageData(g.getImageData(0, 0, 1366, 768));
      });
    }

    function runeIconTests() {
      var S = ASTRA.state;
      function boosterRun(runeObs) {
        var m = new S.BoosterUiState(), fired = 0, f = 0, last = null;
        [['PRESENT'], ['PRESENT'], ['ABSENT'], ['ABSENT'], ['ABSENT']].forEach(function (st) {
          f++;
          var r = m.update({ presence: st[0], frameId: f, capturedAt: f * 0.5,
                             rune: st[0] === 'ABSENT' ? runeObs : null });
          if (r.event) fired++;
          if (r.decision) last = r.decision;
        });
        return { fired: fired, decision: last };
      }
      var read407 = null;
      return runeFrame('assets/candidates/U19.png').then(function (frame) {
        return runeReader.observe(frame, V.buffVisibility(frame), 100).then(function (rd) {
          frame.delete();
          row('[합성·실아이콘] 짙은 파랑 룬(U19) 아이콘에서 2:12를 132초로 판독',
            rd.iconPresence === 'PRESENT' && rd.observedSeconds === 132 && rd.chosenId === 'U19',
            rd.iconPresence + ' · ' + rd.chosenId + ' 원문 "' + rd.rawText + '" → ' +
              rd.observedSeconds + '초', 'PRESENT · U19 · 132초');
          var run = boosterRun(rd);
          row('[합성·실아이콘] 2:12(132초) ≥ 110초이므로 부스터 종료 알림 1회',
            run.fired === 1, run.fired + '회 · ' + run.decision.outcome, '1회 · alerted');
        });
      }).then(function () {
        // Both variants on one frame: the longest remaining time is the one used.
        return runeFramePair('assets/candidates/U19.png', 'assets/candidates/U13.png');
      }).then(function (frame) {
        return runeReader.observe(frame, V.buffVisibility(frame), 103).then(function (rd) {
          frame.delete();
          row('[합성·실아이콘] 룬 아이콘 2개면 남은 시간이 가장 긴 쪽을 채용 (2:12 vs 4:07 → 4:07)',
            rd.observedSeconds === 247 && rd.chosenId === 'U13' &&
            (rd.candidates || []).length === 2,
            '후보 ' + (rd.candidates || []).map(function (c) { return c.id + ':' + c.seconds; }).join(', ') +
              ' → 채택 ' + rd.chosenId + '/' + rd.observedSeconds + '초',
            'U13/247초 채택');
        });
      }).then(function () {
        return runeSameVariantPair();
      }).then(function (frame) {
        return runeReader.observe(frame, V.buffVisibility(frame), 104).then(function (rd) {
          frame.delete();
          row('[합성·실아이콘] 같은 종류의 룬이 두 개여도 둘 다 찾는다 (FIX-13)',
            (rd.candidates || []).length === 2,
            '후보 ' + (rd.candidates || []).length + '개: ' +
              (rd.candidates || []).map(function (c) { return c.id + '@x' + c.bbox[0]; }).join(', '),
            '2개');
        });
      }).then(function () {
        return runeFrame('assets/candidates/U13.png');
      }).then(function (frame) {
        return runeReader.observe(frame, V.buffVisibility(frame), 101).then(function (rd) {
          frame.delete();
          read407 = rd;
          row('[합성·실아이콘] U13 아이콘에서 4:07을 247초로 판독',
            rd.iconPresence === 'PRESENT' && rd.observedSeconds === 247,
            rd.iconPresence + ' · 원문 "' + rd.rawText + '" → ' + rd.observedSeconds + '초 · ' + rd.reason,
            'PRESENT · 247초');
          var run = boosterRun(rd);
          row('[합성·실아이콘] 4:07(247초) ≥ 110초이므로 부스터 종료 알림 1회',
            run.fired === 1 && run.decision.outcome === 'alerted',
            run.fired + '회 · ' + run.decision.outcome + ' · 룬 ' + run.decision.rune_seconds + '초',
            '1회 · alerted');
          return runeFrame('assets/candidates/U12.png');
        });
      }).then(function (frame) {
        return runeReader.observe(frame, V.buffVisibility(frame), 102).then(function (rd) {
          frame.delete();
          /* 값과 해상도가 본질이고 경로 이름은 아니다. 글꼴 대조를 붙인 뒤로
             판독 시점에 이미 '초'로 확정되므로 해석기가 재판독 경로
             (read_seconds_below_minute)를 거치지 않고 곧장 read 로 끝난다.
             OCR로 떨어질 때는 예전 재판독 경로가 그대로 남아 있다. */
          row('[합성·실아이콘] 1분 미만 표시(U12, "22")를 22초·1초해상도로 판독',
            rd.iconPresence === 'PRESENT' && rd.observedSeconds === 22 &&
            (rd.reason === 'read' || rd.reason === 'read_seconds_below_minute'),
            rd.iconPresence + ' · 원문 "' + rd.rawText + '" → ' + rd.observedSeconds + '초 · ' + rd.reason,
            'PRESENT · 22초 · read 또는 read_seconds_below_minute');
          var run = boosterRun(rd);
          row('[합성·실아이콘] 22초 < 110초이므로 알림 없이 종료',
            run.fired === 0 && run.decision.outcome === 'suppressed',
            run.fired + '회 · ' + run.decision.outcome, '0회 · suppressed');
          // The boundary itself, driven with the real reading's shape.
          [[109, 0], [110, 1], [111, 1]].forEach(function (c) {
            var obs = { iconPresence: 'PRESENT', observedSeconds: c[0],
                        rawText: Math.floor(c[0] / 60) + ':' + String(c[0] % 60).padStart(2, '0'),
                        resolution: 1, confidence: read407 ? read407.confidence : 1 };
            var run2 = boosterRun(obs);
            row('[합성] 실판독 형식으로 ' + obs.rawText + ' → ' + c[1] + '회',
              run2.fired === c[1], run2.fired + '회 · ' + run2.decision.outcome, c[1] + '회');
          });
        });
      });
    }

    /* §6.3: the popup must not be raised on ordinary combat scenery, and a
       full-width strip at the top of the frame is never evidence. */
    function lieTests(liveImg) {
      note('§6.3 거짓말 탐지기 — 구조 검증');
      var korean = null;
      return ASTRA.OcrEngine.create('models/rec_korean.onnx', 'models/rec_korean.charset.json', 'korean')
        .then(function (e) {
          korean = e;
          var det = new ASTRA.detectors.LieDetector(korean, { ocrEveryN: 1 });
          return det.load('').then(function () { return det; });
        }).then(function (det) {
          row('탐지기 참조 자산 7종 로드', det.references.length === 7 && !det.loadError,
            det.references.length + '종 · ' + (det.loadError || 'ok'), '7종 · ok');
          var t = performance.now();
          return det.observe(liveImg).then(function (r) {
            var ms = performance.now() - t;
            measure('탐지기 1회 분석 시간 (실사냥 화면, OCR 폴백 포함)', Math.round(ms) + 'ms');
            row('[실화면] 일반 전투 화면을 탐지기로 오인하지 않음',
              r.present === false && r.status === 'observed',
              r.present + ' · ' + r.reason +
                (r.weak_evidence && r.weak_evidence.length ? ' · 약한근거 ' + r.weak_evidence.length : ''),
              'false');

            // Title-bar band: paste a thin full-width strip at y=0 and confirm
            // it is dropped rather than treated as instruction evidence.
            var withBar = titleBarProbe(liveImg, det);
            return withBar.then(function (r2) {
              row('[합성] 상단 전폭 띠는 근거에서 제외됨',
                r2.present === false,
                r2.present + ' · 제외 ' + ((r2.dropped || []).length) + '건 · ' + r2.reason, 'false');
              return det;
            });
          });
        }).then(function (det) {
          note('[실화면] 탐지기 양성 표본 (참조 자산 자기참조 — 강한 근거 아님)');
          return loadMat('assets/lie_detector/video_frame_0.png').then(function (m) {
            return det.observe(m).then(function (r) {
              row('[실화면·자기참조] 실제 탐지기 프레임은 등장으로 판정 (동일 참조 2영역 배치)',
                r.present === true && r.reason === 'A_same_reference_geometry',
                r.present + ' · ' + r.reason, 'true · A_same_reference_geometry');
              m.delete();
              // A popup whose only registered region is one strong template has
              // to survive on the instruction-text route. Losing this would be
              // exactly the "raise the threshold and lose positives" failure
              // §6.3 warns about, so it is asserted rather than assumed.
              return loadMat('assets/lie_detector/user_type_3.webp');
            });
          }).then(function (m) {
            return det.observe(m).then(function (r) {
              row('[실화면·자기참조] 단일 영역 팝업도 안내문 경로로 등장 판정',
                r.present === true, r.present + ' · ' + r.reason, 'true');
              m.delete();
            });
          });
        });
    }

    function titleBarProbe(src, det) {
      var c = new OffscreenCanvas(src.cols, src.rows);
      var g = c.getContext('2d', { willReadFrequently: true });
      var rgba = new cv.Mat();
      cv.cvtColor(src, rgba, cv.COLOR_BGR2RGBA);
      g.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), src.cols, src.rows), 0, 0);
      rgba.delete();
      g.fillStyle = '#202020';
      g.fillRect(0, 0, src.cols, 6);
      g.fillStyle = '#d0d0d0';
      g.font = '11px sans-serif';
      g.fillText('MapleStory', 8, 5);
      var edited = V.matFromImageData(g.getImageData(0, 0, src.cols, src.rows));
      return det.observe(edited).then(function (r) { edited.delete(); return r; });
    }

    function noNumberProbe(src, bbox) {
      // Repaint the number band with the icon art above it, through a canvas so
      // the pixels really change (a direct Mat.data write does not survive).
      var c = new OffscreenCanvas(src.cols, src.rows);
      var g = c.getContext('2d', { willReadFrequently: true });
      var rgba = new cv.Mat();
      cv.cvtColor(src, rgba, cv.COLOR_BGR2RGBA);
      g.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), src.cols, src.rows), 0, 0);
      rgba.delete();
      g.save();
      g.translate(bbox[0], bbox[1] + 32);
      g.scale(1, -1);
      g.drawImage(c, bbox[0], bbox[1] + 8, 32, 12, 0, 0, 32, 12);
      g.restore();
      var edited = V.matFromImageData(g.getImageData(0, 0, src.cols, src.rows));
      return classifier.classify(src, ['P04']).then(function (b) {
        return classifier.classify(edited, ['P04']).then(function (a) {
          edited.delete();
          return { before: b[0], after: a[0] };
        });
      });
    }
  }

  waitForCv().then(function () {
    document.getElementById('boot').textContent =
      'OpenCV ' + (cv.getBuildInformation ? 'ready' : '?') + ' · onnxruntime-web ' + (ort.env.versions ? ort.env.versions.common : '?');
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.logLevel = 'error';
    pureTests();
    return visionTests();
  }).then(function () {
    note('완료');
    window.ASTRA_SELFTEST = { pass: pass, fail: fail, info: info, done: true };
  }).catch(function (e) {
    note('중단: ' + (e && e.message ? e.message : e));
    fail++; tally();
    window.ASTRA_SELFTEST = { pass: pass, fail: fail, info: info, done: true,
                              error: String(e && e.message ? e.message : e) };
    console.error(e);
  });
})();
