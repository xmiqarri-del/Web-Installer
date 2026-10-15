// Browser tests: Chromium opens the built page, page.route serves the fake @yume-chan modules
// in place of jsDelivr, and the tests press the real buttons.
//
// Needs Playwright with Chromium (see README.md). Optional environment variables:
//   PLAYWRIGHT_MODULE  path to another copy of playwright's index.mjs
//   CDZ_SHOTS          folder for screenshots and test files (default: shots/ in this project)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, OUT_FILE } from "../build.mjs";
import * as L from "../src/logic.mjs";
import { fakeModules } from "./browser-fakes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.CDZ_SHOTS ?? join(here, "..", "shots");
const FIXTURES = join(SHOTS, "fixtures");
const PKG = "com.xmiqarri.cardisplayz";
const SCRATCH_APK = "/data/local/tmp/webinstaller_install.apk";
const RELEASE_APK = L.RELEASE_APK_URL;
const playwrightUrl = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright";
const { chromium } = await import(playwrightUrl);

let browser;
before(async () => {
  await build();
  await mkdir(SHOTS, { recursive: true });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function waitForText(page, selector, text, timeoutMs = 8000) {
  let last = "";
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    last = (await page.textContent(selector)) ?? "";
    if (last.includes(text)) return last;
    await sleep(100);
  }
  assert.fail(`"${text}" did not appear in ${selector}. Last text (tail):\n${last.slice(-400)}`);
}

// The simulated head unit as plain data (staged files are reduced to their paths).
const headUnit = (page) => page.evaluate(() => {
  const s = window.__cdzHeadUnit;
  return { ...s, staged: Object.keys(s.staged) };
});

async function openPage({ fake = {}, cdn = "ok", viewport = { width: 1280, height: 900 }, clock = false } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mods = fakeModules(fake);
  await page.route("https://cdn.jsdelivr.net/**", (route) => {
    const url = route.request().url();
    let body = null;
    if (cdn === "ok") {
      if (url.includes("/@yume-chan/adb@2.6.4/")) body = mods.adb;
      else if (url.includes("/@yume-chan/adb-daemon-webusb@2.3.2/")) body = mods.webusb;
      else if (url.includes("/@yume-chan/adb-credential-web@2.1.0/")) body = mods.cred;
    }
    if (body === null) return route.abort("failed");
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    });
  });
  if (fake.noWebUsb) {
    await page.addInitScript(() => {
      try { delete Object.getPrototypeOf(navigator).usb; } catch { /* keep the browser default */ }
    });
  }
  if (clock) await page.clock.install({ time: 0 });
  await page.goto(pathToFileURL(OUT_FILE).href);
  return { context, page, errors };
}

// Opens the page, runs the test body, and fails if any uncaught page error happened.
async function withPage(opts, body) {
  const { context, page, errors } = await openPage(opts);
  try {
    await body(page);
    assert.deepEqual(errors, [], "uncaught page errors");
  } finally {
    await context.close();
  }
}

async function connectAndWait(page) {
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  await page.click("#btnConnect");
  await waitForText(page, "#statusBadge", "متصل بالشاشة");
}

async function runDoctor(page) {
  await page.click("#btnDoctor");
  await waitForText(page, "#terminal", "انتهى التشخيص.");
}

// Test files are written next to the screenshots (not in the source tree).
async function writeFixture(name, bytes) {
  await mkdir(FIXTURES, { recursive: true });
  const path = join(FIXTURES, name);
  await writeFile(path, bytes);
  return path;
}

// A stand-in APK: the ZIP header, a text marker that the fake head unit reads back, and padding.
function fakeApkBytes({ versionName = L.APP_VERSION, versionCode = L.EXPECTED_VERSION_CODE, pad = 4096 } = {}) {
  const marker = `CDZ-FAKE-APK package=${PKG} versionName=${versionName} versionCode=${versionCode}`;
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker, "latin1"), Buffer.alloc(pad)]);
}

// Presses the install button and gives the file picker the file.
async function chooseFile(page, path) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btnInstall")]);
  await chooser.setFiles(path);
}

