import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGINEER_FIRMWARES,
  ENGINEER_REGIONS,
  engineerDialCode,
  formatCountdown,
  generateEngineerCode,
  getCarTimeParts,
  nextCodeChangeAt,
  secondsUntilNextHour,
} from "../src/codegen.mjs";

test("the provided 3.30–3.35 screenshot inputs reproduce code 391819", () => {
  const firmware = ENGINEER_FIRMWARES.find((entry) => entry.id === "v335");
  const code = generateEngineerCode({ mm: 10, dd: 12, hh: 11, seed: firmware.seed });
  assert.equal(code, "391819");
  assert.equal(engineerDialCode(firmware, code), "*#20240730#*");
});

test("the dynamic firmware dial string uses the same hourly six-digit code", () => {
  const firmware = ENGINEER_FIRMWARES.find((entry) => entry.id === "v336");
  const code = generateEngineerCode({ mm: 10, dd: 12, hh: 11, seed: firmware.seed });
  assert.equal(code, "997319");
  assert.equal(engineerDialCode(firmware, code), "*#997319#*");
});

test("the region list contains valid IANA time zones", () => {
  for (const region of ENGINEER_REGIONS) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: region.timeZone }));
  }
});

test("Riyadh clock parts and the screenshot countdown are deterministic", () => {
  const parts = getCarTimeParts("Asia/Riyadh", Date.UTC(2026, 9, 12, 8, 4, 7));
  assert.deepEqual(parts, {
    year: 2026,
    month: 10,
    day: 12,
    hour: 11,
    minute: 4,
    second: 7,
    date: "2026-10-12",
  });
  const remaining = secondsUntilNextHour(parts);
  assert.equal(remaining, 3_353);
  assert.equal(formatCountdown(remaining), "55:53");
  assert.equal((nextCodeChangeAt("Asia/Riyadh", Date.UTC(2026, 9, 12, 8, 4, 7)) - Date.UTC(2026, 9, 12, 8, 4, 7)) / 1000, 3_353);
});

test("the countdown skips a repeated local hour when daylight saving time ends", () => {
  const beforeFallBack = Date.UTC(2026, 10, 1, 5, 30);
  const now = getCarTimeParts("America/New_York", beforeFallBack);
  assert.equal(`${now.hour}:${now.minute}`, "1:30");
  const next = nextCodeChangeAt("America/New_York", beforeFallBack);
  assert.equal((next - beforeFallBack) / 60_000, 90);
  assert.equal(getCarTimeParts("America/New_York", next).hour, 2);
});

test("a one-hour car-clock adjustment crosses date boundaries correctly", () => {
  const adjusted = getCarTimeParts("Asia/Riyadh", Date.UTC(2026, 9, 11, 20, 30) + 5 * 3_600_000);
  assert.equal(adjusted.date, "2026-10-12");
  assert.equal(adjusted.hour, 4);
});

test("invalid clock components, time zones, and firmware codes fail closed", () => {
  assert.throws(() => generateEngineerCode({ mm: 0, dd: 12, hh: 11, seed: 20250530 }), RangeError);
  assert.throws(() => generateEngineerCode({ mm: 10, dd: 32, hh: 11, seed: 20250530 }), RangeError);
  assert.throws(() => generateEngineerCode({ mm: 10, dd: 12, hh: 24, seed: 20250530 }), RangeError);
  assert.throws(() => getCarTimeParts("Not/A_Zone", 0), RangeError);
  assert.throws(() => engineerDialCode(ENGINEER_FIRMWARES[0], "123"), TypeError);
  assert.equal(generateEngineerCode({ mm: 1, dd: 1, hh: 0, seed: 20250530 }).length, 6);
});
