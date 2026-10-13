// Stand-ins for the three @yume-chan modules that the page loads from jsDelivr.
// The browser tests serve these through page.route, so the real page code runs against a simulated head unit.
import { makeHeadUnit } from "./fake-head-unit.mjs";
import { APP_VERSION, EXPECTED_VERSION_CODE } from "../src/logic.mjs";

export function fakeModules({ headUnit = {}, auth = "ok", request = "ok", noWebUsb = false, noShellV2 = false, syncFailure = null } = {}) {
  const options = JSON.stringify({ auth, request, noWebUsb, noShellV2, syncFailure });

  const adb = `
const HU = (${makeHeadUnit.toString()})(${JSON.stringify({ versionName: APP_VERSION, versionCode: EXPECTED_VERSION_CODE, ...headUnit })});
window.__cdzHeadUnit = HU.state;
const OPTS = ${options};

export class Adb {
  constructor(transport) {
    this.transport = transport;
    let done;
    this.disconnected = new Promise((resolve) => { done = resolve; });
    this._done = done;
    const spawn = async (command) => {
      const r = HU.exec(command);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    };
    this.subprocess = {
      shellProtocol: OPTS.noShellV2 ? undefined : { spawnWaitText: spawn },
      noneProtocol: { spawnWaitText: async (command) => HU.exec(command).stdout },
    };
  }
  // Like the real AdbSync: write() takes a ReadableStream of bytes and stores the file on the fake head unit.
  async sync() {
    return {
      async write({ filename, file, permission = 0o666, mtime = null }) {
        if (OPTS.syncFailure === "nospace") throw new Error("No space left on device");
        const reader = file.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        HU.state.staged[filename] = bytes;
        HU.state.pushes.push({ filename, size: total, permission, mtime });
      },
      async dispose() {
        HU.state.syncDisposed += 1;
      },
    };
  }
  async close() {
    await this.transport.close();
    this._done();
  }
}

export class AdbDaemonTransport {
  static async authenticate({ serial, connection }) {
    if (OPTS.auth === "unauthorized") {
      throw new Error("device unauthorized. This adb server's $ADB_VENDOR_KEYS is not allowed");
    }
    if (OPTS.auth === "hang") return new Promise(() => {});
    return { serial, connection, close: async () => {} };
  }
}
`;

  const webusb = `
const OPTS = ${options};
export class AdbDaemonWebUsbDeviceManager {
  static BROWSER = OPTS.noWebUsb ? undefined : new AdbDaemonWebUsbDeviceManager();
  async requestDevice() {
    if (OPTS.request === "cancel") return undefined;
    if (OPTS.request === "notfound") {
      throw new DOMException("Failed to execute 'requestDevice' on 'USB': No device selected.", "NotFoundError");
    }
    return { serial: "FAKE-SERIAL-0001", connect: async () => ({ close: async () => {} }) };
  }
}
`;

  const cred = `export default class AdbWebCredentialStore { constructor(appName = "Tango") { this.appName = appName; } }`;

  return { adb, webusb, cred };
}
