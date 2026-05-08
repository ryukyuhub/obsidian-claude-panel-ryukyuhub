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
		// 認証ステータスは `claude auth status --json` のローカル呼び出しで
		// API レート制限とは独立しているので毎回取得する。使用状況は API
		// 呼び出しなので、十分新しいキャッシュがあればそれで済ませる。
		const cached = getCachedUsage();
		const cacheIsFresh =
			cached !== null &&
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
			const value = usageResult.value;
			if (isUsageData(value)) {
				renderUsageRows(usageSection, value);
			} else if (value.kind === "cache") {
				renderUsageRows(usageSection, value.data);
				const note = usageSection.createDiv({
					cls: "claude-panel-account-note",
				});
				note.setText(
					`${formatCacheAge(value.fetchedAt)} のキャッシュを表示しています。`
				);
			} else {
				const note = usageSection.createDiv({
					cls: "claude-panel-account-note",
				});
				note.setText(
					"レート制限中のため最新の使用状況を取得できませんでした。しばらくしてから「更新」をクリックしてください。"
				);
			}
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
		// バックオフ中は「更新」を無効化。叩いても直ちに 429 を返すだけで、
		// API への余計な負荷にもユーザの混乱の元にもなる。
		if (rateLimited) {
			refreshBtn.disabled = true;
			refreshBtn.title = "レート制限中のため更新できません";
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
	if (diff < 60_000) return "1 分未満前";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes} 分前`;
	const hours = Math.floor(minutes / 60);
	return `${hours} 時間前`;
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
