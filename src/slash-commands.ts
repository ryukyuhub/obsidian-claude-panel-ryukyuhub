import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type ClaudePanelPlugin from "./main";
import {
	MODEL_PRESETS,
	THINKING_MODES,
	formatModelLabel,
	type ThinkingMode,
} from "./settings";
import { listMcpServers, runClaudeSubcommand } from "./agent";
import { diagnoseSessionLookup } from "./session-history";
import { t } from "./i18n";

/**
 * 入力欄に表示する候補のカテゴリ。バッジの色分けにも使う。
 *   local         — このプラグイン内で完結（モーダル/設定操作など）
 *   repl-only     — TTY 必須なのでターミナル案内を出すだけ
 *   passthrough   — そのまま CLI に渡るが、よく使うので候補に出す
 *   skill         — `<dir>/.claude/skills/<name>/SKILL.md` を発見したもの
 *   user-command  — `<dir>/.claude/commands/<name>.md` を発見したもの
 *
 * skill / user-command は `slash-suggest` 側で動的にサジェストへ混ぜるが、
 * `handleLocalSlashCommand` の switch には載らない（マッチしないものは
 * 通常の passthrough としてそのまま CLI に渡る）。
 */
export type SlashCategory =
	| "local"
	| "repl-only"
	| "passthrough"
	| "skill"
	| "user-command";

export interface SlashCommandSpec {
	name: string;
	desc: string;
	category: SlashCategory;
}

/**
 * 入力サジェスト用のスラッシュコマンドカタログ。`handleLocalSlashCommand`
 * の switch とこちらは独立しているので、ローカルハンドラを増やしたら
 * ここにも 1 行足す必要がある（CI で照合する仕組みは入れていない）。
 */
export const SLASH_COMMANDS: SlashCommandSpec[] = [
	{ name: "/clear", desc: t("slash.desc.clear"), category: "local" },
	{ name: "/continue", desc: t("slash.desc.continue"), category: "local" },
	{ name: "/help", desc: t("slash.desc.help"), category: "local" },
	{ name: "/model", desc: t("slash.desc.model"), category: "local" },
	{ name: "/think", desc: t("slash.desc.think"), category: "local" },
	{ name: "/mcp", desc: t("slash.desc.mcp"), category: "local" },
	{ name: "/plugin", desc: t("slash.desc.plugin"), category: "local" },
	{ name: "/usage", desc: t("slash.desc.usage"), category: "local" },
	{ name: "/cost", desc: t("slash.desc.cost"), category: "local" },
	{ name: "/account", desc: t("slash.desc.account"), category: "local" },
	{ name: "/config", desc: t("slash.desc.config"), category: "local" },
	{ name: "/compact", desc: t("slash.desc.compact"), category: "local" },
	{ name: "/exit", desc: t("slash.desc.exit"), category: "local" },
	{ name: "/quit", desc: t("slash.desc.quit"), category: "local" },

	{ name: "/login", desc: t("slash.desc.login"), category: "repl-only" },
	{ name: "/logout", desc: t("slash.desc.logout"), category: "repl-only" },
	{ name: "/agents", desc: t("slash.desc.agents"), category: "repl-only" },
	{ name: "/permissions", desc: t("slash.desc.permissions"), category: "repl-only" },
	{ name: "/doctor", desc: t("slash.desc.doctor"), category: "repl-only" },
	{ name: "/upgrade", desc: t("slash.desc.upgrade"), category: "repl-only" },
	{
		name: "/migrate-installer",
		desc: t("slash.desc.migrateInstaller"),
		category: "repl-only",
	},
	{ name: "/release-notes", desc: t("slash.desc.releaseNotes"), category: "repl-only" },
	{ name: "/bug", desc: t("slash.desc.bug"), category: "repl-only" },
	{
		name: "/terminal-setup",
		desc: t("slash.desc.terminalSetup"),
		category: "repl-only",
	},
	{ name: "/vim", desc: t("slash.desc.vim"), category: "repl-only" },

	{ name: "/init", desc: t("slash.desc.init"), category: "passthrough" },
	{
		name: "/review",
		desc: t("slash.desc.review"),
		category: "passthrough",
	},
	{
		name: "/pr-comments",
		desc: t("slash.desc.prComments"),
		category: "passthrough",
	},
];

