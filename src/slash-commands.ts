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
import { listMcpServers } from "./agent";
import { diagnoseSessionLookup } from "./session-history";

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
	{ name: "/clear", desc: "会話をクリア", category: "local" },
	{ name: "/continue", desc: "前回セッションを再開（履歴も復元）", category: "local" },
	{ name: "/help", desc: "コマンド一覧を表示", category: "local" },
	{ name: "/model", desc: "モデルの表示 / 変更", category: "local" },
	{ name: "/think", desc: "思考深度の表示 / 変更", category: "local" },
	{ name: "/mcp", desc: "MCP サーバの状態を表示", category: "local" },
	{ name: "/usage", desc: "アカウント・使用状況モーダル", category: "local" },
	{ name: "/cost", desc: "/usage と同じ", category: "local" },
	{ name: "/account", desc: "/usage と同じ", category: "local" },
	{ name: "/config", desc: "プラグインの設定タブを開く", category: "local" },
	{ name: "/compact", desc: "（自動圧縮の説明）", category: "local" },
	{ name: "/exit", desc: "サイドバーパネルを閉じる", category: "local" },
	{ name: "/quit", desc: "サイドバーパネルを閉じる", category: "local" },

	{ name: "/login", desc: "Claude Code にログイン", category: "repl-only" },
	{ name: "/logout", desc: "ログアウト", category: "repl-only" },
	{ name: "/agents", desc: "サブエージェント設定", category: "repl-only" },
	{ name: "/permissions", desc: "ツール許可ルール", category: "repl-only" },
	{ name: "/doctor", desc: "ヘルスチェック", category: "repl-only" },
	{ name: "/upgrade", desc: "Claude Code を更新", category: "repl-only" },
	{
		name: "/migrate-installer",
		desc: "インストール方式を移行",
		category: "repl-only",
	},
	{ name: "/release-notes", desc: "リリースノート", category: "repl-only" },
	{ name: "/bug", desc: "バグ報告", category: "repl-only" },
	{
		name: "/terminal-setup",
		desc: "ターミナル統合を設定",
		category: "repl-only",
	},
	{ name: "/vim", desc: "Vim 風キーバインドを切替", category: "repl-only" },

	{ name: "/init", desc: "CLAUDE.md を生成（CLI に転送）", category: "passthrough" },
	{
		name: "/review",
		desc: "コードレビュー（CLI に転送）",
		category: "passthrough",
	},
	{
		name: "/pr-comments",
		desc: "PR コメント取得（CLI に転送）",
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
		case "/usage":
		case "/account":
		case "/cost":
			ctx.openAccountUsage();
			return true;
		case "/config":
			ctx.openPluginSettings();
			ctx.appendSystemMessage(
				"プラグインの設定タブを開きました。モデル、Vault パス、CLI 引数などはこちらから変更できます。"
			);
			return true;
		case "/exit":
		case "/quit":
			ctx.closeView();
			return true;
		case "/login":
			showTerminalOnlyNote(ctx, "/login", "Claude Code にログインする");
			return true;
		case "/logout":
			showTerminalOnlyNote(ctx, "/logout", "Claude Code からログアウトする");
			return true;
		case "/compact":
			ctx.appendSystemMessage(
				[
					"**`/compact` はこのプラグインでは不要です。**",
					"",
					"このプラグインは `claude --print --resume` でセッションを継続しており、",
					"コンテキストウィンドウが埋まると Claude Code 側で自動的に圧縮されます。",
					"会話を完全にリセットしたい場合は `/clear` を使ってください。",
				].join("\n")
			);
			return true;
		case "/agents":
			showTerminalOnlyNote(ctx, "/agents", "サブエージェント設定を編集する");
			return true;
		case "/permissions":
			showTerminalOnlyNote(
				ctx,
				"/permissions",
				"ツール許可ルールを編集する"
			);
			return true;
		case "/doctor":
			showTerminalOnlyNote(ctx, "/doctor", "Claude Code のヘルスチェック");
			return true;
		case "/upgrade":
			showTerminalOnlyNote(ctx, "/upgrade", "Claude Code を更新する");
			return true;
		case "/migrate-installer":
			showTerminalOnlyNote(
				ctx,
				"/migrate-installer",
				"インストール方式を移行する"
			);
			return true;
		case "/release-notes":
			showTerminalOnlyNote(ctx, "/release-notes", "リリースノートを表示");
			return true;
		case "/bug":
			showTerminalOnlyNote(ctx, "/bug", "Anthropic にバグ報告する");
			return true;
		case "/terminal-setup":
			showTerminalOnlyNote(
				ctx,
				"/terminal-setup",
				"ターミナル統合を設定する"
			);
			return true;
		case "/vim":
			showTerminalOnlyNote(ctx, "/vim", "Vim 風キーバインドを切り替える");
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
		ctx.appendSystemMessage("Vault のパスを解決できません。");
		return;
	}
	const count = ctx.restoreFromLatestSession(cwd);
	if (count === 0) {
		const diag = diagnoseSessionLookup(cwd);
		ctx.appendSystemMessage(
			[
				"再開できるセッションが見つかりません。",
				"",
				"**診断:**",
				`- Vault パス: \`${diag.cwd}\``,
				`- 探索先: \`${diag.encodedDir}\``,
				`- フォルダ存在: ${diag.exists ? "はい" : "いいえ"}`,
				`- JSONL ファイル数: ${diag.jsonlCount}`,
			].join("\n")
		);
		return;
	}
	ctx.appendSystemMessage(
		`前回セッションを復元しました（メッセージ ${count} 件）。次の送信で \`--continue\` 付きで再開します。`
	);
}

