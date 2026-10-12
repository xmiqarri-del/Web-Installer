// ---------- App glue: DOM, WebUSB connection, ADB shell and file transfer ----------
// Libraries are loaded with dynamic import() so the page still opens (and explains the problem)
// when the CDN cannot be reached.

const $ = (id) => document.getElementById(id);

const CDN = {
  adb: "https://cdn.jsdelivr.net/npm/@yume-chan/adb@2.6.4/+esm",
  webusb: "https://cdn.jsdelivr.net/npm/@yume-chan/adb-daemon-webusb@2.3.2/+esm",
  cred: "https://cdn.jsdelivr.net/npm/@yume-chan/adb-credential-web@2.1.0/+esm",
};
const COMMAND_TIMEOUT_MS = 30000;
const AUTH_TIMEOUT_MS = 90000;      // time to press "السماح" on the car screen
const INSTALL_TIMEOUT_MS = 180000;  // copying and installing the APK can take a while
const LOG_KEY = "cdz_webinstaller_fixlog_v3";

let adb = null;
let deviceModel = "";
let busy = false;
let lastResults = [];
let libError = null;

const libReady = (async () => {
  try {
    const [a, w, c] = await Promise.all([import(CDN.adb), import(CDN.webusb), import(CDN.cred)]);
    return {
      Adb: a.Adb,
      AdbDaemonTransport: a.AdbDaemonTransport,
      WebUsbManager: w.AdbDaemonWebUsbDeviceManager,
      CredentialStore: c.default,
    };
  } catch (e) {
    libError = e;
    return null;
  }
})();

// ---------- Terminal ----------

// Adds a line and returns it, so the line can be updated later (for example transfer progress).
function out(text, kind = "") {
  const term = $("terminal");
  const line = document.createElement("div");
  line.className = `line ${kind}`.trim();
  line.textContent = text;   // textContent: device output is never parsed as HTML
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
  return line;
}

