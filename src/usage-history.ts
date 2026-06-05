import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MessageUsage } from "./chat-message";
import type { AuthStatus } from "./account-api";

/**
 * トークン消費履歴の永続化と集計。1 ターン分の usage を記録し、任意の
 * タイムウィンドウでの合計値を返す。
 *
 * 永続化先: `~/.claude-panel/usage-history.json`
 *   Vault 配下に置くと Obsidian プロジェクト（vault）ごとに履歴が分裂し、
 *   サブスクリプションアカウント単位の累計が見えなくなる。`os.homedir()`
 *   配下に置くことで、同じ macOS ユーザの全 vault が同一の履歴ファイルを
 *   共有し、Claude のサブスクアカウント単位で集計できる。
 *
 * アカウント識別: 各レコードに `accountKey` を付ける。集計時は現在ログイン
 * 中のアカウントの `accountKey` でフィルタする。これによって複数アカウント
 * を切り替えて使う場合でも累計が混ざらない。
 *   キーは `email[#orgId]`。`claude auth status --json` から取得する。
 *
 * 保持期間: 32 日（今月の月初を確実にカバーする最小限）。
 *
 * 書き込みは debounce: 1 ターン内で複数回 record() が呼ばれても 500ms
 * まとめて 1 回ファイルに書く。
 */

export interface UsageRecord {
	/** epoch ms — ローカルタイムゾーン基準で今日/今月の判定に使う */
	ts: number;
	/** 4 種合計（in + out + cacheCreate + cacheRead） */
	total: number;
	in: number;
	out: number;
	cacheCreate: number;
	cacheRead: number;
	/** どの Claude アカウントの消費か。未解決時は `"_unknown"`。 */
	accountKey: string;
}

export interface UsageBucket {
	total: number;
	in: number;
	out: number;
	cacheCreate: number;
	cacheRead: number;
	/** このバケットに含まれるレコード数（参考値）。 */
	count: number;
}

export interface UsageAggregates {
	today: UsageBucket;
	sevenDays: UsageBucket;
	thisMonth: UsageBucket;
}

/**
 * Anthropic の 5h セッションウィンドウをローカル履歴から推定したもの。
 * `startedAt` から 5 時間後に Anthropic 側でクォータがリセットされる
 * と仮定する（公式 API の `resets_at` がこれと同じ計算）。
 * 直近 5h 以内に 1 件もレコードが無ければ null を返す（=非アクティブ）。
 */
export interface FiveHourWindow {
	startedAt: number;
	resetsAt: number;
	bucket: UsageBucket;
}

const FILE_NAME = "usage-history.json";
const DIR_NAME = ".claude-panel";
const RETENTION_DAYS = 32;
const FLUSH_DEBOUNCE_MS = 500;
const UNKNOWN_KEY = "_unknown";

export class UsageHistory {
	private records: UsageRecord[] = [];
	private flushTimer: number | null = null;
	private loaded = false;
	private currentAccountKey: string | null = null;
	// アカウントが未解決の間に来た usage を保持しておき、解決後にまとめて
	// `_unknown` ではなく実キーでタグ付けする。
	private pending: Array<{ ts: number; usage: MessageUsage }> = [];

	private filePath(): string {
		return path.join(os.homedir(), DIR_NAME, FILE_NAME);
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		const file = this.filePath();
		try {
			if (!fs.existsSync(file)) return;
			const raw = await fs.promises.readFile(file, "utf8");
			const parsed = JSON.parse(raw) as { records?: unknown };
			if (!parsed || !Array.isArray(parsed.records)) return;
			const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
			for (const r of parsed.records) {
				const rec = sanitize(r);
				if (rec && rec.ts >= cutoff) this.records.push(rec);
			}
		} catch {
			// 破損ファイルは黙って捨てる。次回 record() の保存で空状態から再生成。
			this.records = [];
		}
	}

	/**
	 * 現在ログイン中のアカウント情報を反映する。pending キューに溜まった
	 * `_unknown` レコードを実キーでフラッシュする。
	 */
	setAccount(status: AuthStatus | null): void {
		const key = deriveAccountKey(status);
		this.currentAccountKey = key;
		if (this.pending.length === 0) return;
		for (const p of this.pending) {
			this.records.push(buildRecord(p.ts, p.usage, key));
		}
		this.pending = [];
		this.scheduleFlush();
	}

	/** 現在のアカウントキー（解決済みなら）。集計関数のデフォルトに使う。 */
	getCurrentAccountKey(): string | null {
		return this.currentAccountKey;
	}

	/** 1 ターン分の usage を追記。flush は debounce される。 */
	record(usage: MessageUsage): void {
		const total = sumUsage(usage);
		if (total <= 0) return;
		const key = this.currentAccountKey;
		if (!key) {
			// アカウント未解決なら一旦保留。setAccount 時に正しいキーで反映。
			this.pending.push({ ts: Date.now(), usage });
			return;
		}
		this.records.push(buildRecord(Date.now(), usage, key));
		this.scheduleFlush();
	}

