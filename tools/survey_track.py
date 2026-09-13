# -*- coding: utf-8 -*-
"""녹화에서 룬(U13/U19)과 재물 비약(P04) 칸을 식별하고, 시간 수열로 정답을
세운 뒤 판독기를 **정의역 전체**에 대해 채점한다.

핵심은 정답을 판독기로 만들지 않는 것이다. 정답은 물리적 제약에서 온다.

    룬  : 값이 1초에 정확히 1씩 준다
    비약: 값이 60초에 정확히 1씩 준다

기준점 하나만 사람이 확인하면(확대 렌더) 나머지 프레임의 정답은 시각으로부터
계산된다. 판독값이 이 수열과 어긋나면 그 프레임이 오판독이거나, 가림이거나,
버프가 다시 걸린 것이다 — 셋 다 따로 볼 값어치가 있다.

    python tools/survey_track.py <녹화폴더>
"""
import sys, os, json, glob, collections
import cv2
import numpy as np

CELL = 32
RUNE = ['assets/candidates/U13.png', 'assets/candidates/U19.png']
POTION = ['assets/candidates/P04.png', 'assets/candidates/P04c.png']
RIVAL = ['assets/candidates/P05.png', 'assets/candidates/P05c.png']
MATCH_MIN = 0.80
# P04 와 P05 는 그림이 거의 같다. labels.json 이 쓰는 주머니 영역으로 가른다.
DISC = (16, 23, 8, 4)


def load(paths):
    return [(p, cv2.imread(p)) for p in paths if cv2.imread(p) is not None]


def score(cell, tmpl):
    r = cv2.matchTemplate(cell, tmpl, cv2.TM_CCOEFF_NORMED)
    return float(r.max())


def disc_score(cell, tmpl):
    x, y, w, h = DISC
    return score(cell[y:y + h, x:x + w], tmpl[y:y + h, x:x + w])


def main():
    d = sys.argv[1]
    idx = json.load(open(os.path.join(d, 'cells.json'), encoding='utf-8'))
    bin_ = np.fromfile(os.path.join(d, 'cells.bin'), dtype=np.uint8)
    reads = json.load(open(os.path.join(d, 'reads.json'), encoding='utf-8'))
    read_at = {(e['f'], e['x'], e['y']): e for e in reads}

    runes = load(RUNE)
    pots = load(POTION)
    rivals = load(RIVAL)

    stride = CELL * CELL * 3
    hits = {'rune': [], 'potion': []}
    for c in idx['cells']:
        cell = bin_[c['off']:c['off'] + stride].reshape(CELL, CELL, 3)
        rs = max(score(cell, t) for _, t in runes)
        if rs >= MATCH_MIN:
            hits['rune'].append((c['f'], c['x'], c['y'], rs))
            continue
        ps = max(score(cell, t) for _, t in pots)
        if ps >= MATCH_MIN:
            # 경쟁 라벨과 주머니 영역으로 가른다 (labels.json 과 같은 방식)
            mine = max(disc_score(cell, t) for _, t in pots)
            other = max(disc_score(cell, t) for _, t in rivals)
            if mine > other:
                hits['potion'].append((c['f'], c['x'], c['y'], ps))

    out = {}
    for kind in ('rune', 'potion'):
        per_frame = collections.defaultdict(list)
        for f, x, y, s in hits[kind]:
            per_frame[f].append((x, y, s))
        print('%s: %d칸 검출 · %d프레임에 존재' % (kind, len(hits[kind]), len(per_frame)))
        # 판독값 붙이기
        rows = []
        for f in sorted(per_frame):
            for x, y, s in per_frame[f]:
                e = read_at.get((f, x, y))
                rows.append({'f': f, 'x': x, 'y': y, 'match': round(s, 4),
                             'text': e['text'] if e else None,
                             'font': e['font'] if e else None})
        out[kind] = rows
    json.dump(out, open(os.path.join(d, 'tracks.json'), 'w', encoding='utf-8'),
              ensure_ascii=False)
    print('저장: ' + os.path.join(d, 'tracks.json'))


if __name__ == '__main__':
    main()