function hints(text) {
  for (const h of diagnoseText(text).slice(0, 3)) {
    out(`▸ ${h.title}`, "hint");
    for (const step of h.steps) out(`    - ${step}`, "hint");
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`انتهت المهلة الزمنية: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Connection ----------

function setConnected(on) {
  const badge = $("statusBadge");
  badge.textContent = on ? "متصل بالشاشة ✅" : "غير متصل ❌";
  badge.classList.toggle("connected", on);
  $("btnConnect").hidden = on;
  $("btnDisconnect").hidden = !on;
}

function onDisconnected() {
  if (adb) out("انقطع الاتصال بالشاشة.", "warn");
  adb = null;
  setConnected(false);
}

async function closeQuietly(target) {
  try { await target?.close?.(); } catch { /* already closed */ }
}

async function connect() {
  if (adb) return;
  const L = await libReady;
  if (!L) {
    const msg = libError?.message ?? String(libError);
    out(`تعذّر تحميل مكتبة ADB: ${msg}`, "err");
    hints(msg);
    return;
  }
  const manager = L.WebUsbManager.BROWSER;
  if (!manager) {
    out("المتصفح لا يدعم WebUSB.", "err");
    hints("WebUSB");
    return;
  }
  let connection = null;
  try {
    out("اختر جهاز الشاشة من نافذة المتصفح...");
    const device = await manager.requestDevice();
    if (!device) {
      out("لم تختر جهازاً.", "warn");
      return;
    }
    connection = await device.connect();
    out("وافق على طلب تصحيح USB على شاشة السيارة، واختر 'السماح دائماً'.", "hint");
    const transport = await withTimeout(
      L.AdbDaemonTransport.authenticate({
        serial: device.serial,
        connection,
        credentialStore: new L.CredentialStore("Car_DisplayZ WebInstaller"),
      }),
      AUTH_TIMEOUT_MS,
      "موافقة الشاشة",
    );
    const session = new L.Adb(transport);
    adb = session;
    // A late "disconnected" event from an older session must not drop the current one.
    const dropped = () => { if (adb === session) onDisconnected(); };
    session.disconnected?.then?.(dropped, dropped);
    setConnected(true);
    out("تم الاتصال بالشاشة ✅", "ok");
    deviceModel = (await runShell(cmd.model(), { quiet: true })).stdout.trim();
    out(`الموديل: ${deviceModel || "غير معروف"}`);
  } catch (e) {
    adb = null;
    setConnected(false);
    await closeQuietly(connection);   // releases the USB interface so the next attempt can claim it
    const text = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    out(`فشل الاتصال: ${text}`, "err");
    hints(text);
  }
}

async function disconnect() {
  const current = adb;
  adb = null;
  setConnected(false);
  try { await current?.close(); } catch { /* already closed */ }
  out("تم قطع الاتصال.");
}

// ---------- Shell ----------

async function runShell(command, opts = {}) {
  const quiet = !!opts.quiet;
  const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
  if (!adb) {
    if (!quiet) out("غير متصل بالشاشة. اضغط 'توصيل الشاشة' أولاً.", "warn");
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: "غير متصل" };
  }
  if (!quiet) out(`$ ${command}`, "cmd");
  try {
    let r;
    const proto = adb.subprocess.shellProtocol;
    if (proto) {
      const res = await withTimeout(proto.spawnWaitText(command), timeoutMs, command);
      r = { ok: res.exitCode === 0, exitCode: res.exitCode, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: null };
    } else {
      // Older Android versions without shell v2: no exit code, so success is assumed unless the call throws.
      const text = await withTimeout(adb.subprocess.noneProtocol.spawnWaitText(command), timeoutMs, command);
      r = { ok: true, exitCode: null, stdout: text ?? "", stderr: "", error: null };
    }
    if (!quiet) {
      if (r.stdout.trim()) out(r.stdout.replace(/\s+$/, ""));
      if (r.stderr.trim()) out(r.stderr.replace(/\s+$/, ""), "err");
      if (r.exitCode !== null && r.exitCode !== 0) out(`[exit ${r.exitCode}]`, "warn");
    }
    return r;
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (!quiet) {
      out(`خطأ أثناء التنفيذ: ${msg}`, "err");
      hints(msg);
    }
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: msg };
  }
}

function makeCtx(pkg) {
  return {
    pkg,
    run: (command, o = {}) => runShell(command, { quiet: o.quiet ?? true }),
    log: (msg) => out(msg),
  };
}

// Only one heavy operation at a time, so commands never interleave on the device.
async function exclusive(fn) {
  if (busy) {
    out("انتظر انتهاء العملية الحالية.", "warn");
    return;
  }
  busy = true;
  setButtonsDisabled(true);
  try {
    await fn();
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(on) {
  for (const el of document.querySelectorAll(".action")) el.disabled = on;
}

function requireConnection() {
  if (adb) return true;
  out("اتصل بالشاشة أولاً.", "warn");
  return false;
}

function currentPackage() {
  const pkg = $("pkgInput").value.trim();
  if (!isValidPackageName(pkg)) {
    out("اسم الحزمة غير صالح. مثال: com.xmiqarri.cardisplayz", "err");
    return null;
  }
  return pkg;
}

// ---------- Installing an APK picked from this computer (no adb.exe needed) ----------

// SHA-256 needs a secure context (https or a local file). Returns null when the browser cannot compute it.
async function sha256Hex(blob) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Copies the file to the head unit through the ADB sync service. onProgress receives the bytes sent so far.
async function pushFile(file, onProgress) {
  const sync = await adb.sync();
  try {
    let sent = 0;
    const source = file.stream().pipeThrough(new TransformStream({
      transform(chunk, controller) {
        sent += chunk.byteLength;
        onProgress(sent);
        controller.enqueue(chunk);
      },
    }));
    await sync.write({ filename: APK_TEMP_PATH, file: source, permission: 0o644 });
  } finally {
    await sync.dispose();
  }
}

async function installApk(file) {
  if (!requireConnection()) return;
  const pkg = currentPackage();
  if (!pkg) return;

  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const check = checkApkFile({ name: file.name, size: file.size, head });
  if (!check.ok) {
    out(`لن يُنقل الملف إلى الشاشة: ${check.reason}`, "err");
    return;
  }
  out(`الملف: ${file.name} (${(file.size / 1048576).toFixed(1)} ميغابايت)`);

  const sha256 = await sha256Hex(file);
  if (isOfficialApk({ size: file.size, sha256 })) {
    out(`الملف مطابق للإصدار ${APP_VERSION} المنشور في GitHub ✅`, "ok");
  } else {
    const question = sha256 === null
      ? "تعذّر حساب بصمة الملف (SHA-256) لأن الصفحة ليست في سياق آمن.\nتأكد أنك نزّلت الملف من رابط GitHub في هذه الصفحة.\n\nمتابعة؟"
      : `هذا الملف ليس نسخة الإصدار ${APP_VERSION} المنشورة في GitHub.\nقد يفشل التثبيت، أو يكون الملف غير موثوق.\n\nمتابعة بهذا الملف؟`;
    if (!confirm(question)) {
      out("ألغيت العملية. لم يُنقل أي شيء إلى الشاشة.", "warn");
      return;
    }
    if (sha256) out(`SHA-256 للملف: ${sha256}`, "warn");
  }

  const sdk = parseSdk((await runShell(cmd.sdk(), { quiet: true })).stdout);
  if (sdk !== null && sdk < MIN_SDK) {
    out(`إصدار أندرويد في الشاشة (SDK ${sdk}) أقل من المطلوب (SDK ${MIN_SDK}). لن يُنقل الملف.`, "err");
    return;
  }

  const progress = out("نقل الملف إلى الشاشة: 0%", "hint");
  let shownPct = -1;
  try {
    await withTimeout(
      pushFile(file, (sent) => {
        const pct = Math.floor((sent / file.size) * 100);
        if (pct === shownPct) return;
        shownPct = pct;
        progress.textContent = `نقل الملف إلى الشاشة: ${pct}%`;
      }),
      INSTALL_TIMEOUT_MS,
      "نقل الملف إلى الشاشة",
    );
    progress.className = "line ok";
    progress.textContent = "تم نقل الملف إلى الشاشة ✅";

    const r = await runShell(cmd.pmInstall(APK_TEMP_PATH), { timeoutMs: INSTALL_TIMEOUT_MS });
    const result = parsePmResult(`${r.stdout}\n${r.stderr}`);
    if (!result.ok || r.error) {
      out(`لم يكتمل التثبيت${result.code ? `: ${result.code}` : ""}.`, "err");
      hints(`${r.stdout}\n${r.stderr}\n${r.error ?? ""}`);
      return;
    }

    // "Success" alone is not trusted: the installed version is read back from the head unit.
    const info = parseVersion((await runShell(cmd.dumpsysPackage(pkg), { quiet: true })).stdout);
    if (!info) {
      out(`انتهى الأمر لكن التطبيق ${pkg} لا يظهر على الشاشة. تأكد من اسم الحزمة.`, "err");
      return;
    }
    const status = versionStatus(info);
    if (status.state === "ok") out(`تم التثبيت ✅ الإصدار ${status.value}`, "ok");
    else out(`تم التثبيت. ${status.detail}`, "warn");
    out("الخطوة التالية: اضغط 'إصلاح تلقائي لكل المشاكل' في القسم 2، ثم افتح التطبيق على الشاشة.", "hint");
    lastResults = await runDoctor(makeCtx(pkg));
    renderChecks(lastResults);
    summarize(lastResults);
  } catch (e) {
    const text = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    out(`فشل نقل الملف أو تثبيته: ${text}`, "err");
    hints(text);
    // A transfer that hangs leaves the session in an unknown state, so the connection is dropped.
    if (String(e?.message ?? "").startsWith("انتهت المهلة الزمنية")) await disconnect();
  } finally {
    // The copy in /data/local/tmp is only needed for the install, so it is removed in every case.
    await runShell(cmd.rmFile(APK_TEMP_PATH), { quiet: true });
  }
}

// ---------- Permission doctor ----------

const STATE_LABEL = { ok: "سليم ✅", fail: "مشكلة ❌", na: "لا ينطبق", info: "معلومة ℹ️", error: "خطأ ⚠️" };

function renderChecks(results) {
  const box = $("checks");
  box.replaceChildren();
  for (const r of results) {
    const card = document.createElement("article");
    card.className = `card st-${r.state}`;

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("strong");
    title.textContent = r.title;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = STATE_LABEL[r.state] ?? r.state;
    head.append(title, badge);

    const value = document.createElement("div");
    value.className = "card-value";
    value.textContent = r.value ?? "";

    const detail = document.createElement("p");
    detail.className = "card-detail";
    detail.textContent = r.detail ?? "";

    card.append(head, value, detail);
    if (r.state === "fail" && r.fixable) {
      const btn = document.createElement("button");
      btn.className = "btn btn-small action";
      btn.textContent = "إصلاح";
      btn.disabled = busy;   // cards can be re-rendered during an operation
      btn.addEventListener("click", () => exclusive(() => fixOne(r.id)));
      card.append(btn);
    }
    box.append(card);
  }
}

function summarize(results) {
  const count = (state) => results.filter((r) => r.state === state).length;
  $("summary").textContent = `سليم: ${count("ok")}  |  مشاكل: ${count("fail")}  |  لا ينطبق: ${count("na")}`;
}

async function doctor() {
  if (!requireConnection()) return;
  const pkg = currentPackage();
  if (!pkg) return;
  out(`تشخيص الصلاحيات للتطبيق ${pkg}...`, "hint");
  lastResults = await runDoctor(makeCtx(pkg));
  renderChecks(lastResults);
  summarize(lastResults);
  out("انتهى التشخيص.", "ok");
}

async function fixOne(id) {
  if (!requireConnection()) return;
  const pkg = currentPackage();
  if (!pkg) return;
  const title = CHECKS.find((c) => c.id === id)?.title ?? id;
  if (!confirm(`سيتم تعديل: ${title}\nللتطبيق: ${pkg}\n\nمتابعة؟`)) return;
  out(`إصلاح: ${title}`, "hint");
  const res = await applyFix(makeCtx(pkg), id);
  recordFix(pkg, res);
  if (res.fixed) out(`تم الإصلاح ✅: ${title}`, "ok");
  else {
    out(`لم ينجح الإصلاح: ${title}. ${res.after.detail}`, "err");
    hints(res.outcomes.map((o) => o.output).join("\n"));
  }
  lastResults = await runDoctor(makeCtx(pkg));
  renderChecks(lastResults);
  summarize(lastResults);
}

async function autoFixAll() {
  if (!requireConnection()) return;
  const pkg = currentPackage();
  if (!pkg) return;
  if (!confirm(`سيفحص الأداة التطبيق ${pkg} ويصلح كل البنود المعطلة القابلة للإصلاح.\nلن يُحذف أي تطبيق أو بيانات.\nإن لم يُفتح التطبيق منذ تثبيته أو أُوقف بالإجبار، سيُفتح مرة واحدة على الشاشة.\n\nمتابعة؟`)) return;
  out(`إصلاح تلقائي للتطبيق ${pkg}...`, "hint");
  const report = await autoFix(makeCtx(pkg));
  for (const a of report.actions) {
    recordFix(pkg, a);
    out(`${a.fixed ? "✔" : "✘"} ${a.title}`, a.fixed ? "ok" : "err");
  }
  if (report.actions.length === 0) out("لا توجد بنود معطلة قابلة للإصلاح التلقائي.", "ok");
  lastResults = report.after;
  renderChecks(lastResults);
  summarize(lastResults);
  out("انتهى الإصلاح التلقائي.", "ok");
}

// ---------- Learning log (kept in this browser only) ----------

function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]"); } catch { return []; }
}

function recordFix(pkg, a) {
  const list = readLog();
  list.push({
    t: new Date().toISOString(),
    pkg,
    model: deviceModel || "غير معروف",
    id: a.id,
    title: a.title,
    fixed: !!a.fixed,
    commands: (a.outcomes ?? []).map((o) => o.command),
  });
  try { localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-50))); } catch { /* storage blocked */ }
  renderLog();
}

function renderLog() {
  const ul = $("fixLog");
  ul.replaceChildren();
  const entries = readLog().slice(-15).reverse();
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.textContent = "لا توجد إصلاحات مسجّلة بعد.";
    ul.append(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    const when = String(e.t ?? "").slice(0, 16).replace("T", " ");
    li.textContent = `${when} | ${e.model} | ${e.title} | ${e.fixed ? "نجح" : "لم ينجح"}`;
    ul.append(li);
  }
}

// ---------- Error decoder ----------

function decode() {
  const text = $("errInput").value;
  const box = $("decoderOut");
  box.replaceChildren();
  if (!text.trim()) return;
  const hits = diagnoseText(text);
  if (hits.length === 0) {
    box.textContent = "لم أجد مطابقة معروفة. أرسل نص الخطأ كاملاً مع السطر الذي قبله.";
    return;
  }
  for (const h of hits) {
    const card = document.createElement("article");
    card.className = "card st-info";
    const title = document.createElement("strong");
    title.textContent = h.title;
    const ol = document.createElement("ol");
    ol.className = "steps";
    for (const step of h.steps) {
      const li = document.createElement("li");
      li.textContent = step;
      ol.append(li);
    }
    card.append(title, ol);
    box.append(card);
  }
}

// ---------- Tools ----------

// The optional Windows script. It needs adb.exe on the computer, which the page itself does not.
function downloadBat() {
  const text = buildInstallBat({
    pkg: DEFAULT_PACKAGE,
    version: APP_VERSION,
    apkName: EXPECTED_APK_NAME,
    apkUrl: RELEASE_APK_URL,
  });
  const blob = new Blob([text], { type: "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Install_Car_DisplayZ_${APP_VERSION}.bat`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  out("تم تنزيل سكربت BAT. يحتاج adb.exe على الكمبيوتر، ولا حاجة له إذا ثبّتّ التطبيق من هذه الصفحة.", "ok");
}

// ---------- User-installed apps (pm list packages -3): list them, then remove the checked ones ----------

let userApps = [];

function renderUserApps() {
  const list = $("userApps");
  list.replaceChildren();
  if (userApps.length === 0) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "لا توجد تطبيقات مثبتة من المستخدم.";
    list.append(note);
    return;
  }
  for (const pkg of userApps) {
    const row = document.createElement("label");
    row.className = "app-row";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = pkg;
    const name = document.createElement("span");
    name.textContent = pkg;
    row.append(check, name);
    list.append(row);
  }
}

