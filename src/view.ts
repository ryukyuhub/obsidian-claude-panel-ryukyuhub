import {
	ItemView,
	WorkspaceLeaf,
	TFolder,
	Notice,
	Scope,
	setIcon,
} from "obsidian";
import type ClaudePanelPlugin from "./main";
import { checkClaudeCli } from "./agent";
import { ChatRuntime } from "./chat-runtime";
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
import { SelectionCapture } from "./selection-capture";
import { CompletionNotifier } from "./completion-notifier";
import { loadSoundBuffer } from "./notify-sound-source";
import { ContextMeter } from "./context-meter";
import { PromptHistory } from "./prompt-history";
import { handleLocalSlashCommand, type SlashContext } from "./slash-commands";
import { SlashSuggest } from "./slash-suggest";
import { discoverDynamicCommands } from "./skill-discovery";
import { openAccountUsageModal } from "./account-modal";
import { getSettingModal } from "./obsidian-internals";
import { Composer } from "./composer";
import { SummaryBadge } from "./summary-badge";
import { SummaryConfirmModal } from "./summary-confirm-modal";
import {
	type ChatMessage,
	type MessageUsage,
} from "./chat-message";
import {
	renderMessage,
	renderToolPill,
	stripAskBlocksForStream,
} from "./chat-message-render";
import { t } from "./i18n";


export const VIEW_TYPE_CLAUDE_PANEL = "claude-panel-view";

export class ClaudePanelView extends ItemView {
	plugin: ClaudePanelPlugin;

	// DOM 参照（onOpen で初期化）。コンポーザー配下の 3 ホスト
	// （activeFile / selection / attachments）は Composer がオーナーシップを
	// 持つので view 側には保持しない。
	private messagesEl!: HTMLDivElement;
	// スクロール領域の末尾に置く可変高さの余白。送信したプロンプトを常に
	// 最上部まで引き上げられるよう、応答が短いうちは画面の残り高さ分の
	// スクロール余地をここで確保し、応答が伸びるにつれて縮める。
	private bottomSpacer: HTMLElement | null = null;
	// 現在「最上部に位置付けたプロンプト」のメッセージ ID。送信のたびに更新し、
	// 応答完了後もそのまま残す（解除しない）ので、上スクロールで履歴が辿れる。
	private activePromptId: string | null = null;
	// 初回（セッション復元含む）の描画だけは最下部へスクロールして最新を見せる。
	private hasRenderedMessages = false;
	private inputEl!: HTMLTextAreaElement;
	// 一部の select 要素は refreshControls で外部設定変更を反映するため
	// 保持する。effort は現状 sync 対象外なので参照を持たない。
	private modelSelect: HTMLSelectElement | null = null;
	private thinkSelect: HTMLSelectElement | null = null;
	private permSelect: HTMLSelectElement | null = null;
	private sendBtn!: HTMLButtonElement;

