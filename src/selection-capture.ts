import { App, MarkdownView } from "obsidian";

export interface CapturedSelection {
	text: string;
	filePath: string | null;
	lineCount: number;
	startLine: number;
}

/**
 * アクティブな markdown ビューの選択範囲（編集モード／プレビューモード両方）
 * をポーリングし、フォーカスが移動しても直近の選択を保持する。
 *
 * ユーザーがチャットパネルの textarea をクリックすると通常は markdown
 * 選択が失われる。`markHandoff()` を呼ぶと 1.5 秒の grace window が開き、
 * その間は直前にキャプチャ済みの選択を保持する。
 */
export class SelectionCapture {
	private stored: CapturedSelection | null = null;
	private handoffUntil: number | null = null;

	constructor(
		private app: App,
		private panelEl: HTMLElement,
		private onChange: () => void
	) {}

	get(): CapturedSelection | null {
		return this.stored;
	}

	clear(): void {
		if (this.stored === null) return;
		this.stored = null;
		this.onChange();
	}

	/** grace window を開き、パネル内のクリックで選択範囲が失われないようにする。 */
	markHandoff(): void {
		if (this.stored) {
			this.handoffUntil = Date.now() + 1500;
		}
	}

	/** アクティブな markdown ビューの選択範囲を読み取る。250ms 間隔で呼ばれる。 */
	poll(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		// パス A: アクティブな markdown ビューが存在 — 現在の選択を読む。
		if (view) {
			const captured = this.captureFromView(view);
			if (captured) {
				this.handoffUntil = null;
				if (!sameSelection(this.stored, captured)) {
					this.stored = captured;
					this.onChange();
				}
				return;
			}
			// markdown ビューはあるが選択は無い — 「クリアするかも」の分岐へ落とす。
		}

		// パス B: 現時点で使える選択は無い。直前にキャプチャした選択を保持
		// するか破棄するかを判断する（パネル内にフォーカスがあるか、または
		// grace window 内なら保持）。
		if (!this.stored) return;
		if (this.isFocusInPanel()) {
			this.handoffUntil = null;
			return;
		}
		if (this.handoffUntil !== null && Date.now() <= this.handoffUntil) {
			return;
		}
		this.handoffUntil = null;
		this.stored = null;
		this.onChange();
	}

	private captureFromView(view: MarkdownView): CapturedSelection | null {
		let text = "";
		let startLine = 1;
		try {
			if (view.getMode?.() === "preview") {
				const sel = document.getSelection();
				const containerEl = view.containerEl;
				if (sel && containerEl) {
					const a = sel.anchorNode;
					const f = sel.focusNode;
					if (
						(a && containerEl.contains(a)) ||
						(f && containerEl.contains(f))
					) {
						text = sel.toString();
					}
				}
			} else if (view.editor) {
				text = view.editor.getSelection();
				if (text.trim()) {
					startLine = view.editor.getCursor("from").line + 1;
				}
			}
		} catch {
			/* noop */
		}
		if (!text.trim()) return null;
		return {
			text,
			filePath: view.file?.path ?? null,
			lineCount: text.split(/\r?\n/).length,
			startLine,
		};
	}

	private isFocusInPanel(): boolean {
		const ae = document.activeElement;
		return !!ae && this.panelEl.contains(ae);
	}
}

function sameSelection(
	a: CapturedSelection | null,
	b: CapturedSelection
): boolean {
	if (!a) return false;
	return (
		a.text === b.text &&
		a.filePath === b.filePath &&
		a.startLine === b.startLine
	);
}
