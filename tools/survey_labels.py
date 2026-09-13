# -*- coding: utf-8 -*-
"""녹화에서 흰 분 숫자의 정답 라벨을 만들어 고정 표본에 추가한다.

정답을 판독기로 만들지 않는다. 절차는 이렇다.

  1. 판독기가 이미 맞게 읽은 값(아틀라스가 아는 0~3 조합)에서 **계단 하나**를
     기준으로 잡는다. 그 계단은 60프레임 동안 같은 값이 이어진 구간이다.
  2. 분 값은 60초에 정확히 1씩 주므로, 기준 계단의 시작 프레임에서 60프레임
     간격으로 앞뒤 창을 만든다. 각 창의 정답은 시각으로 결정된다.
  3. **자체 검증**: 예측한 창 안에서 셀 내용이 실제로 변하지 않고, 창 경계에서
     변해야 한다. 판독기를 전혀 쓰지 않는 검사이므로 순환논증이 아니다.
     이 검사를 통과한 창에서만 라벨을 채택한다.

`--write` 를 주면 tools/fixtures/buff_cells.* 에 칸을 덧붙인다.

    python tools/survey_labels.py <녹화폴더> [--write]
"""
import sys, os, json, glob, collections
import cv2
import numpy as np

CELL = 32
STEP = 60                     # 분 값이 유지되는 프레임 수 (1 Hz 녹화)


def ink_white(cell):
    return (cell.min(axis=2) >= 150)


def band_ink(cell):
    """흰 분 숫자가 그려지는 자리(칸의 좌측 하단)의 잉크만."""
    return ink_white(cell)[16:32, 0:22]


