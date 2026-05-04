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

export interface SlashContext {
	plugin: ClaudePanelPlugin;
	getVaultPath: () => string | null;
	clearConversation: () => void;
	refreshControls: () => void;
	appendSystemMessage: (text: string) => void;
	appendInteractive: (render: (c: HTMLElement) => void) => void;
	openAccountUsage: () => void;
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
			ctx.openAccountUsage();
			return true;
		case "/login":
			ctx.appendSystemMessage(
				[
					"**`/login` はインタラクティブモード専用です。**",
					"",
					"ターミナルを開いて以下を実行してください:",
					"",
					"```",
					"claude /login",
					"```",
				].join("\n")
			);
			return true;
		default:
			return false;
	}
}

function showHelp(ctx: SlashContext): void {
	ctx.appendInteractive((c) => {
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: "ローカルコマンド",
		});
		const list = c.createEl("ul", { cls: "claude-panel-sys-list" });
		const items: [string, string][] = [
			["/clear", "会話をクリア"],
			["/help", "このヘルプを表示"],
			["/model [id]", "モデルの表示 / 変更"],
			["/think [mode]", "思考深度の表示 / 変更"],
			["/mcp", "設定済みの MCP サーバを表示"],
			["/usage", "アカウント情報とレート制限の使用状況を表示"],
			["/login", "ターミナルからログインする方法を表示"],
		];
		for (const [name, desc] of items) {
			const li = list.createEl("li");
			li.createEl("code", { text: name });
			li.createSpan({ text: ` — ${desc}` });
		}
		c.createEl("div", {
			cls: "claude-panel-sys-title",
			text: "パススルー（Claude Code CLI に転送）",
		});
		const note = c.createEl("div", { cls: "claude-panel-sys-note" });
		note.setText(
			"上記以外の /コマンドはそのまま CLI に --print モードで渡されます。" +
				".claude/commands/*.md で定義したユーザーコマンドも動作します。" +
				"注意: REPL 専用のコマンド（/login, /init, /mcp wizard など）は print モードでは動かない場合があります。"
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