	// 入力（コンポーザー）側の状態と組み立てロジックは Composer に
	// 委譲している。view は Composer に DOM ホストを渡してマウントし、
	// 送信時に composeMessage を呼ぶだけ。
	private composer!: Composer;
	private selection!: SelectionCapture;
	// プロンプト履歴ナビゲーション（textarea 内の Up/Down キー）。
	// state は PromptHistory に持たせている。inputEl 構築後に初期化。
	private history!: PromptHistory;
	// `/` で始まる入力に対するコマンド候補ポップアップ。inputEl 構築後に初期化。
	private slashSuggest!: SlashSuggest;
	private contextMeter: ContextMeter | null = null;
	private summaryBadge: SummaryBadge | null = null;
	// 応答完了通知（フラッシュ・ビープ）。state を view に持つと肥大化する
	// ので CompletionNotifier に切り出している。view からはモードと panel
	// root を引き渡すだけ。
	private notifier!: CompletionNotifier;
	// 会話エンジン。messages / currentRun / セッション ID / pending
	// パーミッション / busy / 累計 usage を所有する。host インターフェース
	// （= この view 自身）経由で DOM 更新と通知音を依頼する。
	private runtime!: ChatRuntime;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudePanelPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CLAUDE_PANEL;
	}

	getDisplayText(): string {
		return t("view.displayText");
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
		this.applyComposerBottomPadding(root);

		this.renderHeader(root);
		this.messagesEl = root.createDiv({ cls: "claude-panel-messages" });
		// Composer は selection に依存するので先に SelectionCapture を作る。
		// SelectionCapture のコールバックも Composer 側へ委譲する。
		this.selection = new SelectionCapture(this.app, this.containerEl, () =>
			this.composer.renderSelection()
		);
		this.composer = new Composer(this.app, this.plugin, this.selection);
		this.renderComposer(root);

		this.notifier = new CompletionNotifier({
			getMode: () => this.plugin.settings.notifyOnComplete,
			getVolume: () => this.plugin.settings.notifySoundVolume,
			getSoundPath: () => this.plugin.settings.notifySoundPath,
			readSoundBytes: (path) => loadSoundBuffer(this.app, path),
			panelRoot: root,
		});
		// view 自身が ChatRuntimeHost を構造的に実装している（onMessagesChanged
		// など以下のメソッド群）。runtime には plugin と host の参照だけを
		// 渡し、状態は完全に runtime 内部に閉じ込める。
		this.runtime = new ChatRuntime(this.plugin, this);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.composer.renderActiveFile();
				this.selection.poll();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				// ファイル選択でアクティブフォルダは解除（相互排他）
				this.composer.setActiveFolderPath(null);
				this.selection.poll();
			})
		);
		// ファイルエクスプローラーでフォルダをクリックしたら
		// activeFolderPath として記録し、アクティブファイル表示と入れ替える。
		// `.nav-folder-title` は Obsidian のファイルツリーが各フォルダに
		// 描画する要素で、`data-path` にフォルダの Vault 相対パスが入る。
		this.registerDomEvent(activeDocument, "click", (e) => {
			const titleEl = (e.target as HTMLElement | null)?.closest(
				".nav-folder-title"
			);
			if (!titleEl) return;
			const path = titleEl.getAttribute("data-path");
			if (!path) return; // ルート（path="" / null）は無視
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFolder)) return;
			this.composer.setActiveFolderPath(path);
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
			if (this.runtime.isCurrentRunActive()) {
				this.runtime.cancel();
				return false;
			}
			return true;
		});

		// 送信ホットキーは Obsidian 標準の hotkey 設定でユーザーが自由に割り
		// 当てられる（コマンド ID: `send-claude-panel-prompt`）。プラグイン側
		// では textarea 内での Enter / Shift+Enter の挙動だけを面倒見て、修飾
		// キー付き Enter のような「グローバルなショートカット」はユーザーの
		// hotkey 設定に委ねる方針。

		// Obsidian 起動時に前回の会話を自動復元する。
		// `~/.claude/projects/<encoded-cwd>/<session>.jsonl` から直近セッションを
		// 読み出し、UI 履歴と `--continue` 予約を一括でセットする。Vault 内
		// （= Google Drive 等で同期される領域）には何も書かないので、複数端末
		// 間でセッション ID が衝突したり absolute path 添付が混入したりしない。
		const cwd = this.getVaultPath();
		if (cwd) {
			this.runtime.restoreFromLatestSession(cwd);
		}

		this.renderMessages();
		this.composer.renderAll();
		this.contextMeter?.update(this.runtime.getLastUsage());
		this.selection.poll();
	}

	async onClose(): Promise<void> {
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
	 * 設定タブで表示言語を変更した直後に呼ばれ、ロケール文字列を含む
	 * パネル DOM を再描画する。runtime / Composer / CompletionNotifier /
	 * SelectionCapture などの状態オブジェクトは破棄せず、入力欄の下書きと
	 * 実行中フラグも保ったまま、ヘッダ・コンポーザ・メッセージリストを
	 * 新ロケールで作り直す。
	 *
	 * ribbon やコマンドパレットのラベルは `addRibbonIcon` / `addCommand`
	 * 時に Obsidian 側に確定し、動的更新の API がないため、ここからは
	 * 反映できない（restartHint で再読み込みを案内している）。
	 */
	rebuildLocalizedUI(): void {
		const root = this.panelRoot();
		if (!root) return;

		// 再描画でロストすると体験を損なう状態を退避。
		const draftText = this.inputEl?.value ?? "";

		root.empty();
		root.addClass("claude-panel-root");
		this.applyFontSize(root);
		this.applyComposerBottomPadding(root);

		this.renderHeader(root);
		this.messagesEl = root.createDiv({ cls: "claude-panel-messages" });
		this.renderComposer(root);

		if (this.inputEl) this.inputEl.value = draftText;

		this.renderMessages();
		this.composer.renderAll();
		this.contextMeter?.update(this.runtime.getLastUsage());
		this.refreshSendBtn();
		this.selection.poll();

		// 実行中ターンの最中に再描画された場合は Send ボタンを Stop 表示へ。
		this.onBusyChanged(this.runtime.isBusy());
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

	/**
	 * `settings.composerBottomPadding` をパネルルートに CSS カスタム
	 * プロパティとして適用する。styles.css 側のコンポーザールールが
	 * `--claude-panel-composer-bottom-padding` を読み、既定の下端 padding
	 * に加算する。テーマのステータスバーがサイドバーの最下部に被る環境
	 * でだけユーザーが手動で値を上げて回避できるよう、既定値は 0px。
	 */
	applyComposerBottomPadding(root?: HTMLElement): void {
		const target = root ?? this.panelRoot();
		if (!target) return;
		target.style.setProperty(
			"--claude-panel-composer-bottom-padding",
			`${this.plugin.settings.composerBottomPadding}px`
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
		if (this.runtime.isCurrentRunActive()) {
			this.runtime.cancel();
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
		new Notice(t("view.modelChangedNotice", formatModelLabel(next)));
	}
	commandToggleIncludeActive(): void {
		const include = this.composer.toggleIncludeActive();
		const target = this.composer.getActiveTargetLabel();
		const state = include
			? t("view.includeStateIncluded")
			: t("view.includeStateExcluded");
		new Notice(
			target
				? t("view.toggleActiveNoticeWithTarget", target, state)
				: t("view.toggleActiveNoticeDefault", state)
		);
	}

	// ============================================================
	//   コンポーザーの構築
	// ============================================================

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "claude-panel-header" });
		header.createEl("h3", { text: t("view.headerTitle") });

		const meterItem = header.createDiv({
			cls: "claude-panel-meter-item",
		});
		const meterHost = meterItem.createDiv({
			cls: "claude-panel-meter-donut claude-panel-context-meter",
		});
		meterItem.createDiv({
			cls: "claude-panel-meter-label",
			text: t("view.meterLabelContext"),
		});
		this.contextMeter = new ContextMeter(meterHost);
		this.contextMeter.update(this.runtime?.getLastUsage() ?? null);

		this.summaryBadge = new SummaryBadge(header, {
			onClick: () => this.openSummaryConfirm(),
		});
		// 初期表示時は runtime からの onUsageChanged 通知がまだ来ていない
		// ことが多いので、現スナップショットを直接読んで反映する。
		this.summaryBadge.update(
			this.toUsageFraction(this.runtime?.getLastUsage() ?? null),
			this.runtime?.isBusy() ?? false
		);

		const accountBtn = header.createEl("button", {
			cls: "claude-panel-icon-btn claude-panel-account-btn",
			attr: { "aria-label": t("view.accountBtnAria") },
		});
		setIcon(accountBtn, "user");
		accountBtn.onclick = () =>
			openAccountUsageModal(
				this.app,
				this.plugin.settings,
				this.plugin.usageHistory
			);

		const clearBtn = header.createEl("button", {
			text: t("view.clearBtn"),
			cls: "claude-panel-clear",
		});
		clearBtn.onclick = () => this.clearConversation();
	}

	private toUsageFraction(
		usage: MessageUsage | null
	): number | null {
		return toUsageFractionStatic(usage);
	}

	/** コンテキストメーターを再描画する（関連する設定が変わった際に
	 *  プラグイン側から呼ばれる）。 */
	refreshMeters(): void {
		const usage = this.runtime?.getLastUsage() ?? null;
		this.contextMeter?.update(usage);
		this.summaryBadge?.update(
			this.toUsageFraction(usage),
			this.runtime?.isBusy() ?? false
		);
	}

	private renderComposer(root: HTMLElement): void {
		const composer = root.createDiv({ cls: "claude-panel-composer" });

		// レイアウト（上 → 下）: キュー表示 → プロンプト textarea →
		// アクティブファイル → 選択範囲 → 添付 → アクションボタン →
		// モデル/Thinking コントロール。入力欄を最上段に置き、参照系
		// （含める/除外できる行）はその下に並べる。selection/attachments
		// は該当時のみ表示される。
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
		});
		this.inputEl.rows = 4;
		this.slashSuggest = new SlashSuggest(suggestEl, this.inputEl);
		// Vault パスが取れる前提で、~/.claude と <vault>/.claude から
		// スキル / ユーザーコマンドを発見してサジェストへ注入する。
		// ファイル I/O は1回だけ（再スキャンが要るほど頻繁には変わらない）。
		this.slashSuggest.setExtraCommands(
			discoverDynamicCommands(this.getVaultPath())
		);
		this.history = new PromptHistory(this.inputEl, () =>
			this.runtime.getInputHistory()
		);
		this.inputEl.addEventListener("input", () => this.refreshSendBtn());
		this.inputEl.addEventListener("keydown", (e) => {
			if (this.slashSuggest.handleKey(e)) return;
			if (e.key === "Enter") {
				// Shift+Enter は改行（ブラウザ既定）
				if (e.shiftKey) return;
				// 修飾キー付き Enter は Obsidian のホットキー設定に委ねる
				// （`send-claude-panel-prompt` コマンドにユーザーが自由に
				// 割り当てる）。ここでは preventDefault せず素通しにする。
				if (e.ctrlKey || e.metaKey || e.altKey) return;
				// 設定 ON: 素の Enter は改行。送信は Obsidian のホットキー経由。
				if (this.plugin.settings.submitWithModEnter) return;
				// 設定 OFF（既定）: 素の Enter で送信。
				if (e.isComposing) return; // IME 変換確定の Enter は無視
				e.preventDefault();
				void this.send();
				return;
			}
			if (e.key === "Escape" && this.runtime.isBusy()) {
				e.preventDefault();
				this.runtime.cancel();
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
			this.composer.handlePaste(e);
		});

		// 参照系（含める/除外）行は textarea の下に並べる。Composer が
		// 個別 mount ホストを所有するので、view 側は枠だけ作って渡す。
		const activeFileEl = composer.createDiv({
			cls: "claude-panel-active-file",
		});
		const selectionEl = composer.createDiv({
			cls: "claude-panel-selection is-empty",
		});
		const attachmentsEl = composer.createDiv({
			cls: "claude-panel-attachments",
		});
		this.composer.mount({ activeFileEl, selectionEl, attachmentsEl });

		const actions = composer.createDiv({ cls: "claude-panel-actions" });
		const actionsLeft = actions.createDiv({
			cls: "claude-panel-actions-left",
		});
		const attachBtn = actionsLeft.createEl("button", {
			text: t("view.attachBtn"),
			cls: "claude-panel-attach",
		});
		attachBtn.onclick = () => void this.composer.openAttachPicker();

		// 添付ボタンの隣の「Vault に保存」チェックボックス。初期状態は
		// プラグイン設定由来で、Composer が構築時に取り込んでいる。ここでの
		// トグルは一時的で、プラグイン設定 `saveAttachmentsToVault` は変えない。
		const saveToggle = actionsLeft.createEl("label", {
			cls: "claude-panel-save-toggle",
		});
		saveToggle.title = t("view.saveToVaultTooltip");
		const saveCheckbox = saveToggle.createEl("input", {
			attr: { type: "checkbox" },
		});
		saveCheckbox.checked = this.composer.getSaveToVault();
		saveCheckbox.onchange = () =>
			this.composer.setSaveToVault(saveCheckbox.checked);
		saveToggle.createSpan({ text: t("view.saveToVaultToggle") });

		this.sendBtn = actions.createEl("button", {
			text: t("view.sendBtn"),
			cls: "mod-cta claude-panel-send",
		});
		this.sendBtn.onclick = () => {
			// textarea が空のときだけ「停止」として振る舞う。入力があれば
			// busy 中でも送信し、send() 側で割り込み (interrupt) として処理する。
			if (this.runtime.isBusy() && !this.inputEl.value.trim()) {
				this.runtime.cancel();
			} else {
				void this.send();
			}
		};

		this.renderModelThinkControls(composer);
	}

	private renderModelThinkControls(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: "claude-panel-controls" });

		row.createSpan({
			cls: "claude-panel-control-label",
			text: t("view.controlLabelModel"),
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
			text: t("view.controlLabelThinking"),
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
			text: t("view.controlLabelEffort"),
		});
		const effortSelect = row.createEl("select", {
			cls: "claude-panel-control-select",
			attr: {
				title: t("view.effortTooltip"),
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

		row.createSpan({
			cls: "claude-panel-control-label",
			text: t("view.controlLabelPermission"),
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
	//   チャットメッセージ
	// ============================================================

	/** チャット全体を再描画する公開フック。ロール名など、描画にのみ
	 *  影響する設定を変更した直後に設定タブから呼ぶ。 */
	rerenderMessages(): void {
		this.renderMessages();
	}

	private renderMessages(): void {
		const messages = this.runtime.getMessages();
		if (messages.length === 0) {
			this.messagesEl.empty();
			this.bottomSpacer = null;
			this.hasRenderedMessages = false;
			this.renderEmptyState(this.messagesEl);
			return;
		}

		// 既存の描画済みメッセージ列を取得する。
		const existingIds = Array.from(
			this.messagesEl.querySelectorAll<HTMLElement>(
				".claude-panel-msg[data-msg-id]"
			)
		).map((el) => el.getAttribute("data-msg-id"));

		// 既存 DOM が新メッセージ列の prefix なら「追記のみ」。それ以外
		// （clear / 要約リセット / 空状態からの初回など）は全再構築する。
		// 追記のみのとき既存メッセージを再描画しないのが最重要ポイント:
		// 全再構築すると過去メッセージのマークダウンが毎回非同期で再描画され、
		// その高さ変動が上端固定中のプロンプトを押し下げてしまう。
		let appendOnly =
			!this.messagesEl.querySelector(".claude-panel-empty") &&
			existingIds.length <= messages.length;
		if (appendOnly) {
			for (let i = 0; i < existingIds.length; i++) {
				if (existingIds[i] !== messages[i].id) {
					appendOnly = false;
					break;
				}
			}
		}

		let startIdx: number;
		if (appendOnly) {
			startIdx = existingIds.length;
		} else {
			this.messagesEl.empty();
			this.bottomSpacer = null;
			startIdx = 0;
		}
		for (let i = startIdx; i < messages.length; i++) {
			const host = this.messagesEl.createDiv();
			renderMessage(
				host,
				messages[i],
				this.app,
				this,
				(toolUseId, decision) =>
					this.runtime.applyPermissionDecision(toolUseId, decision),
				(answer) => {
					void this.sendAskAnswer(answer);
				},
				() => this.recomputeActiveSpacer()
			);
		}

		if (!this.bottomSpacer) {
			this.bottomSpacer = createDiv({ cls: "claude-panel-bottom-spacer" });
		}
		// スペーサーは常に末尾へ（新規メッセージは createDiv で末尾＝スペーサーの
		// 後ろに付くため、ここで末尾へ寄せ直す）。
		this.messagesEl.appendChild(this.bottomSpacer);

		// 初回（セッション復元含む）だけ最下部へ。以降は既存 DOM を保つので
		// スクロール位置は自然に維持され、上端固定は updatePromptPin が担う。
		if (!this.hasRenderedMessages) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
			this.hasRenderedMessages = true;
		}
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
			text: t("view.emptyTitle"),
		});
		const body = card.createDiv({ cls: "claude-panel-empty-body" });
		body.setText(t("view.emptyCheckingSetup"));

		void checkClaudeCli(this.plugin.settings.claudePath).then((status) => {
			body.empty();
			if (status.installed && status.loggedIn) {
				body.setText(t("view.emptyReady"));
				return;
			}
			body.createDiv({
				cls: "claude-panel-empty-warn",
				text: !status.installed
					? t("view.emptyCliMissing")
					: t("view.emptyLoginRequired"),
			});
			const list = body.createEl("ol", { cls: "claude-panel-empty-steps" });
			if (!status.installed) {
				const step1 = list.createEl("li");
				step1.createSpan({ text: t("view.emptyStepRunInTerminal") });
				step1.createEl("code", {
					text: "npm install -g @anthropic-ai/claude-code",
				});
				const step2 = list.createEl("li");
				step2.createSpan({ text: t("view.emptyStepThenLogin") });
				step2.createEl("code", { text: "claude /login" });
			} else {
				const step = list.createEl("li");
				step.createSpan({ text: t("view.emptyStepRunInTerminal") });
				step.createEl("code", { text: "claude /login" });
			}
			const actions = body.createDiv({ cls: "claude-panel-empty-actions" });
			const settingsBtn = actions.createEl("button", {
				cls: "mod-cta",
				text: t("view.emptyOpenSettings"),
			});
			settingsBtn.onclick = () => {
				const setting = getSettingModal(this.app);
				setting?.open();
				setting?.openTabById(this.plugin.manifest.id);
			};
			const recheckBtn = actions.createEl("button", {
				text: t("view.emptyRecheck"),
			});
			recheckBtn.onclick = () => {
				this.renderMessages();
			};
		});
	}

	private getMessageBody(msgId: string): HTMLElement | null {
		return this.messagesEl.querySelector(
			`[data-msg-id="${msgId}"] .claude-panel-msg-text`
		);
	}

	// ============================================================
	//   ChatRuntimeHost 実装
	//   ChatRuntime からの通知を受けて DOM 更新と通知音を担当する。
	//   ここに並ぶ on* メソッドは runtime からのみ呼ばれ、view 内の他の
	//   メソッドからは直接呼ばない（runtime 経由で状態と DOM を同期させる
	//   一貫したフローを維持するため）。
	// ============================================================

	/** ストリーミング中のメッセージにテキストチャンクを追記する DOM 高速パッチ。
	 *  parts 側で最後の text part を引き、`\`\`\`ask` ブロックを抑制した
	 *  フィルタ済みテキストを span に流し込む。確定時の再描画
	 *  （onMessageRerender → MarkdownRenderer + renderAskBlocks）で
	 *  ブロックは質問カードに置き換わるため、最終結果はそちらが正となる。 */
	onStreamingText(msg: ChatMessage, chunk: string): void {
		// chunk は parts に既に反映済み。差分を独自に DOM へ流すと
		// `\`\`\`ask` をまたぐ断片が現れて見づらいので、part の累積から
		// フィルタ済みテキストを 1 回だけ流し直す。
		void chunk;
		const body = this.getMessageBody(msg.id);
		if (!body) return;
		let lastTextPart = "";
		for (let i = msg.parts.length - 1; i >= 0; i--) {
			const p = msg.parts[i];
			if (p.type === "text") {
				lastTextPart = p.text;
				break;
			}
		}
		const displayText = stripAskBlocksForStream(lastTextPart);
		let last = body.lastElementChild as HTMLElement | null;
		if (!last || !last.classList.contains("claude-panel-msg-text-part")) {
			last = body.createDiv({ cls: "claude-panel-msg-text-part" });
		}
		last.textContent = displayText;
		this.followActiveTurn();
	}

	/** ストリーミング中のメッセージにツール実行ピルを追加する。 */
	onStreamingTool(msg: ChatMessage, name: string, input: unknown): void {
		const body = this.getMessageBody(msg.id);
		if (!body) return;
		renderToolPill(body, name, input);
		this.followActiveTurn();
	}

	/** メッセージ配列の構造的変化（追加・置換・clear）。全体再描画する。 */
	onMessagesChanged(): void {
		this.renderMessages();
		this.updatePromptPin();
	}

	/** 単一メッセージの完全再描画（permission 状態変化、結果確定など）。 */
	onMessageRerender(msg: ChatMessage): void {
		const host = this.messagesEl.querySelector<HTMLElement>(
			`[data-msg-id="${msg.id}"]`
		);
		if (host) {
			renderMessage(
				host,
				msg,
				this.app,
				this,
				(toolUseId, decision) =>
					this.runtime.applyPermissionDecision(toolUseId, decision),
				(answer) => {
					void this.sendAskAnswer(answer);
				},
				() => this.recomputeActiveSpacer()
			);
		}
		this.followActiveTurn();
	}

	/** 最後の user メッセージの ID。固定対象（= 現ターンのプロンプト）の特定に使う。 */
	private lastUserMessageId(): string | null {
		const messages = this.runtime.getMessages();
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") return messages[i].id;
		}
		return null;
	}

	/** 新しいプロンプトが送られたら、それをスクロール領域の最上部へ位置付ける。
	 *  busy 中（= 送信直後/割り込み送信）かつ前回と別の user メッセージのときだけ
	 *  発火し、応答完了後の再描画では位置を動かさない（プロンプトを上端に残す）。 */
	private updatePromptPin(): void {
		const lastUserId = this.lastUserMessageId();
		if (!lastUserId) {
			// 会話が空（clear 等）。固定対象とスペーサーを解除する。
			this.activePromptId = null;
			this.markActivePromptHost(null);
			if (this.bottomSpacer) this.bottomSpacer.setCssStyles({ height: "0px" });
			return;
		}
		if (this.runtime.isBusy() && lastUserId !== this.activePromptId) {
			this.activePromptId = lastUserId;
			this.markActivePromptHost(lastUserId);
			this.snapPromptToTop(lastUserId);
		} else if (this.activePromptId) {
			// 同一ターン中の再描画など。再描画で失われた余白マークを付け直す。
			this.markActivePromptHost(this.activePromptId);
			if (this.runtime.isBusy()) {
				// 応答中は最新へ追従する。スペーサーのおかげで応答が短いうちは
				// 上端固定の位置のまま、画面高を超えたら最下部追従に切り替わる。
				this.followActiveTurn();
			} else {
				// 応答後は位置を動かさない（上スクロールで履歴を辿れるように）。
				this.refreshActiveSpacer();
			}
		}
	}

	/** 上端に位置付けるプロンプト吹き出しに上マージン（PROMPT_TOP_GAP）を持たせる。
	 *  スクロールでこのマージン分だけ上を見せることで、上端にぴったり貼り付かず、
	 *  かつ前ターンの内容も覗かない「きれいな余白」を作る。全再描画のたびに
	 *  DOM が作り直されて失われるので、その都度付け直す。 */
	private markActivePromptHost(msgId: string | null): void {
		this.messagesEl
			.querySelectorAll<HTMLElement>(".claude-panel-prompt-pinned")
			.forEach((el) => {
				el.removeClass("claude-panel-prompt-pinned");
				el.setCssStyles({ marginTop: "" });
			});
		if (!msgId) return;
		const host = this.messagesEl.querySelector<HTMLElement>(
			`[data-msg-id="${msgId}"]`
		);
		if (!host) return;
		host.addClass("claude-panel-prompt-pinned");
		host.setCssStyles({ marginTop: `${PROMPT_TOP_GAP}px` });
	}

	/** ストリーミング中は常に最新（最下部）へ追従する。下端スペーサーのおかげで、
	 *  応答が短いうちは「最下部 = 上端固定プロンプトの位置」になるためプロンプトは
	 *  上端に貼り付いたまま、応答が画面高を超えると最下部追従に切り替わり最新が
	 *  常に見える。固定対象があれば追従前にスペーサーを縮める。 */
	private followActiveTurn(): void {
		if (this.activePromptId) {
			this.refreshActiveSpacer();
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/** 現在の固定プロンプトを基準に下端スペーサーの高さを再計算する（スクロール
	 *  位置は変えない）。応答が短いうちは画面の残り分の余白を確保し、応答が
	 *  画面高を超えたら 0 にする。 */
	private refreshActiveSpacer(): void {
		if (this.activePromptId) this.updateBottomSpacer(this.activePromptId);
	}

	/** ユーザプロンプトの省略トグルで本文高が変わったとき、上端固定中の
	 *  下端スペーサーを再計算して追従させる（固定対象が無ければ何もしない）。 */
	recomputeActiveSpacer(): void {
		this.refreshActiveSpacer();
	}

	/** 指定メッセージをスクロール領域の最上部へ位置付ける（余白確保 → スクロール）。
	 *  上端にぴったり貼り付くと窮屈なので、わずかに余白を残した位置に置く。 */
	private snapPromptToTop(msgId: string): void {
		this.updateBottomSpacer(msgId);
		const host = this.messagesEl.querySelector(
			`[data-msg-id="${msgId}"]`
		);
		if (!host) return;
		const contTop = this.messagesEl.getBoundingClientRect().top;
		const hostOffset =
			host.getBoundingClientRect().top - contTop + this.messagesEl.scrollTop;
		this.messagesEl.scrollTop = Math.max(0, hostOffset - PROMPT_TOP_GAP);
	}

	/** 下端スペーサーの高さを、指定メッセージを最上部（上余白 PROMPT_TOP_GAP 込み）まで
	 *  引き上げられる値に揃える。最下部までスクロールしたとき固定プロンプトが
	 *  ちょうど上端＋余白の位置に来るよう、GAP 分を差し引く。
	 *  spacer = max(0, 表示領域の高さ − 当該メッセージ上端から末尾までの実コンテンツ高 − GAP)。 */
	private updateBottomSpacer(msgId: string): void {
		if (!this.bottomSpacer) return;
		const host = this.messagesEl.querySelector(
			`[data-msg-id="${msgId}"]`
		);
		if (!host) {
			this.bottomSpacer.setCssStyles({ height: "0px" });
			return;
		}
		const current = parseFloat(this.bottomSpacer.style.height) || 0;
		const contTop = this.messagesEl.getBoundingClientRect().top;
		const hostOffset =
			host.getBoundingClientRect().top - contTop + this.messagesEl.scrollTop;
		// scrollHeight には現在のスペーサー高が含まれるので差し引いて実コンテンツ高を出す。
		const contentBelow =
			this.messagesEl.scrollHeight - hostOffset - current;
		const spacer = Math.max(
			0,
			this.messagesEl.clientHeight - contentBelow - PROMPT_TOP_GAP
		);
		this.bottomSpacer.setCssStyles({ height: `${spacer}px` });
	}

	/** busy 状態が変わったら送信ボタンと要約バッジの disabled / spinner を更新する。 */
	onBusyChanged(busy: boolean): void {
		this.refreshSendBtn();
		this.summaryBadge?.update(
			this.toUsageFraction(this.runtime?.getLastUsage() ?? null),
			busy
		);
		this.summaryBadge?.setSummarizing(this.runtime?.isSummarizing() ?? false);
		// busy 開始時に送信プロンプトを最上部へ位置付ける（解除はしない）。
		this.updatePromptPin();
	}

	/** 送信ボタンのラベル／クラスを (busy, textarea が空か) に応じて切り替える。
	 *  - !busy                    → 送信 (mod-cta)
	 *  - busy かつ textarea が空   → 停止 (mod-warning)
	 *  - busy かつ textarea に入力 → 割り込み (mod-cta) — クリックで現ターン中断 + 即送信
	 */
	private refreshSendBtn(): void {
		const busy = this.runtime?.isBusy() ?? false;
		const hasText = this.inputEl?.value.trim().length > 0;
		if (busy && !hasText) {
			this.sendBtn.removeClass("mod-cta");
			this.sendBtn.addClass("mod-warning");
			this.sendBtn.setText(t("view.stopBtn"));
		} else if (busy && hasText) {
			this.sendBtn.removeClass("mod-warning");
			this.sendBtn.addClass("mod-cta");
			this.sendBtn.setText(t("view.interruptBtn"));
		} else {
			this.sendBtn.removeClass("mod-warning");
			this.sendBtn.addClass("mod-cta");
			this.sendBtn.setText(t("view.sendBtn"));
		}
		this.sendBtn.disabled = false;
	}

	/** トークン使用量更新 → メーターと要約バッジを駆動する。 */
	onUsageChanged(usage: MessageUsage | null): void {
		this.contextMeter?.update(usage);
		this.summaryBadge?.update(
			this.toUsageFraction(usage),
			this.runtime?.isBusy() ?? false
		);
	}

	/** 1 ターン完了 → ユーザーキャンセル時を除いて通知音／フラッシュ。 */
	onRunComplete(canceled: boolean): void {
		if (!canceled) this.notifier.notify();
	}

	/** AudioContext を起こす（ユーザージェスチャ中にだけ有効）。 */
	onWarmup(): void {
		this.notifier.warmup();
	}

	/** プロンプト履歴ナビ位置のリセット（送信時）。 */
	onResetInputHistory(): void {
		this.history.reset();
	}

	// ============================================================
	//   会話操作のラッパー（パネルボタンとプラグインコマンド向け）
	// ============================================================

	private clearConversation(): void {
		// 添付状態のクリアは Composer に委譲。会話履歴とセッション ID は
		// runtime 側で破棄される。
		this.composer.clearAttachments();
		this.runtime.clear();
	}

	private slashContext(): SlashContext {
		return {
			plugin: this.plugin,
			getVaultPath: () => this.getVaultPath(),
			clearConversation: () => this.clearConversation(),
			restoreFromLatestSession: (cwd) =>
				this.runtime.restoreFromLatestSession(cwd),
			refreshControls: () => this.refreshControls(),
			appendSystemMessage: (text) => this.runtime.appendSystemMessage(text),
			appendInteractive: (render) =>
				this.runtime.appendInteractiveSystemMessage(render),
			openAccountUsage: () =>
				openAccountUsageModal(
					this.app,
					this.plugin.settings,
					this.plugin.usageHistory
				),
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

	/**
	 * 質問 GUI（`\`\`\`ask` ブロックから描かれるボタン群）でユーザーがクリック
	 * した選択肢を、次のユーザーメッセージとして送信する。textarea 側の下書き
	 * は触らない（ユーザーが別のことを書いている最中かもしれないため）。
	 * busy 中は send() と同じく `runtime.inject()` で現ターンに割り込む。
	 */
	private async sendAskAnswer(answer: string): Promise<void> {
		if (this.runtime.isSummarizing()) {
			new Notice(t("view.summarizingInProgress"));
			return;
		}
		const text = answer.trim();
		if (!text) return;
		const cwd = this.getVaultPath();
		if (!cwd) {
			new Notice(t("view.vaultPathUnavailable"));
			return;
		}
		// 未保存のペースト画像を確定させてから組み立てる（× で消されたものは
		// このタイミングまでにディスクへ書き出さず、そのまま捨てられる）。
		await this.composer.flushPendingPastes();
		const composed = this.composer.composeMessage(text);
		if (this.runtime.isBusy()) {
			new Notice(t("view.interruptedNotice"));
			await this.runtime.inject(text, composed, cwd);
			return;
		}
		void this.runtime.send(text, composed, cwd);
	}

	/**
	 * 送信ボタン／Enter キー／プラグインコマンドから呼ばれるエントリ。
	 * view 側でユーザー入力を受け取り、スラッシュコマンドの早期インター
	 * セプト・cwd 検証・composeMessage を済ませてから ChatRuntime に
	 * 渡す。busy 中なら `runtime.inject()` で現ターンに割り込む。
	 */
	private async send(): Promise<void> {
		if (this.runtime.isSummarizing()) {
			new Notice(t("view.summarizingInProgress"));
			return;
		}
		const text = this.inputEl.value.trim();
		if (!text) return;

		const busy = this.runtime.isBusy();

		// スラッシュコマンドは busy 中はブロックする（local も CLI 転送も
		// 会話状態を変える可能性があるため、キューに積まずに案内だけ出す）。
		if (text.startsWith("/")) {
			if (busy) {
				new Notice(t("view.slashBlockedBusy"));
				return;
			}
			if (handleLocalSlashCommand(this.slashContext(), text)) {
				this.inputEl.value = "";
				this.refreshSendBtn();
				return;
			}
		}

		const cwd = this.getVaultPath();
		if (!cwd) {
			new Notice(t("view.vaultPathUnavailable"));
			return;
		}

		// 未保存のペースト画像を確定させてから組み立てる（× で消されたものは
		// このタイミングまでにディスクへ書き出さず、そのまま捨てられる）。
		await this.composer.flushPendingPastes();
		const composed = this.composer.composeMessage(text);

		// runtime に渡す前に入力欄と添付をクリアする (UI 即時フィードバック)。
		this.inputEl.value = "";
		this.composer.clearAttachments();
		this.refreshSendBtn();

		if (busy) {
			new Notice(t("view.interruptedNotice"));
			await this.runtime.inject(text, composed, cwd);
			return;
		}

		await this.runtime.send(text, composed, cwd);
	}

	private getVaultPath(): string | null {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
			basePath?: string;
		};
		return adapter.getBasePath?.() ?? adapter.basePath ?? null;
	}

	private openSummaryConfirm(): void {
		const usage = this.runtime?.getLastUsage() ?? null;
		const fraction = toUsageFractionStatic(usage);
		// バッジ側でも閾値チェックしているが、外部コマンドから呼ばれた場合
		// などに備えてここでも防御的に弾く。
		if (fraction === null || fraction < 0.6) return;
		const cwd = this.getVaultPath();
		if (!cwd) {
			new Notice(t("view.vaultPathUnavailable"));
			return;
		}
		new SummaryConfirmModal(this.app, {
			usageFraction: fraction,
			onConfirm: () => {
				void this.runtime.requestSummaryAndReset(cwd);
			},
		}).open();
	}
}

// コンテキストウィンドウは context-meter 側にも同名の定数があるが、
// 概念上は「メーターの色判定」と「バッジの表示判定」で別物なので、
// 共有モジュールには切り出さず両方に持たせる。
// 送信プロンプトを最上部へ寄せるときに残す上端の余白(px)。
const PROMPT_TOP_GAP = 14;

const CONTEXT_WINDOW_TOKENS = 200_000;

function toUsageFractionStatic(
	usage: MessageUsage | null
): number | null {
	if (!usage) return null;
	const used =
		usage.inputTokens +
		usage.cacheCreationTokens +
		usage.cacheReadTokens +
		usage.outputTokens;
	return used / CONTEXT_WINDOW_TOKENS;
}
