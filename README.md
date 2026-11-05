# tabsheet — 타브 악보 영상 → 악보 PDF/JPG (MVP 1단계)

영상에서 **악보가 나오는 사각형 영역**만 잘라, 악보가 바뀔 때마다 한 조각씩 모아 PDF 또는 JPG로 만듭니다.
입력은 **로컬 영상 파일**입니다 (유튜브 URL은 이후 단계).

## 설치

```bash
pip install -e .            # opencv-python-headless, numpy, Pillow
```

## 웹 GUI (가장 쉬운 방법)

```bash
tabsheet gui                 # 브라우저가 열림 (http://127.0.0.1:8765)
tabsheet gui --no-browser --port 9000 --workdir ./work   # 옵션
# 현재 폴더에 videos/ 가 있으면 자동으로 '서버 폴더 열기'가 켜집니다 (--media-dir 로 다른 폴더 지정 가능)
```

1. 영상 파일을 끌어다 놓기 → 2. 악보가 보이는 시점으로 슬라이더를 옮기고 **화면에서 악보 영역을 드래그** → 3. "악보 추출" → 조각 미리보기에서 필요 없는 조각 체크 해제 → "PDF 만들기" / "JPG 만들기".

내 컴퓨터(127.0.0.1)에서만 접속되며, `--workdir`를 주지 않으면 업로드한 영상과 결과는 종료할 때 삭제됩니다.

## 사용법 (명령줄, 3단계)

```bash
# 1) 영상 크기 확인
tabsheet info my_video.mp4

# 2) 악보 영역(bbox) 찾기: 눈금이 그려진 프레임을 저장해서 x,y,w,h를 읽는다
tabsheet preview my_video.mp4 --time 30 -o preview.png
tabsheet preview my_video.mp4 --time 30 --bbox 140,440,1000,200 -o preview.png   # 지정한 영역을 빨간 사각형으로 확인

# 3) 추출
tabsheet extract my_video.mp4 --bbox 140,440,1000,200 -o out --format pdf
```

`out/` 안에 생기는 것:

| 파일 | 내용 |
|---|---|
| `sheet.pdf` (또는 `sheet_p01.jpg` …) | 최종 악보 (A4, 위에서 아래로 쌓음) |
| `segments/seg_001_t0000.00.png` … | 악보 조각 원본 이미지 |
| `debug_scores.csv` | `--debug` 시: 샘플별 변화 점수 (임계값 튜닝용) |

## 동작 방식

1. `--interval`(기본 0.5초)마다 프레임을 샘플링하고 bbox만 크롭
2. 연속 샘플의 **변화 점수**(변한 픽셀이 몰려 있는 가로 열의 비율)로 "같은 악보가 정지한 구간"을 찾음
   - 악보 교체 / 페이드: 점수 큼 (0.3 이상)
   - 얇은 재생 커서 / 압축 노이즈: 점수 작음 (0.02 이하)
   - 느린 페이드는 구간 첫 샘플과의 점수(`--anchor-thr`)로 차단
3. 구간 안 프레임을 **픽셀별 중앙값**으로 합쳐 대표 이미지를 만듦 → 움직이는 커서 제거
4. 직전 악보와 같으면 병합. 2초 이하로 짧게 정지했고 앞뒤 페이지의 혼합(크로스페이드 중간)으로 설명되는 후보는 제외 표시 (악보가 성긴 페이지는 영향받지 않음)
5. 같은 악보가 곡 중간에 다시 나오면 그대로 다시 포함 (비연속 중복은 유지)

## 튜닝 가이드 (실제 영상에서 결과가 이상할 때)

먼저 `--debug`로 `debug_scores.csv`를 보세요. 악보가 안 바뀌는 구간의 점수와 바뀌는 순간의 점수 사이에 `--stable-thr`를 두면 됩니다.

