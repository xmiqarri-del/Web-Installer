import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRelease, applyRelease, validateManifest, LOGIC_FILE } from "../scripts/sync-release.mjs";
import * as L from "../src/logic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SHA = "a".repeat(64);
const REPO = "xmiqarri-del/Car_DisplayZ";

test("the RELEASE block in src/logic.mjs matches the exported constants", async () => {
  const source = await readFile(LOGIC_FILE, "utf8");
  assert.deepEqual(parseRelease(source), {
    version: L.APP_VERSION, versionCode: L.EXPECTED_VERSION_CODE, bytes: L.EXPECTED_APK_BYTES, sha256: L.EXPECTED_APK_SHA256,
  });
});

test("applyRelease rewrites only the block and keeps the rest of the file", async () => {
  const source = await readFile(LOGIC_FILE, "utf8");
  const next = applyRelease(source, { version: "9.9.9", versionCode: 99, bytes: 123, sha256: SHA });
  assert.deepEqual(parseRelease(next), { version: "9.9.9", versionCode: 99, bytes: 123, sha256: SHA });
  const before = source.slice(0, source.indexOf("// RELEASE:BEGIN"));
  const after = source.slice(source.indexOf("// RELEASE:END") + "// RELEASE:END".length);
  assert.ok(next.startsWith(before));
  assert.ok(next.endsWith(after));
  assert.equal(applyRelease(next, { version: "9.9.9", versionCode: 99, bytes: 123, sha256: SHA }), next, "idempotent");
});

test("a manifest must point at the matching tag of the expected repository", () => {
  const ok = { version_name: "1.2.0", version_code: 11, sha256: SHA, size_bytes: 10, apk_url: `https://github.com/${REPO}/releases/download/v1.2.0/Car_DisplayZ-v1.2.0.apk` };
  assert.equal(validateManifest(ok, REPO), true);
  assert.throws(() => validateManifest({ ...ok, apk_url: "https://example.test/a.apk" }, REPO));
  assert.throws(() => validateManifest({ ...ok, version_name: "1.2" }, REPO));
  assert.throws(() => validateManifest({ ...ok, sha256: "xyz" }, REPO));
  assert.throws(() => validateManifest({ ...ok, version_code: 0 }, REPO));
});
