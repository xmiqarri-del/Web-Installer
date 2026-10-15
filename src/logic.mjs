// Car_DisplayZ WebInstaller Pro v3 - pure logic (no DOM, no network).
// Everything here is testable in Node. The build step strips the `export` keywords
// and inlines this file into the single HTML page.

export const DEFAULT_PACKAGE = "com.xmiqarri.cardisplayz";
export const MIN_SDK = 30;      // Android 11 (minSdk in app/build.gradle.kts)
export const NOTIFY_SDK = 33;   // POST_NOTIFICATIONS is a runtime permission from Android 13

// RELEASE:BEGIN — rewritten by scripts/sync-release.mjs when a new Car_DisplayZ release is published.
// The values come from that release's update.json; the APK itself is checked against them.
export const APP_VERSION = "1.1.11";
export const EXPECTED_VERSION_CODE = 13;
export const EXPECTED_APK_BYTES = 7102277;
export const EXPECTED_APK_SHA256 = "c9823d327d10191e803c5627429a276bbeb81b225e00e822c6517e64d14238e4";
// RELEASE:END
export const EXPECTED_APK_NAME = `Car_DisplayZ-v${APP_VERSION}.apk`;
export const RELEASE_APK_URL = `https://github.com/xmiqarri-del/Car_DisplayZ/releases/download/v${APP_VERSION}/${EXPECTED_APK_NAME}`;
export const MAX_APK_BYTES = 200 * 1024 * 1024;  // same limit as the app's own updater
// Fixed scratch path on the head unit for the APK being installed (never built from user input).
export const APK_TEMP_PATH = "/data/local/tmp/webinstaller_install.apk";

// ---------- Validation and command builders ----------

export function isValidPackageName(name) {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(name);
}

// "package/.Activity" or "package/package.Activity". Used for the home-launcher command.
export function isValidComponent(name) {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+\/[A-Za-z0-9_.$]+$/.test(name);
}

export function navServiceComponent(pkg) {
  return `${pkg}/${pkg}.nav.NavBarService`;
}