| 증상 | 조치 |
|---|---|
| 같은 악보가 여러 조각으로 쪼개짐 | `--stable-thr`, `--anchor-thr`를 올림 / 커서·하이라이트가 크면 특히 |
| 서로 다른 악보가 하나로 합쳐짐 | `--stable-thr`, `--dedupe-thr`를 내림 |
| 짧게(1초 미만) 보이는 악보가 빠짐 | `--interval 0.25 --min-run 2` |
| 페이드 잔상(두 페이지가 겹친 화면)이 섞임 | `--fade-ratio`를 올림 (예: 0.9) |
| 페이지가 페이드 잔상으로 오판되어 제외됨 | 제외된 조각은 `segments/*_faded.png`로 남고 GUI에서는 체크 해제 상태로 보임. 계속되면 `--fade-ratio 0`(판정 끔) |
| 배경 영상이 악보 뒤로 비침 (움직이는 배경) | bbox를 악보 영역 안쪽으로 더 좁게 |
| 글자가 뭉개짐 | 더 높은 화질의 원본 사용 (360p는 한계) |

## 테스트

```bash
python tests/test_pipeline.py        # 합성 영상(컷·1초/3초 페이드·커서·노이즈) 생성 후 검증
python tests/synthetic.py out.mp4    # 합성 영상만 생성
```

## 구조 (이후 MCP/웹 확장용)

```
tabsheet/core.py   # 순수 라이브러리: extract_segments, build_sheet, change_score ...
tabsheet/cli.py    # 얇은 CLI 래퍼
tabsheet/server.py # 로컬 웹 GUI 서버 (표준 라이브러리만 사용)
tabsheet/web/index.html  # GUI 화면 (파일 하나)
```

MCP 서버나 웹 API는 `core.py`의 함수를 그대로 감싸면 됩니다 (`extract_segments`, `save_segments`, `build_sheet`, `video_info`).

## 알려진 한계 (MVP)

- bbox는 수동 지정 (자동 탐지는 다음 단계)
- 악보 한 줄이 다음 줄과 음표가 거의 같은(변화 열 비율 < 임계값) 경우 같은 악보로 합쳐질 수 있음
- 화면이 겹치게 스크롤되는 영상(페이지마다 앞뒤 마디가 겹침)에서는 조각 사이에 같은 마디가 중복됨. 중복 마디를 이어 붙여 제거하는 기능은 아직 없음
- 유튜브 URL 미지원

## 브라우저 버전 (서버·설치 없이)

`docs/` 폴더가 정적 사이트입니다. 영상은 업로드되지 않고 브라우저의 `<video>`로 직접 디코딩해 처리합니다.

```bash
python -m http.server 8000                       # 프로젝트 루트에서 실행 → http://127.0.0.1:8000/docs/ (videos/ 폴더 목록도 사용 가능)
# docs/ 만 서비스해도 됨: python -m http.server 8000 --directory docs  (이 경우 서버 videos/ 목록 버튼은 쓸 수 없음, GitHub Pages도 동일)
```

- `docs/core.js` : 파이썬 알고리즘의 JS 이식 (변화 점수, 구간 추적, 중앙값 합성, 페이드 판정)
- `docs/pdf.js`  : A4 배치 + 외부 라이브러리 없는 PDF 작성기
- `docs/app.js`, `docs/index.html` : 화면
- 영상 고르기: 파일 선택/끌어놓기, **서버 videos/ 폴더**(정적 서버를 프로젝트 루트에서 실행하고 `/docs/`로 접속), **내 컴퓨터 폴더 선택**(Chrome/Edge는 폴더 접근 API, 그 외는 폴더 선택 입력). 서버 폴더 영상은 파일 전체를 브라우저로 가져옵니다
- 한계: H.264/VP9 외 코덱(HEVC 등)은 재생 불가, 파이썬 버전보다 느림(60초 영상 약 1분)
- 탭 숨김: 기본값은 '탭이 숨겨지면 일시정지'(돌아오면 이어서 진행). 고급 설정에서 끄면 계속 진행하며, 끝나면 보이는 탭/숨겨진 탭의 샘플당 평균 시간이 표시됩니다 (실제 PC 측정용)

테스트:
```bash
python tests/browser/make_parity_fixture.py VIDEO X,Y,W,H OUT && node tests/browser/parity.mjs OUT   # 파이썬↔JS 수치 일치
python tests/browser/e2e.py cases.json OUTDIR     # 실제 Chrome에서 tests/browser/expected/*.json 과 비교 (Playwright 필요)
xvfb-run python tests/browser/hidden.py VIDEO X,Y,W,H   # 숨김 탭 분기(일시정지/재개) 검증 (document.hidden 시뮬레이션)
```