test("opens cleanly: first steps shown, nothing connected yet", () => withPage({}, async (page) => {
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  assert.equal((await page.textContent("#statusBadge")).trim(), "غير متصل ❌");
  assert.equal(await page.isVisible("#btnConnect"), true);
  assert.equal(await page.isVisible("#btnDisconnect"), false);
  assert.equal((await page.textContent("#summary")).trim(), "لم يُجرَ التشخيص بعد.");
  assert.ok((await page.textContent("#envNotes")).trim().length > 0, "environment notes are rendered");
}));

test("connect, then the doctor lists exactly the five real problems", () => withPage(
  { fake: { headUnit: { services: "com.other/.Svc" } } },
  async (page) => {
    await connectAndWait(page);
    await waitForText(page, "#terminal", "الموديل: JetourG700");
    await runDoctor(page);
    assert.match(await page.textContent("#summary"), /سليم: 5\s+\|\s+مشاكل: 5\s+\|\s+لا ينطبق: 0/);
    assert.equal(await page.locator("#checks .card").count(), 10);
    const failing = await page.$$eval("#checks .card.st-fail strong", (els) => els.map((e) => e.textContent));
    assert.deepEqual(failing, [
      "الزر العائم (الظهور فوق التطبيقات)",
      "شريط الأزرار السفلي (خدمة إمكانية الوصول)",
      "التثبيت من مصادر غير معروفة",
      "الإشعارات",
      "استثناء توفير البطارية",
    ]);
    assert.equal(await page.locator("#checks .card button").count(), 5, "each failing check offers a fix button");
    await page.screenshot({ path: join(SHOTS, "desktop-doctor.png") });
  },
));

test("auto-fix needs confirmation, then repairs the head unit and keeps other accessibility services", () => withPage(
  { fake: { headUnit: { services: "com.other/.Svc" } } },
  async (page) => {
    await connectAndWait(page);
    page.once("dialog", (d) => d.dismiss());
    await page.click("#btnAutoFix");
    await sleep(300);
    const before = await headUnit(page);
    assert.equal(before.commands.some((c) => /^(appops set|settings put|pm grant|dumpsys deviceidle whitelist \+)/.test(c)), false,
      "a dismissed confirmation must not write anything");

    page.once("dialog", (d) => d.accept());
    await page.click("#btnAutoFix");
    await waitForText(page, "#summary", "مشاكل: 0");
    assert.match(await page.textContent("#summary"), /سليم: 10/);
    const hu = await headUnit(page);
    assert.equal(hu.settings.enabled_accessibility_services,
      `com.other/.Svc:${PKG}/${PKG}.nav.NavBarService`);
    assert.equal(hu.settings.accessibility_enabled, "1");
    assert.equal(hu.appops[`${PKG}|SYSTEM_ALERT_WINDOW`], "allow");
    assert.equal(hu.appops[`${PKG}|REQUEST_INSTALL_PACKAGES`], "allow");
    assert.equal(hu.granted["android.permission.POST_NOTIFICATIONS"], true);
    assert.ok(hu.whitelist.includes(PKG));
  },
));

test("one 'إصلاح' button fixes only its own permission", () => withPage(
  { fake: { headUnit: { services: "com.other/.Svc" } } },
  async (page) => {
    await connectAndWait(page);
    await runDoctor(page);
    page.once("dialog", (d) => d.accept());
    await page.locator("#checks .card", { hasText: "الزر العائم" }).locator("button").click();
    await waitForText(page, "#summary", "مشاكل: 4");
    const hu = await headUnit(page);
    assert.equal(hu.appops[`${PKG}|SYSTEM_ALERT_WINDOW`], "allow");
    assert.equal(hu.settings.accessibility_enabled, "0", "other fixes were not touched");
  },
));

test("the error decoder explains a pasted install failure", () => withPage({}, async (page) => {
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  await page.fill("#errInput", "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.xmiqarri.cardisplayz signatures do not match]");
  await page.click("#btnDecode");
  await waitForText(page, "#decoderOut", "التوقيع لا يطابق النسخة المثبتة");
  assert.match(await page.textContent("#decoderOut"), /APK المنشور في GitHub/);
  await page.fill("#errInput", "nothing known here");
  await page.click("#btnDecode");
  await waitForText(page, "#decoderOut", "لم أجد مطابقة معروفة");
}));