// Reads the list and shows it as checkboxes. Nothing is removed here.
async function loadUserApps() {
  if (!requireConnection()) return;
  const listed = await runShell(cmd.listUserPackages(), { quiet: true });
  if (!listed.ok) {
    out("تعذّر قراءة قائمة التطبيقات.", "err");
    return;
  }
  userApps = parsePackageList(listed.stdout);
  renderUserApps();
  out(`التطبيقات المثبتة من المستخدم: ${userApps.length}`, "ok");
}

// Removes the checked apps with pm uninstall, which also deletes their data. Each removal is checked afterwards.
async function uninstallSelected() {
  if (!requireConnection()) return;
  const picked = [...$("userApps").querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
  if (picked.length === 0) {
    out("حدّد تطبيقاً واحداً على الأقل من القائمة.", "warn");
    return;
  }
  const own = picked.includes(DEFAULT_PACKAGE)
    ? "\nمن بينها Car_DisplayZ نفسه: ستحتاج إلى تثبيته من ملف APK بعد ذلك.\n"
    : "";
  const names = picked.map((p) => `- ${p}`).join("\n");
  const question = `سيتم إلغاء تثبيت ${picked.length} تطبيق من الشاشة، مع بياناتها وإعداداتها:\n${names}\n${own}\nملف APK على الكمبيوتر لن يتأثر.\n\nمتابعة؟`;
  if (!confirm(question)) {
    out("ألغيت العملية. لم يُحذف شيء.", "warn");
    return;
  }
  for (const pkg of picked) {
    const r = await runShell(cmd.pmUninstall(pkg), { timeoutMs: INSTALL_TIMEOUT_MS });
    const result = parsePmResult(`${r.stdout}\n${r.stderr}`);
    const stillThere = parsePmPath((await runShell(cmd.pmPath(pkg), { quiet: true })).stdout);
    if (result.ok && !r.error && !stillThere) {
      out(`تم حذف ${pkg} ✅`, "ok");
    } else {
      out(`لم يُحذف ${pkg}${result.code ? `: ${result.code}` : ""}.`, "err");
      hints(`${r.stdout}\n${r.stderr}\n${r.error ?? ""}`);
    }
  }
  await loadUserApps();
}

async function grantOverlayToAll() {
  if (!requireConnection()) return;
  if (!confirm("تحذير أمني: سيسمح هذا لكل تطبيق ثبّتَه بالظهور فوق الشاشة. يمكن استغلال هذا في خداع المستخدم بصرياً.\nلن تتأثر تطبيقات النظام.\n\nمتابعة؟")) return;
  const listed = await runShell(cmd.listUserPackages(), { quiet: true });
  if (!listed.ok) {
    out("تعذّر قراءة قائمة التطبيقات.", "err");
    return;
  }
  const packages = parsePackageList(listed.stdout);
  for (const p of packages) {
    const r = await runShell(cmd.appopsSet(p, "SYSTEM_ALERT_WINDOW", "allow"), { quiet: true });
    out(`${p}: ${r.ok ? "تم" : "فشل"}`, r.ok ? "" : "err");
  }
  out(`انتهى: ${packages.length} تطبيق.`, "ok");
}

async function grantAllFiles() {
  if (!requireConnection()) return;
  const pkg = currentPackage();
  if (!pkg) return;
  if (!confirm(`سيمنح ${pkg} الوصول إلى كل ملفات الشاشة (MANAGE_EXTERNAL_STORAGE).\nهذه صلاحية واسعة: امنحها للتطبيقات الموثوقة فقط.\nتطبيق Car_DisplayZ لا يحتاجها.\n\nمتابعة؟`)) return;
  const r = await runShell(cmd.appopsSet(pkg, "MANAGE_EXTERNAL_STORAGE", "allow"));
  out(r.ok ? "تم منح الصلاحية." : "لم تنجح الصلاحية. راجع الرسالة أعلاه.", r.ok ? "ok" : "err");
}

async function sendManual() {
  const input = $("cmdInput");
  const command = input.value.trim();
  if (!command) return;
  if (busy) {
    out("انتظر انتهاء العملية الحالية.", "warn");   // keep the typed command for the next try
    return;
  }
  input.value = "";
  await exclusive(() => runShell(command));
}

// ---------- Startup ----------

function renderEnvironment() {
  const notes = environmentNotes({
    hasWebUsb: "usb" in navigator,
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
  });
  const box = $("envNotes");
  box.replaceChildren();
  if (notes.length === 0) {
    box.textContent = "المتصفح مناسب ✅";
    return;
  }
  for (const n of notes) {
    const p = document.createElement("p");
    p.className = `note ${n.level}`;
    p.textContent = n.text;
    box.append(p);
  }
}

// The file picker is opened by the install button. The input is reset as soon as a file is chosen,
// so picking the same file again still fires "change".
$("btnInstall").addEventListener("click", () => {
  if (!requireConnection()) return;
  if (!currentPackage()) return;
  $("apkFile").click();
});
$("apkFile").addEventListener("change", () => {
  const input = $("apkFile");
  const file = input.files?.[0];
  input.value = "";
  if (file) exclusive(() => installApk(file));
});
$("btnConnect").addEventListener("click", () => exclusive(connect));
$("btnDisconnect").addEventListener("click", () => exclusive(disconnect));
$("btnDoctor").addEventListener("click", () => exclusive(doctor));
$("btnAutoFix").addEventListener("click", () => exclusive(autoFixAll));
$("btnBat").addEventListener("click", downloadBat);
$("btnDecode").addEventListener("click", decode);
$("btnListApps").addEventListener("click", () => exclusive(loadUserApps));
$("btnUninstall").addEventListener("click", () => exclusive(uninstallSelected));
$("btnGrantAllOverlay").addEventListener("click", () => exclusive(grantOverlayToAll));
$("btnStorage").addEventListener("click", () => exclusive(grantAllFiles));
$("btnSendCmd").addEventListener("click", sendManual);
$("cmdInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendManual(); });

setConnected(false);
renderEnvironment();
renderLog();
out("Car_DisplayZ WebInstaller 3.1 (c) 2026 Abu Tala. All rights reserved.");
out(`الإصدار ${APP_VERSION} من Car_DisplayZ. اضغط 'توصيل الشاشة'، ثم 'تثبيت ملف APK' أو 'تشخيص الصلاحيات'.`);
libReady.then((L) => {
  if (!L) out(`تنبيه: تعذّر تحميل مكتبة ADB (${libError?.message ?? "خطأ"}). الصفحة تعمل بدون اتصال، ومفكّك الأخطاء متاح.`, "warn");
});
