/** Builds the server into `dist/server` and the extension into `dist/extension` */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function listFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? listFiles(file) : [file];
    });
}

// A rebuilt server replaces a daemon still running older code, so the version names the sources
const hash = createHash("sha256");
for (const file of listFiles(src)) hash.update(readFileSync(file));
const version = `${pkg.version}+${hash.digest("hex").slice(0, 10)}`;

for (const dir of ["server", "extension"]) {
  rmSync(path.join(dist, dir), { recursive: true, force: true });
}

const define = { __VERSION__: JSON.stringify(version) };

await build({
  entryPoints: {
    index: path.join(src, "server/index.ts"),
    daemon: path.join(src, "server/daemon-main.ts"),
  },
  outdir: path.join(dist, "server"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  splitting: false,
  define,
  logLevel: "warning",
});
writeFileSync(path.join(dist, "server/package.json"), JSON.stringify({ type: "module" }));

const extensionBuild = {
  outdir: path.join(dist, "extension"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "firefox140",
  define,
  charset: "utf8",
  logLevel: "warning",
};

await build({
  ...extensionBuild,
  entryPoints: {
    background: path.join(src, "extension/background/index.ts"),
    popup: path.join(src, "extension/popup.ts"),
  },
});

// `eval` may run an agent's code in the content script's world (see `evaluate`), and content scripts can write to
// `storage.local`, where pairing lives. So the script keeps the extension APIs in a closure and removes the globals
await build({
  ...extensionBuild,
  entryPoints: { content: path.join(src, "extension/content/index.ts") },
  banner: { js: "(() => { const browser = globalThis.browser; delete globalThis.browser; delete globalThis.chrome;" },
  footer: { js: "})();" },
});

mkdirSync(path.join(dist, "extension"), { recursive: true });
cpSync(path.join(src, "extension/static"), path.join(dist, "extension"), { recursive: true });

// One version number, from package.json
const manifestFile = path.join(dist, "extension/manifest.json");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
manifest.version = pkg.version;
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

console.log(`Built ${version} → dist/server, dist/extension`);
