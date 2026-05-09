import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClaudePanelSettings } from "./settings";
import { buildEnv, needsShell, resolveClaudePath } from "./cli-resolver";

interface UsageInfo {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
}

/** view 側の承認 UI から返される判定結果。SDK の PermissionResult の形状に
 *  そろえているため、変換層を挟まずに control_response にそのまま
 *  シリアライズできる。 */
export type PermissionDecision =
	| { allow: true; updatedInput?: Record<string, unknown> }
	| { allow: false; message?: string; interrupt?: boolean };

export interface PermissionRequest {
	toolName: string;
	input: Record<string, unknown>;
	toolUseId: string;
	reason?: string;
}

interface AgentEvents {
	onText: (chunk: string) => void;
	onToolUse: (name: string, input: unknown) => void;
	onResult: (info: {
		durationMs: number;
		costUsd?: number;
		sessionId?: string;
	}) => void;
	onError: (err: Error) => void;
	onUsage?: (usage: UsageInfo) => void;
	/** CLI がツール実行のパーミッションを要求した際に発火する。view 側は
	 *  最終的に `decide(...)`（allow か deny）を呼ぶ必要がある。判定前に
	 *  ラン全体がキャンセルされた場合、`decide` は no-op になる。 */
	onPermissionRequest?: (
		req: PermissionRequest,
		decide: (decision: PermissionDecision) => void
	) => void;
	/** Claude が API 応答ヘッダから抽出したレートリミット情報。
	 *  `claude --print` の stream-json に `type: "rate_limit_event"` として
	 *  出てくる。最低限 `resetsAt` と `rateLimitType` は必ず含まれ、閾値
	 *  超過時には `utilization`（0.0〜1.0）も入る。 */
	onRateLimit?: (info: RateLimitInfo) => void;
}

/**
 * `claude --print` が stream-json で吐く rate_limit_event の中身。
 * 値の有無はラン時の状態に依存（utilization は 75/90/95% 閾値超過時のみ）。
 */
export interface RateLimitInfo {
	rateLimitType: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage" | string;
	/** unix epoch 秒。Anthropic 側がリセットする時刻。 */
	resetsAt: number;
	/** "allowed" | "allowed_warning" | "blocked" など。 */
	status: string;
	/** 0.0〜1.0。閾値超過時のみ含まれる。 */
	utilization?: number;
	overageStatus?: string;
	overageDisabledReason?: string;
	isUsingOverage?: boolean;
	surpassedThreshold?: number;
}

interface RunArgs {
	prompt: string;
	cwd: string;
	settings: ClaudePanelSettings;
	/** 指定された場合、claude は当該セッションを `--resume` で継続する。
	 *  undefined を渡すと新規セッション開始 — claude が result イベントで
	 *  新しい session_id を返すので、呼び出し側が以降のターン用に保持する。 */
	sessionId?: string;
	/** true のとき、`--continue` を付けて cwd における直近セッションを再開
	 *  する。`sessionId` が指定されている場合はそちらが優先される。
	 *  Obsidian 再起動後にユーザーが `/resume` を打って前回会話を拾うために
	 *  使う。 */
	continueLast?: boolean;
}

// Claude Code の組み込みシステムプロンプトに `--append-system-prompt` で
// 追記する文字列。ユーザー編集不可（ハードコード）にすることで、アシスタント
// が常に「Obsidian Vault 内で動作している」ことを認識し、MCP ツールを
// 積極的に呼ばないよう強制している。
const SYSTEM_PROMPT_APPENDIX =
	"You are an AI collaborator embedded in the user's Obsidian vault. " +
	"The vault is your working directory. Help the user write, organize, and " +
	"reason about their notes. Prefer concise edits." +
	"\n\n[Tool usage discipline]\n" +
	"Do NOT proactively invoke MCP tools (mcp__*). " +
	"Use MCP tools ONLY when the user explicitly asks for the corresponding capability " +
	"(e.g. 'use serena to ...', 'search the web with ...', 'check via mcp ...'). " +
	"For routine vault edits, prefer built-in Read/Edit/Write/Glob/Grep/Bash. " +
	"Never call MCP tools just to inspect or 'see what's available'.";

