/**
 * textarea 上でシェル風の Up/Down キーによる履歴ナビをするヘルパー。
 *
 * カーソルが最上行なら Up で過去のユーザー入力を、最下行なら Down で
 * 進めるように呼び出す（Up/Down のヒット判定は呼び出し側のキーハンドラ
 * で `cursorOnFirstLine()` / `cursorOnLastLine()` を使って決める）。
 *
 * 履歴一覧は `getHistory()` コールバック経由で都度取得する — 履歴は
 * チャットメッセージから派生するので、キャッシュより常に最新を引いた
 * 方が一貫性が取れる。
 */
export class PromptHistory {
	private cursor: number | null = null;
	private draft = "";

	constructor(
		private readonly inputEl: HTMLTextAreaElement,
		private readonly getHistory: () => string[]
	) {}

	/** ナビ状態を初期化する。送信時など、現在の入力をクリアした直後に呼ぶ。 */
	reset(): void {
		this.cursor = null;
	}

	cursorOnFirstLine(): boolean {
		const pos = this.inputEl.selectionStart;
		if (pos === null) return false;
		return this.inputEl.value.slice(0, pos).indexOf("\n") === -1;
	}

	cursorOnLastLine(): boolean {
		const pos = this.inputEl.selectionStart;
		if (pos === null) return false;
		return this.inputEl.value.slice(pos).indexOf("\n") === -1;
	}

	prev(): void {
		const history = this.getHistory();
		if (history.length === 0) return;
		if (this.cursor === null) {
			// ナビ開始時に下書きを退避。Down で末尾を超えたら復元する。
			this.draft = this.inputEl.value;
			this.cursor = history.length;
		}
		const next = Math.max(0, this.cursor - 1);
		this.cursor = next;
		this.setInput(history[next]);
	}

	next(): void {
		if (this.cursor === null) return;
		const history = this.getHistory();
		const next = this.cursor + 1;
		if (next >= history.length) {
			this.cursor = null;
			this.setInput(this.draft);
		} else {
			this.cursor = next;
			this.setInput(history[next]);
		}
	}

	private setInput(text: string): void {
		this.inputEl.value = text;
		const len = text.length;
		this.inputEl.setSelectionRange(len, len);
	}
}
