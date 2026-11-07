// 시간 입력 해석: "90", "90.5", "1:30", "1:30.5", "01:02:03" 모두 허용. 빈 값은 null.
export function parseTime(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (!/^\d+(\.\d+)?$|^(\d+:){1,2}\d+(\.\d+)?$/.test(t)) return NaN;
  const parts = t.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some((p) => p >= 60)) return NaN; // 분/초는 60 미만
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
