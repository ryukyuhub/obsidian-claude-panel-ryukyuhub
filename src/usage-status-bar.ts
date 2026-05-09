import { setIcon } from "obsidian";
import type ClaudePanelPlugin from "./main";
import {
	fetchUsage,
	getCachedUsage,
	getRateLimitedUntil,
	UsageFetchError,
	type UsageData,
	type UsageWindow,
} from "./account-api";
import { openAccountUsageModal } from "./account-modal";

/**
 * Obsidian 最下部のステータスバーに Claude 使用状況を表示する。
 * クリックで AccountUsageModal を開く。
 *
 * **データソース** (優先度順):
 *   1. `claude --print` の stream-json から拾った `rate_limit_event`
 *      （チャット実行のたびに無料で取れる最新値。API コール不要）
 *   2. `/api/oauth/usage` への HTTP fetch（バックグラウンドポーリング）
 *
 * 1 がチャットを打つたびに自動でキャッシュを更新するので、ポーリング間隔
 * を長め（15 分）に抑えても表示は新鮮に保てる。429 を受けたらバックオフ
 * 中はキャッシュ値（=直近の rate_limit_event 由来でも OK）を表示し続ける。
 *
 * 更新タイミング:
 *   - プラグイン起動時に 1 回 fetch（コールドスタート）
 *   - FETCH_INTERVAL_MS おきに API バックグラウンド更新（5h リセット追従）
 *   - 60 秒おきにキャッシュ済みデータで残り時間を再描画
 *   - チャット完了 → rate_limit_event がキャッシュ更新 → refreshSoon() で即描画
 */
export class UsageStatusBar {
	private plugin: ClaudePanelPlugin;
	private el: HTMLElement | null = null;
	private fetchIntervalId: number | null = null;
	private tickIntervalId: number | null = null;
	private lastFetchAt = 0;

	// `rate_limit_event` が無料でキャッシュを更新してくれるので、API への
	// 自前ポーリングは長めにできる。15 分間隔なら多端末で同じアカウントを
	// 使っても 429 を踏みにくい。
	private static readonly FETCH_INTERVAL_MS = 15 * 60 * 1000;
	private static readonly TICK_INTERVAL_MS = 60 * 1000;
	// 連続 fetch 抑制クールダウン。rate_limit_event 経由の refreshSoon は
	// fetch 自体を呼ばない（キャッシュ表示の再描画だけ）ので、これは API
	// fetch を実際に飛ばす経路にだけ効く。
	private static readonly MIN_REFRESH_GAP_MS = 5 * 60 * 1000;

	constructor(plugin: ClaudePanelPlugin) {
		this.plugin = plugin;
	}

	attach(): void {
		if (this.el) return;
		const item = this.plugin.addStatusBarItem();
		item.addClass("claude-panel-usage-statusbar");
		item.setAttr("role", "button");
		item.setAttr("aria-label", "Claude 使用状況");
		item.title = "Claude 使用状況を読み込み中…";
		renderPrefixIcon(item);
		item.createSpan({ cls: "claude-panel-usage-sb-chip", text: "…" });
		item.addEventListener("click", () => {
			openAccountUsageModal(this.plugin.app, this.plugin.settings);
		});
		this.el = item;

		const fetchId = window.setInterval(
			() => void this.refresh(),
			UsageStatusBar.FETCH_INTERVAL_MS
		);
		this.plugin.registerInterval(fetchId);
		this.fetchIntervalId = fetchId;

		const tickId = window.setInterval(
			() => this.tick(),
			UsageStatusBar.TICK_INTERVAL_MS
		);
		this.plugin.registerInterval(tickId);
		this.tickIntervalId = tickId;

		// 既にキャッシュがあればそれで先に描画（コールドスタートの「…」を短縮）。
		const cached = getCachedUsage();
		if (cached) this.render(cached.data);
		void this.refresh();
	}

	detach(): void {
		if (this.fetchIntervalId !== null) {
			window.clearInterval(this.fetchIntervalId);
			this.fetchIntervalId = null;
		}
		if (this.tickIntervalId !== null) {
			window.clearInterval(this.tickIntervalId);
			this.tickIntervalId = null;
		}
		this.el?.remove();
		this.el = null;
	}

	/**
	 * 外部から呼ばれる更新依頼（チャット完了時など）。
	 *   - キャッシュが既に新鮮な utilization を持っていれば: クールダウン尊重
	 *   - utilization 不明（rate_limit_event だけで API 値が無い）: クール
	 *     ダウン無視して即時 fetch（429 バックオフは尊重）
	 * 後者を入れている理由: ユーザがチャットを送ったタイミングは「最新状態を
	 * 知りたい」意思の現れ。実用 % が出ていないなら遅延せずに 1 回試す。
	 */
	refreshSoon(): void {
		if (!this.el) return;
		const cached = getCachedUsage();
		if (cached) this.render(cached.data);

		// 429 バックオフ中はどんな経路でも fetch しない。
		if (Date.now() < getRateLimitedUntil()) return;

		const haveUtilization = cached?.data.five_hour?.utilization != null;
		if (haveUtilization) {
			// 通常のクールダウンを適用（連続 fetch 抑制）
			const elapsed = Date.now() - this.lastFetchAt;
			if (elapsed < UsageStatusBar.MIN_REFRESH_GAP_MS) return;
		}
		void this.refresh();
	}

	/** キャッシュ済みデータで残り時間表示だけ再計算。fetch はしない。 */
	private tick(): void {
		const cached = getCachedUsage();
		if (this.el && cached) this.render(cached.data);
	}