test("the BAT download is Windows text with CRLF endings and the right release link", () => withPage({}, async (page) => {
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btnBat")]);
  assert.equal(download.suggestedFilename(), `Install_Car_DisplayZ_${L.APP_VERSION}.bat`);
  const file = join(SHOTS, download.suggestedFilename());
  await download.saveAs(file);
  const bat = await readFile(file, "utf8");
  assert.equal(/[^\r]\n/.test(bat), false, "every line must end with CRLF");
  assert.ok(bat.includes(RELEASE_APK));
  assert.ok(bat.includes(`set "PKG=${PKG}"`));
  assert.equal(bat.includes("enabled_accessibility_services"), false, "the BAT must not overwrite the accessibility list");
}));

test("the install section links to the release APK that the page checks against", () => withPage({}, async (page) => {
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  assert.equal(await page.getAttribute("#apkLink", "href"), RELEASE_APK);
}));

test("the install button asks for a connection before it opens the file picker", () => withPage({}, async (page) => {
  let pickerOpened = false;
  page.on("filechooser", () => { pickerOpened = true; });
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  await page.click("#btnInstall");
  await waitForText(page, "#terminal", "اتصل بالشاشة أولاً.");
  await sleep(300);
  assert.equal(pickerOpened, false);
}));

test("another app: any APK installs, and its package name is filled in from the device", () => withPage(
  { fake: { headUnit: {} } },
  async (page) => {
    await connectAndWait(page);
    const otherBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("CDZ-FAKE-APK package=com.example.other versionName=2.0 versionCode=20", "latin1"),
      Buffer.alloc(4096),
    ]);
    const apk = await writeFixture("OtherApp.apk", otherBytes);

    page.once("dialog", (d) => d.accept());
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btnInstallOther")]);
    await chooser.setFiles(apk);
    await waitForText(page, "#terminal", "اسم الحزمة: com.example.other");
    assert.equal(await page.inputValue("#pkgInput"), "com.example.other");
    const hu = await headUnit(page);
    assert.ok(hu.userPackages.includes("com.example.other"), "the other app is on the head unit");
    assert.equal(hu.installed, true, "the DisplayZ state is untouched by installing another app");
  },
));

test("a picked APK is copied to the head unit, installed, cleaned up, and its version read back", () => withPage(
  { fake: { headUnit: { versionName: "1.1.5", versionCode: 7 } } },
  async (page) => {
    await connectAndWait(page);
    const apk = await writeFixture(L.EXPECTED_APK_NAME, fakeApkBytes());

    // The file is not the official build, so the page asks first. Declining copies nothing.
    page.once("dialog", (d) => d.dismiss());
    await chooseFile(page, apk);
    await waitForText(page, "#terminal", "ألغيت العملية");
    assert.equal((await headUnit(page)).pushes.length, 0, "a declined warning copies nothing");

    page.once("dialog", (d) => d.accept());
    await chooseFile(page, apk);
    await waitForText(page, "#terminal", `تم التثبيت ✅ الإصدار ${L.APP_VERSION} (${L.EXPECTED_VERSION_CODE})`);
    const hu = await headUnit(page);
    assert.equal(hu.pushes.length, 1);
    assert.equal(hu.pushes[0].filename, SCRATCH_APK);
    assert.equal(hu.pushes[0].size, (await readFile(apk)).length);
    assert.ok(hu.commands.includes(`pm install -r ${SCRATCH_APK}`));
    assert.deepEqual(hu.installs, [PKG]);
    assert.deepEqual(hu.removed, [SCRATCH_APK], "the copy is removed afterwards");
    assert.deepEqual(hu.staged, []);
    assert.equal(hu.version.name, L.APP_VERSION);
    assert.equal(hu.version.code, L.EXPECTED_VERSION_CODE);
    await waitUntil(async () => (await page.locator("#checks .card.st-ok", { hasText: "إصدار التطبيق" }).count()) === 1,
      "the doctor shows the new version as correct");
    await page.screenshot({ path: join(SHOTS, "desktop-install.png") });
  },
));