export interface SlashContext {
	plugin: ClaudePanelPlugin;
	getVaultPath: () => string | null;
	clearConversation: () => void;
	/** 直近のセッション JSONL から UI 履歴を復元し、次の送信で
	 *  `--continue` を 1 回だけ予約する。戻り値は復元したメッセージ件数。 */
	restoreFromLatestSession: (cwd: string) => number;
	refreshControls: () => void;
	appendSystemMessage: (text: string) => void;
	appendInteractive: (render: (c: HTMLElement) => void) => void;
	openAccountUsage: () => void;
	openPluginSettings: () => void;
	closeView: () => void;
}

/**
 * チャット入力欄に打ち込まれたスラッシュコマンドをディスパッチする。
 * ローカルで処理した場合は `true` を返す。`false` の場合は呼び出し側で
 * そのまま CLI に転送される。
 */
export function handleLocalSlashCommand(
	ctx: SlashContext,
	text: string
): boolean {
	const [cmd, ...rest] = text.split(/\s+/);
	const arg = rest.join(" ").trim();
	switch (cmd) {
		case "/clear":
			ctx.clearConversation();
			return true;
		case "/continue":
			handleContinueCommand(ctx);
			return true;
		case "/help":
			showHelp(ctx);
			return true;
		case "/model":
			handleModelCommand(ctx, arg);
			return true;
		case "/think":
			handleThinkCommand(ctx, arg);
			return true;
		case "/mcp":
			showMcpStatus(ctx);
			return true;
		case "/plugin":
			handlePluginCommand(ctx, arg);
			return true;
		case "/usage":
		case "/account":
		case "/cost":
			ctx.openAccountUsage();
			return true;
		case "/config":
			ctx.openPluginSettings();
			ctx.appendSystemMessage(t("slash.configOpened"));
			return true;
		case "/exit":
		case "/quit":
			ctx.closeView();
			return true;
		case "/login":
			showTerminalOnlyNote(ctx, "/login", t("slash.purpose.login"));
			return true;
		case "/logout":
			showTerminalOnlyNote(ctx, "/logout", t("slash.purpose.logout"));
			return true;
		case "/compact":
			ctx.appendSystemMessage(t("slash.compactExplain"));
			return true;
		case "/agents":
			showTerminalOnlyNote(ctx, "/agents", t("slash.purpose.agents"));
			return true;
		case "/permissions":
			showTerminalOnlyNote(
				ctx,
				"/permissions",
				t("slash.purpose.permissions")
			);
			return true;
		case "/doctor":
			showTerminalOnlyNote(ctx, "/doctor", t("slash.purpose.doctor"));
			return true;
		case "/upgrade":
			showTerminalOnlyNote(ctx, "/upgrade", t("slash.purpose.upgrade"));
			return true;
		case "/migrate-installer":
			showTerminalOnlyNote(
				ctx,
				"/migrate-installer",
				t("slash.purpose.migrateInstaller")
			);
			return true;
		case "/release-notes":
			showTerminalOnlyNote(ctx, "/release-notes", t("slash.purpose.releaseNotes"));
			return true;
		case "/bug":
			showTerminalOnlyNote(ctx, "/bug", t("slash.purpose.bug"));
			return true;
		case "/terminal-setup":
			showTerminalOnlyNote(
				ctx,
				"/terminal-setup",
				t("slash.purpose.terminalSetup")
			);
			return true;
		case "/vim":
			showTerminalOnlyNote(ctx, "/vim", t("slash.purpose.vim"));
			return true;
		default:
			return false;
	}
}

