// Follows the latest Car_DisplayZ release. It reads that release's update.json, downloads the APK,
// checks the APK's size and SHA-256 against update.json, and rewrites the RELEASE block in src/logic.mjs.
// Run it with `node scripts/sync-release.mjs`. It writes `changed=true|false` to $GITHUB_OUTPUT when set.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const LOGIC_FILE = join(here, "..", "src", "logic.mjs");
export const BEGIN = "// RELEASE:BEGIN";
export const END = "// RELEASE:END";

// Reads the four values from the RELEASE block.
export function parseRelease(source) {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new Error("RELEASE block not found in src/logic.mjs");
  const block = source.slice(start, end);
  const pick = (name) => {
    const m = new RegExp(`export const ${name} = (?:"([^"]*)"|(\\d+));`).exec(block);
    if (!m) throw new Error(`${name} missing from RELEASE block`);
    return m[1] ?? Number(m[2]);
  };
  return {
    version: pick("APP_VERSION"),
    versionCode: pick("EXPECTED_VERSION_CODE"),
    bytes: pick("EXPECTED_APK_BYTES"),
    sha256: pick("EXPECTED_APK_SHA256"),
  };
}

// Replaces the RELEASE block with values for a new release. Everything outside the block is kept as is.
export function applyRelease(source, { version, versionCode, bytes, sha256 }) {
  const start = source.indexOf(BEGIN);
  const endMarker = source.indexOf(END);
  if (start < 0 || endMarker < start) throw new Error("RELEASE block not found in src/logic.mjs");
  const endLineEnd = source.indexOf("\n", endMarker);
  const block = [
    `${BEGIN} — rewritten by scripts/sync-release.mjs when a new Car_DisplayZ release is published.`,
    "// The values come from that release's update.json; the APK itself is checked against them.",
    `export const APP_VERSION = "${version}";`,
    `export const EXPECTED_VERSION_CODE = ${versionCode};`,
    `export const EXPECTED_APK_BYTES = ${bytes};`,
    `export const EXPECTED_APK_SHA256 = "${sha256}";`,
    END,
  ].join("\n");
  return source.slice(0, start) + block + source.slice(endLineEnd === -1 ? source.length : endLineEnd);
}

export function validateManifest(m, repo) {
  if (!/^\d+\.\d+\.\d+$/.test(m.version_name ?? "")) throw new Error(`bad version_name: ${m.version_name}`);
  if (!Number.isInteger(m.version_code) || m.version_code < 1) throw new Error(`bad version_code: ${m.version_code}`);
  if (!/^[0-9a-f]{64}$/.test(m.sha256 ?? "")) throw new Error("bad sha256 in update.json");
  if (!Number.isInteger(m.size_bytes) || m.size_bytes < 1) throw new Error("bad size_bytes in update.json");
  // GitHub names are case-insensitive, so the comparison ignores case.
  const prefix = `https://github.com/${repo}/releases/download/v${m.version_name}/`.toLowerCase();
  if (typeof m.apk_url !== "string" || !m.apk_url.toLowerCase().startsWith(prefix)) throw new Error(`apk_url does not point at v${m.version_name} of ${repo}`);
  return true;
}

export async function main({ repo = process.env.CARDZ_REPO ?? "xmiqarri-del/Car_DisplayZ" } = {}) {
  // The "latest release" link needs no API token, and it always points at the newest release's update.json.
  const res = await fetch(`https://github.com/${repo}/releases/latest/download/update.json`);
  if (!res.ok) throw new Error(`update.json of the latest release -> ${res.status}`);
  const manifest = await res.json();
  validateManifest(manifest, repo);

  // The APK must match update.json before the page is allowed to trust it.
  const apkRes = await fetch(manifest.apk_url);
  if (!apkRes.ok) throw new Error(`APK download -> ${apkRes.status}`);
  const apk = Buffer.from(await apkRes.arrayBuffer());
  const sha = createHash("sha256").update(apk).digest("hex");
  if (apk.length !== manifest.size_bytes || sha !== manifest.sha256) {
    throw new Error(`APK does not match update.json (size ${apk.length} vs ${manifest.size_bytes}, sha ${sha})`);
  }

  const next = { version: manifest.version_name, versionCode: manifest.version_code, bytes: manifest.size_bytes, sha256: manifest.sha256 };
  const source = await readFile(LOGIC_FILE, "utf8");
  const current = parseRelease(source);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) await writeFile(LOGIC_FILE, applyRelease(source, next), "utf8");
  console.log(changed ? `updated to ${next.version} (code ${next.versionCode})` : `already at ${next.version}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nversion=${next.version}\n`);
  return { changed, ...next };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
