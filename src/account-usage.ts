import { App, Modal, Notice, requestUrl } from "obsidian";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClaudePanelSettings } from "./settings";
import { resolveClaudePath } from "./agent";

// `claude auth status --json` の出力をそのまま受ける型。
export interface AuthStatus {
	loggedIn: boolean;
	authMethod?: string;
	apiProvider?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
	subscriptionType?: string;
}

// /api/oauth/usage から返るレートリミットウィンドウ1つ分。
export interface UsageWindow {
	utilization: number;
	resets_at: string | null;
}

// /api/oauth/usage が返すフィールドのうち本プラグインで表示するサブセット。
// エンドポイント自体は extra_usage / cowork / oauth_apps なども返すが、
// それらは VS Code 拡張側でも表示されていないので扱わない。
export interface UsageData {
	five_hour?: UsageWindow | null;
	seven_day?: UsageWindow | null;
	seven_day_opus?: UsageWindow | null;
	seven_day_sonnet?: UsageWindow | null;
}

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

/**
 * `claude auth status --json` を実行して結果をパースする。Account セクションの
 * 表示に使用する。CLI が出力する正規化済み JSON を受け取れるので、ログイン
 * 方式ごとに異なる on-disk 設定ファイルを自前で読む必要がない。
 */
export function fetchAuthStatus(
	settings: ClaudePanelSettings
): Promise<AuthStatus> {
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
		execFile(
			claudePath,
			["auth", "status", "--json"],
			{ timeout: 8000, windowsHide: true },
			(err, stdout) => {
				if (err) {
					reject(err);
					return;
				}
				try {
					const data = JSON.parse(stdout) as AuthStatus;
					resolve(data);
				} catch (e) {
					reject(
						new Error(
							`認証ステータスの JSON を解析できません: ${(e as Error).message}`
						)
					);
				}
			}
		);
	});
}

interface KeychainOauth {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

/**
 * Claude Code の OAuth アクセストークンを読み出す。保存場所は OS 依存:
 *   - macOS: Keychain（汎用パスワード "Claude Code-credentials"）
 *   - Linux / Windows: ~/.claude/.credentials.json
 *
 * トークンが見つからない場合は null を返す（"未ログイン" として扱う）。
 */
function readOAuthToken(): Promise<string | null> {
	return new Promise((resolve) => {
		// Linux / Windows / 最初のフォールバック先: プレーン JSON ファイル。
		const jsonPath = path.join(os.homedir(), ".claude", ".credentials.json");
		try {
			if (fs.existsSync(jsonPath)) {
				const raw = fs.readFileSync(jsonPath, "utf8");
				const data = JSON.parse(raw) as { claudeAiOauth?: KeychainOauth };
				const token = data?.claudeAiOauth?.accessToken;
				if (typeof token === "string" && token.length > 0) {
					resolve(token);
					return;
				}
			}
		} catch {
			/* プラットフォーム固有のストレージにフォールバック */
		}

		if (isMac) {
			execFile(
				"security",
				["find-generic-password", "-s", "Claude Code-credentials", "-w"],
				{ timeout: 5000, windowsHide: true },
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					try {
						const data = JSON.parse(stdout) as {
							claudeAiOauth?: KeychainOauth;
						};
						const token = data?.claudeAiOauth?.accessToken;
						resolve(typeof token === "string" ? token : null);
					} catch {
						resolve(null);
					}
				}
			);
			return;
		}

		// Windows では公式 CLI が wincred 経由で Credential Manager を
		// 使うが、そこへのシェルアウトは行わない。"未ログイン" として
		// フォールバックし、ユーザーには `claude auth login` を再実行して
		// CLI に ~/.claude/.credentials.json を書き直させるよう促す。
		resolve(null);
	});
}

/**
 * Anthropic OAuth API からレートリミット使用状況をリアルタイム取得する。
 * これは VS Code 拡張の "Account & Usage" ポップオーバーが叩いているのと
 * 同じエンドポイント。ネットワーク／認証エラーは例外として上位に伝播させ、
 * 呼び出し元で UI に表示する。
 */