let _emptyMcpConfigPath: string | null = null;
function getEmptyMcpConfigPath(): string {
	if (_emptyMcpConfigPath && fs.existsSync(_emptyMcpConfigPath)) {
		return _emptyMcpConfigPath;
	}
	const p = path.join(os.tmpdir(), "claude-panel-empty-mcp.json");
	try {
		fs.writeFileSync(p, '{"mcpServers":{}}\n', "utf8");
	} catch {
		/* noop — エラーは spawn 側で表面化させる */
	}
	_emptyMcpConfigPath = p;
	return p;
}

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
}

interface RawUsage {
	input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	output_tokens?: number;
}

function normalizeUsage(u: RawUsage): UsageInfo {
	return {
		inputTokens: u.input_tokens ?? 0,
		cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
		cacheReadTokens: u.cache_read_input_tokens ?? 0,
		outputTokens: u.output_tokens ?? 0,
	};
}

interface AssistantStreamMessage {
	type: "assistant";
	message: { content: ContentBlock[]; usage?: RawUsage };
}

interface ResultStreamMessage {
	type: "result";
	subtype?: string;
	duration_ms: number;
	total_cost_usd?: number;
	usage?: RawUsage;
	session_id?: string;
	is_error?: boolean;
	errors?: string[];
}

interface ControlRequestMessage {
	type: "control_request";
	request_id: string;
	request: {
		subtype: string;
		tool_name?: string;
		input?: Record<string, unknown>;
		tool_use_id?: string;
		decision_reason?: string;
		blocked_path?: string;
		[key: string]: unknown;
	};
}

interface ControlResponseMessage {
	type: "control_response";
	response: {
		subtype: "success" | "error";
		request_id: string;
		response?: Record<string, unknown>;
		error?: string;
	};
}

type StreamMessage =
	| AssistantStreamMessage
	| ResultStreamMessage
	| ControlRequestMessage
	| ControlResponseMessage
	| { type: string; [key: string]: unknown };

interface StreamCallbacks {
	events: AgentEvents;
	onControlRequest: (msg: ControlRequestMessage) => void;
	onControlResponse: (msg: ControlResponseMessage) => void;
}

function handleStreamLine(line: string, cb: StreamCallbacks): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed: StreamMessage;
	try {
		parsed = JSON.parse(trimmed) as StreamMessage;
	} catch {
		return;
	}
	const events = cb.events;
	if (parsed.type === "assistant") {
		const msg = parsed as AssistantStreamMessage;
		if (msg.message?.usage) {
			events.onUsage?.(normalizeUsage(msg.message.usage));
		}
		for (const block of msg.message?.content ?? []) {
			if (block.type === "text" && typeof block.text === "string") {
				events.onText(block.text);
			} else if (block.type === "tool_use" && typeof block.name === "string") {
				events.onToolUse(block.name, block.input);
			}
		}
	} else if (parsed.type === "rate_limit_event") {
		// `claude --print` は API 応答ヘッダから抽出した rate limit を
		// stream に流してくる。utilization は閾値超過時のみ含まれるが、
		// resetsAt は常に含まれる。これは API への追加コール無しで取れる
		// 「無料の」最新値なので、ステータスバー側でキャッシュ更新に使う。
		const info = (parsed as { rate_limit_info?: RateLimitInfo })
			.rate_limit_info;
		if (info && typeof info.rateLimitType === "string") {
			events.onRateLimit?.(info);
		}
	} else if (parsed.type === "result") {
		const r = parsed as ResultStreamMessage;
		if (r.usage) {
			events.onUsage?.(normalizeUsage(r.usage));
		}
		// CLI が is_error で終了するケース（例: stale な --resume セッション ID
		// → "No conversation found with session ID: ..."）。エラーは stderr では
		// なく stream-json の result メッセージで返ってくるため、ここで取り出して
		// onError へ転送し、view 側のリトライロジックを起動できるようにする。
		if (r.is_error) {
			const detail =
				(r.errors && r.errors.length > 0
					? r.errors.join("; ")
					: r.subtype) || "error_during_execution";
			events.onError(new Error(detail));
		}
		events.onResult({
			durationMs: r.duration_ms,
			costUsd: r.total_cost_usd,
			sessionId: r.session_id,
		});
	} else if (parsed.type === "control_request") {
		cb.onControlRequest(parsed as ControlRequestMessage);
	} else if (parsed.type === "control_response") {
		cb.onControlResponse(parsed as ControlResponseMessage);
	}
	// `keep_alive`, `system`, `partial` などは無視する。
}

