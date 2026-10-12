import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L from "../src/logic.mjs";
import { catalogFromDir } from "../scripts/catalog.mjs";

const H = "a".repeat(64);

test("catalog names must be plain .apk file names", () => {
  assert.equal(L.isCatalogName("waze.apk"), true);
  assert.equal(L.isCatalogName("my-app_1.2.apk"), true);
  assert.equal(L.isCatalogName("../evil.apk"), false);
  assert.equal(L.isCatalogName("a/b.apk"), false);
  assert.equal(L.isCatalogName("notes.txt"), false);
  assert.equal(L.isCatalogName(".hidden.apk"), false);
});

test("buildCatalog drops invalid, duplicate and empty entries and sorts the rest", () => {
  const c = L.buildCatalog([
    { name: "b.apk", size: 10, sha256: H },
    { name: "a.apk", size: 5, sha256: H },
    { name: "a.apk", size: 5, sha256: H },
    { name: "bad name.apk", size: 5, sha256: H },
    { name: "zero.apk", size: 0, sha256: H },
    { name: "nohash.apk", size: 5, sha256: "xyz" },
  ]);
  assert.deepEqual(c.apps.map((a) => a.name), ["a.apk", "b.apk"]);
});

test("parseCatalog rejects a wrong shape", () => {
  assert.throws(() => L.parseCatalog("[]"), TypeError);
  assert.throws(() => L.parseCatalog('{"version":2,"apps":[]}'), TypeError);
  assert.deepEqual(L.parseCatalog('{"version":1,"apps":[]}').apps, []);
});

test("catalogFromDir lists only .apk files with their size and SHA-256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apks-"));
  try {
    await writeFile(join(dir, "one.apk"), "hello");
    await writeFile(join(dir, "readme.txt"), "x");
    await mkdir(join(dir, "folder.apk"));
    const c = await catalogFromDir(dir);
    assert.equal(c.apps.length, 1);
    assert.equal(c.apps[0].name, "one.apk");
    assert.equal(c.apps[0].size, 5);
    assert.equal(c.apps[0].sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
