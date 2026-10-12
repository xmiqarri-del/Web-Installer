import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/logic.mjs";
import { makeHeadUnit } from "./fake-head-unit.mjs";

const PKG = L.DEFAULT_PACKAGE;
const COMP = `${PKG}/${PKG}.nav.NavBarService`;

// The simulated head unit, wrapped as the ctx that logic.mjs expects.
function makeDevice(opts = {}) {
  const unit = makeHeadUnit(opts);
  return { state: unit.state, ctx: { pkg: PKG, run: async (command) => unit.exec(command), log() {} } };
}

const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));

// ---------- Parsers and validation ----------

test("package names are validated before they reach a shell command", () => {
  assert.equal(L.isValidPackageName(PKG), true);
  assert.equal(L.isValidPackageName("a.b"), true);
  for (const bad of ["com", "a; rm -rf /", "1abc.def", "com..x", "", "com.x y", "com.x$(id)"]) {
    assert.equal(L.isValidPackageName(bad), false, bad);
  }
});

test("appops output is parsed for each mode", () => {
  assert.equal(L.parseAppOp("SYSTEM_ALERT_WINDOW: allow"), "allow");
  assert.equal(L.parseAppOp("SYSTEM_ALERT_WINDOW: ignore; time=+1d2h"), "ignore");
  assert.equal(L.parseAppOp("Uid 10123: SYSTEM_ALERT_WINDOW: default"), "default");
  assert.equal(L.parseAppOp("allow\n"), "allow");
  assert.equal(L.parseAppOp("No operations."), "unknown");
  assert.equal(L.parseAppOp(""), "unknown");
});

test("settings values: null, empty and CRLF output", () => {
  assert.equal(L.parseSettingValue("null\r\n"), "null");
  assert.equal(L.parseSettingValue(""), "null");
  assert.equal(L.parseSettingValue(" com.a/.B \n"), "com.a/.B");
});

test("accessibility merge keeps other services and never duplicates ours", () => {
  assert.equal(L.mergeAccessibilityServices("null", PKG), COMP);
  assert.equal(L.mergeAccessibilityServices("", PKG), COMP);
  assert.equal(L.mergeAccessibilityServices("com.other/.Svc", PKG), `com.other/.Svc:${COMP}`);
  assert.equal(L.mergeAccessibilityServices(COMP, PKG), COMP);
  assert.equal(L.mergeAccessibilityServices(`com.other/.Svc:${COMP}`, PKG), `com.other/.Svc:${COMP}`);
  assert.equal(L.hasNavService(`com.other/.Svc:${COMP}`, PKG), true);
  assert.equal(L.hasNavService("com.other/.Svc", PKG), false);
});

test("runtime permission and whitelist parsing", () => {
  assert.equal(L.parseGranted("android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]", "android.permission.POST_NOTIFICATIONS"), true);
  assert.equal(L.parseGranted("android.permission.POST_NOTIFICATIONS: granted=false", "android.permission.POST_NOTIFICATIONS"), false);
  assert.equal(L.parseGranted("nothing here", "android.permission.POST_NOTIFICATIONS"), null);
  assert.equal(L.isWhitelisted("user,com.xmiqarri.cardisplayz,10152", PKG), true);
  assert.equal(L.isWhitelisted("com.xmiqarri.cardisplayz,10152", PKG), true);
  assert.equal(L.isWhitelisted("user,com.xmiqarri.cardisplayzX,1", PKG), false);
  assert.equal(L.parsePmPath("package:/data/app/~~x==/com.xmiqarri.cardisplayz-1/base.apk\n"), "/data/app/~~x==/com.xmiqarri.cardisplayz-1/base.apk");
  assert.equal(L.parsePmPath(""), null);
  assert.equal(L.parseSdk(" 33\n"), 33);
  assert.equal(L.parseSdk("garbage"), null);
});

// ---------- Installing a picked APK ----------

const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);

