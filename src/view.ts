import {
	ItemView,
	WorkspaceLeaf,
	TFile,
	TFolder,
	Notice,
	Scope,
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
	EFFORT_LEVELS,
	MODEL_PRESETS,
	PERMISSION_MODES,
	THINKING_MODES,
	formatModelLabel,
	permissionModeLabel,
	permissionModeTooltip,
	type EffortLevel,
	type PermissionMode,
	type ThinkingMode,
} from "./settings";
import {
	SelectionCapture,
	type CapturedSelection,
} from "./selection-capture";
import {
	extractPastedImages,
	pickFilesViaDialog,
	savePastedImage,
} from "./attachments";
import { CompletionNotifier } from "./completion-notifier";
import { ContextMeter } from "./context-meter";
import {
	loadChat as persistLoadChat,
	saveChat as persistSaveChat,
} from "./chat-persistence";
import { PromptHistory } from "./prompt-history";
import { handleLocalSlashCommand, type SlashContext } from "./slash-commands";
import { SlashSuggest } from "./slash-suggest";
import { openAccountUsageModal } from "./account-usage";
import * as nodePath from "path";
import * as nodeFs from "fs";
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
	private effortSelect: HTMLSelectElement | null = null;
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
	// state は PromptHistory に持たせている。inputEl 構築後に初期化。
	private history!: PromptHistory;
	// `/` で始まる入力に対するコマンド候補ポップアップ。inputEl 構築後に初期化。
	private slashSuggest!: SlashSuggest;
	// claude CLI から得た最新のトークン使用量。コンテキストメーター
	// （ドーナツ）の表示ソース。
	private lastUsage: MessageUsage | null = null;
	private contextMeter: ContextMeter | null = null;
	// アクティブな claude セッション ID。設定されている場合、次のターン
	// で `--resume` 付きで起動して会話コンテキストを継続する（コンテキスト
	// が貯まり、CLI の自動コンパクションも動作する）。/clear でクリア。
	private currentSessionId: string | null = null;
	// 応答完了通知（フラッシュ・ビープ）。state を view に持つと肥大化する
	// ので CompletionNotifier に切り出している。view からはモードと panel
	// root を引き渡すだけ。
	private notifier!: CompletionNotifier;

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

	/** ItemView ライフサイクル中は不変なので、毎回キャストせず一箇所に集約。 */
	private panelRoot(): HTMLElement {
		return this.containerEl.children[1] as HTMLElement;
	}

	async onOpen(): Promise<void> {
		const root = this.panelRoot();
		root.empty();
		root.addClass("claude-panel-root");
		this.applyFontSize(root);

		this.renderHeader(root);
		this.messagesEl = root.createDiv({ cls: "claude-panel-messages" });
		this.renderComposer(root);

		this.selection = new SelectionCapture(this.app, this.containerEl, () =>
			this.renderSelection()
		);
		this.notifier = new CompletionNotifier({
			getMode: () => this.plugin.settings.notifyOnComplete,
			getVolume: () => this.plugin.settings.notifySoundVolume,
			getSoundPath: () => this.plugin.settings.notifySoundPath,
			panelRoot: root,
		});

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
		this.contextMeter?.update(this.lastUsage);
		this.selection.poll();
	}

	async onClose(): Promise<void> {
		// 未送信のドラフトを保存しておき、次回開いた時に復元できるようにする。
		await this.saveChat();
		this.notifier?.dispose();
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
	 * 設定タブの「テスト再生」ボタンから呼ばれる。現在の音量・音声ファイル
	 * 設定で完了通知音を 1 回鳴らす。通知モードに依らず必ず再生する。
	 */
	testNotificationSound(): void {
		this.notifier?.playTest();
	}

	/**
	 * `settings.fontSize` をパネルルートに CSS カスタムプロパティとして
	 * 適用する。styles.css 側の cascade ルールが `--claude-panel-font-size`
	 * を読み、`em` 単位で派生サイズ（small/medium）を決定するので、1つの
	 * 設定値でパネル全体のサイズを比例制御できる。
	 * パネル open 時、および設定タブのスライダー変更時に呼ばれる。
	 */
	applyFontSize(root?: HTMLElement): void {
		const target = root ?? this.panelRoot();
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
		const meterHost = meterItem.createDiv({
			cls: "claude-panel-meter-donut claude-panel-context-meter",
		});
		meterItem.createDiv({
			cls: "claude-panel-meter-label",
			text: "コンテキスト",
		});
		this.contextMeter = new ContextMeter(meterHost);
		this.contextMeter.update(this.lastUsage);

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

	/** コンテキストメーターを再描画する（関連する設定が変わった際に
	 *  プラグイン側から呼ばれる）。 */
	refreshMeters(): void {
		this.contextMeter?.update(this.lastUsage);
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

		// textarea とサジェスト popup を同じ relative 親に入れて、popup を
		// 入力欄の真上にオーバレイする。composer 全体を relative にすると
		// 他の絶対配置要素（モデルセレクト等）に影響するため避ける。
		const inputWrap = composer.createDiv({
			cls: "claude-panel-input-wrap",
		});
		const suggestEl = inputWrap.createDiv({
			cls: "claude-panel-suggest is-hidden",
		});
		this.inputEl = inputWrap.createEl("textarea", {
			cls: "claude-panel-input",
			attr: {
				placeholder:
					"Claude に質問... Enter=送信 · Shift+Enter=改行 · Esc=中断 · /help",
			},
		});
		this.inputEl.rows = 4;
		this.slashSuggest = new SlashSuggest(suggestEl, this.inputEl);
		this.history = new PromptHistory(this.inputEl, () =>
			this.collectInputHistory()
		);
		this.inputEl.addEventListener("keydown", (e) => {
			// サジェスト popup が開いている場合は、popup のキーバインドを
			// 優先させる（Enter で送信 / Up,Down で履歴より先に処理する）。
			if (this.slashSuggest.handleKey(e)) return;
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.send();
			} else if (e.key === "Escape" && this.busy) {
				e.preventDefault();
				this.cancelCurrentRun();
			} else if (e.key === "ArrowUp" && this.history.cursorOnFirstLine()) {
				e.preventDefault();
				this.history.prev();
			} else if (
				e.key === "ArrowDown" &&
				this.history.cursorOnLastLine()
			) {
				e.preventDefault();
				this.history.next();
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
		attachBtn.onclick = () => void this.openAttachPicker();

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
			text: "Effort",
		});
		const effortSelect = row.createEl("select", {
			cls: "claude-panel-control-select",
			attr: {
				title:
					"対応モデル（Sonnet 4.6 / Opus 4.6 など）の推論密度。auto は CLI / ~/.claude/settings.json の既定値に委譲。Haiku は非対応のため指定は無視されます。",
			},
		});
		for (const e of EFFORT_LEVELS) {
			effortSelect.createEl("option", { value: e, text: e });
		}
		effortSelect.value = this.plugin.settings.effortLevel;
		effortSelect.onchange = async () => {
			this.plugin.settings.effortLevel = effortSelect.value as EffortLevel;
			await this.plugin.saveSettings();
		};
		this.effortSelect = effortSelect;

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
			const isAbs = nodePath.isAbsolute(path);
			const chip = this.attachmentsEl.createDiv({
				cls: "claude-panel-chip",
			});
			// 絶対パス（OS ピッカーで添付された Vault 外ファイル）は
			// パスが長くなりがちなのでファイル名だけ表示し、フルパスは
			// ツールチップに格納する。Vault 相対パスは従来通り全文表示。
			const displayPath = isAbs ? nodePath.basename(path) : path;
			const labelText = isFolder ? `@${displayPath}/` : `@${displayPath}`;
			const labelEl = chip.createSpan({ text: labelText });
			labelEl.title = path;
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

	private async openAttachPicker(): Promise<void> {
		const { paths, unresolvedCount } = await pickFilesViaDialog();
		let added = 0;
		for (const p of paths) {
			if (!this.attachments.includes(p)) {
				this.attachments.push(p);
				added++;
			}
		}
		if (added > 0) {
			this.renderAttachments();
			void this.saveChat();
		}
		if (unresolvedCount > 0) {
			new Notice(
				`${unresolvedCount} 件のファイルパスを取得できませんでした（Electron 環境制約）。`
			);
		} else if (paths.length > 0 && added === 0) {
			new Notice("選択されたファイルはすでに添付済みです。");
		}
	}

	private async handlePaste(e: ClipboardEvent): Promise<void> {
		const images = extractPastedImages(e);
		if (images.length === 0) return;
		// バイナリ文字列が textarea に貼り付けられないよう抑止する。
		e.preventDefault();
		const folder = this.plugin.getAttachmentFolder();
		for (const img of images) {
			try {
				const savedPath = await savePastedImage(this.app, folder, img);
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
			openPluginSettings: () => this.openPluginSettings(),
			closeView: () => this.leaf.detach(),
		};
	}

	/**
	 * Obsidian の設定モーダルを開き、本プラグインの設定タブまでスクロール
	 * させる。`app.setting` は公式型に出ていないので最小の cast で叩く。
	 */
	private openPluginSettings(): void {
		const setting = (this.app as unknown as {
			setting?: {
				open: () => void;
				openTabById: (id: string) => void;
			};
		}).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.plugin.manifest.id);
	}

	private async send(): Promise<void> {
		if (this.busy) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		// Chromium の autoplay policy はユーザージェスチャの最中に
		// AudioContext を resume することを要求するので、送信ボタンを
		// 押したこの瞬間に起こしておく。応答完了時はジェスチャの文脈外
		// なので、そこで初めて resume すると suspended のまま無音になる。
		this.notifier.warmup();

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
				thinkingMode:
					composed.thinkingMode !== "off"
						? composed.thinkingMode
						: undefined,
				effortLevel:
					!text.startsWith("/") &&
					this.plugin.settings.effortLevel !== "auto"
						? this.plugin.settings.effortLevel
						: undefined,
			},
			{
				id: nextMsgId(),
				role: "assistant",
				parts: [],
				streaming: true,
			}
		);
		this.history.reset();
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
						this.contextMeter?.update(this.lastUsage);
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
		let canceled = first.canceled;

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
			const retry = await runOnce(undefined);
			canceled = retry.canceled;
		}

		this.finalizeStreamingMessage(assistantMsgId);
		this.setBusy(false);

		// ユーザー自身がキャンセルしたランでは通知しない（自分で止めたので
		// 不要）。エラー終了でも通知する — 失敗を見落とすほうがよくない。
		if (!canceled) this.notifier.notify();

		void this.saveChat();
	}

	/** PromptHistory に渡す履歴ソース。messages から user 入力だけを抽出する。 */
	private collectInputHistory(): string[] {
		const out: string[] = [];
		for (const m of this.messages) {
			if (m.role === "user" && typeof m.inputText === "string") {
				out.push(m.inputText);
			}
		}
		return out;
	}

	// ============================================================
	//   チャットの永続化
	// ============================================================

	private saveChat(): Promise<void> {
		return persistSaveChat(this.app, this.plugin.manifest.id, {
			messages: this.messages,
			attachments: this.attachments,
			draft: this.inputEl?.value ?? "",
			lastUsage: this.lastUsage,
			currentSessionId: this.currentSessionId,
		});
	}

	private async loadChat(): Promise<void> {
		const snap = await persistLoadChat(this.app, this.plugin.manifest.id);
		if (!snap) return;
		if (snap.messages) this.messages = snap.messages;
		if (snap.attachments) this.attachments = snap.attachments;
		if (snap.currentSessionId !== undefined) {
			this.currentSessionId = snap.currentSessionId;
		}
		if (snap.lastUsage) this.lastUsage = snap.lastUsage;
		if (typeof snap.draft === "string" && this.inputEl) {
			this.inputEl.value = snap.draft;
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
		thinkingMode: ThinkingMode;
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

		// バブルに表示する本文: ユーザーが入力した生テキストのみ。
		// thinking-mode はバッジとして役割ラベル横に出すので本文には混ぜない。
		// 選択範囲の本文も除外し、引用ブロックが UI を埋め尽くさないようにする。
		const body = userText;
		const thinkingMode = isSlash
			? ("off" as ThinkingMode)
			: this.plugin.settings.thinkingMode;

		// claude へ送るパスを2つに分ける:
		// - Vault 相対パス（拡張子付きの普通のパス）は従来どおり @-mention
		// - OS の絶対パス（Vault 外）は Claude Code の @-mention パーサが
		//   ドライブレター・スペース・バックスラッシュを正しく扱えない
		//   ことがあるため、専用の「添付」ブロックに列挙して Read ツール
		//   での読み込みを Claude に任せる。フォワードスラッシュへ正規化
		//   して可読性も上げる。
		const vaultPaths: string[] = [];
		const externalPaths: string[] = [];
		for (const p of promptPaths) {
			if (nodePath.isAbsolute(p)) {
				externalPaths.push(p.replace(/\\/g, "/"));
			} else {
				vaultPaths.push(p);
			}
		}
		const mentionsStr = vaultPaths.map((p) => `@${p}`).join(" ");
		const externalBlock = externalPaths.length
			? `[添付ファイル — Read ツールで読み込んでください]\n${externalPaths
					.map((p) => `- ${p}`)
					.join("\n")}\n\n`
			: "";

		const promptBody = `${externalBlock}${selectionBlock}${thinkPrefix}${userText}`;
		const fullPrompt = mentionsStr
			? `${mentionsStr}\n\n${promptBody}`
			: promptBody;

		return { mentions: mentionLabels, selectionRef, body, fullPrompt, thinkingMode };
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