export async function fetchUsage(): Promise<UsageData> {
	const token = await readOAuthToken();
	if (!token) {
		throw new Error(
			"Claude Code にサインインしていません。ターミナルで `claude /login` を実行してください。"
		);
	}
	// `anthropic-beta: oauth-2025-04-20` ヘッダーが必須。これがないと
	// 有効な OAuth トークンを送っても 401 が返る（CLI 本体もこの
	// 呼び出しで同じヘッダーを送っている）。
	const res = await requestUrl({
		url: "https://api.anthropic.com/api/oauth/usage",
		method: "GET",
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
			"anthropic-beta": "oauth-2025-04-20",
		},
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(humanizeUsageError(res.status, res.text));
	}
	return res.json as UsageData;
}

function humanizeUsageError(status: number, body: string): string {
	if (status === 401 || status === 403) {
		return `Anthropic API が HTTP ${status} を返しました。OAuth トークンの有効期限が切れている可能性があります — ターミナルで \`claude /login\` を実行して更新してください。`;
	}
	if (status === 429) {
		// レスポンスボディに retry-after のヒントがあれば取り出して表示する。
		const retry = extractRetryHint(body);
		const suffix = retry ? ` ${retry}` : " 少し待ってから「更新」をクリックしてください。";
		return `Anthropic API のレート制限に達しました (HTTP 429)。${suffix}`;
	}
	if (status >= 500) {
		return `Anthropic API のサーバエラー (HTTP ${status})。しばらくしてから再試行してください。`;
	}
	return `Anthropic API が HTTP ${status} を返しました。`;
}

function extractRetryHint(body: string): string | null {
	if (!body) return null;
	try {
		const parsed = JSON.parse(body) as {
			error?: { message?: string };
		};
		const msg = parsed?.error?.message;
		if (typeof msg === "string" && msg.length > 0) return msg;
	} catch {
		/* JSON でない場合はそのまま null を返す */
	}
	return null;
}

// ============================================================
//   Modal
// ============================================================

export class AccountUsageModal extends Modal {
	private settings: ClaudePanelSettings;
	private bodyEl!: HTMLDivElement;

