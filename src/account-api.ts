import { requestUrl } from "obsidian";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClaudePanelSettings } from "./settings";
import { resolveClaudePath } from "./cli-resolver";
import { t } from "./i18n";

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
// `utilization` は不明な場合 null（rate_limit_event が status="allowed" で
// 利用率を含まないケース）。レンダラ側で null を「—」として描画する。
export interface UsageWindow {
	utilization: number | null;
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
			reject(new Error(t("account.errClaudeCliNotFound")));
			return;
		}
		execFile(
			claudePath,
			["auth", "status", "--json"],
			{ timeout: 8000, windowsHide: true },
			(err, stdout) => {
				if (err) {
					reject(err instanceof Error ? err : new Error("claude auth status を実行できませんでした"));
					return;
				}
				try {
					const data = JSON.parse(stdout) as AuthStatus;
					resolve(data);
				} catch (e) {
					reject(
						new Error(
							t("account.errAuthJsonParse", (e as Error).message)
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
 * 直近の成功 fetch 結果（または `rate_limit_event` 由来の値）を保持する
 * プロセス内キャッシュ。ステータスバーとモーダルで共有することで、モー
 * ダルを開くたびに新規リクエストを発射するのを避ける。
 *
 * Obsidian リロード時のコールドスタートで「—」を表示しないよう、ディスク
 * へも自動永続化する（`~/.claude-panel/usage-cache.json`）。読み込みは
 * `loadCachedUsageFromDisk()` で起動時に 1 度行う。
 */
let cachedUsage: { data: UsageData; fetchedAt: number } | null = null;

const CACHE_FILE = path.join(os.homedir(), ".claude-panel", "usage-cache.json");

/**
 * ディスクからキャッシュを読み込む。プラグイン起動時に 1 度呼ぶ。
 * ファイル不在・破損時は黙って null のまま（次の fetch / rate_limit_event
 * で自然に埋まる）。
 */
export async function loadCachedUsageFromDisk(): Promise<void> {
	try {
		if (!fs.existsSync(CACHE_FILE)) return;
		const raw = await fs.promises.readFile(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as {
			data?: UsageData;
			fetchedAt?: number;
		};
		if (
			parsed &&
			typeof parsed.fetchedAt === "number" &&
			parsed.data &&
			typeof parsed.data === "object"
		) {
			// 旧バージョンが書いた虚偽の `utilization: 0` を除去する。
			// 当該ターンに rate_limit_event だけ来た（=API 値が無い）場合、
			// 旧コードは 0 を保存していた。これをそのまま信じると「0%」と
			// 誤表示するので、value=0 はクリアして null 扱いにする。
			cachedUsage = {
				data: sanitizeLegacyZeros(parsed.data),
				fetchedAt: parsed.fetchedAt,
			};
		}
	} catch {
		/* noop — 起動を妨げない */
	}
}

function sanitizeLegacyZeros(data: UsageData): UsageData {
	const out: UsageData = {};
	for (const key of [
		"five_hour",
		"seven_day",
		"seven_day_opus",
		"seven_day_sonnet",
	] as const) {
		const w = data[key];
		if (!w) continue;
		// utilization === 0 は API が返した正規の 0% かもしれないが、
		// 旧 applyRateLimitEvent のバグで書かれた 0 の可能性が高いので
		// null 扱いに退避させる。次の API fetch / rate_limit_event で
		// 正しい値が入ってくる。
		out[key] = {
			utilization: w.utilization === 0 ? null : w.utilization,
			resets_at: w.resets_at ?? null,
		};
	}
	return out;
}

/**
 * キャッシュをディスクへ書き出す。fetchUsage 成功時と applyRateLimitEvent
 * 内で自動呼び出し。複数フィールド更新を 1 回にまとめるため debounce する。
 */
let persistTimer: number | null = null;
function schedulePersistCache(): void {
	if (persistTimer !== null) return;
	persistTimer = window.setTimeout(() => {
		persistTimer = null;
		void persistCacheNow();
	}, 500);
}
async function persistCacheNow(): Promise<void> {
	if (!cachedUsage) return;
	try {
		await fs.promises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
		await fs.promises.writeFile(
			CACHE_FILE,
			JSON.stringify(cachedUsage),
			"utf8"
		);
	} catch {
		/* noop — 失敗してもメモリ上の状態は維持される */
	}
}

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

/**
 * Claude `--print` の stream-json から拾った rate_limit_event を
 * 既存キャッシュにマージする。チャットを実行するたびに無料で取れる
 * 新鮮値なので、API ポーリングの間を埋めて表示を up-to-date に保てる。
 *
 * 仕様:
 *   - `resetsAt` は常にあるので必ず反映する
 *   - `utilization` は CLI 側が閾値超過時のみ含める。値があれば反映、
 *     無ければ既存キャッシュ値を維持（古くても完全に消すよりマシ）
 *   - 該当ウィンドウのキャッシュエントリが無ければ新規作成
 */
export function applyRateLimitEvent(info: {
	rateLimitType: string;
	resetsAt: number;
	utilization?: number;
}): void {
	const key = mapRateLimitTypeToWindow(info.rateLimitType);
	if (!key) return;
	const data: UsageData = cachedUsage?.data ?? {};
	const existing = data[key] ?? null;
	// utilization は閾値超過時のみ含まれる。無いときは「既存値」を保つ
	// （古くても残す）。既存値も無ければ `null`（=「不明」）にする。
	// 0 を入れると「0% 使用」と誤表示されるので避ける。
	const utilization =
		info.utilization != null
			? clamp01(info.utilization) * 100
			: existing?.utilization != null
				? existing.utilization
				: null;
	const resets_at = new Date(info.resetsAt * 1000).toISOString();
	(data as Record<string, UsageWindow | null | undefined>)[key] = {
		utilization,
		resets_at,
	};
	cachedUsage = { data, fetchedAt: Date.now() };
	schedulePersistCache();
}

function mapRateLimitTypeToWindow(t: string): keyof UsageData | null {
	switch (t) {
		case "five_hour":
			return "five_hour";
		case "seven_day":
			return "seven_day";
		case "seven_day_opus":
			return "seven_day_opus";
		case "seven_day_sonnet":
			return "seven_day_sonnet";
		default:
			return null;
	}
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
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
		throw new Error(t("account.errNotLoggedInForUsage"));
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
	const data = normalizeUsageData(res.json as UsageData);
	cachedUsage = { data, fetchedAt: Date.now() };
	rateLimitedUntil = 0;
	schedulePersistCache();
	return data;
}

/**
 * Anthropic 側がスケールを 0-1 で返すか 0-100 で返すかバージョン依存
 * （VS Code 拡張 claude-usage-bar も両対応している）。`utilization > 1`
 * なら 0-100 スケールとみなしてそのまま、それ以下なら 0-1 とみなして
 * 100 倍する。クランプも併せて行う。
 */
function normalizeUsageData(data: UsageData): UsageData {
	const out: UsageData = {};
	for (const key of [
		"five_hour",
		"seven_day",
		"seven_day_opus",
		"seven_day_sonnet",
	] as const) {
		const w = data[key];
		if (!w) continue;
		const raw = w.utilization;
		const pct =
			raw == null
				? null
				: raw > 1
					? Math.max(0, Math.min(100, raw))
					: Math.max(0, Math.min(100, raw * 100));
		out[key] = { utilization: pct, resets_at: w.resets_at ?? null };
	}
	return out;
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
		return t("account.errUsageAuthHttp", status);
	}
	if (status === 429) {
		// レスポンスボディに retry-after のヒントがあれば取り出して表示する。
		const retry = extractRetryHint(body);
		const suffix = retry ? ` ${retry}` : t("account.errUsageRateLimitedHintDefault");
		return t("account.errUsageRateLimited", suffix);
	}
	if (status >= 500) {
		return t("account.errUsageServer", status);
	}
	return t("account.errUsageGeneric", status);
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