/**
 * Claude Code REPL 専用のコマンドを叩かれたときに、ターミナルから
 * `claude <cmd>` を実行するよう案内するシステムメッセージを表示する。
 * `--print` 経由では動かない（あるいは TTY 必須の）コマンドに使う。
 */
function handleContinueCommand(ctx: SlashContext): void {
	const cwd = ctx.getVaultPath();
	if (!cwd) {
		ctx.appendSystemMessage(t("slash.vaultPathUnresolved"));
		return;
	}
	const count = ctx.restoreFromLatestSession(cwd);
	if (count === 0) {
		const diag = diagnoseSessionLookup(cwd);
		ctx.appendSystemMessage(
			t(
				"slash.continue.notFound",
				diag.cwd,
				diag.encodedDir,
				diag.exists,
				diag.jsonlCount
			)
		);
		return;
	}
	ctx.appendSystemMessage(t("slash.continue.restored", count));
}

function showTerminalOnlyNote(
	ctx: SlashContext,
	command: string,
	purpose: string
): void {
	ctx.appendSystemMessage(t("slash.terminalOnly", command, purpose));
}

function showHelp(ctx: SlashContext): void {
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.help.localTitle"),
		});
		const list = c.createEl("ul", { cls: "claude-panel-sys-list" });
		const items: [string, string][] = [
			["/clear", t("slash.help.itemClear")],
			["/continue", t("slash.help.itemContinue")],
			["/help", t("slash.help.itemHelp")],
			["/model [id]", t("slash.help.itemModel")],
			["/think [mode]", t("slash.help.itemThink")],
			["/mcp", t("slash.help.itemMcp")],
			["/plugin [...]", t("slash.help.itemPlugin")],
			["/usage", t("slash.help.itemUsage")],
			["/cost", t("slash.help.itemCost")],
			["/config", t("slash.help.itemConfig")],
			["/compact", t("slash.help.itemCompact")],
			["/exit, /quit", t("slash.help.itemExit")],
		];
		for (const [name, desc] of items) {
			const li = list.createEl("li");
			li.createEl("code", { text: name });
			li.createSpan({ text: ` — ${desc}` });
		}

		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.help.replTitle"),
		});
		const replList = c.createEl("ul", { cls: "claude-panel-sys-list" });
		const replItems: [string, string][] = [
			["/login, /logout", t("slash.help.itemLogin")],
			["/agents", t("slash.help.itemAgents")],
			["/permissions", t("slash.help.itemPermissions")],
			["/doctor", t("slash.help.itemDoctor")],
			["/upgrade", t("slash.help.itemUpgrade")],
			["/migrate-installer", t("slash.help.itemMigrateInstaller")],
			["/release-notes", t("slash.help.itemReleaseNotes")],
			["/bug", t("slash.help.itemBug")],
			["/terminal-setup", t("slash.help.itemTerminalSetup")],
			["/vim", t("slash.help.itemVim")],
		];
		for (const [name, desc] of replItems) {
			const li = replList.createEl("li");
			li.createEl("code", { text: name });
			li.createSpan({ text: ` — ${desc}` });
		}

		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.help.passthroughTitle"),
		});
		const note = c.createEl("div", { cls: "claude-panel-sys-note" });
		note.setText(t("slash.help.passthroughNote"));
	});
}

function handleModelCommand(ctx: SlashContext, arg: string): void {
	if (arg) {
		ctx.plugin.settings.model = arg;
		void ctx.plugin.saveSettings();
		ctx.refreshControls();
		ctx.appendSystemMessage(t("slash.model.set", formatModelLabel(arg)));
		return;
	}
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.model.current", formatModelLabel(ctx.plugin.settings.model)),
		});
		const choices = c.createDiv({ cls: "claude-panel-sys-choices" });
		for (const m of MODEL_PRESETS) {
			const btn = choices.createEl("button", {
				cls: "claude-panel-sys-choice",
				text: formatModelLabel(m),
				attr: { title: m },
			});
			if (m === ctx.plugin.settings.model) btn.addClass("is-current");
			btn.onclick = async () => {
				ctx.plugin.settings.model = m;
				await ctx.plugin.saveSettings();
				ctx.refreshControls();
				ctx.appendSystemMessage(t("slash.model.set", formatModelLabel(m)));
			};
		}
	});
}

