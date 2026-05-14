import {
	SLASH_COMMANDS,
	type SlashCategory,
	type SlashCommandSpec,
} from "./slash-commands";
import { t } from "./i18n";

/**
 * プロンプト textarea の上に浮かぶスラッシュコマンド候補ポップアップ。
 * 入力欄の最初の行が "/foo" のように `/` で始まり空白を含まない場合のみ
 * 表示する。空白を入力した（=コマンド名を打ち終えた）時点で閉じる。
 *
 * キー操作:
 *   ArrowUp / ArrowDown — 候補を移動
 *   Tab / Enter         — 選択中の候補を入力欄に挿入し、popup を閉じる
 *   Escape              — popup を閉じる（実行中エージェントのキャンセルは
 *                         popup が閉じている時の view 側ハンドラに委ねる）
 *
 * `handleKey` は popup が表示中で、かつそのキーを消費した場合に true を
 * 返す。view 側の keydown ハンドラはこれを見て、true なら自前のロジック
 * (Enter で送信、Up/Down で履歴ナビゲーション等) をスキップする。
 */
export class SlashSuggest {
	private host: HTMLElement;
	private input: HTMLTextAreaElement;
	private items: { spec: SlashCommandSpec; el: HTMLElement }[] = [];
	private selected = 0;
	private visible = false;
	// 動的に発見されたスキル / ユーザーコマンド（view が onOpen で注入する）。
	// ハードコードの SLASH_COMMANDS と名前が衝突したものはここから除外する。
	private extras: SlashCommandSpec[] = [];

	constructor(host: HTMLElement, input: HTMLTextAreaElement) {
		this.host = host;
		this.input = input;
		this.host.addClass("claude-panel-suggest");
		this.host.addClass("is-hidden");

		this.input.addEventListener("input", () => this.update());
		// 候補項目クリックは textarea の blur と競合するので mousedown 段階で
		// 拾う（focus が抜ける前に処理を確定させたい）。各 row 側で実装。
		this.input.addEventListener("blur", () => {
			// クリック直後に閉じると、mousedown→click→blur の順で blur が
			// 先回りしてクリックが届かなくなる。120ms の grace を置く。
			window.setTimeout(() => this.close(), 120);
		});
	}

	/**
	 * 動的に発見されたコマンド（スキル / ユーザーコマンド）を差し替える。
	 * ハードコードの SLASH_COMMANDS と名前が衝突したものは静かに除外する
	 * （ハードコード側の説明・カテゴリの方が正確なので優先する）。
	 */
	setExtraCommands(specs: SlashCommandSpec[]): void {
		const reserved = new Set(SLASH_COMMANDS.map((c) => c.name));
		this.extras = specs.filter((s) => !reserved.has(s.name));
	}

	/** popup の表示/非表示を入力値に応じて更新する。 */
	update(): void {
		const value = this.input.value;
		const firstLine = value.split("\n")[0];
		// `/` で始まり、空白も改行も含まない短いトークンのみ対象。
		const m = firstLine.match(/^\/([^\s]*)$/);
		if (!m) {
			this.close();
			return;
		}
		const term = m[1].toLowerCase();
		const all = [...SLASH_COMMANDS, ...this.extras];
		const matches = all
			.filter((c) => c.name.slice(1).toLowerCase().startsWith(term))
			.slice(0, 12);
		if (matches.length === 0) {
			this.close();
			return;
		}
		this.render(matches);
		this.visible = true;
		this.host.removeClass("is-hidden");
	}

	/**
	 * 入力欄上の keydown を popup が処理した場合 true を返す（呼び出し側は
	 * 通常のキーバインドをスキップする）。popup 非表示時は常に false。
	 */
	handleKey(e: KeyboardEvent): boolean {
		if (!this.visible) return false;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.move(1);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			this.move(-1);
			return true;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			this.accept();
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			this.close();
			return true;
		}
		return false;
	}

	close(): void {
		if (!this.visible && !this.host.children.length) return;
		this.visible = false;
		this.host.addClass("is-hidden");
		this.host.empty();
		this.items = [];
		this.selected = 0;
	}

	private render(matches: SlashCommandSpec[]): void {
		this.host.empty();
		this.items = [];
		if (this.selected >= matches.length) this.selected = 0;
		if (this.selected < 0) this.selected = 0;
		for (let i = 0; i < matches.length; i++) {
			const spec = matches[i];
			const row = this.host.createDiv({
				cls: "claude-panel-suggest-item",
			});
			row.dataset.cat = spec.category;
			row.createSpan({
				cls: "claude-panel-suggest-name",
				text: spec.name,
			});
			row.createSpan({
				cls: "claude-panel-suggest-desc",
				text: spec.desc,
			});
			row.createSpan({
				cls: "claude-panel-suggest-cat",
				text: catLabel(spec.category),
			});
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.selected = i;
				this.accept();
			});
			row.addEventListener("mouseenter", () => {
				this.selected = i;
				this.applySelection();
			});
			this.items.push({ spec, el: row });
		}
		this.applySelection();
	}

	private move(d: number): void {
		if (this.items.length === 0) return;
		this.selected =
			(this.selected + d + this.items.length) % this.items.length;
		this.applySelection();
	}

	private applySelection(): void {
		for (let i = 0; i < this.items.length; i++) {
			this.items[i].el.toggleClass(
				"is-selected",
				i === this.selected
			);
		}
		this.items[this.selected]?.el.scrollIntoView({ block: "nearest" });
	}

	private accept(): void {
		const item = this.items[this.selected];
		if (!item) return;
		const value = this.input.value;
		const newlineIdx = value.indexOf("\n");
		const rest = newlineIdx >= 0 ? value.slice(newlineIdx) : "";
		// コマンド名 + 空白を入れて、続けて引数を打てる位置にカーソルを置く。
		const inserted = item.spec.name + " ";
		this.input.value = inserted + rest;
		const pos = inserted.length;
		this.input.setSelectionRange(pos, pos);
		this.input.focus();
		this.close();
	}
}

function catLabel(cat: SlashCategory): string {
	switch (cat) {
		case "local":
			return t("slash.category.local");
		case "repl-only":
			return t("slash.category.replOnly");
		case "passthrough":
			return t("slash.category.passthrough");
		case "skill":
			return t("slash.category.skill");
		case "user-command":
			return t("slash.category.userCommand");
	}
}