test("a refused install is explained, the copy is still removed, and the old version is still reported", () => withPage(
  { fake: { headUnit: { versionName: "1.1.5", versionCode: 7, installFailure: "INSTALL_FAILED_UPDATE_INCOMPATIBLE" } } },
  async (page) => {
    await connectAndWait(page);
    const apk = await writeFixture(L.EXPECTED_APK_NAME, fakeApkBytes());
    page.once("dialog", (d) => d.accept());
    await chooseFile(page, apk);
    await waitForText(page, "#terminal", "لم يكتمل التثبيت: INSTALL_FAILED_UPDATE_INCOMPATIBLE");
    await waitForText(page, "#terminal", "التوقيع لا يطابق النسخة المثبتة");
    const hu = await headUnit(page);
    assert.deepEqual(hu.removed, [SCRATCH_APK]);
    assert.deepEqual(hu.installs, []);
    assert.deepEqual(hu.staged, []);
    await runDoctor(page);
    assert.equal(await page.locator("#checks .card.st-fail", { hasText: "إصدار التطبيق" }).count(), 1,
      "the old version is still reported as old");
  },
));

test("a head unit that is out of space says so, and nothing is installed", () => withPage(
  { fake: { syncFailure: "nospace" } },
  async (page) => {
    await connectAndWait(page);
    const apk = await writeFixture(L.EXPECTED_APK_NAME, fakeApkBytes());
    page.once("dialog", (d) => d.accept());
    await chooseFile(page, apk);
    await waitForText(page, "#terminal", "لا توجد مساحة كافية على الشاشة لنقل الملف");
    const hu = await headUnit(page);
    assert.equal(hu.commands.some((c) => c.startsWith("pm install")), false, "nothing is installed");
    assert.deepEqual(hu.removed, [SCRATCH_APK], "the temporary copy is still removed");
  },
));

test("a file that is not an APK is refused before anything is copied", () => withPage({}, async (page) => {
  await connectAndWait(page);
  await chooseFile(page, await writeFixture("notes.txt", "this is not an app"));
  await waitForText(page, "#terminal", "ليس بامتداد .apk");
  await chooseFile(page, await writeFixture("broken.apk", "this is not a zip file"));
  await waitForText(page, "#terminal", "لا يبدأ بترويسة ZIP");
  assert.equal((await headUnit(page)).pushes.length, 0);
}));

test("a car screen that refuses the USB debugging prompt is explained", () => withPage(
  { fake: { auth: "unauthorized" } },
  async (page) => {
    await waitForText(page, "#terminal", "تشخيص الصلاحيات");
    await page.click("#btnConnect");
    await waitForText(page, "#terminal", "الشاشة لم تقبل تصريح تصحيح USB");
    assert.equal((await page.textContent("#statusBadge")).trim(), "غير متصل ❌");
  },
));

test("cancelling the device chooser is not reported as a crash", async () => {
  await withPage({ fake: { request: "cancel" } }, async (page) => {
    await waitForText(page, "#terminal", "تشخيص الصلاحيات");
    await page.click("#btnConnect");
    await waitForText(page, "#terminal", "لم تختر جهازاً.");
    assert.equal(await page.isVisible("#btnConnect"), true);
  });
  await withPage({ fake: { request: "notfound" } }, async (page) => {
    await waitForText(page, "#terminal", "تشخيص الصلاحيات");
    await page.click("#btnConnect");
    await waitForText(page, "#terminal", "لم تُختر جهاز الشاشة من نافذة المتصفح");
  });
});

test("waiting for approval on the car screen gives up after 90 s with advice", () => withPage(
  { fake: { auth: "hang" }, clock: true },
  async (page) => {
    await waitForText(page, "#terminal", "تشخيص الصلاحيات");
    await page.click("#btnConnect");
    await waitForText(page, "#terminal", "وافق على طلب تصحيح USB");
    await page.clock.runFor(95_000);
    await waitForText(page, "#terminal", "انتهت المهلة الزمنية");
    await waitForText(page, "#terminal", "لم تُقبل الموافقة على الشاشة في الوقت المحدد");
    assert.equal((await page.textContent("#statusBadge")).trim(), "غير متصل ❌");
  },
));

