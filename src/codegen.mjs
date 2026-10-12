// توليد مستقل لرمز قائمة G700 من مدخلات الساعة وإصدار البرنامج.
// بيانات الإصدار الواردة هنا غير مؤكدة ميدانياً؛ راجع تحذير الواجهة وREADME.
export const ENGINEER_FIRMWARES = Object.freeze([
  Object.freeze({
    id: "v335",
    label: "3.30 – 3.35",
    seed: 20250530,
    fixedDialCode: "*#20240730#*",
    dynamicDial: false,
  }),
  Object.freeze({
    id: "v336",
    label: "3.36 – 3.37+",
    seed: 20251030,
    fixedDialCode: null,
    dynamicDial: true,
  }),
]);

export const ENGINEER_REGIONS = Object.freeze([
  Object.freeze({ id: "sa", label: "السعودية", timeZone: "Asia/Riyadh" }),
  Object.freeze({ id: "ae", label: "الإمارات", timeZone: "Asia/Dubai" }),
  Object.freeze({ id: "qa", label: "قطر", timeZone: "Asia/Qatar" }),
  Object.freeze({ id: "kw", label: "الكويت", timeZone: "Asia/Kuwait" }),
  Object.freeze({ id: "bh", label: "البحرين", timeZone: "Asia/Bahrain" }),
  Object.freeze({ id: "om", label: "عُمان", timeZone: "Asia/Muscat" }),
  Object.freeze({ id: "eg", label: "مصر", timeZone: "Africa/Cairo" }),
  Object.freeze({ id: "jo", label: "الأردن", timeZone: "Asia/Amman" }),
  Object.freeze({ id: "iq", label: "العراق", timeZone: "Asia/Baghdad" }),
  Object.freeze({ id: "tr", label: "تركيا", timeZone: "Europe/Istanbul" }),
  Object.freeze({ id: "uk", label: "المملكة المتحدة", timeZone: "Europe/London" }),
  Object.freeze({ id: "eu", label: "وسط أوروبا", timeZone: "Europe/Berlin" }),
  Object.freeze({ id: "us-east", label: "شرق الولايات المتحدة", timeZone: "America/New_York" }),
]);

export function generateEngineerCode({ mm, dd, hh, seed }) {
  if (!Number.isInteger(mm) || mm < 1 || mm > 12) throw new RangeError("month must be 1–12");
  if (!Number.isInteger(dd) || dd < 1 || dd > 31) throw new RangeError("day must be 1–31");
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) throw new RangeError("hour must be 0–23");
  if (!Number.isSafeInteger(seed) || seed < 1) throw new RangeError("seed must be a positive safe integer");

  const minuteKey = BigInt(mm * 10_000 + dd * 100 + hh);
  const base = BigInt(seed) * minuteKey - BigInt(hh);
  const modulus = 1_000_000n;
  const normalized = ((base % modulus) + modulus) % modulus;
  return normalized.toString().padStart(6, "0");
}

export function getCarTimeParts(timeZone, nowMs = Date.now()) {
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new RangeError("a time zone is required");
  if (!Number.isFinite(nowMs)) throw new RangeError("clock value must be finite");

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs)).map(({ type, value }) => [type, value]),
  );
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function secondsUntilNextHour({ minute, second }) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError("minute must be 0–59");
  if (!Number.isInteger(second) || second < 0 || second > 59) throw new RangeError("second must be 0–59");
  return 3_600 - minute * 60 - second;
}

export function nextCodeChangeAt(timeZone, nowMs = Date.now()) {
  const current = getCarTimeParts(timeZone, nowMs);
  const currentKey = `${current.date}|${current.hour}`;
  const firstMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  // Scan local minute boundaries so a repeated DST hour does not promise a
  // new code when the firmware's month/day/hour inputs have not changed.
  for (let minute = 0; minute < 240; minute++) {
    const candidate = firstMinute + minute * 60_000;
    const parts = getCarTimeParts(timeZone, candidate);
    if (`${parts.date}|${parts.hour}` !== currentKey) return candidate;
  }
  throw new RangeError("could not find the next local code-change boundary");
}

export function formatCountdown(totalSeconds) {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) throw new RangeError("countdown must be a nonnegative integer");
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function engineerDialCode(firmware, code) {
  if (!firmware || !/^\d{6}$/.test(code)) throw new TypeError("firmware and a six-digit code are required");
  return firmware.dynamicDial ? `*#${code}#*` : firmware.fixedDialCode;
}