test("the picked file must be an APK-shaped ZIP of a sane size", () => {
  assert.equal(L.checkApkFile({ name: "Car_DisplayZ-v1.1.6.apk", size: 7009149, head: ZIP_HEAD }).ok, true);
  assert.equal(L.checkApkFile({ name: "CAR.APK", size: 10, head: ZIP_HEAD }).ok, true, "the extension is case-insensitive");
  assert.match(L.checkApkFile({ name: "notes.txt", size: 10, head: ZIP_HEAD }).reason, /\.apk/);
  assert.match(L.checkApkFile({ name: "a.apk", size: 0, head: ZIP_HEAD }).reason, /فارغ/);
  assert.match(L.checkApkFile({ name: "a.apk", size: L.MAX_APK_BYTES + 1, head: ZIP_HEAD }).reason, /أكبر/);
  assert.match(L.checkApkFile({ name: "a.apk", size: 10, head: new Uint8Array([1, 2, 3, 4]) }).reason, /ZIP/);
  assert.equal(L.checkApkFile({ name: "a.apk", size: 10, head: new Uint8Array([0x50]) }).ok, false, "a file too short to hold the header");
  assert.equal(L.checkApkFile({ name: "a.apk", size: NaN, head: ZIP_HEAD }).ok, false, "a size that is not a number");
});

test("only the official release file counts as official: size and SHA-256 must both match", () => {
  assert.equal(L.EXPECTED_APK_BYTES, 7009149);
  assert.equal(L.EXPECTED_APK_SHA256, "91532fd903f63414ba365e8406b1ee84d28843c38931b070c89a10a8b398ff4d");
  assert.equal(L.isOfficialApk({ size: L.EXPECTED_APK_BYTES, sha256: L.EXPECTED_APK_SHA256 }), true);
  assert.equal(L.isOfficialApk({ size: L.EXPECTED_APK_BYTES, sha256: null }), false, "a hash that could not be computed is not a match");
  assert.equal(L.isOfficialApk({ size: L.EXPECTED_APK_BYTES, sha256: "0".repeat(64) }), false);
  assert.equal(L.isOfficialApk({ size: 1, sha256: L.EXPECTED_APK_SHA256 }), false);
  assert.equal(L.RELEASE_APK_URL, "https://github.com/xmiqarri-del/Car_DisplayZ/releases/download/v1.1.6/Car_DisplayZ-v1.1.6.apk");
});

test("pm install and pm uninstall print Success or a Failure code", () => {
  assert.deepEqual(L.parsePmResult("Performing Streamed Install\nSuccess\n"), { ok: true, code: null });
  assert.deepEqual(
    L.parsePmResult("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.x signatures do not match]\n"),
    { ok: false, code: "INSTALL_FAILED_UPDATE_INCOMPATIBLE" },
  );
  assert.deepEqual(L.parsePmResult("Success\n"), { ok: true, code: null });
  assert.deepEqual(L.parsePmResult("Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]\n"), { ok: false, code: "DELETE_FAILED_DEVICE_POLICY_MANAGER" });
  assert.deepEqual(L.parsePmResult(""), { ok: false, code: null });
  assert.deepEqual(L.parsePmResult("Error: something else"), { ok: false, code: null });
});

test("the user-app list keeps valid package lines only, each once, sorted", () => {
  assert.deepEqual(
    L.parsePackageList("package:com.xmiqarri.cardisplayz\r\npackage:com.waze\nnot a package line\npackage:com.waze\npackage:bad name\n"),
    ["com.waze", "com.xmiqarri.cardisplayz"],
  );
  assert.deepEqual(L.parsePackageList(""), []);
});

test("uninstall targets exactly one package, and a refused removal is explained", () => {
  assert.equal(L.cmd.pmUninstall("com.waze"), "pm uninstall com.waze");
  assert.ok(L.diagnoseText("Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]").some((h) => h.id === "delete_failed"));
  assert.ok(L.diagnoseText("Failure [DELETE_FAILED_INTERNAL_ERROR]").some((h) => h.id === "delete_failed"));
});

test("the installed version is read from dumpsys and judged against this release", () => {
  const dump = "    versionCode=8 minSdk=30 targetSdk=33\n    versionName=1.1.6\n";
  assert.deepEqual(L.parseVersion(dump), { versionName: "1.1.6", versionCode: 8 });
  assert.equal(L.parseVersion("nothing here"), null);
  assert.equal(L.versionStatus(L.parseVersion(dump)).state, "ok");
  assert.equal(L.versionStatus({ versionName: "1.1.5", versionCode: 7 }).state, "fail", "an older build is a problem");
  assert.equal(L.versionStatus({ versionName: "1.2.0", versionCode: 9 }).state, "info", "a newer build is only noted");
  assert.equal(L.versionStatus({ versionName: "1.1.6", versionCode: null }).state, "ok");
  assert.equal(L.versionStatus({ versionName: "1.1.5", versionCode: null }).state, "info");
  assert.equal(L.versionStatus(null).state, "info");
});

