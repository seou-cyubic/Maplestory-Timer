# -*- coding: utf-8 -*-
"""정의역 전수조사.

정답을 판독기로 만들지 않는다. 정답은 **물리적 제약**에서 온다.

    시계 표기(룬 등): 값이 1초에 정확히 1씩 준다
    분 표기(비약 등): 값이 60초에 정확히 1씩 준다

그래서 "연속된 판독들이 1초에 1씩 줄어드는 사슬"을 찾으면, 그 사슬 안의 값은
서로가 서로를 증명한다. 한 프레임이 오판독이면 사슬이 그 자리에서 끊긴다.
사슬 밖에서 튄 값은 오판독 후보이고, 사슬 구간 안인데 판독이 없으면 거부다.

    python tools/survey_domain.py <녹화폴더>
"""
import sys, os, json, collections


def to_seconds(text):
    """표시 문자열 -> 초. 시계는 m:ss, 맨숫자는 (1분 미만) 초로 본다."""
    if text is None:
        return None
    if ':' in text:
        m, s = text.split(':', 1)
        if not m.isdigit() or not s.isdigit() or len(s) != 2:
            return None
        return int(m) * 60 + int(s)
    if text.isdigit():
        return int(text)
    return None


def chains(seq, step_per_sec, min_len):
    """seq: [(frame, seconds)] 프레임 오름차순. 값이 프레임차 * step 만큼 준
    구간을 최대로 잇는다. 반환: [[(frame, seconds), ...], ...]"""
    out, cur = [], []
    for i, (f, v) in enumerate(seq):
        if not cur:
            cur = [(f, v)]
            continue
        pf, pv = cur[-1]
        df = f - pf
        if df <= 0 or df > 5:                 # 5프레임 넘게 비면 끊는다
            if len(cur) >= min_len:
                out.append(cur)
            cur = [(f, v)]
            continue
        expect = pv - df * step_per_sec
        if abs(expect - v) < 1e-9:
            cur.append((f, v))
        else:
            if len(cur) >= min_len:
                out.append(cur)
            cur = [(f, v)]
    if len(cur) >= min_len:
        out.append(cur)
    return out


