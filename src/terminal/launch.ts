import { getEmptyMcpConfigPath, VAULT_SYSTEM_PROMPT } from "../agent";
import { buildEnv } from "../cli-resolver";
import type { SessionMode } from "./types";

const isWindows = process.platform === "win32";

/** 起動元の claude のセッションに由来する変数。継がせると入れ子の実行と判断される。 */
const SESSION_VARS = new Set([
	"CLAUDECODE",
	"AI_AGENT",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"CLAUDE_PROJECT_DIR",
	"CLAUDE_ENV_FILE",
	"CLAUDE_PLUGIN_ROOT",
	"CLAUDE_PLUGIN_DATA",
]);
const SESSION_VAR_PATTERN =
	/^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SSE_PORT|CHILD_|SESSION_|MESSAGING_)/;

/** Obsidian を起動した端末の名残。継がせると claude が端末の種類を誤る。 */
const TERMINAL_VARS = new Set([
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMUX",
	"TMUX_PANE",
	"STY",
	"WT_SESSION",
	"WT_PROFILE_ID",
	"VTE_VERSION",
	"TERMINAL_EMULATOR",
	"COLORFGBG",
	"LC_TERMINAL",
]);
const TERMINAL_VAR_PATTERN = /^(KITTY_|ITERM_|VSCODE_|ConEmu)/i;

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

/** 引数に改行を入れないこと（Windows の .cmd 経由では渡せない）。 */
export function buildLaunchArgs(options: {
	mode: SessionMode;
	disableMcpServers: boolean;
	settingsJson: string;
}): string[] {
	const { mode } = options;
	const args: string[] = [];
	if (mode.kind === "continue") args.push("--continue");
	if (mode.kind === "resume") args.push("--resume", mode.sessionId);
	if (options.disableMcpServers) {
		args.push("--strict-mcp-config", "--mcp-config", getEmptyMcpConfigPath());
	}
	args.push("--append-system-prompt", VAULT_SYSTEM_PROMPT);
	args.push("--settings", options.settingsJson);
	return args;
}

export function buildLaunchEnv(
	claudePath: string,
	extra: Record<string, string>
): Record<string, string> {
	const env: Record<string, string> = {};
	const base = buildEnv(claudePath, { suppressBrowser: false });
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && !isInheritedVar(key)) env[key] = value;
	}
	bypassProxyForLoopback(env);
	const added = {
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		// 無いと Windows の ConPTY では実カーソルが入力位置に来ず、IME の表示がずれる
		CLAUDE_CODE_ACCESSIBILITY: "1",
		// 同期出力（DEC 2026）で描画のちらつきを防ぐ
		CLAUDE_CODE_FORCE_SYNC_OUTPUT: "1",
		...extra,
	};
	for (const [key, value] of Object.entries(added)) {
		for (const existing of matchingKeys(env, key)) delete env[existing];
		env[key] = value;
	}
	return env;
}

function isInheritedVar(key: string): boolean {
	const name = isWindows ? key.toUpperCase() : key;
	return (
		SESSION_VARS.has(name) ||
		SESSION_VAR_PATTERN.test(name) ||
		TERMINAL_VARS.has(name) ||
		TERMINAL_VAR_PATTERN.test(name)
	);
}

/** hook の通信をプロキシに通さない。claude の設定が後からプロキシを足すこともあるので常に入れる。 */
function bypassProxyForLoopback(env: Record<string, string>): void {
	const found = isWindows ? matchingKeys(env, "NO_PROXY") : ["no_proxy", "NO_PROXY"];
	const values = found.map((key) => (env[key] ?? "").trim());
	// 片方だけの指定が、新しく足すもう片方に隠れないよう同じ値から始める
	const fallback = values.find(Boolean) ?? "";
	if (isWindows) {
		for (const key of found) delete env[key];
		env.NO_PROXY = withLoopback(fallback);
		return;
	}
	found.forEach((key, i) => {
		env[key] = withLoopback(values[i] || fallback);
	});
}

function withLoopback(noProxy: string): string {
	if (noProxy === "*") return noProxy;
	const listed = noProxy.split(/[\s,]+/);
	const missing = LOOPBACK_HOSTS.filter((host) => !listed.includes(host));
	return [...(noProxy ? [noProxy] : []), ...missing].join(",");
}

/** `name` の変数として扱われるキー（Windows の環境変数は大文字小文字を区別しない）。 */
function matchingKeys(env: Record<string, string>, name: string): string[] {
	return Object.keys(env).filter((key) =>
		isWindows ? key.toUpperCase() === name.toUpperCase() : key === name
	);
}