export const cmd = {
  sdk: () => "getprop ro.build.version.sdk",
  model: () => "getprop ro.product.model",
  pmPath: (pkg) => `pm path ${pkg}`,
  appopsGet: (pkg, op) => `appops get ${pkg} ${op}`,
  appopsSet: (pkg, op, mode = "allow") => `appops set ${pkg} ${op} ${mode}`,
  settingsGet: (key) => `settings get secure ${key}`,
  settingsPut: (key, value) => `settings put secure ${key} "${value}"`,
  pmGrant: (pkg, permission) => `pm grant ${pkg} ${permission}`,
  dumpsysPackage: (pkg) => `dumpsys package ${pkg}`,
  whitelistList: () => "dumpsys deviceidle whitelist",
  whitelistAdd: (pkg) => `dumpsys deviceidle whitelist +${pkg}`,
  listUserPackages: () => "pm list packages -3",
  pmInstall: (path) => `pm install -r ${path}`,
  rmFile: (path) => `rm -f ${path}`,
  pmUninstall: (pkg) => `pm uninstall ${pkg}`,
  // Opens the app once, the same way a launcher icon does. That clears the stopped state.
  launchOnce: (pkg) => `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
  // Makes the given launcher activity the default home screen (Android 10 and newer, shell access).
  setHome: (component) => `cmd package set-home-activity ${component}`,
};

// Permissions granted to each selected user app, in order. Taken from the install script:
// special ones through appops, runtime ones through pm grant. A permission the app never requested is
// simply refused by Android, so each step reports its own result instead of failing the whole app.
export const SELECTED_APPOPS = [
  "SYSTEM_ALERT_WINDOW",
  "PROJECT_MEDIA",
  "REQUEST_INSTALL_PACKAGES",
  "USE_FULL_SCREEN_INTENT",
];
export const SELECTED_RUNTIME_PERMISSIONS = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.HIGH_SAMPLING_RATE_SENSORS",
  "android.car.permission.CAR_SPEED",
  "android.car.permission.CAR_ENERGY",
  "android.car.permission.CAR_ENGINE_DETAILED",
  "android.car.permission.CAR_POWERTRAIN",
  "android.car.permission.CAR_TIRES",
  "android.car.permission.CAR_INFO",
  "android.car.permission.CAR_EXTERIOR_ENVIRONMENT",
  "android.car.permission.CAR_MILEAGE",
  "android.car.permission.CAR_VENDOR_EXTENSION",
  "android.car.permission.CAR_DYNAMICS_STATE",
  "android.car.permission.CONTROL_CAR_CLIMATE",
  "android.car.permission.READ_CAR_DISPLAY_UNITS",
  "android.car.permission.CAR_DRIVING_STATE",
];

// Every command granted to one app, in order: battery-optimisation exemption, appops, then runtime permissions.
export function grantPlanCommands(pkg) {
  return [
    cmd.whitelistAdd(pkg),
    ...SELECTED_APPOPS.map((op) => cmd.appopsSet(pkg, op, "allow")),
    ...SELECTED_RUNTIME_PERMISSIONS.map((perm) => cmd.pmGrant(pkg, perm)),
  ];
}

// ---------- Parsers ----------

// "SYSTEM_ALERT_WINDOW: allow; time=+1d" -> "allow". Unknown output -> "unknown".
export function parseAppOp(output) {
  const m = /(?:^|:\s*)(allow|ignore|deny|default|foreground|errored)\b/im.exec(String(output ?? ""));
  return m ? m[1].toLowerCase() : "unknown";
}

// `settings get` prints "null" when the key is unset.
export function parseSettingValue(output) {
  const v = String(output ?? "").replace(/\r/g, "").trim();
  return v === "" ? "null" : v;
}

export function parseSdk(output) {
  const n = parseInt(String(output ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// "android.permission.POST_NOTIFICATIONS: granted=true" -> true. Not found -> null.
export function parseGranted(dumpsysOutput, permission) {
  const escaped = permission.replace(/\./g, "\\.");
  const m = new RegExp(`${escaped}:\\s*granted=(true|false)`).exec(String(dumpsysOutput ?? ""));
  return m ? m[1] === "true" : null;
}

// Whitelist lines look like "user,com.example,10123" or "com.example,10123".
export function isWhitelisted(deviceIdleOutput, pkg) {
  return String(deviceIdleOutput ?? "").split(/[\s,]+/).includes(pkg);
}

// `pm path com.x` prints "package:/data/app/..." when installed.
export function parsePmPath(output) {
  const m = /package:(\S+)/.exec(String(output ?? ""));
  return m ? m[1] : null;
}

// `dumpsys package` prints "stopped=... notLaunched=..." for each user. Android does not deliver BOOT_COMPLETED
// to an app that was force-stopped or never opened since it was installed, until the user opens it once.
export function parseRunState(dumpsysOutput) {
  const line = String(dumpsysOutput ?? "").split(/\r?\n/).find((l) => /\bstopped=(true|false)\b/.test(l));
  if (!line) return { stopped: null, notLaunched: null };
  const flag = (name) => {
    const m = new RegExp(`\\b${name}=(true|false)\\b`).exec(line);
    return m ? m[1] === "true" : null;
  };
  return { stopped: flag("stopped"), notLaunched: flag("notLaunched") };
}

// ---------- Installing a picked APK (copy to the head unit, then pm install) ----------

// Checks the picked file before anything is sent to the head unit. `head` holds its first bytes.
export function checkApkFile({ name = "", size = 0, head = new Uint8Array(0) }) {
  if (!/\.apk$/i.test(String(name))) return { ok: false, reason: "الملف ليس بامتداد .apk." };
  if (!(size > 0)) return { ok: false, reason: "الملف فارغ." };
  if (size > MAX_APK_BYTES) return { ok: false, reason: `الملف أكبر من ${MAX_APK_BYTES / 1048576} ميغابايت.` };
  const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (!isZip) return { ok: false, reason: "الملف لا يبدأ بترويسة ZIP، فليس APK صالحاً." };
  return { ok: true, reason: "" };
}

// True only for the official release file: size and SHA-256 both match. sha256 is null when it could not be computed.
export function isOfficialApk({ size, sha256 }) {
  return size === EXPECTED_APK_BYTES && sha256 === EXPECTED_APK_SHA256;
}

// `pm list packages -3` prints "package:com.x" per line. Only valid names are kept, each once, sorted.
export function parsePackageList(output) {
  const names = String(output ?? "").split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(isValidPackageName);
  return [...new Set(names)].sort();
}

// Packages that appear after an install. Used to learn the package name of an APK the user picked.
export function newlyInstalled(before, after) {
  const known = new Set(before);
  return after.filter((p) => !known.has(p));
}

// `pm install` and `pm uninstall` both print "Success", or "Failure [CODE: reason]".
export function parsePmResult(output) {
  const text = String(output ?? "");
  if (/^\s*Success\s*$/m.test(text)) return { ok: true, code: null };
  const m = /Failure\s*\[\s*([A-Z_]+)/.exec(text);
  return { ok: false, code: m ? m[1] : null };
}

// From `dumpsys package`: "    versionCode=10 minSdk=30 ..." and "    versionName=1.1.8".
export function parseVersion(dumpsysOutput) {
  const text = String(dumpsysOutput ?? "");
  const name = /^\s*versionName=(\S+)/m.exec(text);
  const code = /^\s*versionCode=(\d+)/m.exec(text);
  if (!name && !code) return null;
  return {
    versionName: name ? name[1] : null,
    versionCode: code ? Number(code[1]) : null,
  };
}

// Compares the installed version with the release this page installs.
export function versionStatus(info) {
  if (!info || info.versionName === null) {
    return { state: "info", value: "غير معروف", detail: "تعذّر قراءة رقم الإصدار من معلومات التطبيق." };
  }
  if (info.versionCode === null) {
    const value = info.versionName;
    return value === APP_VERSION
      ? { state: "ok", value, detail: `الإصدار ${APP_VERSION} هو الذي تنصّبه هذه الصفحة.` }
      : { state: "info", value, detail: `هذه الصفحة تنصّب الإصدار ${APP_VERSION}.` };
  }
  const value = `${info.versionName} (${info.versionCode})`;
  if (info.versionCode === EXPECTED_VERSION_CODE) {
    return { state: "ok", value, detail: `مطابق للإصدار ${APP_VERSION} الذي تنصّبه هذه الصفحة.` };
  }
  if (info.versionCode < EXPECTED_VERSION_CODE) {
    return { state: "fail", value, detail: `أقدم من الإصدار ${APP_VERSION}. ثبّت الملف من القسم 1 في القائمة الجانبية.` };
  }
  return { state: "info", value, detail: `أحدث من الإصدار ${APP_VERSION} الذي تعرفه هذه الصفحة.` };
}

// ---------- Accessibility list handling (never overwrites other services) ----------

export function accessibilityServices(settingValue) {
  const v = parseSettingValue(settingValue);
  return v === "null" ? [] : v.split(":").map((s) => s.trim()).filter(Boolean);
}

export function hasNavService(settingValue, pkg) {
  return accessibilityServices(settingValue).some((c) => c.startsWith(`${pkg}/`) && /NavBarService/.test(c));
}

export function mergeAccessibilityServices(settingValue, pkg) {
  const list = accessibilityServices(settingValue);
  if (list.some((c) => c.startsWith(`${pkg}/`) && /NavBarService/.test(c))) return list.join(":");
  return [...list, navServiceComponent(pkg)].join(":");
}

// ---------- Permission checks ----------
// ctx = { pkg, run(command, opts) -> {ok, exitCode, stdout, stderr, error}, log(line) }

const quietRun = (ctx, command) => ctx.run(command, { quiet: true });

export const CHECKS = [
  {
    id: "sdk",
    title: "إصدار أندرويد",
    async check(ctx) {
      const sdk = parseSdk((await quietRun(ctx, cmd.sdk())).stdout);
      const model = (await quietRun(ctx, cmd.model())).stdout.trim() || "غير معروف";
      if (sdk === null) return { state: "info", value: "غير معروف", detail: `الموديل: ${model}. تعذّر قراءة الإصدار.` };
      if (sdk < MIN_SDK) {
        return {
          state: "fail",
          value: `SDK ${sdk}`,
          detail: `الموديل: ${model}. التطبيق يحتاج Android 11 (SDK ${MIN_SDK}) أو أحدث، ولن يُثبَّت على هذه الشاشة.`,
        };
      }
      return { state: "ok", value: `SDK ${sdk}`, detail: `الموديل: ${model}. مناسب للتطبيق (الحد الأدنى SDK ${MIN_SDK}).` };
    },
  },
  {
    id: "installed",
    title: "التطبيق مثبّت",
    async check(ctx) {
      const path = parsePmPath((await quietRun(ctx, cmd.pmPath(ctx.pkg))).stdout);
      if (path) return { state: "ok", value: "مثبّت", detail: `المسار: ${path}` };
      return {
        state: "fail",
        value: "غير مثبّت",
        detail: "التطبيق غير مثبّت، ولا يمكن إصلاح صلاحياته قبل تثبيته. ثبّته من القسم 1 في القائمة الجانبية.",
      };
    },
  },
  {
    id: "version",
    title: "إصدار التطبيق",
    needsApp: true,
    async check(ctx) {
      return versionStatus(parseVersion((await quietRun(ctx, cmd.dumpsysPackage(ctx.pkg))).stdout));
    },
  },
  {
    id: "overlay",
    title: "الزر العائم (الظهور فوق التطبيقات)",
    needsApp: true,
    async check(ctx) {
      const mode = parseAppOp((await quietRun(ctx, cmd.appopsGet(ctx.pkg, "SYSTEM_ALERT_WINDOW"))).stdout);
      if (mode === "allow") {
        return { state: "ok", value: mode, detail: "مسموح. الزر العائم يستطيع الظهور فوق التطبيقات." };
      }
      return {
        state: "fail",
        value: mode,
        detail: "غير مسموح، فلن يظهر الزر العائم. تأكد أيضاً من تفعيله داخل التطبيق.",
      };
    },
    async fix(ctx) {
      return [cmd.appopsSet(ctx.pkg, "SYSTEM_ALERT_WINDOW", "allow")];
    },
  },
  {
    id: "accessibility",
    title: "شريط الأزرار السفلي (خدمة إمكانية الوصول)",
    needsApp: true,
    async check(ctx) {
      const services = (await quietRun(ctx, cmd.settingsGet("enabled_accessibility_services"))).stdout;
      const enabled = parseSettingValue((await quietRun(ctx, cmd.settingsGet("accessibility_enabled"))).stdout);
      const inList = hasNavService(services, ctx.pkg);
      if (inList && enabled === "1") {
        return { state: "ok", value: "مفعّلة", detail: "الخدمة مفعّلة وإمكانية الوصول مفعّلة. تأكد من تفعيل الأزرار السفلية داخل التطبيق." };
      }
      if (inList) {
        return { state: "fail", value: "معطّلة عامةً", detail: "الخدمة مضافة لكن إمكانية الوصول معطّلة في النظام." };
      }
      return {
        state: "fail",
        value: "غير مفعّلة",
        detail: "الخدمة غير مفعّلة، فلن يظهر الشريط السفلي. الإصلاح يضيفها دون حذف الخدمات الأخرى.",
      };
    },
    async fix(ctx) {
      const current = (await quietRun(ctx, cmd.settingsGet("enabled_accessibility_services"))).stdout;
      return [
        cmd.settingsPut("enabled_accessibility_services", mergeAccessibilityServices(current, ctx.pkg)),
        cmd.settingsPut("accessibility_enabled", "1"),
      ];
    },
  },
  {
    id: "install_unknown",
    title: "التثبيت من مصادر غير معروفة",
    needsApp: true,
    async check(ctx) {
      const mode = parseAppOp((await quietRun(ctx, cmd.appopsGet(ctx.pkg, "REQUEST_INSTALL_PACKAGES"))).stdout);
      if (mode === "allow") {
        return { state: "ok", value: mode, detail: "مسموح للتطبيق بطلب تثبيت الملفات، وهذا ضروري لتثبيت التحديث من داخله." };
      }
      return { state: "fail", value: mode, detail: "غير مسموح، فلن يستطيع التطبيق فتح مثبّت التحديث." };
    },
    async fix(ctx) {
      return [cmd.appopsSet(ctx.pkg, "REQUEST_INSTALL_PACKAGES", "allow")];
    },
  },
  {
    id: "notifications",
    title: "الإشعارات",
    needsApp: true,
    async check(ctx) {
      const sdk = parseSdk((await quietRun(ctx, cmd.sdk())).stdout);
      if (sdk !== null && sdk < NOTIFY_SDK) {
        return { state: "na", value: "لا ينطبق", detail: "هذا الإصدار لا يحتاج إذن إشعارات منفصل (يبدأ من Android 13)." };
      }
      const granted = parseGranted((await quietRun(ctx, cmd.dumpsysPackage(ctx.pkg))).stdout, "android.permission.POST_NOTIFICATIONS");
      if (granted === true) return { state: "ok", value: "مسموحة", detail: "إشعار 'التحديث جاهز' سيظهر." };
      if (granted === false) return { state: "fail", value: "غير مسموحة", detail: "لن يظهر إشعار 'التحديث جاهز'." };
      return { state: "info", value: "غير معروف", detail: "الصلاحية غير مذكورة في معلومات التطبيق." };
    },
    async fix(ctx) {
      return [cmd.pmGrant(ctx.pkg, "android.permission.POST_NOTIFICATIONS")];
    },
  },
  {
    id: "background",
    title: "التشغيل في الخلفية",
    needsApp: true,
    async check(ctx) {
      const mode = parseAppOp((await quietRun(ctx, cmd.appopsGet(ctx.pkg, "RUN_ANY_IN_BACKGROUND"))).stdout);
      if (mode === "allow" || mode === "default") {
        return { state: "ok", value: mode, detail: "مسموح بالعمل في الخلفية." };
      }
      return { state: "fail", value: mode, detail: "مقيّد. قد يتوقف فحص التحديثات كل 6 ساعات ويُقتل الزر العائم." };
    },
    async fix(ctx) {
      return [cmd.appopsSet(ctx.pkg, "RUN_ANY_IN_BACKGROUND", "allow")];
    },
  },
  {
    id: "battery",
    title: "استثناء توفير البطارية",
    needsApp: true,
    async check(ctx) {
      const list = (await quietRun(ctx, cmd.whitelistList())).stdout;
      if (isWhitelisted(list, ctx.pkg)) {
        return { state: "ok", value: "مستثنى", detail: "التطبيق مستثنى من تحسين البطارية." };
      }
      return { state: "fail", value: "غير مستثنى", detail: "قد يوقف النظام التحديثات الخلفية. الإصلاح يضيفه إلى الاستثناءات." };
    },
    async fix(ctx) {
      return [cmd.whitelistAdd(ctx.pkg)];
    },
  },
  {
    id: "launch_state",
    title: "التشغيل بعد إعادة التشغيل",
    needsApp: true,
    async check(ctx) {
      const state = parseRunState((await quietRun(ctx, cmd.dumpsysPackage(ctx.pkg))).stdout);
      if (state.stopped === null) {
        return { state: "info", value: "غير معروف", detail: "تعذّر قراءة حالة التشغيل من النظام، فلا يمكن التحقق من البدء التلقائي." };
      }
      if (state.stopped === false && state.notLaunched !== true) {
        return { state: "ok", value: "جاهز", detail: "فُتح التطبيق من قبل، فيبدأ الزر العائم تلقائياً بعد إعادة التشغيل." };
      }
      return {
        state: "fail",
        value: state.notLaunched === true ? "لم يُفتح بعد" : "موقوف",
        detail: "أندرويد لا يشغّل التطبيق بعد إعادة التشغيل إن لم يُفتح منذ تثبيته، أو إن أُوقف بالإجبار. الإصلاح يفتحه مرة واحدة، ثم يبدأ الزر العائم تلقائياً.",
      };
    },
    async fix(ctx) {
      return [cmd.launchOnce(ctx.pkg), "sleep 2"];
    },
  },
];

// Runs every check. Checks that need the app are skipped when it is not installed.
export async function runDoctor(ctx) {
  const results = [];
  let installed = null;
  for (const check of CHECKS) {
    let res;
    try {
      if (check.needsApp && installed === false) {
        res = { state: "na", value: "—", detail: "يحتاج تثبيت التطبيق أولاً." };
      } else {
        res = await check.check(ctx);
      }
    } catch (e) {
      res = { state: "error", value: "خطأ", detail: e?.message ?? String(e) };
    }
    if (check.id === "installed") installed = res.state === "ok";
    results.push({ id: check.id, title: check.title, fixable: typeof check.fix === "function", ...res });
  }
  return results;
}

// Applies the fix for one check, then re-checks it. Nothing is reported as fixed without a re-check.
export async function applyFix(ctx, id) {
  const check = CHECKS.find((c) => c.id === id);
  if (!check || typeof check.fix !== "function") throw new Error("لا يوجد إصلاح تلقائي لهذا البند.");
  const commands = await check.fix(ctx);
  const outcomes = [];
  for (const command of commands) {
    const r = await ctx.run(command, { quiet: false });
    outcomes.push({ command, ok: r.ok, exitCode: r.exitCode, output: [r.stdout, r.stderr, r.error].filter(Boolean).join("\n").trim() });
  }
  const after = await check.check(ctx);
  return { id, title: check.title, outcomes, after, fixed: after.state === "ok" };
}

// Fixes every failing, fixable check, then runs the doctor again.
export async function autoFix(ctx) {
  const before = await runDoctor(ctx);
  const actions = [];
  for (const r of before) {
    if (r.state === "fail" && r.fixable) actions.push(await applyFix(ctx, r.id));
  }
  const after = await runDoctor(ctx);
  return { before, actions, after };
}

// ---------- Error knowledge base ----------
// Each rule maps a message pattern to a cause and concrete steps. Every rule that matches is returned,
// in table order. The generic INSTALL_* fallback is used only when no rule matches.

export const ERROR_RULES = [
  {
    id: "unauthorized",
    match: /unauthorized|not authorized|AdbAuth|authentication failed/i,
    title: "الشاشة لم تقبل تصريح تصحيح USB",
    steps: [
      "انظر إلى شاشة السيارة واضغط 'السماح'، وفعّل 'السماح دائماً' من هذا الكمبيوتر.",
      "إن لم يظهر الطلب: من خيارات المطور ألغِ 'إلغاء تصاريح تصحيح USB' ثم أعد توصيل الكابل.",
    ],
  },
  {
    id: "timeout",
    match: /انتهت المهلة الزمنية: موافقة الشاشة/,
    title: "لم تُقبل الموافقة على الشاشة في الوقت المحدد",
    steps: [
      "انظر إلى شاشة السيارة واضغط \"السماح\" (وفعّل السماح دائماً).",
      "أعد الضغط على زر توصيل الشاشة بعد ذلك.",
    ],
  },
  {
    id: "command_timeout",
    match: /انتهت المهلة الزمنية: (?!موافقة الشاشة)/,
    title: "انتهت مهلة الأمر على الشاشة",
    steps: [
      "إن كانت الشاشة تعرض نافذة تأكيد فاضغط 'تثبيت' أو 'السماح' عليها، ثم أعد المحاولة.",
      "إن تكرر ذلك فأعد توصيل الكابل والشاشة، ثم حاول مرة أخرى.",
    ],
  },
  {
    id: "offline",
    match: /device offline/i,
    title: "الجهاز غير متصل بشكل سليم (offline)",
    steps: ["افصل الكابل وأعد توصيله.", "أعد تشغيل تصحيح USB من خيارات المطور، ثم حاول مرة أخرى."],
  },
  {
    id: "no_device",
    match: /no devices\/emulators found|device '.*' not found|error: closed/i,
    title: "لا يوجد جهاز متصل بالكمبيوتر",
    steps: ["تحقق من كابل USB (جرّب كابلاً آخر أو منفذاً آخر).", "تأكد أن تصحيح USB مفعّل على الشاشة."],
  },
  {
    id: "adb_missing",
    match: /'adb' is not recognized|adb: command not found|adb.*not recognized/i,
    title: "أداة adb غير موجودة على الكمبيوتر",
    steps: ["ثبّت Android platform-tools.", "أو أضف مجلد platform-tools إلى PATH، أو استخدم المسار الكامل إلى adb.exe."],
  },
  {
    id: "claim_interface",
    match: /Unable to claim interface|claimInterface|already in use/i,
    title: "الجهاز محجوز من برنامج آخر، أو التعريف لا يسمح للمتصفح بالوصول",
    steps: [
      "أغلق Android Studio وأي نافذة adb، ثم نفّذ في الكمبيوتر: adb kill-server.",
      "على Windows: إن استمر الخطأ، ثبّت تعريف WinUSB لجهاز Android ADB عبر Zadig. وللرجوع استخدم Device Manager.",
    ],
  },
  {
    id: "webusb_denied",
    match: /NotAllowedError|SecurityError/i,
    title: "المتصفح منع الوصول إلى USB",
    steps: [
      "استخدم Google Chrome أو Microsoft Edge على سطح المكتب.",
      "افتح الصفحة كملف محلي أو من HTTPS، وليس داخل إطار (iframe).",
      "تحقق من أذونات USB للموقع في إعدادات المتصفح.",
    ],
  },
  {
    id: "no_device_selected",
    match: /NotFoundError|No device selected/i,
    title: "لم تُختر جهاز الشاشة من نافذة المتصفح",
    steps: ["اضغط زر التوصيل ثم اختر جهاز Android من القائمة."],
  },
  {
    id: "webusb_unsupported",
    match: /WebUSB|navigator\.usb|reading 'requestDevice'/i,
    title: "المتصفح لا يدعم WebUSB",
    steps: ["استخدم Google Chrome أو Microsoft Edge على الكمبيوتر."],
  },
  {
    id: "lib_load",
    match: /Failed to fetch dynamically imported module|Failed to load module script|Failed to fetch|ERR_INTERNET_DISCONNECTED|net::ERR/i,
    title: "تعذّر تحميل مكتبة ADB من الإنترنت",
    steps: ["تحقق من الاتصال بالإنترنت، ثم أعد تحميل الصفحة."],
  },
  {
    id: "install_update_incompatible",
    match: /INSTALL_FAILED_UPDATE_INCOMPATIBLE/,
    title: "التوقيع لا يطابق النسخة المثبتة",
    steps: [
      "النسخة المثبتة موقّعة بمفتاح مختلف، وغالباً تكون نسخة debug من الكمبيوتر.",
      "ثبّت APK المنشور في GitHub، لأنه موقّع بمفتاح الإصدار.",
      "إن كانت المثبتة نسخة debug فألغِ تثبيتها أولاً. تنبيه: هذا يحذف بيانات التطبيق وصلاحياته.",
    ],
  },
  {
    id: "install_version_downgrade",
    match: /INSTALL_FAILED_VERSION_DOWNGRADE/,
    title: "النسخة أقدم من المثبتة",
    steps: [
      "ثبّت نسخة أحدث (رقم versionCode أعلى).",
      "للنسخ debug فقط يمكن استخدام adb install -r -d لتجاوز ذلك.",
    ],
  },
  {
    id: "install_older_sdk",
    match: /INSTALL_FAILED_OLDER_SDK/,
    title: "إصدار أندرويد في الشاشة أقل من المطلوب",
    steps: ["التطبيق يحتاج Android 11 أو أحدث، ولا يمكن تثبيته على هذه الشاشة."],
  },
  {
    id: "sync_no_space",
    match: /No space left on device|ENOSPC/i,
    title: "لا توجد مساحة كافية على الشاشة لنقل الملف",
    steps: [
      "احذف ملفات أو تطبيقات غير مستخدمة من الشاشة، ثم أعد المحاولة.",
      "الملف يحتاج نحو 7 ميغابايت مؤقتاً، ويُحذف من الشاشة بعد التثبيت.",
    ],
  },
  {
    id: "install_storage",
    match: /INSTALL_FAILED_INSUFFICIENT_STORAGE/,
    title: "لا توجد مساحة كافية على الشاشة",
    steps: ["احذف تطبيقات غير مستخدمة أو ملفات كبيرة، ثم أعد المحاولة."],
  },
  {
    id: "install_user_restricted",
    match: /INSTALL_FAILED_USER_RESTRICTED|INSTALL_CANCELED_BY_USER|Install canceled by user/i,
    title: "التثبيت مرفوض من النظام أو ألغاه المستخدم",
    steps: [
      "إن ظهرت نافذة تأكيد على الشاشة فاضغط 'تثبيت'.",
      "فعّل 'التثبيت عبر USB' من خيارات المطور إن وُجد.",
      "إن كان التثبيت من داخل تطبيق: فعّل 'التثبيت من مصادر غير معروفة' لذلك التطبيق.",
    ],
  },
  {
    id: "install_parse",
    match: /INSTALL_PARSE_FAILED|INSTALL_FAILED_INVALID_APK|PARSE_FAILED_NO_CERTIFICATES|not a valid APK/i,
    title: "الملف ليس APK صالحاً أو أنه تالف",
    steps: [
      "أعد تحميل الملف من GitHub.",
      "قارن حجم الملف وSHA-256 مع update.json المنشور في الإصدار.",
    ],
  },
  {
    id: "permission_denial",
    match: /Permission Denial|SecurityException|Security exception/i,
    title: "أمر محظور بسبب صلاحية مفقودة",
    steps: [
      "اقرأ اسم الصلاحية في الرسالة.",
      "الصلاحيات العادية تُمنح بـ pm grant، والخاصة تُمنح بـ appops.",
      "شغّل زر 'إصلاح تلقائي' في التشخيص لأشهر الصلاحيات.",
    ],
  },
  {
    id: "unknown_permission",
    match: /Unknown permission|not a changeable permission type/i,
    title: "الصلاحية غير معرّفة أو لا تُغيَّر بهذا الأمر",
    steps: [
      "تحقق من كتابة اسم الصلاحية بالكامل.",
      "يجب أن يعلنها التطبيق في AndroidManifest.xml.",
      "صلاحيات التثبيت تُمنح تلقائياً ولا تحتاج pm grant.",
    ],
  },
  {
    id: "not_runtime_permission",
    match: /is not a runtime permission|Operation not allowed/i,
    title: "هذه ليست صلاحية وقت التشغيل",
    steps: [
      "استخدم appops بدلاً من pm grant. مثال: appops set <package> SYSTEM_ALERT_WINDOW allow.",
    ],
  },
  {
    id: "permission_not_requested",
    match: /not requested by package|has not requested|not requested/i,
    title: "التطبيق المثبّت لا يطلب هذه الصلاحية",
    steps: [
      "الصلاحية لا تُمنح إلا إذا أعلنها التطبيق في AndroidManifest.xml، فلا يمكن منحها من الكمبيوتر.",
      "ثبّت الملف من القسم 1 في القائمة الجانبية (الإصدار 1.1.8 يعلن صلاحية الإشعارات)، ثم أعد التشخيص.",
    ],
  },
  {
    id: "delete_failed",
    match: /DELETE_FAILED/,
    title: "تعذّر حذف التطبيق من الشاشة",
    steps: [
      "إن كان التطبيق مسؤول جهاز (Device Admin) فألغِ ذلك من إعدادات الأمان أولاً، ثم أعد المحاولة.",
      "تأكد أن التطبيق ما زال مثبتاً، ثم حدّث القائمة.",
    ],
  },
  {
    id: "unknown_package",
    match: /Unknown package|Package .* not found|Error: Unknown package/i,
    title: "التطبيق غير مثبّت",
    steps: ["ثبّت التطبيق أولاً من القسم 1 في القائمة الجانبية، ثم شغّل التشخيص."],
  },
  {
    id: "appops_missing",
    match: /appops: .*(inaccessible|not found)|Can't find service: appops/i,
    title: "أمر appops غير متاح على هذا النظام",
    steps: [
      "جرّب الصيغة cmd appops بدلاً من appops.",
      "إن لم يعمل، فالإعداد يحتاج إلى الواجهة الرسومية للنظام إن توفرت.",
    ],
  },
];

export function diagnoseText(text) {
  const src = String(text ?? "");
  const hits = ERROR_RULES.filter((rule) => rule.match.test(src));
  if (hits.length === 0) {
    const generic = /Failure \[(INSTALL_[A-Z_]+)/.exec(src);
    if (generic) {
      return [{
        id: "install_generic",
        title: `فشل التثبيت برمز ${generic[1]}`,
        steps: ["ابحث عن الرمز أعلاه في هذه الصفحة إن كان مدرجاً، أو أرسل الرسالة كاملة للتحليل."],
      }];
    }
  }
  return hits;
}

// ---------- Environment notes ----------

export function environmentNotes({ hasWebUsb, isSecureContext, userAgent }) {
  const notes = [];
  if (!hasWebUsb) notes.push({ level: "fail", text: "المتصفح لا يدعم WebUSB. استخدم Google Chrome أو Microsoft Edge على الكمبيوتر." });
  if (!isSecureContext) notes.push({ level: "warn", text: "الصفحة ليست في سياق آمن (HTTPS أو ملف محلي). قد يمنع المتصفح الوصول إلى USB." });
  const ua = String(userAgent ?? "");
  if (/Firefox\//.test(ua)) notes.push({ level: "fail", text: "Firefox لا يدعم WebUSB. استخدم Chrome أو Edge." });
  return notes;
}

// ---------- Install script (Windows .bat) ----------
// Uses CRLF line endings. The bat never touches the accessibility list: the page merges that list instead.

export function buildInstallBat({ pkg, version, apkName, apkUrl }) {
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    `title Car_DisplayZ Installer ${version}`,
    "setlocal",
    `set "PKG=${pkg}"`,
    `set "APK=${apkName}"`,
    `set "URL=${apkUrl}"`,
    "set \"ADB=adb\"",
    "where adb >nul 2>&1",
    "if not errorlevel 1 goto :adb_ok",
    "if not exist \"%LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe\" goto :adb_missing",
    "set \"ADB=%LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe\"",
    ":adb_ok",
    "echo ===================================================",
    `echo      Car_DisplayZ Installer - الإصدار ${version}`,
    "echo ===================================================",
    "echo.",
    "\"%ADB%\" get-state >nul 2>&1",
    "if errorlevel 1 goto :no_device",
    "if exist \"%APK%\" goto :have_apk",
    "echo جاري تحميل التحديث من GitHub...",
    "curl -L -f -o \"%APK%\" \"%URL%\"",
    "if errorlevel 1 goto :download_failed",
    ":have_apk",
    "echo جاري تثبيت التطبيق...",
    "\"%ADB%\" install -r \"%APK%\" > \"%TEMP%\\cdz_install.txt\" 2>&1",
    "type \"%TEMP%\\cdz_install.txt\"",
    "find /i \"Success\" \"%TEMP%\\cdz_install.txt\" >nul",
    "if errorlevel 1 goto :install_failed",
    "echo.",
    "echo جاري منح الصلاحيات الأساسية...",
    "\"%ADB%\" shell appops set %PKG% SYSTEM_ALERT_WINDOW allow",
    "\"%ADB%\" shell appops set %PKG% REQUEST_INSTALL_PACKAGES allow",
    "\"%ADB%\" shell dumpsys deviceidle whitelist +%PKG%",
    "echo.",
    "echo ملاحظة: خدمة الشريط السفلي تُفعَّل من الصفحة (WebInstaller) حتى لا تُمسح الخدمات الأخرى.",
    "echo تم. افتح التطبيق على الشاشة وتحقق من الزر العائم.",
    "goto :end",
    ":adb_missing",
    "echo [خطأ] لم أجد adb. ثبّت Android platform-tools أو أضفه إلى PATH.",
    "goto :end",
    ":no_device",
    "echo [خطأ] الشاشة غير متصلة. تحقق من الكابل وتفعيل تصحيح USB ثم أعد المحاولة.",
    "goto :end",
    ":download_failed",
    "echo [خطأ] فشل التحميل. تحقق من الإنترنت ثم أعد المحاولة.",
    "goto :end",
    ":install_failed",
    "echo [خطأ] فشل التثبيت. الصق رسالة Failure أو INSTALL_FAILED في مفكّك الأخطاء على الصفحة.",
    ":end",
    "echo.",
    "pause",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ---------- APK catalog (apks/ folder -> manifest.json) ----------

export const CATALOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.apk$/;
export const CATALOG_MAX_ENTRIES = 200;

export function isCatalogName(name) {
  return typeof name === "string" && CATALOG_NAME_RE.test(name);
}

// entries: [{ name, size, sha256 }]. Names that fail validation are dropped, not repaired.
export function buildCatalog(entries) {
  const seen = new Set();
  const items = [];
  for (const e of entries) {
    if (!isCatalogName(e.name) || seen.has(e.name)) continue;
    if (!(Number.isSafeInteger(e.size) && e.size > 0)) continue;
    if (!/^[0-9a-f]{64}$/.test(e.sha256 || "")) continue;
    seen.add(e.name);
    items.push({ name: e.name, size: e.size, sha256: e.sha256 });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { version: 1, apps: items.slice(0, CATALOG_MAX_ENTRIES) };
}

// Parses manifest.json text. Throws on anything that does not match the expected shape.
export function parseCatalog(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.apps)) throw new TypeError("manifest shape is wrong");
  return buildCatalog(data.apps);
}
