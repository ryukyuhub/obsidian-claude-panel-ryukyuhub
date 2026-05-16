import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "module";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

// ビルド成果物は開発者の Obsidian Vault のプラグインフォルダへ直接書き出す。
// これにより `npm run dev` でホットリロード可能なインストールが得られる。
// 開発者個人のパスは gitignore された `esbuild.config.local.mjs` に置く。
// CI や初回 clone 時はこのファイルが存在しないので、OUT_DIR か ./build に
// フォールバックする。VAULT_OUT_DIRS は親ディレクトリが実在する最初の
// エントリが採用されるため、1ファイルで複数の開発マシンに対応できる。
let VAULT_OUT_DIRS = [];
try {
  const local = await import("./esbuild.config.local.mjs");
  VAULT_OUT_DIRS = local.VAULT_OUT_DIRS ?? [];
} catch {
  // ローカルオーバーライドファイルが無い場合はそのまま OK。OUT_DIR か ./build にフォールバックする。
}

const OUT_DIR =
  process.env.OUT_DIR ||
  VAULT_OUT_DIRS.find((p) => fs.existsSync(path.dirname(p))) ||
  "./build";

fs.mkdirSync(OUT_DIR, { recursive: true });

const ASSETS = ["manifest.json", "styles.css"];

const copyAssetsPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      for (const name of ASSETS) {
        fs.copyFileSync(name, path.join(OUT_DIR, name));
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(OUT_DIR, "main.js"),
  minify: prod,
  platform: "node",
  plugins: [copyAssetsPlugin],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
}
