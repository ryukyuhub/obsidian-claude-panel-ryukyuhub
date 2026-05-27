import { App, Modal } from "obsidian";
import { t } from "./i18n";

// 要約バッジクリック時に出す確認モーダル。
// Yes で onConfirm() が呼ばれ、Cancel または ×・Esc で何もせず閉じる。
// モーダルを閉じる時点ではすでに onConfirm が呼ばれた後 — 呼び出し側で
// 非同期処理を進めるか待機するかは決めてよい(本プラグインでは
// fire-and-forget で view 側が requestSummaryAndReset を呼ぶ)。
export class SummaryConfirmModal extends Modal {
	private usageFraction: number;
	private onConfirm: () => void;

	constructor(
		app: App,
		opts: { usageFraction: number; onConfirm: () => void }
	) {
		super(app);
		this.usageFraction = opts.usageFraction;
		this.onConfirm = opts.onConfirm;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("claude-panel-summary-modal");
		contentEl.empty();

		contentEl.createEl("h3", { text: t("view.summarizeModalTitle") });

		const percent = Math.round(this.usageFraction * 100);
		contentEl.createEl("p", {
			text: t("view.summarizeModalBody", percent),
		});

		const buttons = contentEl.createDiv({
			cls: "claude-panel-summary-modal-actions",
		});
		const cancelBtn = buttons.createEl("button", {
			text: t("view.summarizeModalCancel"),
		});
		cancelBtn.onclick = () => this.close();

		const confirmBtn = buttons.createEl("button", {
			cls: "mod-cta",
			text: t("view.summarizeModalConfirm"),
		});
		confirmBtn.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