	private async refresh(): Promise<void> {
		if (!this.el) return;
		// 429 バックオフ中は実 fetch 自体を打たない。直近のキャッシュ値が
		// あればそれで描画し続け、Anthropic 側の制限が解けるまで待つ。
		if (Date.now() < getRateLimitedUntil()) {
			const cached = getCachedUsage();
			if (cached) this.render(cached.data);
			return;
		}
		this.lastFetchAt = Date.now();
		try {
			const usage = await fetchUsage();
			if (!this.el) return;
			this.render(usage);
		} catch (err) {
			if (!this.el) return;
			// 429 のときはキャッシュ値（rate_limit_event 由来でも OK）を残す。
			const cached = getCachedUsage();
			if (
				err instanceof UsageFetchError &&
				err.status === 429 &&
				cached
			) {
				this.render(cached.data);
				return;
			}
			// それ以外（401、ネットワーク不通など）でもキャッシュがあれば
			// それを優先表示。完全に何も無いときだけエラー表示にフォールバック。
			if (cached) {
				this.render(cached.data);
				return;
			}
			this.renderError((err as Error).message);
		}
	}

	private render(data: UsageData): void {
		if (!this.el) return;
		this.el.empty();
		this.el.removeClass("is-error");
		this.el.removeClass("is-warn");
		this.el.removeClass("is-danger");
		renderPrefixIcon(this.el);
		appendChip(this.el, data.five_hour);
		const fiveHRemain = formatRemainShort(data.five_hour?.resets_at);
		if (fiveHRemain) {
			this.el.createSpan({
				cls: "claude-panel-usage-sb-remain",
				text: fiveHRemain,
			});
		}

		const tipLines: string[] = [];
		if (data.five_hour) {
			const remain = formatRemainLong(data.five_hour.resets_at);
			tipLines.push(
				`セッション (5h): ${formatPct(data.five_hour)}` +
					(remain ? `（${remain}）` : "")
			);
		}
		if (data.seven_day) {
			tipLines.push(`週間 (7d): ${formatPct(data.seven_day)}`);
		}

		// utilization が「—」のときは状況説明を加える。よくある理由:
		//   1) Anthropic API がレートリミット中（30 分待つ）
		//   2) コールドスタート直後で API 取得がまだ走っていない
		// rate_limit_event は status="allowed" で利用率を含まないので、
		// 実 % は API fetch でしか取れない。状態を明示してユーザを混乱
		// させない。
		const fiveHrUtil = data.five_hour?.utilization;
		if (fiveHrUtil == null) {
			const backoffEnd = getRateLimitedUntil();
			tipLines.push("");
			if (Date.now() < backoffEnd) {
				const min = Math.max(
					1,
					Math.ceil((backoffEnd - Date.now()) / 60_000)
				);
				tipLines.push(
					`使用率: Anthropic API レート制限中（あと ${min} 分待機）`
				);
			} else {
				tipLines.push(
					"使用率: API 取得待ち（次回チャット送信時に再試行します）"
				);
			}
		}

		tipLines.push("", "クリックで詳細");
		this.el.title = tipLines.join("\n");
	}

	private renderError(message: string): void {
		if (!this.el) return;
		this.el.empty();
		this.el.removeClass("is-warn");
		this.el.removeClass("is-danger");
		this.el.addClass("is-error");
		renderPrefixIcon(this.el);
		this.el.createSpan({
			cls: "claude-panel-usage-sb-chip",
			text: "—",
		});
		this.el.title = `使用状況を取得できません:\n${message}\n\nクリックで詳細`;
	}
}

function renderPrefixIcon(host: HTMLElement): void {
	const wrap = host.createSpan({ cls: "claude-panel-usage-sb-prefix" });
	setIcon(wrap, "bot");
}

function appendChip(
	host: HTMLElement,
	win: UsageWindow | null | undefined
): void {
	const chip = host.createSpan({ cls: "claude-panel-usage-sb-chip" });
	if (!win || win.utilization == null) {
		// utilization が未知のとき（rate_limit_event が status="allowed"
		// で値を出さない & API もまだ取得できていない）は「—」を表示し、
		// 偽の 0% を見せない。リセット時刻は別途出るのでカウントダウンは生きる。
		chip.setText("—");
		return;
	}
	const pct = clamp(win.utilization, 0, 100);
	chip.setText(`${Math.round(pct)}%`);
	if (pct >= 85) host.addClass("is-danger");
	else if (pct >= 60) host.addClass("is-warn");
}

function formatPct(win: UsageWindow): string {
	if (win.utilization == null) return "—";
	const pct = clamp(win.utilization, 0, 100);
	return `${Math.round(pct)}%`;
}

function formatRemainShort(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const ms = Date.parse(iso) - Date.now();
	if (!Number.isFinite(ms)) return null;
	if (ms <= 0) return "<1m";
	const totalMin = Math.floor(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h <= 0) return `${m}m`;
	return `${h}h${m}m`;
}

function formatRemainLong(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const ms = Date.parse(iso) - Date.now();
	if (!Number.isFinite(ms)) return null;
	if (ms <= 0) return "まもなくリセット";
	const totalMin = Math.floor(ms / 60_000);
	if (totalMin < 60) return `あと ${totalMin} 分でリセット`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h < 24) {
		return m > 0
			? `あと ${h} 時間 ${m} 分でリセット`
			: `あと ${h} 時間でリセット`;
	}
	const d = Math.floor(h / 24);
	return `あと ${d} 日でリセット`;
}

function clamp(n: number, min: number, max: number): number {
	if (Number.isNaN(n)) return min;
	return Math.max(min, Math.min(max, n));
}