test("install and cleanup commands only ever touch the fixed scratch path", () => {
  assert.equal(L.APK_TEMP_PATH, "/data/local/tmp/webinstaller_install.apk");
  assert.equal(L.cmd.pmInstall(L.APK_TEMP_PATH), "pm install -r /data/local/tmp/webinstaller_install.apk");
  assert.equal(L.cmd.rmFile(L.APK_TEMP_PATH), "rm -f /data/local/tmp/webinstaller_install.apk");
});

// ---------- Error knowledge base ----------

const expectRule = (text, id) => {
  const ids = L.diagnoseText(text).map((h) => h.id);
  assert.ok(ids.includes(id), `expected ${id} for: ${text} -> got ${ids}`);
};

test("error messages map to the right cause", () => {
  expectRule("adb: error: device unauthorized. This adb server's $ADB_VENDOR_KEYS is not allowed", "unauthorized");
  expectRule("error: device offline", "offline");
  expectRule("error: no devices/emulators found", "no_device");
  expectRule("'adb' is not recognized as an internal or external command", "adb_missing");
  expectRule("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.x signatures do not match]", "install_update_incompatible");
  expectRule("Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected]", "install_version_downgrade");
  expectRule("Failure [INSTALL_FAILED_OLDER_SDK]", "install_older_sdk");
  expectRule("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]", "install_storage");
  expectRule("Failure [INSTALL_CANCELED_BY_USER]", "install_user_restricted");
  expectRule("Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]", "install_parse");
  expectRule("java.lang.SecurityException: Permission Denial: starting Intent requires android.permission.X", "permission_denial");
  expectRule("Error: Unknown package: com.foo", "unknown_package");
  expectRule("Unknown permission: android.permission.FOO", "unknown_permission");
  expectRule("Operation not allowed: android.permission.READ_LOGS is not a runtime permission", "not_runtime_permission");
  expectRule("appops: inaccessible or not found", "appops_missing");
  expectRule("Unable to claim interface", "claim_interface");
  expectRule("NotAllowedError: Failed to execute 'requestDevice' on 'USB': Access denied", "webusb_denied");
  expectRule("NotFoundError: Failed to execute 'requestDevice' on 'USB': No device selected.", "no_device_selected");
  expectRule("Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/x", "lib_load");
  expectRule("انتهت المهلة الزمنية: موافقة الشاشة", "timeout");
});

test("a transfer that times out is not reported as a car-screen approval timeout", () => {
  expectRule("انتهت المهلة الزمنية: نقل الملف إلى الشاشة", "command_timeout");
  expectRule("انتهت المهلة الزمنية: pm install -r /data/local/tmp/webinstaller_install.apk", "command_timeout");
  const ids = L.diagnoseText("انتهت المهلة الزمنية: نقل الملف إلى الشاشة").map((h) => h.id);
  assert.equal(ids.includes("timeout"), false);
  const approval = L.diagnoseText("انتهت المهلة الزمنية: موافقة الشاشة").map((h) => h.id);
  assert.equal(approval.includes("command_timeout"), false);
});

test("a head unit out of space while copying the APK is explained", () => {
  expectRule("No space left on device", "sync_no_space");
  expectRule("write failed: ENOSPC", "sync_no_space");
});

test("a pm grant for a permission the app does not request is explained", () => {
  expectRule("Unable to grant android.permission.POST_NOTIFICATIONS to package com.x: not requested by package", "permission_not_requested");
});

test("a 'no device selected' error does not also report a WebUSB denial", () => {
  const ids = L.diagnoseText("NotFoundError: Failed to execute 'requestDevice' on 'USB': No device selected.").map((h) => h.id);
  assert.equal(ids.includes("webusb_denied"), false);
});

test("unknown install codes fall back to a generic answer, and empty text gives nothing", () => {
  const hits = L.diagnoseText("Failure [INSTALL_FAILED_SOMETHING_NEW]");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "install_generic");
  assert.deepEqual(L.diagnoseText(""), []);
  assert.deepEqual(L.diagnoseText("random words"), []);
});

test("environment notes flag missing WebUSB, insecure context and Firefox", () => {
  const bad = L.environmentNotes({ hasWebUsb: false, isSecureContext: false, userAgent: "Mozilla/5.0 Firefox/130.0" });
  assert.equal(bad.filter((n) => n.level === "fail").length, 2);
  assert.equal(bad.filter((n) => n.level === "warn").length, 1);
  assert.deepEqual(L.environmentNotes({ hasWebUsb: true, isSecureContext: true, userAgent: "Chrome/130" }), []);
});