function handleThinkCommand(ctx: SlashContext, arg: string): void {
	if (arg) {
		if ((THINKING_MODES as string[]).includes(arg)) {
			ctx.plugin.settings.thinkingMode = arg as ThinkingMode;
			void ctx.plugin.saveSettings();
			ctx.refreshControls();
			ctx.appendSystemMessage(t("slash.think.set", arg));
		} else {
			const valid = THINKING_MODES.map((v) => `\`${v}\``).join(", ");
			ctx.appendSystemMessage(t("slash.think.unknown", arg, valid));
		}
		return;
	}
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.think.current", ctx.plugin.settings.thinkingMode),
		});
		const choices = c.createDiv({ cls: "claude-panel-sys-choices" });
		for (const mode of THINKING_MODES) {
			const btn = choices.createEl("button", {
				cls: "claude-panel-sys-choice",
				text: mode,
			});
			if (mode === ctx.plugin.settings.thinkingMode)
				btn.addClass("is-current");
			btn.onclick = async () => {
				ctx.plugin.settings.thinkingMode = mode;
				await ctx.plugin.saveSettings();
				ctx.refreshControls();
				ctx.appendSystemMessage(t("slash.think.set", mode));
			};
		}
	});
}

type McpScope = "project" | "user" | "local" | "claude.ai" | "unknown";

interface ScopeMap {
	project: Set<string>;
	user: Set<string>;
	local: Set<string>;
}

/**
 * ローカル設定ファイルを読み、各 MCP サーバがどの scope に設定されているか
 * を判定する。`claude mcp list` の出力とつき合わせて行ごとに出所バッジを
 * 付与する。
 *   project: <cwd>/.mcp.json（リポジトリにコミット、共有される）
 *   user:    ~/.claude.json mcpServers（このユーザーのグローバル設定）
 *   local:   ~/.claude.json projects.<cwd>.mcpServers（プロジェクト×ユーザー）
 */
function detectMcpScopes(cwd: string): ScopeMap {
	const map: ScopeMap = {
		project: new Set(),
		user: new Set(),
		local: new Set(),
	};

	try {
		const projectPath = path.join(cwd, ".mcp.json");
		if (fs.existsSync(projectPath)) {
			const data = JSON.parse(fs.readFileSync(projectPath, "utf8"));
			for (const name of Object.keys(data?.mcpServers ?? {})) {
				map.project.add(name);
			}
		}
	} catch {
		/* noop — ファイル破損時はスキップ */
	}

	try {
		const userPath = path.join(os.homedir(), ".claude.json");
		if (fs.existsSync(userPath)) {
			const data = JSON.parse(fs.readFileSync(userPath, "utf8"));
			for (const name of Object.keys(data?.mcpServers ?? {})) {
				map.user.add(name);
			}
			const projectEntry = data?.projects?.[cwd];
			if (projectEntry?.mcpServers) {
				for (const name of Object.keys(projectEntry.mcpServers)) {
					map.local.add(name);
				}
			}
		}
	} catch {
		/* noop — ファイル破損時はスキップ */
	}

	return map;
}

function lookupScope(name: string, scopes: ScopeMap): McpScope {
	// project が user を上書きする（claude 本体も同じ優先順位で解決する）。
	if (scopes.project.has(name)) return "project";
	if (scopes.local.has(name)) return "local";
	if (scopes.user.has(name)) return "user";
	if (name.startsWith("claude.ai ")) return "claude.ai";
	return "unknown";
}

function scopeTooltip(scope: McpScope): string {
	switch (scope) {
		case "project":
			return t("slash.mcp.scopeTooltipProject");
		case "local":
			return t("slash.mcp.scopeTooltipLocal");
		case "user":
			return t("slash.mcp.scopeTooltipUser");
		case "claude.ai":
			return t("slash.mcp.scopeTooltipClaudeAi");
		default:
			return t("slash.mcp.scopeTooltipUnknown");
	}
}

