# -*- coding: utf-8 -*-
"""녹화 프레임에서 버프 칸을 전부 오려 Node 판독기에 넘길 형식으로 저장한다.

왜 이렇게 나누는가: 판독은 **운영에 실제로 쓰이는 src/glyphs.js** 로 해야
의미가 있다. Python 으로 다시 구현하면 그 구현을 검증하는 꼴이 된다. 그래서
Python 은 PNG 디코딩과 오려내기만 하고(Node 에는 PNG 디코더가 없다), 판독은
tools/survey_read.js 가 맡는다.

격자는 실측이다. 아이콘 세로 테두리가 x=947, 978|979, 1010|1011, 1042... 로
32화소 주기이고, 모든 행의 아이콘이 같은 격자 위에 있다(1108-948=160=5*32,
1172-948=224=7*32). 행 위치는 판독기가 띠를 스스로 찾으므로 대략이면 된다 —
y 를 0..11 로 바꿔 가며 시험했을 때 판독 결과가 동일했다.

    python tools/survey_extract.py <녹화폴더> [--limit N]
"""
import sys, os, glob, json, re
import cv2

GRID_X = list(range(948, 1333, 32))     # 13열
GRID_Y = [4, 41, 78, 112]               # 4행 (판독기가 ±10 정도는 흡수한다)
CELL = 32


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    d = sys.argv[1]
    limit = None
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    files = sorted(glob.glob(os.path.join(d, 'f*.png')))
    if limit:
        files = files[:limit]
    if not files:
        print('프레임이 없다: ' + d)
        return 1

    out_bin = os.path.join(d, 'cells.bin')
    out_idx = os.path.join(d, 'cells.json')
    buf = bytearray()
    cells = []
    for n, f in enumerate(files):
        img = cv2.imread(f)
        if img is None:
            continue
        fi = int(re.search(r'f(\d+)\.png', os.path.basename(f)).group(1))
        h, w = img.shape[:2]
        for y in GRID_Y:
            if y + CELL > h:
                continue
            for x in GRID_X:
                if x + CELL > w:
                    continue
                cells.append({'f': fi, 'x': x, 'y': y, 'off': len(buf)})
                buf += img[y:y + CELL, x:x + CELL].tobytes()
        if n % 200 == 0:
            print('  %d/%d 프레임 · %.0f MB' % (n, len(files), len(buf) / 1048576), flush=True)

    with open(out_bin, 'wb') as fh:
        fh.write(bytes(buf))
    with open(out_idx, 'w', encoding='utf-8') as fh:
        json.dump({'cell': CELL, 'grid_x': GRID_X, 'grid_y': GRID_Y,
                   'frames': len(files), 'cells': cells}, fh)
    print('완료: %d칸 · %.0f MB · %s' % (len(cells), len(buf) / 1048576, out_bin))
    return 0


if __name__ == '__main__':
    sys.exit(main())