// ---------- Install script ----------

test("install .bat uses CRLF, valid labels and never overwrites the accessibility list", () => {
  const bat = L.buildInstallBat({ pkg: PKG, version: "1.1.6", apkName: "Car_DisplayZ-v1.1.6.apk", apkUrl: "https://example.test/a.apk" });
  assert.equal(/[^\r]\n/.test(bat), false, "every line ends with CRLF");
  assert.equal(/&\s*goto/i.test(bat), false, "no 'cmd & goto' pattern (it would always jump)");
  assert.equal(/settings put secure enabled_accessibility_services/i.test(bat), false, "must not overwrite accessibility services");
  const labels = new Set([...bat.matchAll(/^:(\w+)/gm)].map((m) => m[1]));
  for (const m of bat.matchAll(/goto :(\w+)/g)) assert.ok(labels.has(m[1]), `missing label ${m[1]}`);
  assert.ok(bat.includes(`set "PKG=${PKG}"`));
  assert.ok(bat.includes("install -r"));
  assert.ok(bat.includes("dumpsys deviceidle whitelist +%PKG%"));
  assert.ok(bat.includes("SYSTEM_ALERT_WINDOW allow"));
});

// ---------- Permission doctor and fixes (against the simulated device) ----------

test("doctor reports the real problems on a fresh head unit", async () => {
  const dev = makeDevice({ services: "com.other/.Svc", appops: { [`${PKG}|RUN_ANY_IN_BACKGROUND`]: "ignore" } });
  const r = byId(await L.runDoctor(dev.ctx));
  assert.equal(r.sdk.state, "ok");
  assert.equal(r.installed.state, "ok");
  assert.equal(r.version.state, "ok", "the default test unit runs the release this page installs");
  assert.equal(r.overlay.state, "fail");
  assert.equal(r.accessibility.state, "fail");
  assert.equal(r.install_unknown.state, "fail");
  assert.equal(r.notifications.state, "fail");
  assert.equal(r.background.state, "fail");
  assert.equal(r.battery.state, "fail");
});

test("doctor flags an older installed build, and that problem has no automatic fix", async () => {
  const dev = makeDevice({ versionName: "1.1.5", versionCode: 7 });
  const r = byId(await L.runDoctor(dev.ctx));
  assert.equal(r.version.state, "fail");
  assert.equal(r.version.fixable, false);
  assert.match(r.version.detail, /أقدم/);
});

test("auto-fix repairs every problem and keeps the other accessibility services", async () => {
  const dev = makeDevice({ services: "com.other/.Svc", appops: { [`${PKG}|RUN_ANY_IN_BACKGROUND`]: "ignore" } });
  const report = await L.autoFix(dev.ctx);
  assert.ok(report.actions.length >= 6, `fixed ${report.actions.length} checks`);
  assert.ok(report.actions.every((a) => a.fixed), JSON.stringify(report.actions.map((a) => [a.id, a.after.state])));
  const after = byId(report.after);
  for (const id of ["overlay", "accessibility", "install_unknown", "notifications", "background", "battery"]) {
    assert.equal(after[id].state, "ok", id);
  }
  assert.equal(dev.state.settings.enabled_accessibility_services, `com.other/.Svc:${COMP}`);
  assert.equal(dev.state.settings.accessibility_enabled, "1");
  assert.equal(dev.state.appops[`${PKG}|SYSTEM_ALERT_WINDOW`], "allow");
  assert.ok(dev.state.whitelist.includes(PKG));
});

test("a second auto-fix run performs no write commands", async () => {
  const dev = makeDevice({ services: "com.other/.Svc" });
  await L.autoFix(dev.ctx);
  const services = dev.state.settings.enabled_accessibility_services;
  const mark = dev.state.commands.length;
  const report = await L.autoFix(dev.ctx);
  assert.equal(report.actions.length, 0);
  assert.equal(dev.state.settings.enabled_accessibility_services, services);
  const writes = dev.state.commands.slice(mark).filter((c) => /^(appops set|settings put|pm grant|dumpsys deviceidle whitelist \+)/.test(c));
  assert.deepEqual(writes, []);
});