function showMcpStatus(ctx: SlashContext): void {
	const cwd = ctx.getVaultPath();
	if (!cwd) {
		ctx.appendSystemMessage(t("slash.vaultPathUnresolved"));
		return;
	}

	const scopes = detectMcpScopes(cwd);

	let resultArea: HTMLElement | null = null;

	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.mcp.title"),
		});
		resultArea = c.createDiv({ cls: "claude-panel-sys-block" });
		resultArea.createEl("div", {
			cls: "claude-panel-sys-note",
			text: t("slash.mcp.checking"),
		});
	});

	// `claude mcp list` 完了で初期描画より縦が伸びるため、結果反映後に
	// メッセージリストを最下部へ寄せる。`appendInteractive` 時点の
	// 自動スクロールでは「checking…」分しかカバーされない。
	const scrollToBottom = (): void => {
		const messagesEl = resultArea?.closest(
			".claude-panel-messages"
		) as HTMLElement | null;
		if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
	};

	void listMcpServers(ctx.plugin.settings, cwd)
		.then((result) => {
			if (!resultArea) return;
			resultArea.empty();
			renderMcpListOutput(
				resultArea,
				result.stdout,
				result.stderr,
				result.exitCode,
				scopes
			);
			scrollToBottom();
		})
		.catch((err) => {
			if (!resultArea) return;
			resultArea.empty();
			resultArea.createEl("div", {
				cls: "claude-panel-sys-note",
				text: t("slash.mcp.error", (err as Error).message),
			});
			scrollToBottom();
		});
}

/**
 * `/plugin [...args]` を `claude plugin [...args]` に転送する薄いラッパ。
 * 引数なしのときは `list` を補う。REPL モードの `/plugin` は --print では
 * 動かないため、ここで自前のサブプロセスとして起動して結果を pre で描画。
 */
function handlePluginCommand(ctx: SlashContext, arg: string): void {
	const cwd = ctx.getVaultPath();
	if (!cwd) {
		ctx.appendSystemMessage(t("slash.vaultPathUnresolved"));
		return;
	}

	const pluginArgs = arg.trim() ? arg.trim().split(/\s+/) : ["list"];
	const display = pluginArgs.join(" ");

	let resultArea: HTMLElement | null = null;

	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: t("slash.plugin.title", display),
		});
		resultArea = c.createDiv({ cls: "claude-panel-sys-block" });
		resultArea.createEl("div", {
			cls: "claude-panel-sys-note",
			text: t("slash.plugin.running", display),
		});
	});

	const scrollToBottom = (): void => {
		const messagesEl = resultArea?.closest(
			".claude-panel-messages"
		) as HTMLElement | null;
		if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
	};

	void runClaudeSubcommand(ctx.plugin.settings, cwd, [
		"plugin",
		...pluginArgs,
	])
		.then((result) => {
			if (!resultArea) return;
			resultArea.empty();
			renderPluginOutput(
				resultArea,
				result.stdout,
				result.stderr,
				result.exitCode
			);
			scrollToBottom();
		})
		.catch((err) => {
			if (!resultArea) return;
			resultArea.empty();
			resultArea.createEl("div", {
				cls: "claude-panel-sys-note",
				text: t("slash.plugin.error", (err as Error).message),
			});
			scrollToBottom();
		});
}

function renderPluginOutput(
	host: HTMLElement,
	stdout: string,
	stderr: string,
	exitCode: number
): void {
	const trimmedOut = stdout.trim();
	const trimmedErr = stderr.trim();

	if (!trimmedOut && !trimmedErr) {
		host.createEl("div", {
			cls: "claude-panel-sys-note",
			text: t("slash.plugin.emptyOutput"),
		});
		return;
	}

	if (trimmedOut) {
		const pre = host.createEl("pre", {
			cls: "claude-panel-sys-mcp-output",
		});
		pre.createEl("code", { text: trimmedOut });
	}

	if (trimmedErr) {
		host.createEl("div", {
			cls: "claude-panel-sys-subtitle",
			text: "stderr",
		});
		const pre = host.createEl("pre", {
			cls: "claude-panel-sys-mcp-output",
		});
		pre.createEl("code", { text: trimmedErr });
	}

	if (exitCode !== 0) {
		host.createEl("div", {
			cls: "claude-panel-sys-note",
			text: t("slash.plugin.exitCode", exitCode),
		});
	}
}

