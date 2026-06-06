import { t } from "./i18n";

// コンテキスト使用率が閾値を超えたときに、メーター右に表示する
// 「要約して新会話」バッジ。表示・色・disabled の切り替えだけを
// 担い、クリック後の確認モーダル表示と要約処理の呼び出しは
// 呼び出し側(view)が組み立てる。
//
// 閾値定数 (`0.6` / `0.85`) は ContextMeter の色判定と数値が
// 同じだが、概念が別(色 vs 提案)なので共有化はしない。

const THRESHOLD_WARN = 0.6;
const THRESHOLD_DANGER = 0.85;

export class SummaryBadge {
	private host: HTMLElement;
	private btn: HTMLButtonElement;
	private currentFraction: number | null = null;
	private isBusy = false;
	private isSummarizing = false;

	constructor(host: HTMLElement, opts: { onClick: () => void }) {
		this.host = host;
		this.btn = host.createEl("button", {
			cls: "claude-panel-summary-badge is-hidden",
		});
		this.btn.onclick = () => {
			if (this.btn.classList.contains("is-disabled")) return;
			opts.onClick();
		};
		this.renderLabel();
	}

	// 使用率 [0, 1]。null のときは非表示。`isBusy` は通常ターンまたは
	// 要約処理中で、どちらでもクリックを無効化する。
	update(usageFraction: number | null, isBusy: boolean): void {
		this.currentFraction = usageFraction;
		this.isBusy = isBusy;
		this.applyState();
	}

	// 要約処理が始まったことを別ルートから通知する。クラスとラベルを
	// 「要約中…」に切り替える。`update()` 側の `isBusy` は通常ターンと
	// 共通なので、要約中かどうかをここで明示区別する。
	setSummarizing(active: boolean): void {
		this.isSummarizing = active;
		this.applyState();
	}

	private applyState(): void {
		const f = this.currentFraction;
		const visible = typeof f === "number" && f >= THRESHOLD_WARN;
		this.btn.classList.toggle("is-hidden", !visible);
		if (!visible) {
			this.btn.classList.remove("is-warn", "is-danger", "is-disabled", "is-summarizing");
			return;
		}
		this.btn.classList.toggle("is-danger", f >= THRESHOLD_DANGER);
		this.btn.classList.toggle("is-warn", f < THRESHOLD_DANGER);
		this.btn.classList.toggle("is-disabled", this.isBusy || this.isSummarizing);
		this.btn.classList.toggle("is-summarizing", this.isSummarizing);
		this.renderLabel();
		if (typeof f === "number") {
			this.btn.setAttr(
				"aria-label",
				t("view.summarizeBadgeAria", Math.round(f * 100))
			);
		}
	}

	private renderLabel(): void {
		this.btn.textContent = this.isSummarizing
			? t("view.summarizeBadgeBusyLabel")
			: t("view.summarizeBadgeLabel");
	}
}
