# -*- coding: utf-8 -*-
"""녹화에 나온 버프 아이콘을 종류별로 묶어 목록을 만든다.

왜 필요한가: 어떤 아이콘이 무엇인지는 사람만 안다. 기계가 할 수 있는 일은
"서로 다른 아이콘이 몇 종류이고 각각 언제 어디에 있었는지"를 정리해 사람이
한 번만 보고 이름을 붙이게 하는 것이다.

묶는 기준
---------
아이콘 위에 얹힌 **숫자는 계속 바뀌므로 빼고** 본다. 실측한 표기 위치는
  노란 가운데 숫자  y 11~19
  흰 좌측하단 숫자  y 20~28
그래서 서명은 (1) 숫자가 닿지 않는 윗부분 y 0~10 의 축소 회색조와
(2) 칸 전체의 색상 히스토그램을 합쳐 만든다. 숫자 화소는 전체의 일부라
히스토그램을 크게 흔들지 않는다.

    python tools/survey_icons.py <녹화폴더> [--every N]
"""
import sys, os, glob, json, collections
import cv2
import numpy as np

CELL = 32
GRID_X = list(range(948, 1333, 32))
# 실측 행 위치. 격자 정렬 아이콘의 y 분포에서 나온 값이다
# (4:233회, 41:1189회, 73:914회, 109:167회, 147:11회).
# 예전에 3행을 78 로 잘못 두어 두 행에 걸쳐 잘렸고, 같은 아이콘이 수십 종으로
# 쪼개졌다.
GRID_Y = [4, 41, 73, 109, 147]


def art(cell):
    """숫자가 닿지 않는 아이콘 윗부분. 실측 표기 위치는 노란 가운데 y 11~19,
       흰 좌측하단 y 20~28 이므로 y 0~10 은 항상 그림만 있다."""
    return cv2.cvtColor(cell[0:11, :, :], cv2.COLOR_BGR2GRAY)


def core(a):
    """가장자리를 깎은 알맹이. 이동을 허용해 맞추기 위한 템플릿."""
    return a[1:10, 4:28]


def similar(a, b_core):
    """이동을 허용한 정합 상관계수.

       버프 줄은 오른쪽에 붙어 있어 버프가 늘고 줄 때마다 통째로 밀린다.
       고정 격자로 자르면 같은 아이콘이 1~3화소 어긋나 그대로 비교하면
       상관계수가 뚝 떨어지고, 같은 아이콘이 여러 종류로 쪼개진다
       (실측: 그렇게 119종이 나왔다). 알맹이를 전체 안에서 찾게 하면
       어긋남이 흡수된다."""
    if a.shape[0] < b_core.shape[0] or a.shape[1] < b_core.shape[1]:
        return -1.0
    return float(cv2.matchTemplate(a, b_core, cv2.TM_CCOEFF_NORMED).max())


def occupied(cell):
    """아이콘이 있는 칸인가.

       예전 판정("테두리가 어둡다")은 거꾸로였다 — 버프 아이콘은 어두운 외곽선
       안에 **밝은 테두리**가 있고, 게임 배경은 매끈하다. 그래서 배경 칸이
       아이콘으로 잡혀 목록이 부풀었다(실측: 116종 중 상당수가 배경).

       지금은 '네 변에 경계가 실제로 있는가'로 본다. 아이콘은 네모 틀이 있어
       가장자리 띠에 경계 화소가 촘촘하고, 배경은 그렇지 않다."""
    g = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    e = cv2.Canny(g, 60, 150) > 0
    ring = np.concatenate([e[0:2, :].ravel(), e[-2:, :].ravel(),
                           e[:, 0:2].ravel(), e[:, -2:].ravel()])
    if ring.mean() < 0.25:
        return False
    return g[8:24, 8:24].std() > 10


def main():
    d = sys.argv[1]
    every = 20
    if '--every' in sys.argv:
        every = int(sys.argv[sys.argv.index('--every') + 1])
    files = sorted(glob.glob(os.path.join(d, 'f*.png')))[::every]
    print('프레임 %d장 훑는다' % len(files))

    clusters = []          # {art, count, cell, first, last, pos}
    SIM = 0.85
    for n, f in enumerate(files):
        img = cv2.imread(f)
        if img is None:
            continue
        fi = int(os.path.basename(f)[1:6])
        for y in GRID_Y:
            for x in GRID_X:
                if y + CELL > img.shape[0] or x + CELL > img.shape[1]:
                    continue
                cell = img[y:y + CELL, x:x + CELL]
                if not occupied(cell):
                    continue
                a = art(cell)
                best, bs = None, -1.0
                for c in clusters:
                    sc = similar(a, c['core'])
                    if sc > bs:
                        bs, best = sc, c
                if best is not None and bs >= SIM:
                    best['count'] += 1
                    best['pos'][(x, y)] += 1
                    best['last'] = fi
                else:
                    clusters.append({'art': a, 'core': core(a), 'count': 1, 'cell': cell.copy(),
                                     'first': fi, 'last': fi,
                                     'pos': collections.Counter({(x, y): 1})})
        if n % 20 == 0:
            print('  %d/%d 프레임 · 종류 %d' % (n, len(files), len(clusters)), flush=True)

    clusters.sort(key=lambda c: -c['count'])
    keep = [c for c in clusters if c['count'] >= 5]
    print('아이콘 종류 %d개 (3회 이상 나온 것만; 전체 %d개)' % (len(keep), len(clusters)))

    # 접촉 인화지
    COLS = 8
    ZOOM = 5
    tw, th = CELL * ZOOM, CELL * ZOOM + 34
    rows = (len(keep) + COLS - 1) // COLS
    sheet = np.full((rows * th, COLS * tw, 3), 18, np.uint8)
    index = []
    for i, c in enumerate(keep):
        r, col = divmod(i, COLS)
        big = cv2.resize(c['cell'], None, fx=ZOOM, fy=ZOOM,
                         interpolation=cv2.INTER_NEAREST)
        y0, x0 = r * th, col * tw
        sheet[y0:y0 + CELL * ZOOM, x0:x0 + tw] = big
        top = c['pos'].most_common(1)[0][0]
        cv2.putText(sheet, '#%d  x%d' % (i + 1, c['count']),
                    (x0 + 3, y0 + CELL * ZOOM + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, (90, 220, 255), 1)
        cv2.putText(sheet, 'f%d~%d @%d,%d' % (c['first'], c['last'], top[0], top[1]),
                    (x0 + 3, y0 + CELL * ZOOM + 29),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.36, (170, 170, 170), 1)
        index.append({'id': i + 1, 'count': c['count'],
                      'first_frame': c['first'], 'last_frame': c['last'],
                      'positions': [{'x': p[0], 'y': p[1], 'n': n_}
                                    for p, n_ in c['pos'].most_common(4)]})
    out_png = os.path.join(d, 'icons.png')
    cv2.imwrite(out_png, sheet)
    json.dump({'_note': '녹화에 나온 버프 아이콘 종류. id 는 icons.png 의 번호와 같다.',
               'icons': index},
              open(os.path.join(d, 'icons.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('저장: %s (%dx%d)' % (out_png, sheet.shape[1], sheet.shape[0]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