interface ParsedMcpServer {
	name: string;
	target: string;
	connected: boolean;
	statusText: string;
}

/**
 * `claude mcp list` の出力1行を以下の形式でパースする:
 *   `<name>: <command-or-url> - ✓ Connected`
 *   `<name>: <command-or-url> - ✗ Failed to connect`
 */
function parseMcpListLine(line: string): ParsedMcpServer | null {
	const match = line.match(/^(.+?):\s+(.+?)\s+-\s+(✓.*|✗.*)$/);
	if (!match) return null;
	const status = match[3].trim();
	return {
		name: match[1].trim(),
		target: match[2].trim(),
		connected: status.startsWith("✓"),
		statusText: status,
	};
}

function renderMcpListOutput(
	host: HTMLElement,
	stdout: string,
	stderr: string,
	exitCode: number,
	scopes: ScopeMap
): void {
	const trimmedOut = stdout.trim();
	const trimmedErr = stderr.trim();

	if (!trimmedOut && !trimmedErr) {
		host.createEl("div", {
			cls: "claude-panel-sys-note",
			text: t("slash.mcp.emptyOutput"),
		});
		return;
	}

	const parsed: ParsedMcpServer[] = [];
	const unparsed: string[] = [];
	for (const line of trimmedOut.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		// 先頭の "Checking MCP server health…" ヘルスチェック行はスキップ。
		if (/^Checking/i.test(t)) continue;
		const p = parseMcpListLine(t);
		if (p) parsed.push(p);
		else unparsed.push(t);
	}

	if (parsed.length > 0) {
		const list = host.createDiv({ cls: "claude-panel-mcp-list" });
		const okCount = parsed.filter((p) => p.connected).length;
		host.insertBefore(
			Object.assign(activeDocument.createElement("div"), {
				className: "claude-panel-sys-note",
				textContent: t(
					"slash.mcp.connectedCount",
					okCount,
					parsed.length
				),
			}),
			list
		);
		for (const server of parsed) {
			const scope = lookupScope(server.name, scopes);
			const row = list.createDiv({
				cls:
					"claude-panel-mcp-row " +
					(server.connected ? "is-ok" : "is-fail"),
			});
			row.createSpan({
				cls: "claude-panel-mcp-status",
				text: server.connected ? "✓" : "✗",
			});
			row.createSpan({
				cls: `claude-panel-mcp-scope claude-panel-mcp-scope-${scope.replace(".", "-")}`,
				text: scope,
				attr: { title: scopeTooltip(scope) },
			});
			row.createSpan({
				cls: "claude-panel-mcp-name",
				text: server.name,
			});
			row.createSpan({
				cls: "claude-panel-mcp-target",
				text: server.target,
				attr: { title: server.target },
			});
		}
	}

	if (unparsed.length > 0) {
		const pre = host.createEl("pre", {
			cls: "claude-panel-sys-mcp-output",
		});
		pre.createEl("code", { text: unparsed.join("\n") });
	}

	if (trimmedErr) {
		host.createEl("div", {
			cls: "claude-panel-sys-subtitle",
			text: "stderr",
		});
		const pre = host.createEl("pre", {
			cls: "claude-panel-sys-mcp-output",
		});
		pre.createEl("code", { text: trimmedErr });
	}

	if (exitCode !== 0) {
		host.createEl("div", {
			cls: "claude-panel-sys-note",
			text: t("slash.mcp.exitCode", exitCode),
		});
	}
}
