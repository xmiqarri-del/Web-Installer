// Builds the single-file WebInstaller: src/template.html + src/logic.mjs + src/app.js -> index.html.
// The logic and app code run inside one <script type="module">, so the `export` keywords are removed.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MARKER = "/*__BUILD__*/";
export const OUT_FILE = join(here, "index.html");

export function stripExports(source) {
  return source.replace(/^export\s+(?=const|function|async|let|class)/gm, "");
}

export function assemble(template, logicSource, appSource) {
  if (template.split(MARKER).length !== 2) throw new Error(`template must contain ${MARKER} exactly once`);
  const code = `${stripExports(logicSource)}\n${appSource}`;
  if (/^\s*export\s/m.test(code)) throw new Error("an export keyword survived the build");
  if (/<\/script/i.test(code)) throw new Error("the code contains </script>, which would end the script tag early");
  // A function replacement keeps "$" sequences in the code (e.g. "$1") from being read as replacement patterns.
  return template.replace(MARKER, () => code);
}

export async function build() {
  const [template, logic, app] = await Promise.all([
    readFile(join(here, "src", "template.html"), "utf8"),
    readFile(join(here, "src", "logic.mjs"), "utf8"),
    readFile(join(here, "src", "app.js"), "utf8"),
  ]);
  const html = assemble(template, logic, app);
  await writeFile(OUT_FILE, html, "utf8");
  return { out: OUT_FILE, bytes: Buffer.byteLength(html, "utf8") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await build();
  console.log(`built ${r.out} (${r.bytes} bytes)`);
}
