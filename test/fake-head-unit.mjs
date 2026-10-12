// A simulated Android head unit. It answers only the commands the installer issues.
// Unit tests import it; the browser tests embed it with Function.prototype.toString(),
// so this function must stay self-contained (no imports, no references to outer variables).
//
// Fake APK files carry a text marker, "CDZ-FAKE-APK package=... versionName=... versionCode=...",
// which `pm install` reads back. That lets the tests install "versions" without a real APK.
export function makeHeadUnit(opts = {}) {
  const state = {
    sdk: opts.sdk ?? 33,
    model: opts.model ?? "JetourG700",
    installed: opts.installed ?? true,
    version: { name: opts.versionName ?? "1.1.6", code: opts.versionCode ?? 8 },
    installFailure: opts.installFailure ?? null,   // e.g. "INSTALL_FAILED_UPDATE_INCOMPATIBLE"
    appops: { ...(opts.appops ?? {}) },
    settings: {
      enabled_accessibility_services: opts.services ?? null,
      accessibility_enabled: opts.a11yEnabled ?? "0",
    },
    granted: {},
    whitelist: [...(opts.whitelist ?? [])],
    userPackages: [...(opts.userPackages ?? ["com.xmiqarri.cardisplayz", "com.waze"])],
    failPmGrant: opts.failPmGrant ?? false,
    staged: {},      // files pushed through the sync service, by path
    pushes: [],
    syncDisposed: 0,
    installs: [],
    removed: [],
    commands: [],
  };
  const ok = (stdout = "", exitCode = 0) => ({ ok: exitCode === 0, exitCode, stdout, stderr: "", error: null });
  const fail = (text) => ({ ok: false, exitCode: 1, stdout: `${text}\n`, stderr: "", error: null });
  const exec = (command) => {
    state.commands.push(command);
    let m;
    if (command === "getprop ro.build.version.sdk") return ok(`${state.sdk}\n`);
    if (command === "getprop ro.product.model") return ok(`${state.model}\n`);
    if ((m = /^pm path (\S+)$/.exec(command))) {
      return state.installed ? ok(`package:/data/app/${m[1]}/base.apk\n`) : ok("", 1);
    }
    if (command === "pm list packages -3") {
      return ok(state.userPackages.map((p) => `package:${p}\n`).join(""));
    }
    if ((m = /^pm install -r (\S+)$/.exec(command))) {
      const bytes = state.staged[m[1]];
      if (!bytes) return fail(`Failure [INSTALL_PARSE_FAILED_NOT_APK: no file at ${m[1]}]`);
      const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
      const meta = /CDZ-FAKE-APK package=(\S+) versionName=(\S+) versionCode=(\d+)/.exec(text);
      if (!meta) return fail("Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES: not an APK]");
      if (state.installFailure) return fail(`Failure [${state.installFailure}: refused by the head unit]`);
      if (state.installed && Number(meta[3]) < state.version.code) {
        return fail("Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected]");
      }
      state.installed = true;
      state.version = { name: meta[2], code: Number(meta[3]) };
      state.installs.push(meta[1]);
      return ok("Performing Streamed Install\nSuccess\n");
    }
    if ((m = /^rm -f (\S+)$/.exec(command))) {
      delete state.staged[m[1]];
      state.removed.push(m[1]);
      return ok("");
    }
    if ((m = /^appops get (\S+) (\S+)$/.exec(command))) {
      const mode = state.appops[`${m[1]}|${m[2]}`] ?? "default";
      return ok(`${m[2]}: ${mode}; time=+1d\n`);
    }
    if ((m = /^appops set (\S+) (\S+) (\S+)$/.exec(command))) {
      state.appops[`${m[1]}|${m[2]}`] = m[3];
      return ok("");
    }
    if ((m = /^settings get secure (\S+)$/.exec(command))) {
      const v = state.settings[m[1]];
      return ok(v == null ? "null\n" : `${v}\n`);
    }
    if ((m = /^settings put secure (\S+) "(.*)"$/.exec(command))) {
      state.settings[m[1]] = m[2];
      return ok("");
    }
    if ((m = /^pm grant (\S+) (\S+)$/.exec(command))) {
      if (state.failPmGrant) return { ok: false, exitCode: 1, stdout: "", stderr: "Unknown permission", error: null };
      state.granted[m[2]] = true;
      return ok("");
    }
    if (/^dumpsys package \S+$/.test(command)) {
      if (!state.installed) return ok("");
      const g = state.granted["android.permission.POST_NOTIFICATIONS"] ? "true" : "false";
      return ok(
        `    versionCode=${state.version.code} minSdk=30 targetSdk=33\n` +
        `    versionName=${state.version.name}\n` +
        `android.permission.POST_NOTIFICATIONS: granted=${g}, flags=[ USER_SET ]\n`,
      );
    }
    if (command === "dumpsys deviceidle whitelist") {
      return ok(state.whitelist.map((p) => `user,${p},10123\n`).join(""));
    }
    if ((m = /^dumpsys deviceidle whitelist \+(\S+)$/.exec(command))) {
      if (!state.whitelist.includes(m[1])) state.whitelist.push(m[1]);
      return ok(`Added ${m[1]}\n`);
    }
    return { ok: false, exitCode: 127, stdout: "", stderr: `sh: not found: ${command}`, error: null };
  };
  return { state, exec };
}
