import {
	ItemView,
	WorkspaceLeaf,
	TFile,
	TFolder,
	Notice,
	Scope,
	normalizePath,
	setIcon,
} from "obsidian";
import type ClaudePanelPlugin from "./main";
import {
	checkClaudeCli,
	runAgent,
	type PermissionDecision,
	type PermissionRequest,
	type RunHandle,
} from "./agent";
import {
	MODEL_PRESETS,
	PERMISSION_MODES,
	THINKING_MODES,
	formatModelLabel,
	permissionModeLabel,
	permissionModeTooltip,
	type PermissionMode,
	type ThinkingMode,
} from "./settings";
import { FilePickerModal } from "./file-picker";
import {
	SelectionCapture,
	type CapturedSelection,
} from "./selection-capture";
import { handleLocalSlashCommand, type SlashContext } from "./slash-commands";
import { openAccountUsageModal } from "./account-usage";
import {
	type ChatMessage,
	type MessageUsage,
	type RunResult,
	type SelectionRef,
	nextMsgId,
	appendText as appendTextToParts,
	pushPermission as pushPermissionToParts,
	pushTool as pushToolToParts,
	renderMessage,
	renderToolPill,
	setPermissionStatus,
} from "./chat-message";


export const VIEW_TYPE_CLAUDE_PANEL = "claude-panel-view";

export class ClaudePanelView extends ItemView {
	plugin: ClaudePanelPlugin;

	// DOM 参照（onOpen で初期化）
	private messagesEl!: HTMLDivElement;
	private inputEl!: HTMLTextAreaElement;
	private attachmentsEl!: HTMLDivElement;
	private activeFileEl!: HTMLDivElement;
	private selectionEl!: HTMLDivElement;
	private modelSelect: HTMLSelectElement | null = null;
	private thinkSelect: HTMLSelectElement | null = null;
	private permSelect: HTMLSelectElement | null = null;
	private sendBtn!: HTMLButtonElement;
	// CLI からの未解決パーミッションリクエスト（key: tool_use_id）。
	// agent 層がリクエストを転送する際に `decide(...)` コールバックを
	// 渡してくるので、view 側でここに保持し、Allow/Deny クリックで解決
	// する。/clear や cancel 時はまとめて Deny で flush する。
	private pendingPermDecisions = new Map<
		string,
		(d: PermissionDecision) => void
	>();

