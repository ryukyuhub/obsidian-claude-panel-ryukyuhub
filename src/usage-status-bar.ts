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
 * クリックで既存の AccountUsageModal を開く。
 *
 * 更新ポリシー:
 *   - プラグイン起動時に1回 fetch
 *   - FETCH_INTERVAL_MS おきにバックグラウンド更新（5h リセット追従）
 *   - 60秒おきにキャッシュ済みデータで再描画（残り時間カウントダウン）
 *   - チャットラン完了時など外部から refreshSoon() を呼べる
 *   - MIN_REFRESH_GAP_MS のクールダウンで連発を防ぐ
 *   - account-api.ts のプロセス内キャッシュとバックオフを共有するので、
 *     429 を受けている間は実 HTTP 要求を出さない
 */
export class UsageStatusBar {
	private plugin: ClaudePanelPlugin;
	private el: HTMLElement | null = null;
	private fetchIntervalId: number | null = null;
	private tickIntervalId: number | null = null;
	private lastFetchAt = 0;

	// 5h 表示の更新は 5 分間隔で十分（5h ウィンドウは時間オーダーで動くので
	// 10 分でも実用上は問題ないが、複数 PC 間で叩きすぎない範囲で押さえる）。
	private static readonly FETCH_INTERVAL_MS = 10 * 60 * 1000;
	private static readonly TICK_INTERVAL_MS = 60 * 1000;
	// チャット完了直後の使用量はほぼ前回と変わらないので、頻繁に refresh
	// する価値が低い。複数 PC で同じアカウントを使うとき 429 を踏みやすく
	// なるため 30 秒 → 2 分に伸ばしている。
	private static readonly MIN_REFRESH_GAP_MS = 2 * 60 * 1000;

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

	/** 外部からの更新依頼。クールダウン中／バックオフ中なら何もしない。 */
	refreshSoon(): void {
		if (!this.el) return;
		const elapsed = Date.now() - this.lastFetchAt;
		if (elapsed < UsageStatusBar.MIN_REFRESH_GAP_MS) return;
		if (Date.now() < getRateLimitedUntil()) return;
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
			// 429（レート制限）のときは直近のキャッシュ値をそのまま残す。
			// 一時的な制限で表示が「—」に崩れるのを避け、バックオフが解けて
			// から自然回復させる。それ以外のエラー（401・ネットワーク不通
			// など）は状態が確実に分かったほうが良いのでエラー表示に切り替える。
			const cached = getCachedUsage();
			if (
				err instanceof UsageFetchError &&
				err.status === 429 &&
				cached
			) {
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
				`セッション: ${formatPct(data.five_hour)}` +
					(remain ? `（${remain}）` : "")
			);
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

// プレフィックスにテキスト「Claude」ではなくアイコンを描く。リボンアイコン
// と同じ `bot` を使うことで「Claude を表す印」として一貫させる。
function renderPrefixIcon(host: HTMLElement): void {
	const wrap = host.createSpan({ cls: "claude-panel-usage-sb-prefix" });
	setIcon(wrap, "bot");
}

// 警告/危険の色は host（ステータスバー全体）に付ける。チップだけ色を変える
// より、ピル全体を染めたほうが視覚的に強く、見落としにくい。
function appendChip(
	host: HTMLElement,
	win: UsageWindow | null | undefined
): void {
	const chip = host.createSpan({ cls: "claude-panel-usage-sb-chip" });
	if (!win) {
		chip.setText("—");
		return;
	}
	const pct = clamp(win.utilization, 0, 100);
	chip.setText(`${Math.round(pct)}%`);
	if (pct >= 85) host.addClass("is-danger");
	else if (pct >= 60) host.addClass("is-warn");
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