def main():
    d = sys.argv[1]
    write = '--write' in sys.argv
    reads = json.load(open(os.path.join(d, 'reads.json'), encoding='utf-8'))
    frames = {int(os.path.basename(f)[1:6]): f
              for f in glob.glob(os.path.join(d, 'f*.png'))}

    # ---- 1) 기준 계단 찾기 -------------------------------------------------
    bypos = collections.defaultdict(list)
    for e in reads:
        if e.get('font') == 'minutes' and e['text'].isdigit():
            bypos[(e['x'], e['y'])].append((e['f'], int(e['text'])))
    anchors = []
    for pos, es in bypos.items():
        es.sort()
        runs = []
        for f, v in es:
            if runs and runs[-1][0] == v and f - runs[-1][2] <= 3:
                runs[-1][2] = f
            else:
                runs.append([v, f, f])
        for v, f0, f1 in runs:
            if f1 - f0 + 1 >= STEP - 8:          # 거의 한 계단을 다 봤다
                anchors.append((pos, v, f0, f1))
    if not anchors:
        print('기준 계단을 찾지 못했다')
        return 1
    anchors.sort(key=lambda a: -(a[3] - a[2]))
    print('기준 계단 후보 %d개, 상위:' % len(anchors))
    for pos, v, f0, f1 in anchors[:5]:
        print('   %s  값 %d  f%d..f%d (%d프레임)' % (pos, v, f0, f1, f1 - f0 + 1))

    cache = {}

    def cell_at(f, x, y):
        key = (f, x, y)
        if key in cache:
            return cache[key]
        pth = frames.get(f)
        out = None
        if pth:
            im = cv2.imread(pth)
            if im is not None and y + CELL <= im.shape[0] and x + CELL <= im.shape[1]:
                out = im[y:y + CELL, x:x + CELL]
        if len(cache) < 4000:
            cache[key] = out
        return out

    accepted = {}          # 값 -> (프레임, x, y)
    seen_track = set()
    print()
    print('%-5s %-13s %-12s %-9s %-9s %s'
          % ('값', '창', '추적', '창내변화', '경계변화', '판정'))
    for pos, v0, a0, a1 in anchors:
        x, y = pos
        if (x, y) in seen_track:
            continue
        seen_track.add((x, y))
        for v in range(30, 9, -1):
            if v in accepted:
                continue
            f0 = a0 + (v0 - v) * STEP
            f1 = f0 + STEP - 1
            if f0 < 0 or f1 not in frames:
                continue
            mid = (f0 + f1) // 2
            inside = [cell_at(f, x, y) for f in (f0 + 8, mid, f1 - 8)]
            if any(c is None for c in inside):
                continue
            m = [band_ink(c) for c in inside]
            din = max(int((m[0] != m[1]).sum()), int((m[1] != m[2]).sum()))
            prev = cell_at(f0 - 8, x, y)
            if prev is None:
                continue
            dbound = int((band_ink(prev) != m[0]).sum())
            # '변하지 않는다'만 보면 **흰 글자가 아예 없는 칸**도 통과한다.
            # 실제로 그렇게 통과한 4건이 사람 확인에서 노란 시계였다
            # (9:24 / 2:24 / 1:24 / 24). 그래서 그 자리에 두 자리 숫자
            # 정도의 잉크가 실제로 있는지를 함께 요구한다.
            amount = int(m[1].sum())
            if not (20 <= amount <= 150):
                continue
            # 코덱 잡음만으로 마스크가 최대 41화소까지 흔들린다(실측). 그래서
            # 절대 임계가 아니라 상대 기준을 쓴다: 창 안 변화가 잡음 수준 이하이고,
            # 경계 변화가 그보다 뚜렷이 커야 한다.
            ok = din <= 30 and dbound >= din * 2 + 15
            print('%-5d f%-12s %-12s %-9d %-9d %s'
                  % (v, '%d..%d' % (f0, f1), '(%d,%d)' % (x, y), din, dbound,
                     '채택' if ok else '기각'))
            if ok:
                accepted[v] = (mid, x, y)
    accepted = sorted(accepted.items())
    accepted = [(v, f, x, y) for v, (f, x, y) in accepted]
    print('\n채택 %d개: %s' % (len(accepted), ' '.join(str(v) for v, _, _, _ in accepted)))
    digits = set()
    for v, _, _, _ in accepted:
        digits |= set(str(v))
    print('덮는 숫자: %s' % ''.join(sorted(digits)))

    if not write:
        print('\n(--write 를 주면 tools/fixtures 에 칸을 추가한다)')
        return 0

    # ---- 4) 고정 표본에 덧붙이기 ------------------------------------------
    man_p = 'tools/fixtures/buff_cells.json'
    bin_p = 'tools/fixtures/buff_cells.bin'
    man = json.load(open(man_p, encoding='utf-8'))
    buf = bytearray(open(bin_p, 'rb').read())
    have = {(c['source'], c['x'], c['y']) for c in man['cells']}
    added = 0
    for v, f, x, y in accepted:
        src = 'rec/%s/f%05d' % (os.path.basename(d.rstrip('/\\')), f)
        if (src, x, y) in have:
            continue
        c = cell_at(f, x, y)
        man['cells'].append({'font': 'minutes', 'source': src, 'x': x, 'y': y,
                             'text': str(v), 'offset': len(buf),
                             'crop_x': x, 'crop_w': CELL,
                             'label_from': '시간 외삽 + 내용 변화 자체검증'})
        buf += c.tobytes()
        added += 1
    man['_note'] = man.get('_note', '') + (
        ' 2026-09-07: 흰 분 숫자 칸을 녹화에서 추가했다. 라벨은 판독기가 아니라 '
        '분이 60초에 1씩 준다는 성질로 세웠고, 창 안에서 내용이 안 변하고 '
        '경계에서 변한다는 검사를 통과한 것만 넣었다.')
    json.dump(man, open(man_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    open(bin_p, 'wb').write(bytes(buf))
    print('\ntools/fixtures 에 %d칸 추가 (총 %d칸)' % (added, len(man['cells'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