function randomRequestId(): string {
	return Math.random().toString(36).slice(2, 15);
}

export interface RunHandle {
	promise: Promise<void>;
	cancel: () => void;
	canceled: () => boolean;
}

interface McpListResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * セットアップ画面で表示する `claude` CLI の状態。
 *
 * - `installed: false` の場合、CLI バイナリ自体が見つかっていない。
 * - `installed: true` で `loggedIn: false` の場合、CLI はあるがログイン
 *   セッションが無い（`claude auth status --json` が `loggedIn: false`
 *   を返したか、パースに失敗した）。
 * - `installed: true` で `loggedIn: true` の場合、即利用可能。
 */
export interface CliStatus {
	installed: boolean;
	resolvedPath?: string;
	version?: string;
	loggedIn?: boolean;
	email?: string;
	authMethod?: string;
	subscriptionType?: string;
	/** 何かが想定外に失敗したときの一行サマリ。表示用。 */
	error?: string;
}

/**
 * `claude --version` と `claude auth status --json` を順に呼んで
 * セットアップタブに出すための状態を組み立てる。タイムアウトは短め
 * （5 秒）で、失敗した場合も resolve（reject しない）。常に「現在の
 * 表示用スナップショット」を返したいため。
 */
export function checkClaudeCli(configured: string): Promise<CliStatus> {
	return new Promise((resolve) => {
		const claudePath = resolveClaudePath(configured);
		if (!claudePath) {
			resolve({ installed: false });
			return;
		}
		const exec = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
			new Promise((done) => {
				try {
					const child = spawn(claudePath, args, {
						env: buildEnv(claudePath),
						stdio: ["ignore", "pipe", "pipe"],
						shell: needsShell(claudePath),
					});
					let stdout = "";
					let stderr = "";
					child.stdout?.setEncoding("utf8");
					child.stderr?.setEncoding("utf8");
					child.stdout?.on("data", (c: string) => (stdout += c));
					child.stderr?.on("data", (c: string) => (stderr += c));
					const timer = setTimeout(() => {
						try {
							child.kill();
						} catch {
							/* noop */
						}
						done({ code: -1, stdout, stderr: stderr || "timeout" });
					}, 5000);
					child.on("error", (err: Error) => {
						clearTimeout(timer);
						done({ code: -1, stdout, stderr: err.message });
					});
					child.on("close", (code: number | null) => {
						clearTimeout(timer);
						done({ code: code ?? -1, stdout, stderr });
					});
				} catch (err) {
					done({ code: -1, stdout: "", stderr: (err as Error).message });
				}
			});

		void (async () => {
			const ver = await exec(["--version"]);
			if (ver.code !== 0) {
				resolve({
					installed: false,
					resolvedPath: claudePath,
					error: (ver.stderr || ver.stdout || "").trim().slice(0, 200) ||
						`exit code ${ver.code}`,
				});
				return;
			}
			const version = ver.stdout.trim();

			const auth = await exec(["auth", "status", "--json"]);
			if (auth.code !== 0) {
				resolve({
					installed: true,
					resolvedPath: claudePath,
					version,
					loggedIn: false,
				});
				return;
			}
			try {
				const data = JSON.parse(auth.stdout) as {
					loggedIn?: boolean;
					email?: string;
					authMethod?: string;
					subscriptionType?: string;
				};
				resolve({
					installed: true,
					resolvedPath: claudePath,
					version,
					loggedIn: !!data.loggedIn,
					email: data.email,
					authMethod: data.authMethod,
					subscriptionType: data.subscriptionType,
				});
			} catch {
				resolve({
					installed: true,
					resolvedPath: claudePath,
					version,
					loggedIn: false,
				});
			}
		})();
	});
}