	// 状態
	private messages: ChatMessage[] = [];
	private attachments: string[] = []; // Vault 相対パス
	private includeActiveFile = true;
	// 直近にファイルエクスプローラーでクリックされたフォルダ。
	// 設定されている間はアクティブファイルの自動メンションを置き換え、
	// 送信時にフォルダ配下のファイルを @メンションとして展開する。
	// ファイル選択（file-open）が発生したらクリアされる。
	private activeFolderPath: string | null = null;
	private includeSelection = true;
	private busy = false;
	private currentRun: RunHandle | null = null;
	private selection!: SelectionCapture;
	// プロンプト履歴ナビゲーション（textarea 内の Up/Down キー）。
	// null = ナビゲーション中ではない。それ以外はユーザー入力履歴リストの
	// インデックスを保持。
	private historyCursor: number | null = null;
	private draftBeforeHistory = "";
	// claude CLI から得た最新のトークン使用量。コンテキストメーター
	// （ドーナツ）の表示ソース。
	private lastUsage: MessageUsage | null = null;
	private contextMeterEl: HTMLElement | null = null;
	// アクティブな claude セッション ID。設定されている場合、次のターン
	// で `--resume` 付きで起動して会話コンテキストを継続する（コンテキスト
	// が貯まり、CLI の自動コンパクションも動作する）。/clear でクリア。
	private currentSessionId: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudePanelPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CLAUDE_PANEL;
	}

	getDisplayText(): string {
		return "Claude パネル";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("claude-panel-root");
		this.applyFontSize(root);

		this.renderHeader(root);
		this.messagesEl = root.createDiv({ cls: "claude-panel-messages" });
		this.renderComposer(root);

		this.selection = new SelectionCapture(this.app, this.containerEl, () =>
			this.renderSelection()
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.renderActiveFile();
				this.selection.poll();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				// ファイル選択でアクティブフォルダは解除（相互排他）
				this.activeFolderPath = null;
				this.renderActiveFile();
				this.selection.poll();
			})
		);
		// ファイルエクスプローラーでフォルダをクリックしたら
		// activeFolderPath として記録し、アクティブファイル表示と入れ替える。
		// `.nav-folder-title` は Obsidian のファイルツリーが各フォルダに
		// 描画する要素で、`data-path` にフォルダの Vault 相対パスが入る。
		this.registerDomEvent(document, "click", (e) => {
			const titleEl = (e.target as HTMLElement | null)?.closest(
				".nav-folder-title"
			);
			if (!titleEl) return;
			const path = titleEl.getAttribute("data-path");
			if (!path) return; // ルート（path="" / null）は無視
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFolder)) return;
			this.activeFolderPath = path;
			this.renderActiveFile();
		});
		// Grace-period handoff（猶予期間の引き継ぎ）: パネル内クリックで
		// キャプチャ済みの markdown 選択を失わないようにする。これがないと
		// パネルがアクティブな leaf になった瞬間に選択が消える。
		this.registerDomEvent(this.containerEl, "pointerdown", () => {
			this.selection.markHandoff();
		});
		this.registerInterval(
			window.setInterval(() => this.selection.poll(), 250)
		);

		// ESC で実行中のエージェントを中断。プライベートな Scope を使う
		// ことで、パネルが未フォーカスの状況でも他の Obsidian ホットキー
		// が動き続けるようにしている。
		this.scope = new Scope(this.app.scope);
		this.scope.register([], "Escape", () => {
			if (this.currentRun && !this.currentRun.canceled()) {
				this.currentRun.cancel();
				return false;
			}
			return true;
		});

		await this.loadChat();

		this.renderMessages();
		this.renderActiveFile();
		this.renderAttachments();
		this.renderContextMeter();
		this.selection.poll();
	}

	async onClose(): Promise<void> {
		// 未送信のドラフトを保存しておき、次回開いた時に復元できるようにする。
		await this.saveChat();
	}

	/**
	 * プロンプト textarea にフォーカスを移す。プラグインコマンド
	 * (`Focus Claude Panel input`) から呼ばれる。先に選択範囲を再ポーリング
	 * し、handoff grace window を発動させることで、フォーカスがパネルに
	 * 移動した際のアクティブな markdown 選択の喪失を防ぐ。
	 */
	focusInput(): void {
		if (!this.inputEl) return;
		this.selection?.poll();
		this.selection?.markHandoff();
		this.inputEl.focus();
	}

	/**
	 * `settings.fontSize` をパネルルートに CSS カスタムプロパティとして
	 * 適用する。styles.css 側の cascade ルールが `--claude-panel-font-size`
	 * を読み、`em` 単位で派生サイズ（small/medium）を決定するので、1つの
	 * 設定値でパネル全体のサイズを比例制御できる。
	 * パネル open 時、および設定タブのスライダー変更時に呼ばれる。
	 */
	applyFontSize(root?: HTMLElement): void {
		const target = root ?? (this.containerEl.children[1] as HTMLElement);
		if (!target) return;
		target.style.setProperty(
			"--claude-panel-font-size",
			`${this.plugin.settings.fontSize}px`
		);
	}

	// ---- プラグインコマンド向けの公開フック（Send / Cancel / Clear） ----
	// `send`, `cancelCurrentRun`, `clearConversation` はパネル内ボタンに
	// 接続されているため private にしている。ここでは main.ts に登録された
	// コマンドコールバックから呼び出せるよう、薄いラッパーだけを公開する。
	commandSend(): void {
		void this.send();
	}
	commandCancel(): boolean {
		if (this.currentRun && !this.currentRun.canceled()) {
			this.cancelCurrentRun();
			return true;
		}
		return false;
	}
	commandClear(): void {
		this.clearConversation();
	}
	commandCycleModel(): void {
		const list = MODEL_PRESETS;
		const i = list.indexOf(this.plugin.settings.model);
		const next = list[(i + 1) % list.length];
		this.plugin.settings.model = next;
		void this.plugin.saveSettings();
		if (this.modelSelect) this.modelSelect.value = next;
		new Notice(`モデル: ${formatModelLabel(next)}`);
	}

	// ============================================================
	//   コンポーザーの構築
	// ============================================================

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "claude-panel-header" });
		header.createEl("h3", { text: "Claude パネル" });

		const meterItem = header.createDiv({
			cls: "claude-panel-meter-item",
		});
		this.contextMeterEl = meterItem.createDiv({
			cls: "claude-panel-meter-donut claude-panel-context-meter",
		});
		meterItem.createDiv({
			cls: "claude-panel-meter-label",
			text: "コンテキスト",
		});
		this.renderContextMeter();

		const accountBtn = header.createEl("button", {
			cls: "claude-panel-icon-btn claude-panel-account-btn",
			attr: { "aria-label": "アカウントと使用状況" },
		});
		setIcon(accountBtn, "user");
		accountBtn.onclick = () =>
			openAccountUsageModal(this.app, this.plugin.settings);

		const clearBtn = header.createEl("button", {
			text: "クリア",
			cls: "claude-panel-clear",
		});
		clearBtn.onclick = () => this.clearConversation();
	}

	/** 暫定でハードコード。現行 Claude 4.x モデルはすべて 200k がデフォルト。 */
	private static CONTEXT_WINDOW_TOKENS = 200_000;

	private contextTokensUsed(usage: MessageUsage | null): number {
		if (!usage) return 0;
		// モデルの入力ウィンドウを占めるトークン量。今ターン生成された
		// 出力トークンは入力には含まれないが、次ターンの入力には乗るので、
		// 「会話を続けた場合にコンテキストへ入る量」を近似するために
		// 出力トークンも含めている。
		return (
			usage.inputTokens +
			usage.cacheCreationTokens +
			usage.cacheReadTokens +
			usage.outputTokens
		);
	}

	private renderDonut(host: HTMLElement, fraction: number): void {
		host.empty();
		const f = Math.max(0, Math.min(1, fraction));
		const percent = f * 100;

		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 36 36");
		svg.classList.add("claude-panel-meter-svg");

		const bg = document.createElementNS(ns, "circle");
		bg.setAttribute("cx", "18");
		bg.setAttribute("cy", "18");
		bg.setAttribute("r", "15.9155");
		bg.setAttribute("fill", "none");
		bg.setAttribute("stroke-width", "3.5");
		bg.classList.add("claude-panel-meter-bg");
		svg.appendChild(bg);

		const fg = document.createElementNS(ns, "circle");
		fg.setAttribute("cx", "18");
		fg.setAttribute("cy", "18");
		fg.setAttribute("r", "15.9155");
		fg.setAttribute("fill", "none");
		fg.setAttribute("stroke-width", "3.5");
		fg.setAttribute("stroke-linecap", "round");
		// 円周は 2π·15.9155 ≈ 100 になるので、dasharray はそのまま % にマッピングできる。
		fg.setAttribute("stroke-dasharray", `${percent.toFixed(2)} 100`);
		fg.setAttribute("transform", "rotate(-90 18 18)");
		fg.classList.add("claude-panel-meter-fg");
		if (f >= 0.85) fg.classList.add("is-danger");
		else if (f >= 0.6) fg.classList.add("is-warn");
		svg.appendChild(fg);

		host.appendChild(svg);
	}

	private renderContextMeter(): void {
		const host = this.contextMeterEl;
		if (!host) return;
		const cap = ClaudePanelView.CONTEXT_WINDOW_TOKENS;
		const used = this.contextTokensUsed(this.lastUsage);
		this.renderDonut(host, used / cap);

		const tooltip = this.lastUsage
			? `コンテキスト: ${used.toLocaleString()} / ${cap.toLocaleString()} (${((used / cap) * 100).toFixed(0)}%)\n入力 ${this.lastUsage.inputTokens.toLocaleString()} · キャッシュ ${(this.lastUsage.cacheCreationTokens + this.lastUsage.cacheReadTokens).toLocaleString()} · 出力 ${this.lastUsage.outputTokens.toLocaleString()}`
			: "コンテキスト — 使用データはまだありません";
		// aria-label のみを使う（Obsidian がツールチップとしてレンダリングする）。
		// 同時に `title` も設定すると、Obsidian のツールチップとブラウザ標準の
		// title 吹き出しが二重に表示されてしまう。
		host.setAttr("aria-label", tooltip);
	}

	/** コンテキストメーターを再描画する（関連する設定が変わった際に
	 *  プラグイン側から呼ばれる）。 */
	refreshMeters(): void {
		this.renderContextMeter();
	}

	private renderComposer(root: HTMLElement): void {
		const composer = root.createDiv({ cls: "claude-panel-composer" });

		// レイアウト（上 → 下）: アクティブファイル → 選択範囲 → 添付 →
		// プロンプト textarea → アクションボタン → モデル/Thinking コントロール。
		this.activeFileEl = composer.createDiv({
			cls: "claude-panel-active-file",
		});
		this.selectionEl = composer.createDiv({
			cls: "claude-panel-selection is-empty",
		});
		this.attachmentsEl = composer.createDiv({
			cls: "claude-panel-attachments",
		});

		this.inputEl = composer.createEl("textarea", {
			cls: "claude-panel-input",
			attr: {
				placeholder:
					"Claude に質問... Enter=送信 · Shift+Enter=改行 · Esc=中断 · /help",
			},
		});
		this.inputEl.rows = 4;
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.send();
			} else if (e.key === "Escape" && this.busy) {
				e.preventDefault();
				this.cancelCurrentRun();
			} else if (e.key === "ArrowUp" && this.cursorOnFirstLine()) {
				e.preventDefault();
				this.historyPrev();
			} else if (e.key === "ArrowDown" && this.cursorOnLastLine()) {
				e.preventDefault();
				this.historyNext();
			}
		});
		this.inputEl.addEventListener("paste", (e) => {
			void this.handlePaste(e);
		});

		const actions = composer.createDiv({ cls: "claude-panel-actions" });
		const attachBtn = actions.createEl("button", {
			text: "添付",
			cls: "claude-panel-attach",
		});
		attachBtn.onclick = () => this.openAttachPicker();

		this.sendBtn = actions.createEl("button", {
			text: "送信",
			cls: "mod-cta claude-panel-send",
		});
		this.sendBtn.onclick = () => {
			if (this.busy) this.cancelCurrentRun();
			else this.send();
		};

		this.renderModelThinkControls(composer);
	}

	private renderModelThinkControls(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: "claude-panel-controls" });

		row.createSpan({
			cls: "claude-panel-control-label",
			text: "モデル",
		});
		const modelSelect = row.createEl("select", {
			cls: "claude-panel-control-select",
		});
		const presets = new Set(MODEL_PRESETS);
		const currentModel = this.plugin.settings.model;
		for (const m of MODEL_PRESETS) {
			modelSelect.createEl("option", {
				value: m,
				text: formatModelLabel(m),
			});
		}
		if (currentModel && !presets.has(currentModel)) {
			modelSelect.createEl("option", {
				value: currentModel,
				text: `${formatModelLabel(currentModel)} (custom)`,
			});
		}
		modelSelect.value = currentModel;
		modelSelect.onchange = async () => {
			this.plugin.settings.model = modelSelect.value;
			await this.plugin.saveSettings();
		};
		this.modelSelect = modelSelect;

		row.createSpan({
			cls: "claude-panel-control-label",
			text: "思考",
		});
		const thinkSelect = row.createEl("select", {
			cls: "claude-panel-control-select",
		});
		for (const mode of THINKING_MODES) {
			thinkSelect.createEl("option", { value: mode, text: mode });
		}
		thinkSelect.value = this.plugin.settings.thinkingMode;
		thinkSelect.onchange = async () => {
			this.plugin.settings.thinkingMode = thinkSelect.value as ThinkingMode;
			await this.plugin.saveSettings();
		};
		this.thinkSelect = thinkSelect;

		row.createSpan({
			cls: "claude-panel-control-label",
			text: "承認",
		});
		const permSelect = row.createEl("select", {
			cls: "claude-panel-control-select",
		});
		for (const m of PERMISSION_MODES) {
			permSelect.createEl("option", {
				value: m,
				text: permissionModeLabel(m),
				// オプション毎に `title` を設定し、ドロップダウンを開いた
				// 状態で各エントリにホバーするとそのモードの説明が出るようにする。
				attr: { title: permissionModeTooltip(m) },
			});
		}
		permSelect.value = this.plugin.settings.permissionMode;
		// 選択中オプションのツールチップを select 本体にも反映し、閉じた
		// 状態でホバーした時に現在のモードの説明が表示されるようにする。
		const refreshPermTooltip = () => {
			permSelect.title = permissionModeTooltip(
				permSelect.value as PermissionMode
			);
		};
		refreshPermTooltip();
		permSelect.onchange = async () => {
			this.plugin.settings.permissionMode = permSelect.value as PermissionMode;
			refreshPermTooltip();
			await this.plugin.saveSettings();
		};
		this.permSelect = permSelect;
	}

	private refreshControls(): void {
		if (this.modelSelect) {
			const m = this.plugin.settings.model;
			const has = Array.from(this.modelSelect.options).some(
				(o) => o.value === m
			);
			if (!has) {
				this.modelSelect.createEl("option", {
					value: m,
					text: `${formatModelLabel(m)} (custom)`,
				});
			}
			this.modelSelect.value = m;
		}
		if (this.thinkSelect) {
			this.thinkSelect.value = this.plugin.settings.thinkingMode;
		}
		if (this.permSelect) {
			this.permSelect.value = this.plugin.settings.permissionMode;
		}
	}

	// ============================================================
	//   アクティブファイル / 選択範囲 / 添付の描画
	// ============================================================

	private getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	private renderActiveFile(): void {
		this.activeFileEl.empty();

		// アクティブフォルダが設定されているとアクティブファイルより優先
		// （相互排他）。表示と挙動はファイルと対称。
		if (this.activeFolderPath) {
			const folder = this.app.vault.getAbstractFileByPath(
				this.activeFolderPath
			);
			if (!(folder instanceof TFolder)) {
				// 削除済み等で実体が無い場合は黙ってクリアしてフォールバック
				this.activeFolderPath = null;
			} else {
				const fileCount = this.listFolderFiles(folder.path).length;
				const label = this.activeFileEl.createSpan({
					cls: "claude-panel-active-file-label",
					text: "アクティブ:",
				});
				label.title =
					"フォルダ内のファイルを @メンションとして Claude に送ります";
				const pathEl = this.activeFileEl.createSpan({
					cls: "claude-panel-active-file-path",
					text: `${folder.path}/ ×${fileCount}`,
				});
				pathEl.title = `${folder.path} (${fileCount} ファイル)`;
				const toggle = this.activeFileEl.createEl("button", {
					cls: "claude-panel-active-file-toggle",
					text: this.includeActiveFile ? "✓ 含める" : "○ 除外",
				});
				toggle.onclick = () => {
					this.includeActiveFile = !this.includeActiveFile;
					this.renderActiveFile();
				};
				return;
			}
		}

		const file = this.getActiveFile();
		if (!file) {
			this.activeFileEl.createSpan({
				cls: "claude-panel-active-file-empty",
				text: "アクティブファイルなし",
			});
			return;
		}
		const label = this.activeFileEl.createSpan({
			cls: "claude-panel-active-file-label",
			text: "アクティブ:",
		});
		label.title = "メッセージ送信のたびに @メンションとして Claude に送られます";
		const pathEl = this.activeFileEl.createSpan({
			cls: "claude-panel-active-file-path",
			text: file.path,
		});
		pathEl.title = file.path;
		const toggle = this.activeFileEl.createEl("button", {
			cls: "claude-panel-active-file-toggle",
			text: this.includeActiveFile ? "✓ 含める" : "○ 除外",
		});
		toggle.onclick = () => {
			this.includeActiveFile = !this.includeActiveFile;
			this.renderActiveFile();
		};
	}

	private renderSelection(): void {
		this.selectionEl.empty();
		const sel = this.selection?.get() ?? null;
		if (!sel) {
			this.selectionEl.addClass("is-empty");
			return;
		}
		this.selectionEl.removeClass("is-empty");

		const charCount = sel.text.length;

		const header = this.selectionEl.createDiv({
			cls: "claude-panel-selection-header",
		});
		header.createSpan({
			cls: "claude-panel-selection-label",
			text: "選択範囲:",
		});
		header.createSpan({
			cls: "claude-panel-selection-meta",
			text: `${sel.lineCount} 行 · ${charCount} 文字 · L${sel.startLine}`,
		});
		const toggle = header.createEl("button", {
			cls: "claude-panel-selection-toggle",
			text: this.includeSelection ? "✓ 含める" : "○ 除外",
		});
		toggle.onclick = () => {
			this.includeSelection = !this.includeSelection;
			this.renderSelection();
		};

		const preview = this.selectionEl.createDiv({
			cls: "claude-panel-selection-preview",
		});
		const firstLine = sel.text.split("\n")[0];
		const truncated =
			firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
		const tail = sel.lineCount > 1 ? ` ⋯ 他 ${sel.lineCount - 1} 行` : "";
		preview.setText(truncated + tail);
		preview.title = sel.text;
	}

	private isFolderPath(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
	}

	private listFolderFiles(folderPath: string): string[] {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return [];
		const out: string[] = [];
		const walk = (f: TFolder): void => {
			for (const child of f.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile) out.push(child.path);
			}
		};
		walk(folder);
		out.sort();
		return out;
	}

	private renderAttachments(): void {
		this.attachmentsEl.empty();
		for (const path of this.attachments) {
			const isFolder = this.isFolderPath(path);
			const chip = this.attachmentsEl.createDiv({
				cls: "claude-panel-chip",
			});
			chip.createSpan({
				text: isFolder ? `@${path}/` : `@${path}`,
			});
			if (isFolder) {
				const count = this.listFolderFiles(path).length;
				chip.createSpan({
					text: ` ×${count}`,
					attr: { title: `${count} ファイル` },
				});
			}
			const x = chip.createEl("button", { text: "×" });
			x.onclick = () => {
				this.attachments = this.attachments.filter((p) => p !== path);
				this.renderAttachments();
				void this.saveChat();
			};
		}
	}

	// ============================================================
	//   添付アクション（ピッカー + クリップボードペースト）
	// ============================================================

	private openAttachPicker(): void {
		new FilePickerModal(this.app, (item) => {
			if (!this.attachments.includes(item.path)) {
				this.attachments.push(item.path);
				this.renderAttachments();
				void this.saveChat();
			}
		}).open();
	}

	private async handlePaste(e: ClipboardEvent): Promise<void> {
		const items = e.clipboardData?.items;
		if (!items) return;
		const images: File[] = [];
		for (const item of Array.from(items)) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const f = item.getAsFile();
				if (f) images.push(f);
			}
		}
		if (images.length === 0) return;
		// バイナリ文字列が textarea に貼り付けられないよう抑止する。
		e.preventDefault();
		for (const img of images) {
			try {
				const savedPath = await this.savePastedImage(img);
				if (!this.attachments.includes(savedPath)) {
					this.attachments.push(savedPath);
				}
				this.renderAttachments();
				new Notice(`貼り付け: ${savedPath}`);
			} catch (err) {
				new Notice(
					`貼り付け画像の保存に失敗: ${(err as Error).message}`
				);
			}
		}
		void this.saveChat();
	}

	// ペーストされた画像をプラグイン専用の添付フォルダ
	// (.obsidian/plugins/<id>/attachments) に保存し、Vault 相対パスを返す。
	private async savePastedImage(file: File): Promise<string> {
		const subtype = (file.type.split("/")[1] || "png").toLowerCase();
		const ext = subtype === "jpeg" ? "jpg" : subtype;
		const folder = this.plugin.getAttachmentFolder();
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(folder))) {
			await adapter.mkdir(folder);
		}
		const ts = new Date()
			.toISOString()
			.replace("T", "_")
			.replace(/[:.]/g, "-")
			.slice(0, 19);
		const filePath = normalizePath(`${folder}/clipboard-${ts}.${ext}`);
		const buf = await file.arrayBuffer();
		await adapter.writeBinary(filePath, buf);
		return filePath;
	}

	// ============================================================
	//   チャットメッセージ
	// ============================================================

	private renderMessages(): void {
		this.messagesEl.empty();
		if (this.messages.length === 0) {
			this.renderEmptyState(this.messagesEl);
			return;
		}
		for (const msg of this.messages) {
			const host = this.messagesEl.createDiv();
			renderMessage(host, msg, this.app, this, (toolUseId, decision) =>
				this.permissionDecision(toolUseId, decision)
			);
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/**
	 * メッセージが空のときに表示する案内。CLI が解決済みなら軽いウェルカム
	 * を、未検出なら未セットアップ向けの誘導カードを描画する。`checkClaudeCli`
	 * は数百ms かかるので、まず軽い表示を出してから非同期に上書きする。
	 */
	private renderEmptyState(host: HTMLElement): void {
		const card = host.createDiv({ cls: "claude-panel-empty" });
		card.createDiv({
			cls: "claude-panel-empty-title",
			text: "Claude パネルへようこそ",
		});
		const body = card.createDiv({ cls: "claude-panel-empty-body" });
		body.setText("セットアップを確認しています…");

		void checkClaudeCli(this.plugin.settings.claudePath).then((status) => {
			body.empty();
			if (status.installed && status.loggedIn) {
				body.setText(
					"下の入力欄からメッセージを送信してください。`/help` でローカルコマンド一覧を表示できます。"
				);
				return;
			}
			body.createDiv({
				cls: "claude-panel-empty-warn",
				text: !status.installed
					? "Claude CLI が見つかりません。"
					: "Claude CLI へのログインが必要です。",
			});
			const list = body.createEl("ol", { cls: "claude-panel-empty-steps" });
			if (!status.installed) {
				const step1 = list.createEl("li");
				step1.createSpan({ text: "ターミナルで次を実行: " });
				step1.createEl("code", {
					text: "npm install -g @anthropic-ai/claude-code",
				});
				const step2 = list.createEl("li");
				step2.createSpan({ text: "続けてログイン: " });
				step2.createEl("code", { text: "claude /login" });
			} else {
				const step = list.createEl("li");
				step.createSpan({ text: "ターミナルで次を実行: " });
				step.createEl("code", { text: "claude /login" });
			}
			const actions = body.createDiv({ cls: "claude-panel-empty-actions" });
			const settingsBtn = actions.createEl("button", {
				cls: "mod-cta",
				text: "設定を開く",
			});
			settingsBtn.onclick = () => {
				const setting = (this.app as any).setting;
				setting?.open?.();
				setting?.openTabById?.(this.plugin.manifest.id);
			};
			const recheckBtn = actions.createEl("button", {
				text: "再チェック",
			});
			recheckBtn.onclick = () => {
				this.renderMessages();
			};
		});
	}

	private getMessageBody(msgId: string): HTMLElement | null {
		return this.messagesEl.querySelector(
			`[data-msg-id="${msgId}"] .claude-panel-msg-text`
		) as HTMLElement | null;
	}

	/** ストリーミング中のメッセージにテキストチャンクを追記し、DOM を逐次更新する。 */
	private appendStreamingText(msgId: string, chunk: string): void {
		const msg = this.messages.find((m) => m.id === msgId);
		if (!msg) return;
		appendTextToParts(msg.parts, chunk);

		const body = this.getMessageBody(msgId);
		if (!body) return;
		const last = body.lastElementChild as HTMLElement | null;
		if (last && last.classList.contains("claude-panel-msg-text-part")) {
			last.textContent = (last.textContent || "") + chunk;
		} else {
			const span = body.createDiv({ cls: "claude-panel-msg-text-part" });
			span.textContent = chunk;
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/** ストリーミング中のメッセージにツール実行ピルを追加する。 */
	private appendStreamingTool(
		msgId: string,
		name: string,
		input: unknown
	): void {
		const msg = this.messages.find((m) => m.id === msgId);
		if (!msg) return;
		pushToolToParts(msg.parts, name, input);

		const body = this.getMessageBody(msgId);
		if (!body) return;
		renderToolPill(body, name, input);
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/**
	 * ストリーミング中のアシスタントメッセージにインラインの承認カードを
	 * 追加し、agent から渡された resolver を登録する。Allow / Deny クリック
	 * は `permissionDecision()` 経由で resolver を呼び、CLI に
	 * control_response を返す。
	 */
	private appendPermissionRequest(
		msgId: string,
		req: PermissionRequest,
		decide: (d: PermissionDecision) => void
	): void {
		const msg = this.messages.find((m) => m.id === msgId);
		if (!msg) {
			// 通常起こらないが、CLI をハングさせないよう fail-closed で拒否しておく。
			decide({ allow: false, message: "アクティブなチャットメッセージがありません。" });
			return;
		}
		this.pendingPermDecisions.set(req.toolUseId, decide);
		pushPermissionToParts(
			msg.parts,
			req.toolName,
			req.input,
			req.toolUseId,
			req.reason
		);
		this.rerenderMessage(msg);
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/**
	 * パーミッションカードの Allow/Deny クリックを処理する。決定を agent 層に
	 * 転送し、part を終了状態に更新したうえで該当メッセージを再描画する
	 * （ボタンがステータスバッジに置き換わる）。
	 */
	private permissionDecision(
		toolUseId: string,
		decision: PermissionDecision
	): void {
		const decide = this.pendingPermDecisions.get(toolUseId);
		if (!decide) return;
		this.pendingPermDecisions.delete(toolUseId);
		decide(decision);
		const msg = this.findMessageWithPermission(toolUseId);
		if (!msg) return;
		setPermissionStatus(
			msg.parts,
			toolUseId,
			decision.allow ? "approved" : "denied"
		);
		this.rerenderMessage(msg);
	}

	/** 未解決のパーミッションカードをすべてキャンセルする。CLI に
	 *  Deny+interrupt を送り、UI 上のステータスを "denied" に更新する。
	 *  cancel 処理および /clear から呼ばれる。 */
	private flushPendingPermissions(reason = "実行を中断しました。"): void {
		for (const [toolUseId, decide] of this.pendingPermDecisions) {
			decide({ allow: false, message: reason, interrupt: true });
			const msg = this.findMessageWithPermission(toolUseId);
			if (msg) {
				setPermissionStatus(msg.parts, toolUseId, "denied");
				this.rerenderMessage(msg);
			}
		}
		this.pendingPermDecisions.clear();
	}

	private findMessageWithPermission(toolUseId: string): ChatMessage | null {
		for (const m of this.messages) {
			for (const p of m.parts) {
				if (p.type === "permission" && p.toolUseId === toolUseId) {
					return m;
				}
			}
		}
		return null;
	}

	private rerenderMessage(msg: ChatMessage): void {
		const host = this.messagesEl.querySelector(
			`[data-msg-id="${msg.id}"]`
		) as HTMLElement | null;
		if (host) {
			renderMessage(host, msg, this.app, this, (toolUseId, decision) =>
				this.permissionDecision(toolUseId, decision)
			);
		}
	}

	/**
	 * ラン結果を保存する。フッターの実描画は finalizeStreamingMessage
	 * 側で1度だけ行う（メッセージ全体のコンテキストが必要なため）。
	 */
	private setMessageResult(msgId: string, result: RunResult): void {
		const msg = this.messages.find((m) => m.id === msgId);
		if (!msg) return;
		msg.result = result;
	}

	private finalizeStreamingMessage(msgId: string): void {
		const msg = this.messages.find((m) => m.id === msgId);
		if (!msg) return;
		msg.streaming = false;
		const host = this.messagesEl.querySelector(
			`[data-msg-id="${msgId}"]`
		) as HTMLElement | null;
		if (host) {
			renderMessage(host, msg, this.app, this, (toolUseId, decision) =>
				this.permissionDecision(toolUseId, decision)
			);
		}
	}

	private appendSystemMessage(text: string): void {
		this.messages.push({
			id: nextMsgId(),
			role: "system",
			parts: [{ type: "text", text }],
		});
		this.renderMessages();
	}

	private appendInteractiveSystemMessage(
		render: (container: HTMLElement) => void
	): void {
		this.messages.push({
			id: nextMsgId(),
			role: "system",
			parts: [],
			interactive: render,
		});
		this.renderMessages();
	}

	private clearConversation(): void {
		// 表示中の会話だけクリアする。コンテキストドーナツの値は保持する
		// （Clear ボタンでメーターまで消えないようにユーザーから明確に
		// 要望があったため）。セッション ID は破棄するので、次のターンは
		// 新しい claude セッションで開始される。
		this.flushPendingPermissions("会話をクリアしました。");
		this.messages = [];
		this.attachments = [];
		this.currentSessionId = null;
		this.renderMessages();
		this.renderAttachments();
		void this.saveChat();
	}

	// ============================================================
	//   Send / cancel（送信・キャンセル）
	// ============================================================

	private setBusy(busy: boolean): void {
		this.busy = busy;
		if (busy) {
			this.sendBtn.removeClass("mod-cta");
			this.sendBtn.addClass("mod-warning");
			this.sendBtn.setText("停止 (Esc)");
		} else {
			this.sendBtn.removeClass("mod-warning");
			this.sendBtn.addClass("mod-cta");
			this.sendBtn.setText("送信");
		}
		this.sendBtn.disabled = false;
	}

	private cancelCurrentRun(): void {
		if (this.currentRun && !this.currentRun.canceled()) {
			this.currentRun.cancel();
		}
	}

	private slashContext(): SlashContext {
		return {
			plugin: this.plugin,
			getVaultPath: () => this.getVaultPath(),
			clearConversation: () => this.clearConversation(),
			refreshControls: () => this.refreshControls(),
			appendSystemMessage: (text) => this.appendSystemMessage(text),
			appendInteractive: (render) =>
				this.appendInteractiveSystemMessage(render),
			openAccountUsage: () =>
				openAccountUsageModal(this.app, this.plugin.settings),
		};
	}

	private async send(): Promise<void> {
		if (this.busy) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		if (text.startsWith("/")) {
			if (handleLocalSlashCommand(this.slashContext(), text)) {
				this.inputEl.value = "";
				return;
			}
		}

		const cwd = this.getVaultPath();
		if (!cwd) {
			new Notice("Vault のパスを解決できません（デスクトップ版のみ対応）。");
			return;
		}

		const composed = this.composeMessage(text);

		this.messages.push(
			{
				id: nextMsgId(),
				role: "user",
				mentions: composed.mentions.length
					? composed.mentions
					: undefined,
				selectionRef: composed.selectionRef,
				parts: [{ type: "text", text: composed.body }],
				inputText: text,
			},
			{
				id: nextMsgId(),
				role: "assistant",
				parts: [],
				streaming: true,
			}
		);
		this.historyCursor = null;
		const assistantMsgId = this.messages[this.messages.length - 1].id;
		this.renderMessages();

		this.inputEl.value = "";
		this.attachments = [];
		this.renderAttachments();
		this.setBusy(true);

		const runOnce = async (
			sessionId: string | undefined
		): Promise<{ canceled: boolean; errorMessage: string }> => {
			let errorMessage = "";
			const handle = runAgent(
				{
					prompt: composed.fullPrompt,
					cwd,
					settings: this.plugin.settings,
					sessionId,
				},
				{
					onText: (chunk) =>
						this.appendStreamingText(assistantMsgId, chunk),
					onToolUse: (name, input) =>
						this.appendStreamingTool(assistantMsgId, name, input),
					onPermissionRequest: (req, decide) =>
						this.appendPermissionRequest(
							assistantMsgId,
							req,
							decide
						),
					onResult: ({ durationMs, costUsd, sessionId: newSession }) => {
						this.setMessageResult(assistantMsgId, {
							durationMs,
							costUsd,
						});
						if (newSession) this.currentSessionId = newSession;
					},
					onUsage: (usage) => {
						const msg = this.messages.find(
							(m) => m.id === assistantMsgId
						);
						if (msg) msg.usage = usage;
						this.lastUsage = usage;
						this.renderContextMeter();
					},
					onError: (err) => {
						errorMessage = err.message;
						this.appendStreamingText(
							assistantMsgId,
							`\n\n**エラー:** ${err.message}`
						);
					},
				}
			);
			this.currentRun = handle;
			await handle.promise;
			const canceled = handle.canceled();
			if (canceled) {
				this.flushPendingPermissions("ユーザーが実行を中断しました。");
				this.appendStreamingText(
					assistantMsgId,
					"\n\n_**[ユーザーが中断しました]**_"
				);
			} else {
				// 自然終了。残った pending（通常は発生しないがフェイルセーフ）
				// はもう古いので、ここでまとめて Deny で flush しておく。
				this.flushPendingPermissions("実行終了。");
			}
			this.currentRun = null;
			return { canceled, errorMessage };
		};

		const first = await runOnce(this.currentSessionId ?? undefined);

		// CLI 側でセッションが失われることがある（クリーンアップ、期限切れ、
		// ~/.claude/sessions の手動編集など）。--resume が存在しない
		// セッションを指したときの唯一の復旧策はリセットしてやり直すこと。
		// 保存していたセッション ID を破棄し、--resume なしで1度だけ再実行
		// することで、ユーザーが手動でリトライしなくても済むようにする。
		if (
			!first.canceled &&
			this.currentSessionId &&
			/No conversation found with session ID/i.test(first.errorMessage)
		) {
			this.currentSessionId = null;
			const msg = this.messages.find((m) => m.id === assistantMsgId);
			if (msg) {
				// resume 失敗のエラーメッセージを消去する。これがないと
				// リトライの出力が古い赤バナーの下に描画されてしまう。
				msg.parts = [];
				msg.streaming = true;
				msg.result = undefined;
				msg.usage = undefined;
				this.rerenderMessage(msg);
			}
			await runOnce(undefined);
		}

		this.finalizeStreamingMessage(assistantMsgId);
		this.setBusy(false);

		void this.saveChat();
	}

	// ============================================================
	//   プロンプト履歴（textarea 内のシェル風 Up/Down ナビゲーション）
	// ============================================================

	private cursorOnFirstLine(): boolean {
		const pos = this.inputEl.selectionStart;
		if (pos === null) return false;
		return this.inputEl.value.slice(0, pos).indexOf("\n") === -1;
	}

	private cursorOnLastLine(): boolean {
		const pos = this.inputEl.selectionStart;
		if (pos === null) return false;
		return this.inputEl.value.slice(pos).indexOf("\n") === -1;
	}

	private getHistory(): string[] {
		const out: string[] = [];
		for (const m of this.messages) {
			if (m.role === "user" && typeof m.inputText === "string") {
				out.push(m.inputText);
			}
		}
		return out;
	}

	private setInputFromHistory(text: string): void {
		this.inputEl.value = text;
		const len = text.length;
		this.inputEl.setSelectionRange(len, len);
	}

	private historyPrev(): void {
		const history = this.getHistory();
		if (history.length === 0) return;
		if (this.historyCursor === null) {
			this.draftBeforeHistory = this.inputEl.value;
			this.historyCursor = history.length;
		}
		const next = Math.max(0, this.historyCursor - 1);
		this.historyCursor = next;
		this.setInputFromHistory(history[next]);
	}

	private historyNext(): void {
		if (this.historyCursor === null) return;
		const history = this.getHistory();
		const next = this.historyCursor + 1;
		if (next >= history.length) {
			this.historyCursor = null;
			this.setInputFromHistory(this.draftBeforeHistory);
		} else {
			this.historyCursor = next;
			this.setInputFromHistory(history[next]);
		}
	}

	// ============================================================
	//   チャットの永続化（Obsidian 再起動を跨いで会話を保持する）。
	//   保存先: .obsidian/plugins/<id>/chat.json
	// ============================================================

	private chatStatePath(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/chat.json`
		);
	}

	private async saveChat(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			const persisted = {
				version: 1,
				// interactive メッセージ（スラッシュコマンドの UI 出力等）は
				// コールバック関数を含むためシリアライズできない上、そもそも
				// 一時的なものなので保存対象から除外する。
				messages: this.messages
					.filter((m) => !m.interactive)
					.map((m) => ({
						id: m.id,
						role: m.role,
						parts: m.parts,
						mentions: m.mentions,
						selectionRef: m.selectionRef,
						result: m.result,
						inputText: m.inputText,
						usage: m.usage,
					})),
				attachments: this.attachments,
				draft: this.inputEl?.value ?? "",
				lastUsage: this.lastUsage,
				currentSessionId: this.currentSessionId,
			};
			await adapter.write(
				this.chatStatePath(),
				JSON.stringify(persisted)
			);
		} catch {
			/* ベストエフォート永続化 — ディスクエラーで UI をブロックしない */
		}
	}

	private async loadChat(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const path = this.chatStatePath();
		try {
			if (!(await adapter.exists(path))) return;
			const raw = await adapter.read(path);
			const data = JSON.parse(raw) as {
				messages?: ChatMessage[];
				attachments?: string[];
				draft?: string;
				lastUsage?: MessageUsage;
				currentSessionId?: string | null;
			};
			if (Array.isArray(data.messages)) {
				this.messages = data.messages.map((m) => ({
					...m,
					streaming: false,
					// 前回保存時に pending のままだったパーミッションカードは
					// もう古い（発行元の agent ランは消滅している）ので、
					// denied 表示で復元する。
					parts: m.parts.map((p) =>
						p.type === "permission" && p.status === "pending"
							? { ...p, status: "denied" as const }
							: p
					),
				}));
			}
			if (typeof data.currentSessionId === "string") {
				this.currentSessionId = data.currentSessionId;
			}
			if (Array.isArray(data.attachments)) {
				// 既に存在しないパスは除去する（前回 unload 時にクリップボード
				// 画像が削除されているケース等）。
				const live: string[] = [];
				for (const p of data.attachments) {
					if (await adapter.exists(p)) live.push(p);
				}
				this.attachments = live;
			}
			if (typeof data.draft === "string" && this.inputEl) {
				this.inputEl.value = data.draft;
			}
			if (data.lastUsage) {
				this.lastUsage = data.lastUsage;
			}
		} catch {
			/* ファイル破損 — 新規状態で開始し、ユーザーには通知しない */
		}
	}

	/**
	 * 送信用プロンプトとユーザーメッセージバブル描画用のメタデータを
	 * 組み立てる。バブルには添付ファイルごとにメンションチップ、選択範囲
	 * チップ（ファイル名・行情報のみ、本文は含めない）を表示する。
	 * 選択範囲の本文は `fullPrompt` 側にだけ含めて claude に送る。
	 */
	private composeMessage(userText: string): {
		mentions: string[];
		selectionRef: SelectionRef | undefined;
		body: string;
		fullPrompt: string;
	} {
		const isSlash = userText.startsWith("/");

		// 表示用ラベル（フォルダは末尾 `/` 付きで1チップ）と、CLI に渡す
		// 展開済みファイルパスを別々に組み立てる。
		const mentionLabels: string[] = [];
		const promptPaths: string[] = [];
		const addMention = (path: string, isFolder: boolean): void => {
			const label = isFolder ? `${path}/` : path;
			if (!mentionLabels.includes(label)) mentionLabels.push(label);
			if (isFolder) {
				for (const child of this.listFolderFiles(path)) {
					if (!promptPaths.includes(child)) promptPaths.push(child);
				}
			} else if (!promptPaths.includes(path)) {
				promptPaths.push(path);
			}
		};
		if (!isSlash) {
			// アクティブフォルダがあればフォルダを優先（相互排他）。
			if (this.includeActiveFile && this.activeFolderPath) {
				const folder = this.app.vault.getAbstractFileByPath(
					this.activeFolderPath
				);
				if (folder instanceof TFolder) {
					addMention(folder.path, true);
				}
			} else if (this.includeActiveFile) {
				const activeFile = this.getActiveFile();
				if (activeFile) addMention(activeFile.path, false);
			}
			for (const fp of this.attachments) {
				addMention(fp, this.isFolderPath(fp));
			}
		}

		const thinkPrefix =
			!isSlash && this.plugin.settings.thinkingMode !== "off"
				? `${this.plugin.settings.thinkingMode}: `
				: "";

		const sel =
			!isSlash && this.includeSelection
				? this.selection?.get() ?? null
				: null;
		const selectionBlock = sel ? formatSelectionBlock(sel) : "";
		const selectionRef: SelectionRef | undefined = sel
			? {
					filePath: sel.filePath,
					startLine: sel.startLine,
					lineCount: sel.lineCount,
				}
			: undefined;

		// バブルに表示する本文: ユーザーが入力したテキストのみ（必要なら
		// thinking-mode プレフィックス付き）。選択範囲の本文は除外し、
		// 引用ブロックが UI を埋め尽くさないようにする。
		const body = `${thinkPrefix}${userText}`;

		// claude に送るフルプロンプト: メンション + 選択ブロックを含む。
		const promptBody = `${selectionBlock}${thinkPrefix}${userText}`;
		const mentionsStr = promptPaths.map((p) => `@${p}`).join(" ");
		const fullPrompt = mentionsStr
			? `${mentionsStr}\n\n${promptBody}`
			: promptBody;

		return { mentions: mentionLabels, selectionRef, body, fullPrompt };
	}

	private getVaultPath(): string | null {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
			basePath?: string;
		};
		return adapter.getBasePath?.() ?? adapter.basePath ?? null;
	}
}

function formatSelectionBlock(sel: CapturedSelection | null): string {
	if (!sel) return "";
	const src = sel.filePath
		? `（出典: \`${sel.filePath}\` L${sel.startLine}）`
		: "";
	return `選択範囲${src}:\n\`\`\`\n${sel.text}\n\`\`\`\n\n`;
}
