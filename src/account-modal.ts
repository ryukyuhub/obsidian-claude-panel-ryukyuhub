import { App, Modal, Notice } from "obsidian";
import type { ClaudePanelSettings } from "./settings";
import {
	fetchAuthStatus,
	fetchUsage,
	getCachedUsage,
	getRateLimitedUntil,
	UsageFetchError,
	type AuthStatus,
	type UsageData,
	type UsageWindow,
} from "./account-api";
import {
	formatTokens,
	type UsageBucket,
	type UsageHistory,
} from "./usage-history";
import { t } from "./i18n";

/**
 * モーダルを開いた時に「キャッシュ済みデータをそのまま使ってよい」と
 * みなす最大経過時間。ステータスバーが 10 分間隔で更新するので、これ
 * より新しいデータが既にあれば追加 fetch は不要 — 同じ値しか返ってこない。
 */
const MODAL_CACHE_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * 「アカウントと使用状況」モーダル。account-api.ts のデータ取得を
 * 呼び出して整形表示する純 UI 層。データソースの内部実装に依存しない。
 */
export class AccountUsageModal extends Modal {
	private settings: ClaudePanelSettings;
	private bodyEl!: HTMLDivElement;
	// 任意。渡されると「ローカル累計」セクションを描画する。
	private history: UsageHistory | null;

	constructor(
		app: App,
		settings: ClaudePanelSettings,
		history: UsageHistory | null = null
	) {
		super(app);
		this.settings = settings;
		this.history = history;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("claude-panel-account-modal");
		contentEl.empty();
		contentEl.createEl("h3", {
			text: t("account.modalTitle"),
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
			text: t("account.loading"),
		});
	}