/**
 * `claude mcp list` を実行して出力をキャプチャする。設定ファイルを直接
 * 読むのと違い、CLI から見た各 MCP サーバの *実際の* 接続ステータスを
 * 取得できる。
 */
export function listMcpServers(
	settings: ClaudePanelSettings,
	cwd: string
): Promise<McpListResult> {
	return new Promise((resolve, reject) => {
		const claudePath = resolveClaudePath(settings.claudePath);
		if (!claudePath) {
			reject(
				new Error(
					"`claude` CLI が見つかりません。プラグイン設定で絶対パスを指定してください。"
				)
			);
			return;
		}
		try {
			const child = spawn(claudePath, ["mcp", "list"], {
				cwd,
				env: buildEnv(claudePath),
				stdio: ["ignore", "pipe", "pipe"],
				shell: needsShell(claudePath),
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (c: string) => {
				stdout += c;
			});
			child.stderr?.on("data", (c: string) => {
				stderr += c;
			});
			child.on("error", reject);
			child.on("close", (code) => {
				resolve({ stdout, stderr, exitCode: code ?? -1 });
			});
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

export function runAgent(args: RunArgs, events: AgentEvents): RunHandle {
	const { prompt, cwd, settings } = args;
	let canceled = false;
	let child: ReturnType<typeof spawn> | null = null;
	// view へ転送済みかつ判定が戻っていない CLI パーミッションリクエスト。
	// cancel 後の遅延判定をショートサーキットするために使う（閉じた stdin
	// に書くと例外になるため）。
	const pendingPermissions = new Set<string>();

	const promise = new Promise<void>((resolve) => {
		const claudePath = resolveClaudePath(settings.claudePath);
		if (!claudePath) {
			events.onError(
				new Error(
					"`claude` CLI が見つかりません。プラグイン設定で絶対パスを指定してください。"
				)
			);
			resolve();
			return;
		}

		const cliArgs = [
			"--output-format",
			"stream-json",
			"--input-format",
			"stream-json",
			"--verbose",
			"--permission-mode",
			settings.permissionMode,
			"--model",
			settings.model,
		];
		// CLI に対して、can_use_tool リクエストをインラインの TTY プロンプト
		// ではなく stdout（stream-json の制御プロトコル）で発行するよう指示する。
		// 全モードで指定する: `default`/`acceptEdits` はインタラクティブな
		// 端末がないとみなされて edit 系以外を自動拒否されないように、
		// `bypassPermissions` でも CLI 側が稀に発行する can_use_tool（保護
		// パスへの書き込み等）を取りこぼさないように、`plan` でも将来の
		// 仕様変更で発行されたときに備えて、常に stdio で受け取る。
		cliArgs.push("--permission-prompt-tool", "stdio");
		if (args.sessionId) {
			// 既存の claude セッションを継続する。これによりコンテキストが
			// 蓄積され、ウィンドウが埋まったタイミングで CLI 側の自動
			// コンパクションが動作するようになる。
			cliArgs.push("--resume", args.sessionId);
		} else if (args.continueLast) {
			// セッション ID が手元にないが、CLI 側に残っている直近会話を
			// 拾い上げる。Obsidian 再起動後に `/resume` で前回の続きから
			// 始めるためのパス。新しい session_id は result イベント経由で
			// 受け取り、以降のターンでは sessionId 経由の `--resume` に切り替わる。
			cliArgs.push("--continue");
		}
		// `auto` のときはフラグを送らず、CLI 既定 / ~/.claude/settings.json の
		// `effortLevel` をそのまま尊重する。明示値が選ばれているときだけ
		// `--effort` で上書きする。Haiku など非対応モデルでは CLI が黙って
		// 無視するため、フラグ送信自体は安全。
		if (settings.effortLevel && settings.effortLevel !== "auto") {
			cliArgs.push("--effort", settings.effortLevel);
		}
		if (settings.disableMcpServers) {
			cliArgs.push("--strict-mcp-config", "--mcp-config", getEmptyMcpConfigPath());
		}
		cliArgs.push("--append-system-prompt", SYSTEM_PROMPT_APPENDIX);

		try {
			child = spawn(claudePath, cliArgs, {
				cwd,
				env: buildEnv(claudePath),
				// stdin もパイプにする: ユーザープロンプトおよび
				// control_response メッセージをここに書き込む。
				stdio: ["pipe", "pipe", "pipe"],
				shell: needsShell(claudePath),
			});
		} catch (err) {
			events.onError(err instanceof Error ? err : new Error(String(err)));
			resolve();
			return;
		}

		const childRef = child;

		const writeJson = (obj: unknown): void => {
			if (canceled) return;
			const line = JSON.stringify(obj) + "\n";
			try {
				childRef.stdin?.write(line);
			} catch {
				/* CLI が書き込み途中で終了。エラーは close ハンドラで表面化させる */
			}
		};

		// initialize ハンドシェイク。CLI の stream-json 入力モードは、
		// ユーザーメッセージの前にこれを要求する。これがないと
		// `--permission-prompt-tool stdio` の配線が確立されず、
		// can_use_tool リクエストが取りこぼされる。
		// 成功レスポンスを待つ必要はない（CLI は最初のアシスタントチャンク
		// 送出前に必ず ack を返してくる）。
		writeJson({
			type: "control_request",
			request_id: randomRequestId(),
			request: { subtype: "initialize" },
		});

		// ユーザープロンプトを SDKUserMessage として送る。新規セッションでは
		// session_id を空にしておき、CLI が割り当てた ID を result イベント
		// 経由で受け取る。再開セッションでは argv 側の `--resume` で継続性を
		// 担保しているので、ここでは session_id を空のまま送る。
		writeJson({
			type: "user",
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [{ type: "text", text: prompt }],
			},
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";

		const onControlRequest = (msg: ControlRequestMessage): void => {
			if (msg.request.subtype !== "can_use_tool") {
				// それ以外の control_request サブタイプ（mcp_message 等）は
				// このプロセスで管理していない状態を要求するため、CLI が
				// ハングしないよう即座に拒否で応答する。
				writeJson({
					type: "control_response",
					response: {
						subtype: "error",
						request_id: msg.request_id,
						error: `Unsupported control request: ${msg.request.subtype}`,
					},
				});
				return;
			}
			const toolUseId = msg.request.tool_use_id ?? msg.request_id;
			pendingPermissions.add(msg.request_id);

			const decide = (decision: PermissionDecision): void => {
				if (!pendingPermissions.delete(msg.request_id)) return;
				if (canceled) return;
				const response =
					decision.allow
						? {
								behavior: "allow" as const,
								updatedInput: decision.updatedInput ?? msg.request.input ?? {},
								toolUseID: toolUseId,
							}
						: {
								behavior: "deny" as const,
								message: decision.message ?? "ユーザーが拒否しました。",
								interrupt: decision.interrupt ?? false,
								toolUseID: toolUseId,
							};
				writeJson({
					type: "control_response",
					response: {
						subtype: "success",
						request_id: msg.request_id,
						response,
					},
				});
			};

			// `bypassPermissions` モードのときは UI を出さず自動承認する。
			// CLI 側でも内部的に大半は auto-allow されるが、保護パスや一部の
			// ケースでは can_use_tool が発行されるため、ここで止めずに通すと
			// 「アシスタントが『承認してください』と言うのに承認ボタンが
			// 出ない」状態になる。bypass を選択しているユーザーは介入を
			// 望まないので、即時 allow して透過にする。
			if (settings.permissionMode === "bypassPermissions") {
				decide({
					allow: true,
					updatedInput: msg.request.input ?? {},
				});
				return;
			}
			if (!events.onPermissionRequest) {
				// UI が未配線 — 落としたプロンプトで CLI が永続ハングしない
				// よう自動 deny する。
				decide({
					allow: false,
					message: "承認 UI が利用できないため拒否しました。",
				});
				return;
			}
			events.onPermissionRequest(
				{
					toolName: msg.request.tool_name ?? "(unknown)",
					input: msg.request.input ?? {},
					toolUseId,
					reason: msg.request.decision_reason,
				},
				decide
			);
		};

		const onControlResponse = (_msg: ControlResponseMessage): void => {
			// 現状こちらから能動的に control_request を送っていない
			// （initialize ハンドシェイクなしでも本プラグイン用途では CLI
			// が動作する）ため、受信する control_response は実質「何もない」
			// ack で安全に無視できる。
		};

		// 呼び出し側の onResult をラップし、最初の result 受信後に stdin を
		// 閉じる。stream-json 入力モードの CLI は追加ユーザーメッセージを
		// 待ち続けるため、stdin を閉じないとランが永遠に終わらない。
		const eventsWithEnd: AgentEvents = {
			...events,
			onResult: (info) => {
				events.onResult(info);
				try {
					childRef.stdin?.end();
				} catch {
					/* noop */
				}
			},
		};

		const callbacks: StreamCallbacks = {
			events: eventsWithEnd,
			onControlRequest,
			onControlResponse,
		};

		childRef.stdout?.setEncoding("utf8");
		childRef.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			let nl: number;
			while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
				const line = stdoutBuffer.slice(0, nl);
				stdoutBuffer = stdoutBuffer.slice(nl + 1);
				handleStreamLine(line, callbacks);
			}
		});

		childRef.stderr?.setEncoding("utf8");
		childRef.stderr?.on("data", (chunk: string) => {
			stderrBuffer += chunk;
		});

		// stdin への書き込みエラーをレンダラのクラッシュではなく agent
		// エラーとして取り扱う（そうしないと Electron が uncaught EPIPE と
		// してログに残してしまう）。
		childRef.stdin?.on("error", () => {
			/* 多くの場合 CLI が先に stdin を閉じる。無害として扱う */
		});

		childRef.on("error", (err) => {
			events.onError(err);
			resolve();
		});

		childRef.on("close", (code) => {
			if (stdoutBuffer.trim()) {
				handleStreamLine(stdoutBuffer, callbacks);
				stdoutBuffer = "";
			}
			pendingPermissions.clear();
			if (canceled) {
				resolve();
				return;
			}
			if (code !== 0 && code !== null) {
				const detail = stderrBuffer.trim() || `exit code ${code}`;
				events.onError(new Error(`claude CLI exited with ${detail}`));
			}
			resolve();
		});
	});

	const cancel = (): void => {
		if (canceled) return;
		canceled = true;
		pendingPermissions.clear();
		if (child && !child.killed) {
			try {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (child && !child.killed) {
						try {
							child.kill("SIGKILL");
						} catch {
							/* noop */
						}
					}
				}, 1500);
			} catch {
				/* noop */
			}
		}
	};

	return { promise, cancel, canceled: () => canceled };
}