test("if the ADB library cannot load, the page still opens and explains why", () => withPage(
  { cdn: "fail" },
  async (page) => {
    await waitForText(page, "#terminal", "تعذّر تحميل مكتبة ADB");
    await page.click("#btnConnect");
    await waitForText(page, "#terminal", "تعذّر تحميل مكتبة ADB من الإنترنت");
    await page.click("#btnDoctor");
    await waitForText(page, "#terminal", "اتصل بالشاشة أولاً");
    await page.fill("#errInput", "Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/x");
    await page.click("#btnDecode");
    await waitForText(page, "#decoderOut", "تعذّر تحميل مكتبة ADB من الإنترنت");
  },
));

test("a browser without WebUSB is told before anything is attempted", () => withPage(
  { fake: { noWebUsb: true } },
  async (page) => {
    await waitForText(page, "#envNotes", "المتصفح لا يدعم WebUSB");
    await page.click("#btnConnect");
    await waitForText(page, "#terminal", "المتصفح لا يدعم WebUSB.");
  },
));

test("the adb shell box refuses while disconnected and runs commands once connected", () => withPage({}, async (page) => {
  await waitForText(page, "#terminal", "تشخيص الصلاحيات");
  await page.fill("#cmdInput", "getprop ro.product.model");
  await page.press("#cmdInput", "Enter");
  await waitForText(page, "#terminal", "غير متصل بالشاشة");
  await connectAndWait(page);
  await page.fill("#cmdInput", "getprop ro.product.model");
  await page.press("#cmdInput", "Enter");
  await waitForText(page, "#terminal", "$ getprop ro.product.model");
  await waitUntil(async () => (await page.textContent("#terminal")).split("JetourG700").length >= 3,
    "the model printed by the typed command");
  assert.equal(await page.inputValue("#cmdInput"), "");
}));

test("'overlay for selected apps' asks first, then grants only the checked apps one by one", () => withPage({}, async (page) => {
  await connectAndWait(page);
  await page.click("#btnListApps");
  await waitUntil(async () => (await page.locator("#userApps input[type=checkbox]").count()) === 2, "two user apps listed");

  await page.click("#btnGrantOverlaySelected");
  await waitForText(page, "#terminal", "حدّد تطبيقاً واحداً على الأقل من القائمة.");
  const none = await headUnit(page);
  assert.equal(none.commands.some((c) => c.startsWith("appops set")), false, "nothing selected must change nothing");

  await page.locator(".app-row", { hasText: "com.waze" }).locator("input").check();
  page.once("dialog", (d) => d.dismiss());
  await page.click("#btnGrantOverlaySelected");
  await waitForText(page, "#terminal", "ألغيت العملية. لم تُمنح أي صلاحية.");
  const declined = await headUnit(page);
  assert.equal(declined.commands.some((c) => c.startsWith("appops set")), false, "a dismissed warning must change nothing");

  page.once("dialog", (d) => d.accept());
  await page.click("#btnGrantOverlaySelected");
  await waitForText(page, "#terminal", "انتهى: 1 من 1 تطبيق.");
  const hu = await headUnit(page);
  assert.equal(hu.appops[`com.waze|SYSTEM_ALERT_WINDOW`], "allow");
  assert.equal(hu.appops[`${PKG}|SYSTEM_ALERT_WINDOW`], undefined, "an unchecked app must not be granted");
}));

test("older head units without shell v2 still get a full diagnosis", () => withPage(
  { fake: { noShellV2: true, headUnit: { services: "com.other/.Svc" } } },
  async (page) => {
    await connectAndWait(page);
    await runDoctor(page);
    assert.match(await page.textContent("#summary"), /مشاكل: 5/);
  },
));