	private async load(): Promise<void> {
		// 認証ステータスは `claude auth status --json` のローカル呼び出しで
		// API レート制限とは独立しているので毎回取得する。使用状況は API
		// 呼び出しなので、十分新しいキャッシュがあればそれで済ませる。
		// ただしキャッシュに utilization が無い場合（rate_limit_event 由来
		// の resets_at だけしか入っていない状態）は新鮮でも fetch を試す
		// ─ ユーザがモーダルを開く瞬間は「実際の % が知りたい」意図。
		const cached = getCachedUsage();
		const hasUtil = cached?.data.five_hour?.utilization != null;
		const cacheIsFresh =
			cached !== null &&
			hasUtil &&
			Date.now() - cached.fetchedAt < MODAL_CACHE_FRESHNESS_MS;
		const rateLimited = Date.now() < getRateLimitedUntil();

		const usagePromise: Promise<UsageData | UsageFallback> =
			cacheIsFresh || rateLimited
				? Promise.resolve(
						cached
							? ({ kind: "cache", data: cached.data, fetchedAt: cached.fetchedAt } as const)
							: ({ kind: "rate-limited" } as const)
					)
				: fetchUsage().catch((err) => {
						const cachedNow = getCachedUsage();
						if (
							err instanceof UsageFetchError &&
							err.status === 429 &&
							cachedNow
						) {
							return {
								kind: "cache",
								data: cachedNow.data,
								fetchedAt: cachedNow.fetchedAt,
							} as const;
						}
						throw err;
					});

		const results = await Promise.allSettled([
			fetchAuthStatus(this.settings),
			usagePromise,
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
			text: t("account.sectionAccount"),
		});
		if (authResult.status === "fulfilled" && authResult.value.loggedIn) {
			renderAuthRows(accountSection, authResult.value);
		} else {
			const note = accountSection.createDiv({
				cls: "claude-panel-account-note",
			});
			note.setText(
				authResult.status === "rejected"
					? t("account.authFetchFailed", authResult.reason?.message ?? authResult.reason)
					: t("account.notLoggedIn")
			);
		}

		// 使用状況セクション
		const usageSection = this.bodyEl.createDiv({
			cls: "claude-panel-account-section",
		});
		usageSection.createDiv({
			cls: "claude-panel-account-section-label",
			text: t("account.sectionUsage"),
		});
		if (usageResult.status === "fulfilled") {
			const value = usageResult.value;
			if (isUsageData(value)) {
				renderUsageRows(usageSection, value);
			} else if (value.kind === "cache") {
				renderUsageRows(usageSection, value.data);
				const note = usageSection.createDiv({
					cls: "claude-panel-account-note",
				});
				note.setText(
					t("account.cacheNote", formatCacheAge(value.fetchedAt))
				);
			} else {
				const note = usageSection.createDiv({
					cls: "claude-panel-account-note",
				});
				note.setText(t("account.rateLimitedNote"));
			}
		} else {
			const note = usageSection.createDiv({
				cls: "claude-panel-account-note",
			});
			note.setText(
				t("account.usageFetchFailed", usageResult.reason?.message ?? usageResult.reason)
			);
		}

		// ローカル累計セクション（このプラグインが記録した分の今日 / 7日 / 今月）
		if (this.history) {
			const histSection = this.bodyEl.createDiv({
				cls: "claude-panel-account-section",
			});
			histSection.createDiv({
				cls: "claude-panel-account-section-label",
				text: t("account.sectionLocalTotal"),
			});
			renderHistoryRows(histSection, this.history);
		}

		// フッターリンク
		const footer = this.bodyEl.createDiv({
			cls: "claude-panel-account-footer",
		});
		const link = footer.createEl("a", {
			text: t("account.manageOnClaudeAi"),
			href: "https://claude.ai/settings/usage",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");

		const refreshBtn = footer.createEl("button", {
			text: t("account.refresh"),
			cls: "claude-panel-account-refresh",
		});
		// バックオフ中は「更新」を無効化。叩いても直ちに 429 を返すだけで、
		// API への余計な負荷にもユーザの混乱の元にもなる。
		if (rateLimited) {
			refreshBtn.disabled = true;
			refreshBtn.title = t("account.refreshDisabledRateLimited");
		}
		refreshBtn.onclick = () => {
			this.renderLoading();
			void this.load();
		};
	}
}

type UsageFallback =
	| { kind: "cache"; data: UsageData; fetchedAt: number }
	| { kind: "rate-limited" };

function isUsageData(v: UsageData | UsageFallback): v is UsageData {
	return !(v as UsageFallback).kind;
}

function formatCacheAge(fetchedAt: number): string {
	const diff = Date.now() - fetchedAt;
	if (diff < 60_000) return t("account.cacheAgeLessThanMinute");
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return t("account.cacheAgeMinutes", minutes);
	const hours = Math.floor(minutes / 60);
	return t("account.cacheAgeHours", hours);
}

export function openAccountUsageModal(
	app: App,
	settings: ClaudePanelSettings,
	history: UsageHistory | null = null
): void {
	try {
		new AccountUsageModal(app, settings, history).open();
	} catch (err) {
		new Notice(
			t("account.openModalFailed", (err as Error).message)
		);
	}
}

function renderAuthRows(host: HTMLElement, status: AuthStatus): void {
	const grid = host.createDiv({ cls: "claude-panel-account-grid" });
	const rows: [string, string | undefined][] = [
		[t("account.rowAuthMethod"), formatAuthMethod(status.authMethod)],
		[t("account.rowEmail"), status.email],
		[t("account.rowOrg"), status.orgName],
		[t("account.rowPlan"), formatPlan(status.subscriptionType)],
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

/**
 * ローカル累計の表示。「7日間」は Claude API の「週間（7日）」と重複するので
 * ここでは出さない（API のほうがアカウント全体を見ているので正確）。
 * 「今日」「今月」は API に該当エンドポイントが無いのでローカル集計だけで描く。
 */
function renderHistoryRows(host: HTMLElement, history: UsageHistory): void {
	const agg = history.aggregates();
	const accountKey = history.getCurrentAccountKey();
	const grid = host.createDiv({ cls: "claude-panel-account-grid" });
	const rows: [string, UsageBucket][] = [
		[t("account.historyToday"), agg.today],
		[t("account.historyThisMonth"), agg.thisMonth],
	];
	for (const [label, bucket] of rows) {
		const row = grid.createDiv({ cls: "claude-panel-account-row" });
		row.createSpan({
			cls: "claude-panel-account-row-label",
			text: label,
		});
		const value = row.createSpan({
			cls: "claude-panel-account-row-value claude-panel-token-value",
			text: `${formatTokens(bucket.total)} tokens`,
		});
		if (bucket.count > 0) {
			value.setAttr(
				"title",
				t(
					"account.historyTooltip",
					bucket.count,
					bucket.in.toLocaleString(),
					bucket.out.toLocaleString(),
					bucket.cacheCreate.toLocaleString(),
					bucket.cacheRead.toLocaleString()
				)
			);
		}
	}
	if (!accountKey) {
		// アカウント解決中。集計値は全レコード（複数アカウント混在の可能性）。
		host.createDiv({
			cls: "claude-panel-account-note",
			text: t("account.historyResolving"),
		});
	}
	host.createDiv({
		cls: "claude-panel-account-note",
		text: t("account.historyFootnote"),
	});
}

function renderUsageRows(host: HTMLElement, data: UsageData): void {
	const items: [string, UsageWindow | null | undefined][] = [
		[t("account.windowFiveHour"), data.five_hour],
		[t("account.windowSevenDay"), data.seven_day],
		[t("account.windowSevenDayOpus"), data.seven_day_opus],
		[t("account.windowSevenDaySonnet"), data.seven_day_sonnet],
	];
	let rendered = 0;
	let anyMissingUtil = false;
	for (const [label, win] of items) {
		if (!win) continue;
		renderUsageRow(host, label, win);
		if (win.utilization == null) anyMissingUtil = true;
		rendered++;
	}
	if (rendered === 0) {
		host.createDiv({
			cls: "claude-panel-account-note",
			text: t("account.noUsageData"),
		});
	}
	if (anyMissingUtil) {
		// 「—」の理由をユーザに説明。リセット時刻だけは rate_limit_event
		// 由来で取れているが、利用率（%）は API fetch が必須。
		const backoffEnd = getRateLimitedUntil();
		const note = host.createDiv({
			cls: "claude-panel-account-note",
		});
		if (Date.now() < backoffEnd) {
			const min = Math.max(
				1,
				Math.ceil((backoffEnd - Date.now()) / 60_000)
			);
			note.setText(t("account.utilizationRateLimited", min));
		} else {
			note.setText(t("account.utilizationFetchHint"));
		}
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
	// utilization 不明（rate_limit_event 由来のリセット時刻だけある状態）は
	// 「—」を表示。バーも描かず、リセットカウントダウンだけ出す。
	if (win.utilization == null) {
		head.createSpan({
			cls: "claude-panel-usage-pct",
			text: "—",
			attr: {
				title: t("account.utilizationPending"),
			},
		});
		const reset = formatResetsIn(win.resets_at);
		if (reset) {
			row.createDiv({
				cls: "claude-panel-usage-reset",
				text: reset,
			});
		}
		return;
	}
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
	if (ms <= 0) return t("account.resetSoon");
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return t("account.resetInMinutes", minutes);
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("account.resetInHours", hours);
	const days = Math.floor(hours / 24);
	return t("account.resetInDays", days);
}