def fmt_clock(sec):
    return '%d:%02d' % (sec // 60, sec % 60) if sec >= 60 else str(sec)


def main():
    d = sys.argv[1]
    reads = json.load(open(os.path.join(d, 'reads.json'), encoding='utf-8'))
    bypos = collections.defaultdict(list)
    for e in reads:
        bypos[(e['x'], e['y'])].append(e)

    # ---- 시계/초 영역 (룬과 같은 1초 해상도 버프) ----
    clock_seen = collections.Counter()     # 초 -> 사슬 안에서 확인된 횟수
    clock_chains = []
    violations = []
    for pos, es in bypos.items():
        es.sort(key=lambda e: e['f'])
        seq = []
        for e in es:
            v = to_seconds(e['text'])
            if v is not None and (':' in e['text'] or v < 60):
                seq.append((e['f'], v))
        for ch in chains(seq, 1, 10):
            clock_chains.append((pos, ch))
            for f, v in ch:
                clock_seen[v] += 1

    # 사슬 구간 안에서 어긋난 판독 = 오판독 후보
    inchain = {}
    for pos, ch in clock_chains:
        f0, v0 = ch[0]
        for f, v in ch:
            inchain[(pos, f)] = v
        for e in bypos[pos]:
            if e['f'] < ch[0][0] or e['f'] > ch[-1][0]:
                continue
            exp = v0 - (e['f'] - f0)
            got = to_seconds(e['text'])
            if got is not None and got != exp and (e['f'], pos) not in inchain:
                violations.append((pos, e['f'], e['text'], fmt_clock(exp)))

    # 사슬 구간 안의 빈 프레임 = 거부
    refused = 0
    covered_frames = 0
    for pos, ch in clock_chains:
        f0, f1 = ch[0][0], ch[-1][0]
        have = set(f for f, _ in ch)
        for f in range(f0, f1 + 1):
            covered_frames += 1
            if f not in have:
                refused += 1

    # ---- 분 영역 ----
    #
    # 분 값은 초당 1씩 줄지 않는다. **60프레임 동안 그대로 있다가 1 줄어든다.**
    # 그래서 사슬 규칙이 다르다: 같은 값이 이어지는 '계단'을 만들고, 이웃한
    # 계단이 정확히 1 차이이며 계단 길이가 60초 근처인지를 본다.
    #
    # 글꼴로는 가를 수 없다. 재물 비약의 분 숫자는 아이콘 중앙의 **노란** 숫자이고
    # (어제 확인한 "29" = 29:59), 다른 버프의 분 숫자는 좌측 하단의 흰 숫자다.
    # 맨숫자가 '분'인지 '1분 미만의 초'인지는 생김새가 아니라 **행동**으로만
    # 갈린다 - 초당 1씩 줄면 초, 60초 유지 후 1 줄면 분이다.
    minute_seen = collections.Counter()
    minute_chains = []
    STEP_LO, STEP_HI = 40, 80          # 계단 길이 허용 범위(초)
    for pos, es in bypos.items():
        es.sort(key=lambda e: e['f'])
        seq = [(e['f'], int(e['text'])) for e in es
               if e['text'] and e['text'].isdigit()]
        if len(seq) < STEP_LO:
            continue
        # 같은 값이 이어지는 계단으로 묶는다 (5프레임 넘게 비면 끊는다)
        steps = []
        for f, v in seq:
            if steps and steps[-1][0] == v and f - steps[-1][2] <= 5:
                steps[-1][2] = f
                steps[-1][3] += 1
            else:
                steps.append([v, f, f, 1])
        # 이웃 계단이 값 1 차이 + 길이가 분에 맞으면 분 수열로 인정
        run = []
        for i, st in enumerate(steps):
            v, f0, f1, n = st
            if not run:
                run = [st]
                continue
            pv, pf0, pf1, pn = run[-1]
            span = f0 - pf0
            if v == pv - 1 and STEP_LO <= span <= STEP_HI:
                run.append(st)
            else:
                if len(run) >= 3:
                    minute_chains.append((pos, run))
                run = [st]
        if len(run) >= 3:
            minute_chains.append((pos, run))
    for pos, run in minute_chains:
        for v, f0, f1, n in run:
            minute_seen[v] += 1

    # ---- 보고 ----
    print('=' * 66)
    print('정의역 전수조사 - %s' % os.path.basename(d.rstrip('/\\')))
    print('=' * 66)
    print()
    print('[1] 1초 해상도 값 (룬 지속시간과 같은 표기)')
    print('  시간정합 사슬 %d개 · 가장 긴 사슬 %d프레임'
          % (len(clock_chains), max((len(c) for _, c in clock_chains), default=0)))
    print('  사슬로 서로 증명된 판독 %d건' % sum(clock_seen.values()))
    print('  사슬 구간 %d프레임 중 판독 없음(거부) %d건 = %.2f%%'
          % (covered_frames, refused, 100.0 * refused / max(1, covered_frames)))
    print('  사슬과 어긋난 판독(오판독 후보) %d건' % len(violations))
    for v in violations[:10]:
        print('     %s f%d 판독 "%s" 기대 "%s"' % v)
    print()
    dom = list(range(1, 301))              # 5:00(300) .. 0:01(1)
    hit = [v for v in dom if clock_seen.get(v)]
    print('  정의역 1..300초 (5:00~0:01) 중 확인된 값: %d/300 = %.1f%%'
          % (len(hit), 100.0 * len(hit) / 300))
    missing = [v for v in dom if not clock_seen.get(v)]
    print('  빠진 값 %d개' % len(missing))
    if missing:
        show = [fmt_clock(v) for v in missing[:40]]
        print('     ' + ' '.join(show) + (' ...' if len(missing) > 40 else ''))
    # 자릿수별 커버리지
    below = [v for v in range(1, 60) if clock_seen.get(v)]
    above = [v for v in range(60, 301) if clock_seen.get(v)]
    print('  1분 미만(맨숫자 1~59): %d/59   1분 이상(m:ss 60~300): %d/241'
          % (len(below), len(above)))
    print()
    print('[2] 분 해상도 값 (비약과 같은 표기)')
    print('  분 수열 %d개 · 가장 긴 수열 %d단계(분)'
          % (len(minute_chains), max((len(c) for _, c in minute_chains), default=0)))
    for pos, run in sorted(minute_chains, key=lambda t: -len(t[1]))[:4]:
        print('     %s  f%d..f%d  %s'
              % (pos, run[0][1], run[-1][2],
                 ' '.join('%d' % v for v, _, _, _ in run)))
    mhit = sorted(minute_seen)
    print('  확인된 분 값 %d개: %s' % (len(mhit), ' '.join(str(v) for v in mhit)))
    print('  정의역 0..30 중 %d/31 = %.1f%%' % (len(mhit), 100.0 * len(mhit) / 31))
    print('  빠진 분 값: %s' % ' '.join(str(v) for v in range(0, 31) if v not in minute_seen))
    print()
    print('[3] 글리프 커버리지 (아틀라스를 채우는 데 쓸 수 있는가)')
    digits = collections.Counter()
    for v in hit:
        for ch in fmt_clock(v).replace(':', ''):
            digits[ch] += 1
    print('  시계/초 값에서 각 숫자가 나온 서로 다른 값의 수:')
    print('    ' + '  '.join('%s:%d' % (k, digits[k]) for k in sorted(digits)))
    mdig = collections.Counter()
    for v in mhit:
        for ch in str(v):
            mdig[ch] += 1
    print('  분 값에서:')
    print('    ' + '  '.join('%s:%d' % (k, mdig[k]) for k in sorted(mdig)) if mdig else '    (없음)')
    json.dump({'clock_values': sorted(hit), 'clock_missing': missing,
               'minute_values': mhit, 'violations': violations,
               'refused': refused, 'covered_frames': covered_frames},
              open(os.path.join(d, 'domain_survey.json'), 'w', encoding='utf-8'))
    print()
    print('저장: ' + os.path.join(d, 'domain_survey.json'))


if __name__ == '__main__':
    main()
