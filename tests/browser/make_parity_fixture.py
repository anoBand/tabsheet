"""파이썬 구현의 중간값을 파일로 덤프한다. tests/browser/parity.mjs 가 같은 입력을 JS 로 돌려 비교한다.
사용: python tests/browser/make_parity_fixture.py VIDEO X,Y,W,H OUTDIR"""
import json, sys
from pathlib import Path
import cv2, numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tabsheet.core import _prep_small, change_score, _blend_ratio, _sharpness

video, bbox, out = sys.argv[1], [int(v) for v in sys.argv[2].split(",")], Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
x, y, w, h = bbox
cap = cv2.VideoCapture(video)
crops = []
for t in (2.0, 2.5, 6.0, 9.0, 20.0):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, f = cap.read()
    assert ok
    crops.append(f[y:y + h, x:x + w].copy())
meta = {"w": w, "h": h, "frames": []}
for i, c in enumerate(crops):
    rgba = cv2.cvtColor(c, cv2.COLOR_BGR2RGBA)
    rgba.tofile(out / f"f{i}.rgba")
    small = _prep_small(c, 320)
    small.tofile(out / f"f{i}.small")
    meta["frames"].append({"small_h": int(small.shape[0]), "sharp": _sharpness(c)})
smalls = [_prep_small(c, 320) for c in crops]
meta["scores"] = [[i, j, change_score(smalls[i], smalls[j])] for i in range(5) for j in range(5) if i != j]
# 블렌드: 실제 두 프레임의 합성(알파 0.3) 과 독립 프레임
P, N = smalls[0].astype(np.float32), smalls[3].astype(np.float32)
blend = np.clip(0.3 * P + 0.7 * N, 0, 255).round().astype(np.uint8)
blend.tofile(out / "blend.small")
meta["blend"] = {"real_blend": _blend_ratio(smalls[0], blend, smalls[3]), "independent": _blend_ratio(smalls[0], smalls[4], smalls[3])}
json.dump(meta, open(out / "meta.json", "w"))
print(json.dumps(meta["blend"]), "scores:", len(meta["scores"]))
