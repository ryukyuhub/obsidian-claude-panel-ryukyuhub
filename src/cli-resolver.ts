import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * `claude` CLI を起動するための共通ヘルパー: パス解決・環境変数構築・
 * Windows の `.cmd`/`.bat` シム判定。サブプロセス実行を行う agent.ts /
 * cli-introspect 系から共通利用される。サブプロセス自体は起動しない
 * 純粋な「どのバイナリを、どんな env と shell モードで起動するか」を
 * 計算する責務。
 */

const isWindows = process.platform === "win32";

const COMMON_CLAUDE_PATHS = isWindows
	? [
		"%USERPROFILE%\\.local\\bin\\claude.exe",
		"%USERPROFILE%\\.claude\\local\\claude.exe",
		"%LOCALAPPDATA%\\Programs\\claude\\claude.exe",
		"%APPDATA%\\npm\\claude.cmd",
	]
	: [
		"~/.local/bin/claude",
		"~/.claude/local/claude",
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
		"/usr/bin/claude",
	];

function expandPath(p: string): string {
	if (isWindows) {
		return p.replace(/%([^%]+)%/g, (_, name: string) =>
			process.env[name] ?? `%${name}%`
		);
	}
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function resolveClaudePath(configured: string): string | null {
	if (configured) {
		const expanded = expandPath(configured);
		return fs.existsSync(expanded) ? expanded : null;
	}
	for (const candidate of COMMON_CLAUDE_PATHS) {
		const expanded = expandPath(candidate);
		if (fs.existsSync(expanded)) return expanded;
	}
	return null;
}

// 一時ディレクトリに `open`（macOS）と `xdg-open`（Linux）の no-op スクリプト
// を置き、PATH の先頭に差し込むことで、起動した `claude` CLI 配下の
// サブプロセス（起動時にダッシュボードを自動で立ち上げる Serena などの
// MCP サーバを含む）がブラウザを開かないようにする。POSIX 限定
// （Windows にはシャドウすべき同等のシェル呼び出し可能な `open` がない）。
// 必要時に遅延生成し、以降は再利用する。
let _shadowBinDir: string | null = null;
function getShadowBinDir(): string | null {
	if (isWindows) return null;
	if (_shadowBinDir && fs.existsSync(_shadowBinDir)) return _shadowBinDir;
	const dir = path.join(os.tmpdir(), "claude-panel-shadow-bin");
	try {
		fs.mkdirSync(dir, { recursive: true });
		// Shell script content stays English — it is written to a temp file
		// and only inspected by developers, not shown in any UI.
		const script = "#!/bin/sh\n# claude-panel: no-op script that suppresses browser launches\nexit 0\n";
		for (const name of ["open", "xdg-open"]) {
			const p = path.join(dir, name);
			fs.writeFileSync(p, script, { mode: 0o755 });
			try {
				fs.chmodSync(p, 0o755);
			} catch {
				/* noop */
			}
		}
	} catch {
		/* noop — env 構築処理は続行 */
	}
	_shadowBinDir = dir;
	return dir;
}

export function buildEnv(claudePath: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const shadow = getShadowBinDir();
	const extraPathDirs = [
		// PATH の順序が重要: shadow ディレクトリを必ず先頭に置き、no-op の
		// `open` がシステム標準の `open` をシャドウできるようにする。
		...(shadow ? [shadow] : []),
		path.dirname(claudePath),
		...(isWindows
			? [
				expandPath("%USERPROFILE%\\.local\\bin"),
				expandPath("%APPDATA%\\npm"),
				// Node.js のインストール先。Obsidian の起動時 PATH に
				// 含まれていなくても、Claude CLI とそのフックスクリプト
				// （`node ...`）が確実に動くようにここで明示的に通す。
				expandPath("%ProgramFiles%\\nodejs"),
				expandPath("%ProgramFiles(x86)%\\nodejs"),
			]
			: [
				expandPath("~/.local/bin"),
				"/usr/local/bin",
				"/opt/homebrew/bin",
				"/usr/bin",
				"/bin",
			]),
	];
	const currentPath = env.PATH ?? "";
	const sep = path.delimiter;
	const merged = [
		...extraPathDirs,
		...currentPath.split(sep).filter(Boolean),
	];
	env.PATH = Array.from(new Set(merged)).join(sep);
	delete env.ANTHROPIC_API_KEY;
	// Linux／クロスプラットフォーム向けのフォールバック。`true` は no-op の
	// シェル組み込みコマンド。$BROWSER を尊重するツール（Linux の Python
	// webbrowser モジュール等）はこれを見て静かに何もしないようになる。
	env.BROWSER = "true";
	return env;
}

// Windows では `.cmd` / `.bat` のシム（例: `npm i -g` で入る `claude.cmd`）を
// `child_process.spawn` から直接 exec できないためシェル経由で起動する必要がある。
// `.exe` バイナリ（Anthropic 公式インストーラ由来の claude.exe — 本リポジトリ
// 推奨）は `shell: true` のクォーティング地雷を避けて直接 spawn できる。
export function needsShell(claudePath: string): boolean {
	if (!isWindows) return false;
	const ext = path.extname(claudePath).toLowerCase();
	return ext === ".cmd" || ext === ".bat";
}
