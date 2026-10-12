// Scans apks/ and writes apks/manifest.json. Run through `npm run build`.
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, isCatalogName } from "../src/logic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const APKS_DIR = join(here, "..", "apks");

export async function catalogFromDir(dir = APKS_DIR) {
  const names = (await readdir(dir)).filter(isCatalogName).sort();
  const entries = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const bytes = await readFile(path);
    entries.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return buildCatalog(entries);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = await catalogFromDir();
  await writeFile(join(APKS_DIR, "manifest.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log(`catalog: ${catalog.apps.length} apk(s) listed in apks/manifest.json`);
}