test("a fix that does not work is not reported as fixed", async () => {
  const dev = makeDevice({ failPmGrant: true });
  const result = await L.applyFix(dev.ctx, "notifications");
  assert.equal(result.fixed, false);
  assert.equal(result.after.state, "fail");
});

test("app-dependent checks are skipped when the app is not installed", async () => {
  const dev = makeDevice({ installed: false });
  const r = byId(await L.runDoctor(dev.ctx));
  assert.equal(r.installed.state, "fail");
  assert.equal(r.overlay.state, "na");
  assert.equal(r.accessibility.state, "na");
  assert.equal(r.version.state, "na");
  const report = await L.autoFix(dev.ctx);
  assert.equal(report.actions.length, 0, "nothing is fixable without the app");
});

test("Android 10 is reported as too old, and notifications do not apply below Android 13", async () => {
  const dev = makeDevice({ sdk: 29 });
  const r = byId(await L.runDoctor(dev.ctx));
  assert.equal(r.sdk.state, "fail");
  const dev30 = makeDevice({ sdk: 30 });
  const r30 = byId(await L.runDoctor(dev30.ctx));
  assert.equal(r30.notifications.state, "na");
});

test("unfixable checks refuse to run a fix", async () => {
  const dev = makeDevice();
  await assert.rejects(() => L.applyFix(dev.ctx, "installed"), /لا يوجد إصلاح/);
});

test("a shell that throws becomes an error state, not a crash", async () => {
  const ctx = { pkg: PKG, run: async () => { throw new Error("boom"); }, log() {} };
  const r = await L.runDoctor(ctx);
  assert.ok(r.every((x) => x.state === "error" || x.state === "info" || x.state === "na"));
  assert.ok(r.some((x) => x.state === "error"));
});

// ---------- Boot start: Android starts an app after reboot only once it has been opened ----------

test("the run state is read from dumpsys: stopped and notLaunched flags", () => {
  const line = (stopped, notLaunched) =>
    `    User 0: ceDataInode=0 installed=true hidden=false suspended=false distractionFlags=0 ` +
    `stopped=${stopped} notLaunched=${notLaunched} enabled=0 instant=false virtual=false`;
  assert.deepEqual(L.parseRunState(line("false", "false")), { stopped: false, notLaunched: false });
  assert.deepEqual(L.parseRunState(line("true", "false")), { stopped: true, notLaunched: false });
  assert.deepEqual(L.parseRunState(line("true", "true")), { stopped: true, notLaunched: true });
  assert.deepEqual(L.parseRunState("    versionCode=8\n"), { stopped: null, notLaunched: null });
  assert.deepEqual(L.parseRunState(""), { stopped: null, notLaunched: null });
});

test("a never-opened or force-stopped app is flagged, and the launch fix opens it once", async () => {
  const fresh = makeDevice({ stopped: true, notLaunched: true });
  const r = byId(await L.runDoctor(fresh.ctx));
  assert.equal(r.launch_state.state, "fail");
  assert.equal(r.launch_state.value, "لم يُفتح بعد");
  assert.equal(r.launch_state.fixable, true);
  const fixed = await L.applyFix(fresh.ctx, "launch_state");
  assert.equal(fixed.fixed, true);
  assert.deepEqual(fresh.state.launches, [PKG]);
  assert.ok(fresh.state.commands.includes(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`));
  assert.equal(fresh.state.stopped, false);

  const stopped = makeDevice({ stopped: true });
  const s = byId(await L.runDoctor(stopped.ctx));
  assert.equal(s.launch_state.state, "fail");
  assert.equal(s.launch_state.value, "موقوف");
});

test("an app that was opened before is fine, and the boot check is skipped without the app", async () => {
  const opened = byId(await L.runDoctor(makeDevice().ctx));
  assert.equal(opened.launch_state.state, "ok");
  const none = byId(await L.runDoctor(makeDevice({ installed: false }).ctx));
  assert.equal(none.launch_state.state, "na");
});

test("auto-fix opens a never-opened app last, after the permission fixes", async () => {
  const dev = makeDevice({ services: "com.other/.Svc", stopped: true, notLaunched: true });
  const report = await L.autoFix(dev.ctx);
  const ids = report.actions.map((a) => a.id);
  assert.equal(ids[ids.length - 1], "launch_state", ids.join(","));
  assert.ok(report.actions.every((a) => a.fixed), JSON.stringify(report.actions.map((a) => [a.id, a.after.state])));
  assert.deepEqual(dev.state.launches, [PKG]);
});
