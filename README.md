# Maplestory Timer (Astra Web)

[日本語](#日本語) · [English](#english) · [한국어](#한국어)

---

## 日本語

Chrome の画面共有でメイプルストーリーのゲーム画面を**見るだけ**で、経験値の停滞・ルーンの出現・ポーションやブースターの終了・嘘発見器の出現を音で知らせるローカルウェブアプリです。

ゲームへの入力の自動化、クイズの解読や応答、プロセスメモリへのアクセスは一切行いません。ブラウザに共有された映像をコンピュータビジョンで解析するだけです。

### 技術スタック

| 分類 | 使用技術 |
|---|---|
| 言語 | JavaScript (ブラウザ / Web Worker)、HTML、CSS、Python (開発ツール・旧実装) |
| 画面取得 | **Screen Capture API** (`getDisplayMedia`)、`<video>`、`OffscreenCanvas`、`ImageBitmap` |
| 並列処理 | **Web Workers** (役割ごとに分離)、`postMessage` + セッション ID / キャリブレーション ID / フレーム ID |
| コンピュータビジョン | **OpenCV.js 4.11** (WebAssembly) — テンプレートマッチング (`TM_CCOEFF_NORMED`)、HSV 色域マスク、**SIFT** 特徴量 + BFMatcher、ピクセル射影 |
| OCR | **ONNX Runtime Web 1.20** (WASM + SIMD) で **PaddleOCR** 認識モデル (PP-OCRv4 英語 / 韓国語、PP-OCRv6 汎用) を実行、CTC greedy デコード |
| 独自認識 | ゲームフォントの**グリフアトラス**によるビットマップ照合 (OCR の約 270 倍高速) |
| 判定ロジック | 有限状態機械 (ブースター・ポーション・経験値)、画素シグネチャの差分検出 |
| 通知 | **Web Audio API** |
| サーバー | Python `http.server` (127.0.0.1 限定、キャッシュ制御、フレーム保存用エンドポイント) |
| テスト | Node.js 純粋ロジックテスト 120 件、ブラウザ画像回帰テスト (`selftest.html`) |
| 旧実装 (`legacy/`) | Python、Windows Graphics Capture (`windows-capture`)、opencv-python、RapidOCR、onnxruntime、pytest |

### 各部分の技術

#### 1. 画面取得とキャリブレーション — `src/capture.js`

- `getDisplayMedia` で共有されたウィンドウには枠やタイトルバーが含まれ、サイズも環境ごとに異なります。そこで共有面の中からゲームのクライアント領域 (1366×768) を探し出し、毎フレーム基準解像度へリサンプリングします。
- 候補ごとに 7 秒の猶予を与え、「切れていない経験値表示 + HUD の根拠 2 つ以上 (ミニマップ・バフ領域・有効画面)」を満たしたときだけ成功とします。キャリブレーション中は通知を保留します。

#### 2. 役割別ワーカーと判定の分離 — `src/worker.js`, `src/main.js`

- 経験値・HUD・バフ一覧・嘘発見器などの解析を役割ごとの Web Worker に分け、重い処理がほかの判定を止めないようにしています。
- すべてのメッセージにセッション ID・キャリブレーション ID・フレーム ID を付け、共有をやり直したときの遅延結果や古いキャリブレーションの結果を確実に破棄します。
- ワーカーの結果は**届いた瞬間に**状態機械へ反映し、`requestAnimationFrame` は描画だけを担当します。タブが隠れて描画が止まっても判定は続きます。

#### 3. 画像認識 — `src/vision.js`, `src/detectors.js`, `src/glyphs.js`, `src/ocr.js`

- **テンプレートマッチング**: バフアイコン・ルーンマーカー・ブースター UI などを OpenCV.js の正規化相関で検出します。表示モード (分表示 / 時計表示) によって見た目が変わるアイコンは別テンプレートを登録し、似たポーション同士はアイコン下部の領域同士の相関比較で区別します (マージン 0.99 対 0.83)。
- **色マスク**: ミニマップ上のルーン出現は、ピンク色の HSV 範囲とテンプレートの両方が一致し、2 回連続で確認されたときだけ認めます。
- **SIFT 特徴量**: 嘘発見器のポップアップは SIFT キーポイントと構造的な位置関係で判定し、細い帯 1 本のような弱い根拠では発火しません。
- **グリフアトラス**: 経験値やバフの残り時間の数字は、画面から抽出したゲームフォントのビットマップと直接照合します。経験値の読み取りは 1.2 ms で、従来の OCR (324 ms) より約 270 倍高速です。
- **ONNX OCR**: アトラスで読めない文字は PaddleOCR 認識モデルをブラウザ内の ONNX Runtime で推論し、CTC greedy デコードで文字列にします。

#### 4. 判定ロジック — `src/state.js`, `src/display.js`

- **ブースター終了**: 残り時間を「測る」のではなく、残り時間 UI が**存在するか**だけを見ます。`UNSEEN → VISIBLE → DISAPPEARANCE_CANDIDATE → CHECK_RUNE → RESOLVED` の状態機械で、UI が消えた瞬間のルーン持続時間が 1 分 50 秒以上なら 1 回だけ通知します。共有の途切れや古い結果 (`UNKNOWN`) は決して「消えた」とは扱いません。
- **経験値の停滞**: 数字を読まず、経験値文字領域の明るい画素の列分布を**シグネチャ**として 8 秒以上変化がなければ停滞と判定します (同一フレーム差 0、実際の変化 179、閾値 6)。ストリームが固まった場合は画面全体のシグネチャで区別します。
- **表示用タイマー**: 画面の数字を 1 回読んで同期し、以降は自動カウントダウンします。ポーションは数字領域の変化を約 1 秒ごとに検出し、分表示が切り替わる瞬間に再同期して精度を上げます。表示は判定とは無関係です。

#### 5. 検証体制 — `tools/state_tests.js`, `selftest.html`, `tools/`

- ブラウザ不要の純粋ロジックテスト 120 件と、実画面・合成画像を使ったブラウザ回帰テストを備え、テスト結果には `[実画面]` / `[合成]` / `[合成・実アイコン]` と根拠の種類を明記します。
- 30 分の連続セッション録画 (1 秒間隔の可逆キャプチャ) を保存するツール、グリフアトラス生成、アイコンやラベルの調査用 Python スクリプト (OpenCV・NumPy) を含みます。

### 実際の効用

- メイプルストーリーの狩りでは、経験値が止まっていないか、ルーンが出ていないか、ポーションやブースターが切れていないかを長時間見張り続ける必要があります。これを**音で知らせる**ことで、画面に張り付く負担を減らします。
- ゲームクライアントに一切触れず、ブラウザの画面共有映像を解析するだけなので、メモリ読み取りや入力自動化とは異なり**画面を見ているのと同じ情報**しか使いません。
- インストールはブラウザとローカルサーバーのみで、OCR もすべて端末内の WebAssembly で動くため、画面映像が外部に送信されません。
- 設計面では、ノイズの多い実画面で「誤報を出さない」ことを優先し、状態機械・複数根拠の確認・不確実な観測の除外によって信頼できる通知を実現している点が特徴です。

> 注: 実際のゲーム画面キャプチャ (キャラクター名が写るもの) はリポジトリから除外しているため、`selftest.html` の一部の実画面テストはクローン環境では実行できません。

---

## English

A local web app that **watches** MapleStory through Chrome's screen sharing and plays a sound when experience stops rising, a rune appears, a potion or booster runs out, or the lie detector pops up.

It never automates game input, never solves or answers the lie detector, and never touches process memory. It only runs computer vision on the video the browser was given.

### Tech Stack

| Category | Technologies |
|---|---|
| Languages | JavaScript (browser / Web Worker), HTML, CSS, Python (dev tools and legacy build) |
| Screen capture | **Screen Capture API** (`getDisplayMedia`), `<video>`, `OffscreenCanvas`, `ImageBitmap` |
| Concurrency | **Web Workers** (one per role), `postMessage` tagged with session / calibration / frame IDs |
| Computer vision | **OpenCV.js 4.11** (WebAssembly) — template matching (`TM_CCOEFF_NORMED`), HSV colour masks, **SIFT** features + BFMatcher, pixel projections |
| OCR | **ONNX Runtime Web 1.20** (WASM + SIMD) running **PaddleOCR** recognition models (PP-OCRv4 English / Korean, PP-OCRv6 general), CTC greedy decoding |
| Custom recognition | **Glyph atlas** bitmap matching against the game font (~270× faster than OCR) |
| Decision logic | Finite-state machines (booster, potion, experience), pixel-signature change detection |
| Alerts | **Web Audio API** |
| Server | Python `http.server` (bound to 127.0.0.1, cache control, frame-harvest endpoint) |
| Testing | 120 pure-logic tests on Node.js, in-browser image regression suite (`selftest.html`) |
| Legacy build (`legacy/`) | Python, Windows Graphics Capture (`windows-capture`), opencv-python, RapidOCR, onnxruntime, pytest |

### Technology in Each Part

#### 1. Capture and calibration — `src/capture.js`

- A window shared through `getDisplayMedia` includes its frame and title bar, at whatever size the compositor chose. The app locates the game's client area (1366×768) inside the shared surface and resamples every frame to that reference resolution.
- Each candidate rectangle gets 7 seconds, and calibration only succeeds with an uncut experience readout **plus at least two pieces of HUD evidence** (minimap, buff area, valid screen). Alerts are held back while calibrating.

#### 2. Role-based workers, decisions separated from drawing — `src/worker.js`, `src/main.js`

- Experience, HUD, full buff list and lie-detector analysis each run in their own Web Worker, so one slow pass never stalls the others.
- Every message carries a session ID, calibration ID and frame ID, so late results from a previous share or an outdated calibration are reliably discarded.
- Worker results feed the state machines **the moment they arrive**; `requestAnimationFrame` only draws. When the tab is hidden and drawing stops, judging continues.

#### 3. Image recognition — `src/vision.js`, `src/detectors.js`, `src/glyphs.js`, `src/ocr.js`

- **Template matching**: buff icons, the rune marker and the booster UI are found with OpenCV.js normalised cross-correlation. Icons whose look changes between display modes (minutes vs clock) get separate templates, and two near-identical potions are told apart by correlating only the bottom pouch region against both templates (margin 0.99 vs 0.83).
- **Colour masks**: a rune spawn on the minimap counts only when a pink HSV range and the template agree, confirmed twice.
- **SIFT features**: the lie-detector popup is recognised from SIFT keypoints plus their structural layout; a single thin strip of evidence never fires.
- **Glyph atlas**: experience and buff-timer digits are matched directly against bitmaps of the game font harvested from real frames. Reading experience takes 1.2 ms, about 270× faster than the previous OCR path (324 ms).
- **ONNX OCR**: text the atlas cannot read goes to PaddleOCR recognition models running in ONNX Runtime inside the browser, decoded with CTC greedy decoding.

#### 4. Decision logic — `src/state.js`, `src/display.js`

- **Booster end**: instead of *timing* the booster, the app only asks whether its remaining-time UI **exists**. A state machine — `UNSEEN → VISIBLE → DISAPPEARANCE_CANDIDATE → CHECK_RUNE → RESOLVED` — fires exactly one alert when the UI disappears while the rune buff has at least 1:50 left. A dropped share or stale result (`UNKNOWN`) is never treated as a disappearance.
- **Experience stall**: no digits are read. The column-wise distribution of bright pixels in the experience text becomes a **signature**; no change for 8 seconds means a stall (identical frames differ by 0, a real change by 179, threshold 6). A frozen stream is recognised from a whole-screen signature and not counted.
- **Display timers**: the on-screen number is read once to sync, then a local countdown takes over. For potions the digit area is checked for change about once a second and re-synced the instant the minute display ticks, which makes the countdown accurate. Display never feeds the decision.

#### 5. Verification — `tools/state_tests.js`, `selftest.html`, `tools/`

- 120 browser-free logic tests plus an in-browser regression suite on real and synthetic frames; every row is labelled `[real screen]`, `[synthetic]` or `[synthetic with real icon]` so evidence types are never confused.
- Tooling includes a 30-minute session recorder (lossless capture every second), a glyph-atlas builder, and Python survey scripts (OpenCV, NumPy) for icons and labels.

### Real-World Value

- Grinding in MapleStory means watching for hours whether experience is still rising, whether a rune has spawned, and whether potions or boosters have run out. **Audible alerts** remove the need to stare at the screen.
- The game client is never touched. Unlike memory readers or input bots, it only uses **what a person looking at the screen could see**.
- Everything runs locally — a browser and a local server — with OCR in on-device WebAssembly, so no screen footage leaves the machine.
- Design-wise, it prioritises *not raising false alarms* on noisy real footage: state machines, multi-evidence confirmation and refusal to judge uncertain observations make the alerts trustworthy.

> Note: real game captures (which show character names) are excluded from this repository, so some real-screen cases in `selftest.html` cannot run from a fresh clone.

---

## 한국어

Chrome 화면 공유로 메이플스토리 게임 화면을 **보기만** 하면서 경험치 정체 · 룬 등장 · 비약/부스터 종료 · 거짓말 탐지기 등장을 소리로 알려주는 로컬 웹 앱입니다.

게임 입력 자동화, 문제 해독·응답, 프로세스 메모리 접근은 하지 않습니다. 브라우저에 공유된 영상을 컴퓨터 비전으로 분석할 뿐입니다.

### 기술 스택

| 분류 | 사용 기술 |
|---|---|
| 언어 | JavaScript (브라우저 / Web Worker), HTML, CSS, Python (개발 도구·이전 구현) |
| 화면 획득 | **Screen Capture API** (`getDisplayMedia`), `<video>`, `OffscreenCanvas`, `ImageBitmap` |
| 병렬 처리 | **Web Workers** (역할별 분리), `postMessage` + 세션 ID / 보정 ID / 프레임 ID |
| 컴퓨터 비전 | **OpenCV.js 4.11** (WebAssembly) — 템플릿 정합 (`TM_CCOEFF_NORMED`), HSV 색상 마스크, **SIFT** 특징점 + BFMatcher, 픽셀 투영 |
| OCR | **ONNX Runtime Web 1.20** (WASM + SIMD)으로 **PaddleOCR** 인식 모델 (PP-OCRv4 영어/한국어, PP-OCRv6 범용) 실행, CTC greedy 디코딩 |
| 자체 인식 | 게임 글꼴 **글리프 아틀라스** 비트맵 대조 (OCR 대비 약 270배 빠름) |
| 판정 로직 | 유한 상태 기계 (부스터·비약·경험치), 화소 서명 변화 감지 |
| 알림 | **Web Audio API** |
| 서버 | Python `http.server` (127.0.0.1 전용, 캐시 제어, 프레임 저장 엔드포인트) |
| 테스트 | Node.js 순수 로직 테스트 120개, 브라우저 이미지 회귀 테스트 (`selftest.html`) |
| 이전 구현 (`legacy/`) | Python, Windows Graphics Capture (`windows-capture`), opencv-python, RapidOCR, onnxruntime, pytest |

### 부분별 기술

#### 1. 화면 획득과 보정 — `src/capture.js`

- `getDisplayMedia`로 공유된 창에는 테두리와 제목줄이 포함되고 크기도 환경마다 다릅니다. 그래서 공유 표면 안에서 게임 클라이언트 영역(1366×768)을 찾아내고, 매 프레임을 기준 해상도로 다시 샘플링합니다.
- 후보마다 7초를 주고, "잘리지 않은 경험치 표시 + HUD 근거 2개 이상(미니맵·버프 영역·유효 화면)"을 만족할 때만 보정 성공으로 봅니다. 보정 중에는 알림을 보류합니다.

#### 2. 역할별 워커와 판정·렌더링 분리 — `src/worker.js`, `src/main.js`

- 경험치·HUD·전체 버프·거짓말 탐지기 분석을 역할별 Web Worker로 나눠, 무거운 처리가 다른 판정을 멈추지 않게 했습니다.
- 모든 메시지에 세션 ID·보정 ID·프레임 ID를 붙여, 공유를 다시 시작했을 때 뒤늦게 도착한 결과나 이전 보정의 결과를 확실히 버립니다.
- 워커 결과는 **도착 즉시** 상태 기계에 반영하고, `requestAnimationFrame`은 그리기만 합니다. 탭이 가려져 렌더링이 멈춰도 판정은 계속됩니다.

#### 3. 이미지 인식 — `src/vision.js`, `src/detectors.js`, `src/glyphs.js`, `src/ocr.js`

- **템플릿 정합**: 버프 아이콘·룬 마커·부스터 UI를 OpenCV.js 정규화 상관으로 찾습니다. 표시 모드(분 표시 / 시계 표시)에 따라 모양이 바뀌는 아이콘은 템플릿을 따로 등록하고, 거의 같은 두 비약은 아이콘 하단 주머니 영역만 두 템플릿과 상관 비교해 구분합니다(마진 0.99 대 0.83).
- **색상 마스크**: 미니맵의 룬 등장은 분홍색 HSV 범위와 템플릿이 함께 일치하고 2회 연속 확인될 때만 인정합니다.
- **SIFT 특징점**: 거짓말 탐지기 팝업은 SIFT 키포인트와 그 구조적 배치로 판정하며, 얇은 띠 하나 같은 약한 근거로는 알림을 내지 않습니다.
- **글리프 아틀라스**: 경험치와 버프 남은 시간 숫자는 실제 화면에서 추출한 게임 글꼴 비트맵과 직접 대조합니다. 경험치 판독은 1.2ms로, 기존 OCR(324ms)보다 약 270배 빠릅니다.
- **ONNX OCR**: 아틀라스로 읽지 못한 글자는 브라우저 안의 ONNX Runtime에서 PaddleOCR 인식 모델로 추론하고 CTC greedy 디코딩으로 문자열로 바꿉니다.

#### 4. 판정 로직 — `src/state.js`, `src/display.js`

- **부스터 종료**: 남은 시간을 *재는* 대신 남은 시간 UI가 **존재하는지**만 봅니다. `UNSEEN → VISIBLE → DISAPPEARANCE_CANDIDATE → CHECK_RUNE → RESOLVED` 상태 기계로, UI가 사라진 그 프레임의 룬 지속시간이 1분 50초 이상이면 알림을 정확히 한 번 냅니다. 공유 끊김이나 오래된 결과(`UNKNOWN`)는 절대 소멸로 치지 않습니다.
- **경험치 정체**: 숫자를 읽지 않습니다. 경험치 글자 영역의 밝은 화소 열별 분포를 **서명**으로 삼아 8초 이상 변화가 없으면 정체로 판정합니다(같은 프레임 변화량 0, 실제 변화 179, 임계 6). 스트림이 얼어붙은 경우는 전체 화면 서명으로 구분합니다.
- **표시용 타이머**: 화면 숫자를 한 번 읽어 싱크한 뒤 자동으로 카운트다운합니다. 비약은 숫자 영역 변화를 약 1초마다 감지해, 분 표시가 바뀌는 순간 다시 싱크하여 정확도를 높입니다. 표시는 판정과 무관합니다.

#### 5. 검증 체계 — `tools/state_tests.js`, `selftest.html`, `tools/`

- 브라우저 없이 도는 순수 로직 테스트 120개와 실화면·합성 이미지를 쓰는 브라우저 회귀 테스트가 있으며, 결과마다 `[실화면]` / `[합성]` / `[합성·실아이콘]`처럼 근거 종류를 명시합니다.
- 30분 연속 세션 녹화(1초 간격 무손실 캡처) 도구, 글리프 아틀라스 생성기, 아이콘·라벨 조사용 Python 스크립트(OpenCV·NumPy)를 포함합니다.

### 실제 효용

- 메이플스토리 사냥에서는 경험치가 멈추지 않았는지, 룬이 떴는지, 비약이나 부스터가 끝났는지를 오랜 시간 계속 지켜봐야 합니다. 이를 **소리로 알려** 화면에 붙어 있어야 하는 부담을 줄여 줍니다.
- 게임 클라이언트를 전혀 건드리지 않고 브라우저 화면 공유 영상만 분석하므로, 메모리 읽기나 입력 자동화와 달리 **사람이 화면을 보고 알 수 있는 정보**만 사용합니다.
- 브라우저와 로컬 서버만으로 동작하고 OCR도 기기 안의 WebAssembly로 돌기 때문에 화면 영상이 외부로 전송되지 않습니다.
- 설계 측면에서는 잡음이 많은 실제 화면에서 "잘못 울리지 않는 것"을 우선했습니다. 상태 기계, 복수 근거 확인, 불확실한 관측의 판정 제외로 믿을 수 있는 알림을 만든 점이 특징입니다.

> 참고: 캐릭터 이름이 찍힌 실제 게임 캡처는 저장소에서 제외했으므로, `selftest.html`의 일부 실화면 테스트는 새로 클론한 환경에서 실행되지 않습니다.