test("user-installed apps are listed with checkboxes, and nothing is removed without confirmation", () => withPage({}, async (page) => {
  await connectAndWait(page);
  await page.click("#btnListApps");
  await waitUntil(async () => (await page.locator("#userApps input[type=checkbox]").count()) === 2, "two user apps listed");
  const values = await page.$$eval("#userApps input[type=checkbox]", (els) => els.map((e) => e.value));
  assert.deepEqual(values, ["com.waze", "com.xmiqarri.cardisplayz"]);
  await page.locator(".app-row", { hasText: "com.waze" }).locator("input").check();
  page.once("dialog", (d) => d.dismiss());
  await page.click("#btnUninstall");
  await waitForText(page, "#terminal", "ألغيت العملية. لم يُحذف شيء.");
  const hu = await headUnit(page);
  assert.deepEqual(hu.uninstalls, []);
  assert.ok(hu.userPackages.includes("com.waze"));
}));

test("checked apps are removed after confirmation, and the list is refreshed", () => withPage({}, async (page) => {
  await connectAndWait(page);
  await page.click("#btnListApps");
  await waitUntil(async () => (await page.locator("#userApps input[type=checkbox]").count()) === 2, "two user apps listed");
  await page.locator(".app-row", { hasText: "com.waze" }).locator("input").check();
  page.once("dialog", (d) => d.accept());
  await page.click("#btnUninstall");
  await waitForText(page, "#terminal", "تم حذف com.waze ✅");
  await waitUntil(async () => (await page.locator("#userApps input[type=checkbox]").count()) === 1, "one user app left in the list");
  const hu = await headUnit(page);
  assert.deepEqual(hu.uninstalls, ["com.waze"]);
  assert.deepEqual(hu.userPackages, ["com.xmiqarri.cardisplayz"]);
}));

test("removing Car_DisplayZ itself is allowed, and the confirmation says it must be reinstalled", () => withPage({}, async (page) => {
  await connectAndWait(page);
  await page.click("#btnListApps");
  await waitUntil(async () => (await page.locator("#userApps input[type=checkbox]").count()) === 2, "two user apps listed");
  await page.locator(".app-row", { hasText: "com.xmiqarri.cardisplayz" }).locator("input").check();
  const messages = [];
  page.once("dialog", (d) => { messages.push(d.message()); d.accept(); });
  await page.click("#btnUninstall");
  await waitForText(page, "#terminal", "تم حذف com.xmiqarri.cardisplayz ✅");
  assert.match(messages[0], /ستحتاج إلى تثبيته من ملف APK/);
  const hu = await headUnit(page);
  assert.equal(hu.installed, false);
  assert.deepEqual(hu.uninstalls, ["com.xmiqarri.cardisplayz"]);
}));

test("a removal the head unit refuses is explained, and the app stays listed", () => withPage(
  { fake: { headUnit: { uninstallFailure: "DELETE_FAILED_DEVICE_POLICY_MANAGER" } } },
  async (page) => {
    await connectAndWait(page);
    await page.click("#btnListApps");
    await waitUntil(async () => (await page.locator("#userApps input[type=checkbox]").count()) === 2, "two user apps listed");
    await page.locator(".app-row", { hasText: "com.waze" }).locator("input").check();
    page.once("dialog", (d) => d.accept());
    await page.click("#btnUninstall");
    await waitForText(page, "#terminal", "لم يُحذف com.waze: DELETE_FAILED_DEVICE_POLICY_MANAGER.");
    await waitForText(page, "#terminal", "مسؤول جهاز");
    const hu = await headUnit(page);
    assert.deepEqual(hu.uninstalls, []);
    assert.ok(hu.userPackages.includes("com.waze"));
  },
));

test("the delete button asks for a selection first", () => withPage({}, async (page) => {
  await connectAndWait(page);
  await page.click("#btnUninstall");
  await waitForText(page, "#terminal", "حدّد تطبيقاً واحداً على الأقل");
}));

