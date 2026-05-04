// このファイルを `esbuild.config.local.mjs` にコピーし、`VAULT_OUT_DIRS`
// を自分の Obsidian Vault のプラグインフォルダへ向けて編集してください。
// 実ファイルは gitignore 対象なので、開発者ごとに自分のパスを保持できます。
//
// `esbuild.config.mjs` は親ディレクトリが実在する最初のエントリを採用する
// ため、複数マシン分（macOS と Windows など）のパスを並べておいても安全
// です。実行時に解決できる行だけが採用されます。
//
// このファイルを置かずに `OUT_DIR` 環境変数を使う方法もあります:
//     OUT_DIR=/path/to/vault/.obsidian/plugins/claude-panel-ryukyuhub npm run dev

export const VAULT_OUT_DIRS = [
	// "/Users/you/path/to/vault/.obsidian/plugins/claude-panel-ryukyuhub",
	// "D:\\path\\to\\vault\\.obsidian\\plugins\\claude-panel-ryukyuhub",
];
