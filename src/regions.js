/* Search areas for every detector, derived with the same expressions the
   analysis code uses so the UI can never drift from what is actually scanned,
   plus the per-detector crop plan the five preview panels render.
   Pure geometry and text — no DOM, no canvas — so it is directly testable. */
(function (root) {
  'use strict';

  function trunc(v) { return Math.trunc(v); }
  function fmt(n, d) { return n === null || n === undefined ? '—' : Number(n).toFixed(d === undefined ? 2 : d); }
  function commas(digits) { return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function clock(sec) {
    var n = Math.max(0, Math.round(sec));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  function compute(w, h) {
    w = w || 1366; h = h || 768;
    var half = trunc(w * 0.5);
    var expX1 = trunc(w * 0.435), expX2 = trunc(w * 0.574), expY = h - 12;
    var boosterX = trunc(w * 0.25), boosterX2 = trunc(w * 0.75);
    var lieX = trunc(w * 0.12), lieX2 = trunc(w * 0.88);
    var lieY = trunc(h * 0.04), lieY2 = trunc(h * 0.82);

    return {
      client: [0, 0, w, h],
      exp_read: {
        rect: [expX1, expY, expX2 - expX1, h - expY],
        label: '경험치 판독 prior',
        source: 'vision.js ExpLocator prior — w*0.435~0.574, h-12 (탐색 실패 시에만)'
      },
      minimap_search: {
        rect: [0, 0, Math.min(w, Math.max(300, trunc(w / 3))), Math.min(h, Math.max(240, trunc(h / 2)))],
        label: '미니맵 탐색 범위',
        source: 'vision.js detectMinimap — 좌상단, 후보 조건 x<40 · 40<y<140 · 100≤w≤400 · 60≤h≤220'
      },
      buff_search: {
        rect: [half, 0, w - half, Math.min(180, trunc(h / 3))],
        label: '버프 아이콘 탐색 범위',
        source: 'vision.js iconCandidates / BuffClassifier — 우측 절반 상단 180px'
      },
      buff_visibility: {
        rect: [w - 380, 30, 380, 130],
        label: '버프 가림 판정 영역',
        source: 'vision.js buffVisibility — 어두운 저채도 화소 80% 초과 시 obscured'
      },
      booster_search: {
        rect: [boosterX, 0, boosterX2 - boosterX, Math.min(250, h)],
        label: '부스터 “남은시간” 앵커 탐색 범위',
        source: 'detectors.js BoosterDetector — w*0.25~0.75, 상단 250px, 정합 ≥0.78 (숫자 판독 없음)'
      },
      lie_features: {
        rect: [0, 0, w, h],
        label: '탐지기 특징 탐색 (전체 프레임)',
        source: 'detectors.js LieDetector — SIFT 또는 다중 스케일 템플릿'
      },
      lie_ocr: {
        rect: [lieX, lieY, lieX2 - lieX, lieY2 - lieY],
        label: '탐지기 안내문 OCR 범위',
        source: 'detectors.js LieDetector — 중앙 영역, 800px 폭으로 리샘플 후 인식'
      }
    };
  }

  function pad(rect, n, w, h) {
    var x = Math.max(0, rect[0] - n), y = Math.max(0, rect[1] - n);
    return [x, y, Math.min(w - x, rect[2] + 2 * n), Math.min(h - y, rect[3] + 2 * n)];
  }

  /* The rectangle each detector actually read this frame.

     §5.2 keeps two things apart that the 2026-09-05 build merged:
       `locked` - is this rectangle being reused from a previous frame?
       `src`    - where did the rectangle come from originally?
     A prior stays a prior after it has been stored and reused. */
  function cropPlan(statics, exp, hud, lie, nowSeconds) {
    var w = statics.client[2], h = statics.client[3];
    var rune = hud && hud.rune, wealth = hud && hud.wealth;
    var boosterUi = hud && hud.booster_ui;
    var runeDur = hud && hud.rune_duration;
    var ld = lie && lie.lie_detector;
    var plans = {};

    var expSrc = exp && exp.roi_source;
    plans.exp = {
      rect: (exp && exp.bbox) ? exp.bbox : statics.exp_read.rect,
      locked: !!(exp && exp.roi_locked),
      sub: [],
      src: !expSrc ? '판독 prior'
        : expSrc === 'searched' ? '자동 탐색으로 찾음'
        : expSrc === 'prior' ? '탐색 실패 — 비율 prior 사용'
        : expSrc === 'searching' ? '탐색 중…'
        : expSrc,
      info: !exp ? '대기'
        : exp.confirmed && exp.value
          ? commas(exp.value) + ' · 신뢰도 ' + fmt(exp.score, 3) + ' · 잘림검사 ' + (exp.truncation || '—')
        : exp.value
          ? '보류 (' + (exp.reject_reason || exp.truncation) + ') · raw "' + (exp.raw || '') + '"'
        : '문법 불일치 · raw "' + (exp.raw || '') + '" ' + fmt(exp.score, 3)
    };
    if (exp && exp.roi_locked) plans.exp.src += ' · 재사용 중';

    /* 룬 칸은 **지금 무엇을 근거로 판정하고 있는지**를 그대로 보여준다
       (사용자 지시 2026-09-07). 글로 쓰는 세 상태와 순서가 같아야 한다
       (main.js renderRune 참고).

           룬 발동 중   -> 룬 지속시간 버프 아이콘
           룬 쿨타임    -> 룬 쿨타임 아이콘
           둘 다 아님   -> 미니맵 UI (룬 표식을 찾는 범위)

       순서가 어긋나면 글과 그림이 다른 것을 가리키게 되므로 조건을 렌더러와
       똑같이 둔다. */
    var runeCool = hud && hud.rune_cooldown;
    if (runeDur && runeDur.iconPresence === 'PRESENT' && runeDur.bbox) {
      plans.rune = {
        rect: runeDur.bbox, locked: true, sub: [],
        src: '룬 지속시간 버프 아이콘',
        info: '룬 발동 중' +
          (runeDur.observedSeconds !== null && runeDur.observedSeconds !== undefined
            ? ' · ' + clock(runeDur.observedSeconds) : '') +
          (runeDur.rawText ? ' · 화면 "' + runeDur.rawText + '"' : '')
      };
    } else if (runeCool && runeCool.present && runeCool.bbox) {
      plans.rune = {
        rect: runeCool.bbox, locked: true, sub: [],
        src: '룬 쿨타임 아이콘 (U20)',
        info: '룬 쿨타임' +
          (runeCool.remaining_seconds !== null && runeCool.remaining_seconds !== undefined
            ? ' · ' + clock(runeCool.remaining_seconds) : '') +
          (runeCool.match_score !== null && runeCool.match_score !== undefined
            ? ' · 정합 ' + fmt(runeCool.match_score, 3) : '')
      };
    } else if (hud && hud.minimap_bbox) {
      /* 룬은 미니맵 UI **전체**에서 찾으므로(2026-09-07 지시), 화면에도 그
         범위를 보여준다. 안쪽 미니맵과 이름 띠는 얇은 사각형으로 겹쳐 그려
         무엇을 어디서 보는지 한눈에 드러나게 한다. 예전에는 안쪽 미니맵만
         보여 줘서 실제 탐색 범위와 화면이 어긋났다. */
      var runeSubs = [];
      if (rune && rune.status === 'observed' && rune.bbox) {
        runeSubs.push({ rect: rune.bbox, owner: 'rune' });
      }
      if (hud.minimap_ui_bbox) runeSubs.push({ rect: hud.minimap_bbox, owner: 'exp' });
      if (hud.minimap_name_bbox) runeSubs.push({ rect: hud.minimap_name_bbox, owner: 'wealth' });
      plans.rune = {
        rect: hud.minimap_ui_bbox || hud.minimap_bbox, locked: true,
        src: '미니맵 UI ' + (hud.minimap_source === 'locked' ? '고정(재사용)'
          : hud.minimap_source === 'locked_unverified' ? '고정(확인 대기)'
          : hud.minimap_source === 'searched' ? '새로 검출' : '검출 영역'),
        sub: runeSubs,
        info: !rune ? '대기' : rune.status !== 'observed' ? '판정 불가'
          : (rune.present ? '룬 등장' : '없음') + ' · 정합 ' + fmt(rune.score, 3) +
            '/0.78 · 색상화소 ' + (rune.colored || 0) + '/4'
      };
    } else {
      plans.rune = {
        rect: statics.minimap_search.rect, locked: false, sub: [],
        src: hud ? '미니맵 미검출 — 탐색 범위' : '탐색 범위',
        info: hud ? '미니맵을 찾지 못해 룬 마커 판정 불가' : '대기'
      };
    }

    if (wealth && wealth.bbox) {
      plans.wealth = {
        rect: wealth.bbox, locked: true, sub: [],
        src: 'P04 아이콘 검출' + (wealth.rival_margin !== null && wealth.rival_margin !== undefined
          ? ' (판별 마진 ' + fmt(wealth.rival_margin, 3) + ')' : ''),
        info: '정합 ' + fmt(wealth.match_score, 3) + ' · 화면숫자 ' + (wealth.raw_number || '—') +
          (wealth.remaining_seconds !== null ? ' → ' + clock(wealth.remaining_seconds) : '') +
          (wealth.reject_reason ? ' · 거부 ' + wealth.reject_reason : '') +
          (wealth.verified ? ' · 마스크 일치' : '')
      };
    } else {
      plans.wealth = {
        rect: statics.buff_search.rect, locked: false, sub: [],
        src: hud ? '미매칭 — 버프 탐색 범위' : '탐색 범위',
        info: !hud ? '대기'
          : hud.buff_visibility === 'obscured' ? '버프 영역 가림 — 판정 보류'
          : '소형 재물 획득의 비약 아이콘 없음'
      };
    }

    // §4: presence, never a number. The inner rectangle is the digit area of
    // the widget, drawn for orientation only - nothing reads it any more.
    if (boosterUi && boosterUi.presence === 'PRESENT' && boosterUi.bbox) {
      plans.booster = {
        rect: boosterUi.bbox, locked: true, src: '“남은시간” 앵커 검출',
        sub: boosterUi.number_rect ? [{ rect: boosterUi.number_rect, owner: 'booster' }] : [],
        info: 'UI 있음 · 앵커 ' + fmt(boosterUi.score, 3) + '/' + fmt(boosterUi.threshold, 2) +
          ' · 숫자 판독 안 함 (표시용 영역만 표시)'
      };
    } else {
      plans.booster = {
        rect: statics.booster_search.rect, locked: false, sub: [],
        src: !boosterUi ? '탐색 범위'
          : boosterUi.presence === 'ABSENT' ? 'UI 없음 — 탐색 범위'
          : '관측 불가 — 탐색 범위',
        info: !boosterUi ? '대기'
          : boosterUi.presence === 'ABSENT'
            ? '최고 정합 ' + fmt(boosterUi.score, 3) + ' < ' + fmt(boosterUi.threshold, 2)
            : '관측 불가 · ' + (boosterUi.reason || '')
      };
    }
    if (runeDur) {
      plans.booster.info += '  |  룬 지속시간 ' + runeDur.iconPresence +
        (runeDur.observedSeconds !== null && runeDur.observedSeconds !== undefined
          ? ' ' + clock(runeDur.observedSeconds) + ' (' + runeDur.observedSeconds + '초/110초)'
          : '') +
        (runeDur.rawText ? ' 원문 "' + runeDur.rawText + '"' : '') +
        (runeDur.reason ? ' · ' + runeDur.reason : '');
      if (runeDur.bbox) plans.booster.sub.push({ rect: runeDur.bbox, owner: 'rune' });
    }

    var ev = (ld && ld.evidence && ld.evidence.length) ? ld.evidence[0] : null;
    var box = (ld && ld.candidate_bbox) || (ev && ev.bbox) || null;
    if (box) {
      plans.lie = {
        rect: pad(box, 24, w, h), locked: true,
        src: '후보 위치: ' + (ev ? ev.type : '—'),
        sub: (ld.evidence || []).filter(function (e) { return e.bbox; })
          .map(function (e) { return { rect: e.bbox, owner: 'lie' }; }),
        info: (ld.present ? '등장 · ' : '약한 근거 · ') + (ld.reason || '') +
          (ev && ev.score !== undefined ? ' ' + fmt(ev.score, 3) : '') +
          (ev && ev.inliers !== undefined ? ' inliers ' + ev.inliers : '')
      };
    } else {
      plans.lie = {
        rect: statics.lie_ocr.rect, locked: false, sub: [],
        src: ld ? '미등장 — 안내문 OCR 범위' : '안내문 OCR 범위',
        info: ld
          ? (ld.status === 'observed' ? '없음' : '관측 불가') + ' · ' + (ld.reason || '') +
            ' · ' + (ld.matcher || '') +
            (nowSeconds !== undefined && lie ? ' · 결과 나이 ' + fmt(nowSeconds - lie.stamp, 1) + '초' : '')
          : '대기'
      };
    }
    return plans;
  }

  root.regions = { compute: compute, cropPlan: cropPlan, pad: pad };
})(typeof self !== 'undefined' ? (self.ASTRA = self.ASTRA || {}) : (this.ASTRA = this.ASTRA || {}));