test("a force-stopped app is flagged, and its launch fix opens it once", () => withPage(
  { fake: { headUnit: { stopped: true } } },
  async (page) => {
    await connectAndWait(page);
    await runDoctor(page);
    const bootCard = () => page.locator("article.card", { hasText: "التشغيل بعد إعادة التشغيل" });
    await waitUntil(async () => ((await bootCard().getAttribute("class")) ?? "").includes("st-fail"), "the boot-start card shows a problem");
    page.once("dialog", (d) => d.accept());
    await bootCard().locator("button", { hasText: "إصلاح" }).click();
    await waitForText(page, "#terminal", "تم الإصلاح ✅: التشغيل بعد إعادة التشغيل");
    await waitUntil(async () => ((await bootCard().getAttribute("class")) ?? "").includes("st-ok"), "the boot-start card is ok again");
    const hu = await headUnit(page);
    assert.deepEqual(hu.launches, [PKG]);
    assert.equal(hu.stopped, false);
    assert.equal(hu.notLaunched, false);
  },
));

test("phone width: the layout fits without sideways scrolling", () => withPage(
  { viewport: { width: 390, height: 844 } },
  async (page) => {
    await connectAndWait(page);
    await runDoctor(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `sideways overflow of ${overflow}px`);
    await page.screenshot({ path: join(SHOTS, "phone-doctor.png"), fullPage: true });
  },
));

test("phone, tablet, and laptop layouts fit their viewport and switch columns at the intended widths", async () => {
  for (const { width, height, stacked } of [
    { width: 390, height: 844, stacked: true },
    { width: 768, height: 1024, stacked: true },
    { width: 1024, height: 768, stacked: false },
    { width: 1440, height: 900, stacked: false },
  ]) {
    await withPage({ viewport: { width, height } }, async (page) => {
      await waitForText(page, "#terminal", "تشخيص الصلاحيات");
      const layout = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
        const main = document.querySelector(".main").getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          columnGap: Math.abs(main.top - sidebar.top),
        };
      });
      assert.ok(layout.overflow <= 0, `${width}px viewport has sideways overflow of ${layout.overflow}px`);
      assert.equal(layout.columnGap > 24, stacked, `${width}px should ${stacked ? "stack" : "use columns"}`);
    });
  }
});

test("the framed DisplayZ header and connection hero keep their live USB controls visible", () => withPage(
  { viewport: { width: 390, height: 844 } },
  async (page) => {
    await waitForText(page, "#terminal", "تشخيص الصلاحيات");
    assert.equal(await page.locator(".brand-link").isVisible(), true);
    assert.equal(await page.locator(".hero-panel").isVisible(), true);
    assert.equal(await page.locator(".connection-orbit").isVisible(), true);
    assert.equal(await page.locator(".target-package #pkgInput").inputValue(), "com.xmiqarri.cardisplayz");
    assert.equal(await page.locator("#connectionHelp").textContent(), "لا يوجد جهاز متصل");
    await connectAndWait(page);
    assert.equal(await page.locator("#connectionHelp").textContent(), "تم إنشاء اتصال USB آمن بالشاشة");
    assert.equal(await page.isVisible("#btnDisconnect"), true);
  },
));

test("the G700 engineer-code guide updates with firmware, region and clock selection", () => withPage(
  { viewport: { width: 390, height: 844 } },
  async (page) => {
    await waitUntil(async () => /^\d{6}$/.test((await page.textContent("#engineerCode")).trim()), "six-digit engineer code");
    assert.match((await page.textContent("#engineerCode")).trim(), /^\d{6}$/);
    assert.equal((await page.textContent("#engineerDialCode")).trim(), "*#20240730#*");
    await page.selectOption("#engineerVersion", "v336");
    const dynamicCode = (await page.textContent("#engineerCode")).trim();
    assert.match(dynamicCode, /^\d{6}$/);
    assert.equal((await page.textContent("#engineerDialCode")).trim(), `*#${dynamicCode}#*`);
    assert.equal(await page.locator("#engineerVersionHint").isVisible(), true);
    await page.selectOption("#engineerVersion", "v335");
    await page.selectOption("#engineerRegion", "ae");
    await page.selectOption("#engineerClockOffset", "1");
    assert.match((await page.textContent("#engineerCarTime")).trim(), /Asia\/Dubai، \+1h/);
    assert.equal((await page.textContent("#engineerDialCode")).trim(), "*#20240730#*");
    assert.equal(await page.locator("#adb-activation").isVisible(), true);
    await connectAndWait(page);
    assert.equal((await page.textContent("#statusBadge")).includes("متصل بالشاشة"), true);
  },
));
