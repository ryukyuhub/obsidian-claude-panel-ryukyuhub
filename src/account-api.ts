import { requestUrl } from "obsidian";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClaudePanelSettings } from "./settings";
import { resolveClaudePath } from "./cli-resolver";

/**
 * Anthropic / Claude Code への API 呼び出し層。UI には依存しない純粋なデータ取得。
 * Modal 等の表示は `account-modal.ts` 側に分離している。
 */

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

/**
 * /api/oauth/usage の HTTP エラーを HTTP ステータス込みで伝える型付きエラー。
 * 呼び出し側が 429（レート制限）と他の失敗を区別したいときに使う。
 */
export class UsageFetchError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "UsageFetchError";
	}
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
 * 直近の成功 fetch 結果を保持するプロセス内キャッシュ。
 * ステータスバーとモーダルで共有することで、モーダルを開くたびに新規
 * リクエストを発射するのを避ける。Obsidian を再起動すると消える。
 */
let cachedUsage: { data: UsageData; fetchedAt: number } | null = null;

/**
 * 429 を受けた直後の再リクエスト抑制ウィンドウ。`Date.now()` がこの値を
 * 超えるまで `fetchUsage()` は実 HTTP 要求を出さず、キャッシュ済み 429
 * エラーを即時 throw する。Anthropic 側の制限が解けないうちに連打して
 * 制限を伸ばすのを防ぐ目的。
 */
let rateLimitedUntil = 0;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

export function getCachedUsage(): { data: UsageData; fetchedAt: number } | null {
	return cachedUsage;
}

/** 現在 429 バックオフ中なら解除予定時刻、そうでなければ 0。 */
export function getRateLimitedUntil(): number {
	return rateLimitedUntil;
}

/**
 * Anthropic OAuth API からレートリミット使用状況をリアルタイム取得する。
 * これは VS Code 拡張の "Account & Usage" ポップオーバーが叩いているのと
 * 同じエンドポイント。ネットワーク／認証エラーは例外として上位に伝播させ、
 * 呼び出し元で UI に表示する。
 *
 * 直近で 429 を受けている間は HTTP 要求を出さず、即座に同じ 429 を
 * 投げ返す（再連打で制限を伸ばさないため）。成功時はキャッシュ更新と
 * バックオフ解除を行う。
 */
export async function fetchUsage(): Promise<UsageData> {
	if (Date.now() < rateLimitedUntil) {
		throw new UsageFetchError(
			humanizeUsageError(429, ""),
			429
		);
	}
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
		if (res.status === 429) {
			const hint = parseRetryAfter(res);
			rateLimitedUntil = Date.now() + (hint > 0 ? hint : DEFAULT_RATE_LIMIT_BACKOFF_MS);
		}
		throw new UsageFetchError(humanizeUsageError(res.status, res.text), res.status);
	}
	const data = res.json as UsageData;
	cachedUsage = { data, fetchedAt: Date.now() };
	rateLimitedUntil = 0;
	return data;
}

/**
 * Retry-After ヘッダー（秒数 or HTTP-date）またはレスポンスボディ内の
 * `retry_after` をミリ秒に変換する。値が見当たらない／不正なら 0 を返し、
 * 呼び出し側の既定バックオフが使われる。
 */
function parseRetryAfter(res: { headers?: Record<string, string>; text: string }): number {
	const header = res.headers?.["retry-after"] ?? res.headers?.["Retry-After"];
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
		const dateMs = Date.parse(header);
		if (Number.isFinite(dateMs)) {
			const diff = dateMs - Date.now();
			if (diff > 0) return diff;
		}
	}
	try {
		const parsed = JSON.parse(res.text) as { retry_after?: number };
		if (typeof parsed.retry_after === "number" && parsed.retry_after > 0) {
			return parsed.retry_after * 1000;
		}
	} catch {
		/* not JSON — fall through */
	}
	return 0;
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