	constructor(app: App, settings: ClaudePanelSettings) {
		super(app);
		this.settings = settings;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("claude-panel-account-modal");
		contentEl.empty();
		contentEl.createEl("h3", {
			text: "アカウントと使用状況",
			cls: "claude-panel-account-title",
		});
		this.bodyEl = contentEl.createDiv({
			cls: "claude-panel-account-body",
		});
		this.renderLoading();
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderLoading(): void {
		this.bodyEl.empty();
		this.bodyEl.createDiv({
			cls: "claude-panel-account-loading",
			text: "読み込み中…",
		});
	}

	private async load(): Promise<void> {
		const results = await Promise.allSettled([
			fetchAuthStatus(this.settings),
			fetchUsage(),
		]);
		this.bodyEl.empty();

		const authResult = results[0];
		const usageResult = results[1];

		// アカウントセクション
		const accountSection = this.bodyEl.createDiv({
			cls: "claude-panel-account-section",
		});
		accountSection.createDiv({
			cls: "claude-panel-account-section-label",
			text: "アカウント",
		});
		if (authResult.status === "fulfilled" && authResult.value.loggedIn) {
			renderAuthRows(accountSection, authResult.value);
		} else {
			const note = accountSection.createDiv({
				cls: "claude-panel-account-note",
			});
			note.setText(
				authResult.status === "rejected"
					? `認証ステータスを取得できません: ${authResult.reason?.message ?? authResult.reason}`
					: "サインインしていません。ターミナルで `claude /login` を実行してください。"
			);
		}

		// 使用状況セクション
		const usageSection = this.bodyEl.createDiv({
			cls: "claude-panel-account-section",
		});
		usageSection.createDiv({
			cls: "claude-panel-account-section-label",
			text: "使用状況",
		});
		if (usageResult.status === "fulfilled") {
			renderUsageRows(usageSection, usageResult.value);
		} else {
			const note = usageSection.createDiv({
				cls: "claude-panel-account-note",
			});
			note.setText(
				`使用状況を取得できません: ${usageResult.reason?.message ?? usageResult.reason}`
			);
		}

		// フッターリンク
		const footer = this.bodyEl.createDiv({
			cls: "claude-panel-account-footer",
		});
		const link = footer.createEl("a", {
			text: "claude.ai で使用状況を管理",
			href: "https://claude.ai/settings/usage",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");

		const refreshBtn = footer.createEl("button", {
			text: "更新",
			cls: "claude-panel-account-refresh",
		});
		refreshBtn.onclick = () => {
			this.renderLoading();
			void this.load();
		};
	}
}

function renderAuthRows(host: HTMLElement, status: AuthStatus): void {
	const grid = host.createDiv({ cls: "claude-panel-account-grid" });
	const rows: [string, string | undefined][] = [
		["認証方式", formatAuthMethod(status.authMethod)],
		["メール", status.email],
		["組織", status.orgName],
		["プラン", formatPlan(status.subscriptionType)],
	];
	for (const [label, value] of rows) {
		if (!value) continue;
		const row = grid.createDiv({ cls: "claude-panel-account-row" });
		row.createSpan({
			cls: "claude-panel-account-row-label",
			text: label,
		});
		row.createSpan({
			cls: "claude-panel-account-row-value",
			text: value,
		});
	}
}

function renderUsageRows(host: HTMLElement, data: UsageData): void {
	const items: [string, UsageWindow | null | undefined][] = [
		["セッション（5時間）", data.five_hour],
		["週間（7日）", data.seven_day],
		["週間 Opus", data.seven_day_opus],
		["週間 Sonnet", data.seven_day_sonnet],
	];
	let rendered = 0;
	for (const [label, win] of items) {
		if (!win) continue;
		renderUsageRow(host, label, win);
		rendered++;
	}
	if (rendered === 0) {
		host.createDiv({
			cls: "claude-panel-account-note",
			text: "使用状況データはありません。",
		});
	}
}

function renderUsageRow(
	host: HTMLElement,
	label: string,
	win: UsageWindow
): void {
	const row = host.createDiv({ cls: "claude-panel-usage-row" });
	const head = row.createDiv({ cls: "claude-panel-usage-head" });
	head.createSpan({
		cls: "claude-panel-usage-label",
		text: label,
	});
	const pct = clamp(win.utilization, 0, 100);
	head.createSpan({
		cls: "claude-panel-usage-pct",
		text: `${Math.round(pct)}%`,
	});
	const bar = row.createDiv({ cls: "claude-panel-usage-bar" });
	const fill = bar.createDiv({
		cls:
			"claude-panel-usage-bar-fill" +
			(pct >= 85
				? " is-danger"
				: pct >= 60
					? " is-warn"
					: ""),
	});
	fill.style.width = `${pct.toFixed(2)}%`;
	const reset = formatResetsIn(win.resets_at);
	if (reset) {
		row.createDiv({
			cls: "claude-panel-usage-reset",
			text: reset,
		});
	}
}

function clamp(n: number, min: number, max: number): number {
	if (Number.isNaN(n)) return min;
	return Math.max(min, Math.min(max, n));
}

function formatAuthMethod(method: string | undefined): string | undefined {
	if (!method) return undefined;
	if (method === "claude.ai") return "Claude AI";
	return method;
}

function formatPlan(sub: string | undefined): string | undefined {
	if (!sub) return undefined;
	switch (sub) {
		case "max":
			return "Claude Max";
		case "pro":
			return "Claude Pro";
		case "team":
			return "Claude Team";
		case "free":
			return "Free";
		default:
			return sub.charAt(0).toUpperCase() + sub.slice(1);
	}
}

function formatResetsIn(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const reset = Date.parse(iso);
	if (!Number.isFinite(reset)) return null;
	const ms = reset - Date.now();
	if (ms <= 0) return "まもなくリセット";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} 分後にリセット`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 時間後にリセット`;
	const days = Math.floor(hours / 24);
	return `${days} 日後にリセット`;
}

export function openAccountUsageModal(
	app: App,
	settings: ClaudePanelSettings
): void {
	try {
		new AccountUsageModal(app, settings).open();
	} catch (err) {
		new Notice(
			`「アカウントと使用状況」を開けません: ${(err as Error).message}`
		);
	}
}