function showTerminalOnlyNote(
	ctx: SlashContext,
	command: string,
	purpose: string
): void {
	ctx.appendSystemMessage(
		[
			`**\`${command}\` はインタラクティブモード（REPL）専用です。**`,
			"",
			`${purpose}には、ターミナルを開いて以下を実行してください:`,
			"",
			"```",
			`claude ${command}`,
			"```",
		].join("\n")
	);
}

function showHelp(ctx: SlashContext): void {
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: "ローカルコマンド（パネル内で完結）",
		});
		const list = c.createEl("ul", { cls: "claude-panel-sys-list" });
		const items: [string, string][] = [
			["/clear", "会話をクリア"],
			["/continue", "前回セッションを再開（UI 履歴も `~/.claude/projects/...jsonl` から復元）"],
			["/help", "このヘルプを表示"],
			["/model [id]", "モデルの表示 / 変更"],
			["/think [mode]", "思考深度の表示 / 変更"],
			["/mcp", "設定済みの MCP サーバを表示"],
			["/usage", "アカウント情報とレート制限の使用状況を表示"],
			["/cost", "/usage と同じ（セッションのコスト・トークンを表示）"],
			["/config", "プラグインの設定タブを開く"],
			["/compact", "自動圧縮の説明（このプラグインでは手動操作不要）"],
			["/exit, /quit", "サイドバーパネルを閉じる"],
		];
		for (const [name, desc] of items) {
			const li = list.createEl("li");
			li.createEl("code", { text: name });
			li.createSpan({ text: ` — ${desc}` });
		}

		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: "ターミナル案内のみ（REPL 専用コマンド）",
		});
		const replList = c.createEl("ul", { cls: "claude-panel-sys-list" });
		const replItems: [string, string][] = [
			["/login, /logout", "Claude Code の認証"],
			["/agents", "サブエージェント設定"],
			["/permissions", "ツール許可ルール"],
			["/doctor", "ヘルスチェック"],
			["/upgrade", "Claude Code 更新"],
			["/migrate-installer", "インストール方式の移行"],
			["/release-notes", "リリースノート"],
			["/bug", "Anthropic にバグ報告"],
			["/terminal-setup", "ターミナル統合設定"],
			["/vim", "Vim 風キーバインド"],
		];
		for (const [name, desc] of replItems) {
			const li = replList.createEl("li");
			li.createEl("code", { text: name });
			li.createSpan({ text: ` — ${desc}` });
		}

		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: "パススルー（Claude Code CLI に転送）",
		});
		const note = c.createEl("div", { cls: "claude-panel-sys-note" });
		note.setText(
			"上記以外の /コマンド（例: /init, /review, /pr-comments など）はそのまま CLI に --print モードで渡されます。" +
				".claude/commands/*.md で定義したユーザーコマンドも動作します。" +
				"注意: TTY を要求する REPL 専用コマンドは print モードでは動かない場合があります。"
		);
	});
}

function handleModelCommand(ctx: SlashContext, arg: string): void {
	if (arg) {
		ctx.plugin.settings.model = arg;
		void ctx.plugin.saveSettings();
		ctx.refreshControls();
		ctx.appendSystemMessage(
			`モデルを **${formatModelLabel(arg)}** に設定しました。`
		);
		return;
	}
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: `現在のモデル: ${formatModelLabel(ctx.plugin.settings.model)}`,
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
				ctx.appendSystemMessage(
					`モデルを **${formatModelLabel(m)}** に設定しました。`
				);
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
			ctx.appendSystemMessage(`思考モードを **${arg}** に設定しました。`);
		} else {
			ctx.appendSystemMessage(
				`不明な思考モード \`${arg}\`。有効な値: ${THINKING_MODES.map(
					(v) => `\`${v}\``
				).join(", ")}`
			);
		}
		return;
	}
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: `現在の思考モード: ${ctx.plugin.settings.thinkingMode}`,
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
				ctx.appendSystemMessage(`思考モードを **${mode}** に設定しました。`);
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
			return "<vault>/.mcp.json から（この Vault を編集するすべての人と共有）";
		case "local":
			return "~/.claude.json の projects.<vault>.mcpServers から（Vault ごと・このマシン限定）";
		case "user":
			return "~/.claude.json の mcpServers から（グローバル・このマシン限定）";
		case "claude.ai":
			return "Claude.ai アカウントが管理（自動提供）";
		default:
			return "ローカル設定ファイル内に出所が見つかりません";
	}
}

function showMcpStatus(ctx: SlashContext): void {
	const cwd = ctx.getVaultPath();
	if (!cwd) {
		ctx.appendSystemMessage("Vault のパスを解決できません。");
		return;
	}

	const scopes = detectMcpScopes(cwd);

	let resultArea: HTMLElement | null = null;

	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: "MCP サーバ（ライブ）",
		});
		resultArea = c.createDiv({ cls: "claude-panel-sys-block" });
		resultArea.createEl("div", {
			cls: "claude-panel-sys-note",
			text: "`claude mcp list` で接続確認中…",
		});
	});

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
		})
		.catch((err) => {
			if (!resultArea) return;
			resultArea.empty();
			resultArea.createEl("div", {
				cls: "claude-panel-sys-note",
				text: `エラー: ${(err as Error).message}`,
			});
		});
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
			text: "(`claude mcp list` からの出力はありません)",
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
			Object.assign(document.createElement("div"), {
				className: "claude-panel-sys-note",
				textContent: `${okCount} / ${parsed.length} 接続中`,
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
			text: `(終了コード ${exitCode})`,
		});
	}
}
