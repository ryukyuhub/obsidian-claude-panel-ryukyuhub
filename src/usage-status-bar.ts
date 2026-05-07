import type ClaudePanelPlugin from "./main";
import { fetchUsage, type UsageData, type UsageWindow } from "./account-api";
import { openAccountUsageModal } from "./account-modal";

/**
 * Obsidian 最下部のステータスバーに Claude 使用状況を表示する。
 * クリックで既存の AccountUsageModal を開く。
 *
 * 更新ポリシー:
 *   - プラグイン起動時に1回 fetch
 *   - FETCH_INTERVAL_MS おきにバックグラウンド更新（5h リセット追従）
 *   - 60秒おきにキャッシュ済みデータで再描画（残り時間カウントダウン）
 *   - チャットラン完了時など外部から refreshSoon() を呼べる
 *   - MIN_REFRESH_GAP_MS のクールダウンで連発を防ぐ
 */
export class UsageStatusBar {
	private plugin: ClaudePanelPlugin;
	private el: HTMLElement | null = null;
	private fetchIntervalId: number | null = null;
	private tickIntervalId: number | null = null;
	private lastFetchAt = 0;
	private latest: UsageData | null = null;

	private static readonly FETCH_INTERVAL_MS = 10 * 60 * 1000;
	private static readonly TICK_INTERVAL_MS = 60 * 1000;
	private static readonly MIN_REFRESH_GAP_MS = 30 * 1000;

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
		item.setText("Claude …");
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
		this.latest = null;
	}

	/** 外部からの更新依頼。クールダウン中なら何もしない。 */
	refreshSoon(): void {
		if (!this.el) return;
		const elapsed = Date.now() - this.lastFetchAt;
		if (elapsed < UsageStatusBar.MIN_REFRESH_GAP_MS) return;
		void this.refresh();
	}

	/** キャッシュ済みデータで残り時間表示だけ再計算。fetch はしない。 */
	private tick(): void {
		if (this.el && this.latest) this.render(this.latest);
	}

	private async refresh(): Promise<void> {
		if (!this.el) return;
		this.lastFetchAt = Date.now();
		try {
			const usage = await fetchUsage();
			if (!this.el) return;
			this.latest = usage;
			this.render(usage);
		} catch (err) {
			if (!this.el) return;
			this.latest = null;
			this.renderError((err as Error).message);
		}
	}

	private render(data: UsageData): void {
		if (!this.el) return;
		this.el.empty();
		this.el.removeClass("is-error");
		this.el.createSpan({
			cls: "claude-panel-usage-sb-prefix",
			text: "Claude",
		});
		appendChip(this.el, "5h", data.five_hour);
		const fiveHRemain = formatRemainShort(data.five_hour?.resets_at);
		if (fiveHRemain) {
			this.el.createSpan({
				cls: "claude-panel-usage-sb-remain",
				text: fiveHRemain,
			});
		}
		appendChip(this.el, "7d", data.seven_day);

		const tipLines: string[] = [];
		if (data.five_hour) {
			const remain = formatRemainLong(data.five_hour.resets_at);
			tipLines.push(
				`5h セッション: ${formatPct(data.five_hour)}` +
					(remain ? `（${remain}）` : "")
			);
		}
		if (data.seven_day) {
			const remain = formatRemainLong(data.seven_day.resets_at);
			tipLines.push(
				`7d 週間: ${formatPct(data.seven_day)}` +
					(remain ? `（${remain}）` : "")
			);
		}
		if (data.seven_day_opus) {
			tipLines.push(`7d Opus: ${formatPct(data.seven_day_opus)}`);
		}
		if (data.seven_day_sonnet) {
			tipLines.push(`7d Sonnet: ${formatPct(data.seven_day_sonnet)}`);
		}
		tipLines.push("", "クリックで詳細");
		this.el.title = tipLines.join("\n");
	}

	private renderError(message: string): void {
		if (!this.el) return;
		this.el.empty();
		this.el.addClass("is-error");
		this.el.createSpan({
			cls: "claude-panel-usage-sb-prefix",
			text: "Claude",
		});
		this.el.createSpan({
			cls: "claude-panel-usage-sb-chip",
			text: "—",
		});
		this.el.title = `使用状況を取得できません:\n${message}\n\nクリックで詳細`;
	}
}

function appendChip(
	host: HTMLElement,
	label: string,
	win: UsageWindow | null | undefined
): void {
	const chip = host.createSpan({ cls: "claude-panel-usage-sb-chip" });
	if (!win) {
		chip.setText(`${label} —`);
		return;
	}
	const pct = clamp(win.utilization, 0, 100);
	chip.setText(`${label} ${Math.round(pct)}%`);
	if (pct >= 85) chip.addClass("is-danger");
	else if (pct >= 60) chip.addClass("is-warn");
}

function formatPct(win: UsageWindow): string {
	const pct = clamp(win.utilization, 0, 100);
	return `${Math.round(pct)}%`;
}

/** ステータスバー用の極短形式: "1h23m" / "42m" / "<1m" / "" */
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

/** ツールチップ用の長形式: "あと 1 時間 23 分でリセット" */
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