	/**
	 * 指定アカウントの今日/7日/今月集計を返す。`accountKey` 未指定時は
	 * 現在のアカウントを使う。さらに未解決時は全レコード（`_unknown` を
	 * 含む）の合算を返す。
	 */
	aggregates(
		now: Date = new Date(),
		accountKey: string | null = this.currentAccountKey
	): UsageAggregates {
		const startOfToday = startOfDay(now).getTime();
		const sevenDaysAgo = now.getTime() - 7 * 86_400_000;
		const startOfMonth = new Date(
			now.getFullYear(),
			now.getMonth(),
			1
		).getTime();

		const today = emptyBucket();
		const sevenDays = emptyBucket();
		const thisMonth = emptyBucket();

		for (const r of this.records) {
			if (accountKey && r.accountKey !== accountKey) continue;
			if (r.ts >= startOfToday) addToBucket(today, r);
			if (r.ts >= sevenDaysAgo) addToBucket(sevenDays, r);
			if (r.ts >= startOfMonth) addToBucket(thisMonth, r);
		}
		return { today, sevenDays, thisMonth };
	}

	/**
	 * 現在アクティブな 5h セッションウィンドウを返す。Anthropic の挙動
	 * （初メッセージから 5h で固定リセット）に倣い、過去レコードを時系列
	 * に並べて 5h 以上の空きで区切り、最新ウィンドウを返す。
	 *
	 * 最新ウィンドウの終了時刻が現在時刻を過ぎている場合は、その「直前
	 * のウィンドウ」は失効済みと判断して null を返す（次のメッセージが
	 * 新しいウィンドウを開始する）。
	 */
	fiveHourWindow(
		now: Date = new Date(),
		accountKey: string | null = this.currentAccountKey
	): FiveHourWindow | null {
		const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
		const filtered = this.records
			.filter((r) => !accountKey || r.accountKey === accountKey)
			.sort((a, b) => a.ts - b.ts);
		if (filtered.length === 0) return null;

		let windowStart = filtered[0].ts;
		let windowEnd = windowStart + FIVE_HOURS_MS;
		for (const r of filtered) {
			if (r.ts > windowEnd) {
				windowStart = r.ts;
				windowEnd = windowStart + FIVE_HOURS_MS;
			}
		}

		const nowMs = now.getTime();
		if (windowEnd <= nowMs) return null;

		const bucket = emptyBucket();
		for (const r of filtered) {
			if (r.ts >= windowStart && r.ts <= windowEnd) {
				addToBucket(bucket, r);
			}
		}
		return { startedAt: windowStart, resetsAt: windowEnd, bucket };
	}

	/** 即時保存して pending タイマーを破棄。プラグイン onunload で呼ぶ。 */
	async flushNow(): Promise<void> {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.persist();
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.persist();
		}, FLUSH_DEBOUNCE_MS);
	}

	private async persist(): Promise<void> {
		// 保存前に retention をかけて、ファイルが永遠に膨らむのを防ぐ。
		const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
		this.records = this.records.filter((r) => r.ts >= cutoff);

		const file = this.filePath();
		const dir = path.dirname(file);
		try {
			await fs.promises.mkdir(dir, { recursive: true });
			const payload = JSON.stringify({
				version: 1,
				records: this.records,
			});
			await fs.promises.writeFile(file, payload, "utf8");
		} catch {
			/* noop — 書き込み失敗時はメモリ上の状態だけ保持して次回再試行 */
		}
	}
}

function buildRecord(
	ts: number,
	usage: MessageUsage,
	accountKey: string
): UsageRecord {
	return {
		ts,
		total: sumUsage(usage),
		in: usage.inputTokens || 0,
		out: usage.outputTokens || 0,
		cacheCreate: usage.cacheCreationTokens || 0,
		cacheRead: usage.cacheReadTokens || 0,
		accountKey,
	};
}

function sumUsage(u: MessageUsage): number {
	return (
		(u.inputTokens || 0) +
		(u.outputTokens || 0) +
		(u.cacheCreationTokens || 0) +
		(u.cacheReadTokens || 0)
	);
}

function sanitize(raw: unknown): UsageRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const ts = numOr(r.ts, 0);
	if (!ts) return null;
	const inT = numOr(r.in, 0);
	const out = numOr(r.out, 0);
	const cc = numOr(r.cacheCreate, 0);
	const cr = numOr(r.cacheRead, 0);
	const total = numOr(r.total, inT + out + cc + cr);
	const accountKey =
		typeof r.accountKey === "string" && r.accountKey
			? r.accountKey
			: UNKNOWN_KEY;
	return {
		ts,
		total,
		in: inT,
		out,
		cacheCreate: cc,
		cacheRead: cr,
		accountKey,
	};
}

function numOr(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function emptyBucket(): UsageBucket {
	return { total: 0, in: 0, out: 0, cacheCreate: 0, cacheRead: 0, count: 0 };
}

function addToBucket(b: UsageBucket, r: UsageRecord): void {
	b.total += r.total;
	b.in += r.in;
	b.out += r.out;
	b.cacheCreate += r.cacheCreate;
	b.cacheRead += r.cacheRead;
	b.count += 1;
}

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * AuthStatus からアカウント識別キーを生成する。同じメールで複数組織に
 * 所属する場合に備えて orgId を後置するが、無ければ email 単独。
 * email も無いとき（例: API key 認証）は authMethod ベースのキーで代替。
 */
function deriveAccountKey(status: AuthStatus | null): string {
	if (!status || !status.loggedIn) return UNKNOWN_KEY;
	if (status.email) {
		return status.orgId
			? `${status.email}#${status.orgId}`
			: status.email;
	}
	if (status.orgId) return `org:${status.orgId}`;
	if (status.authMethod) return `method:${status.authMethod}`;
	return UNKNOWN_KEY;
}

/** 12345 → "12.3k" / 1234567 → "1.23M" / 123 → "123" */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}
