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
import { openAccountUsageModal } from "./account-modal";
import { Composer } from "./composer";
import {
	type ChatMessage,
	type MessageUsage,
} from "./chat-message";
import { renderMessage, renderToolPill } from "./chat-message-render";


export const VIEW_TYPE_CLAUDE_PANEL = "claude-panel-view";

export class ClaudePanelView extends ItemView {
	plugin: ClaudePanelPlugin;

	// DOM 参照（onOpen で初期化）。コンポーザー配下の 3 ホスト
	// （activeFile / selection / attachments）は Composer がオーナーシップを
	// 持つので view 側には保持しない。
	private messagesEl!: HTMLDivElement;
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
		this.registerDomEvent(document, "click", (e) => {
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
		new Notice(`モデル: ${formatModelLabel(next)}`);
	}
	commandToggleIncludeActive(): void {
		const include = this.composer.toggleIncludeActive();
		const target = this.composer.getActiveTargetLabel();
		const state = include ? "含める" : "除外";
		const label = target ? `「${target}」を` : "アクティブを";
		new Notice(`${label}${state}`);
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
		this.contextMeter.update(this.runtime?.getLastUsage() ?? null);

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
		this.contextMeter?.update(this.runtime?.getLastUsage() ?? null);
	}

	private renderComposer(root: HTMLElement): void {
		const composer = root.createDiv({ cls: "claude-panel-composer" });

		// レイアウト（上 → 下）: プロンプト textarea → アクティブファイル →
		// 選択範囲 → 添付 → アクションボタン → モデル/Thinking コントロール。
		// 入力欄を最上段に置き、参照系（含める/除外できる行）はその下に
		// 並べる。selection/attachments は該当時のみ表示される。
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
		this.history = new PromptHistory(this.inputEl, () =>
			this.runtime.getInputHistory()
		);
		this.inputEl.addEventListener("keydown", (e) => {
			// サジェスト popup が開いている場合は、popup のキーバインドを
			// 優先させる（Enter で送信 / Up,Down で履歴より先に処理する）。
			if (this.slashSuggest.handleKey(e)) return;
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			} else if (e.key === "Escape" && this.runtime.isBusy()) {
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
			void this.composer.handlePaste(e);
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
		const attachBtn = actions.createEl("button", {
			text: "添付",
			cls: "claude-panel-attach",
		});
		attachBtn.onclick = () => void this.composer.openAttachPicker();

		this.sendBtn = actions.createEl("button", {
			text: "送信",
			cls: "mod-cta claude-panel-send",
		});
		this.sendBtn.onclick = () => {
			if (this.runtime.isBusy()) this.runtime.cancel();
			else void this.send();
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
	//   チャットメッセージ
	// ============================================================

	private renderMessages(): void {
		this.messagesEl.empty();
		const messages = this.runtime.getMessages();
		if (messages.length === 0) {
			this.renderEmptyState(this.messagesEl);
			return;
		}
		for (const msg of messages) {
			const host = this.messagesEl.createDiv();
			renderMessage(host, msg, this.app, this, (toolUseId, decision) =>
				this.runtime.applyPermissionDecision(toolUseId, decision)
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

	// ============================================================
	//   ChatRuntimeHost 実装
	//   ChatRuntime からの通知を受けて DOM 更新と通知音を担当する。
	//   ここに並ぶ on* メソッドは runtime からのみ呼ばれ、view 内の他の
	//   メソッドからは直接呼ばない（runtime 経由で状態と DOM を同期させる
	//   一貫したフローを維持するため）。
	// ============================================================

	/** ストリーミング中のメッセージにテキストチャンクを追記する DOM 高速パッチ。
	 *  最後の text-part span に textContent を append し、再描画を避ける。 */
	onStreamingText(msg: ChatMessage, chunk: string): void {
		const body = this.getMessageBody(msg.id);
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
	onStreamingTool(msg: ChatMessage, name: string, input: unknown): void {
		const body = this.getMessageBody(msg.id);
		if (!body) return;
		renderToolPill(body, name, input);
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/** メッセージ配列の構造的変化（追加・置換・clear）。全体再描画する。 */
	onMessagesChanged(): void {
		this.renderMessages();
	}

	/** 単一メッセージの完全再描画（permission 状態変化、結果確定など）。 */
	onMessageRerender(msg: ChatMessage): void {
		const host = this.messagesEl.querySelector(
			`[data-msg-id="${msg.id}"]`
		) as HTMLElement | null;
		if (host) {
			renderMessage(host, msg, this.app, this, (toolUseId, decision) =>
				this.runtime.applyPermissionDecision(toolUseId, decision)
			);
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/** 送信ボタンの見た目を busy に応じて切り替える。 */
	onBusyChanged(busy: boolean): void {
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

	/** トークン使用量更新 → コンテキストメーターを駆動する。 */
	onUsageChanged(usage: MessageUsage | null): void {
		this.contextMeter?.update(usage);
	}

	/** 1 ターン完了 → ユーザーキャンセル時を除いて通知音／フラッシュ。
	 *  併せてステータスバーの使用状況も再取得する（直近の消費を反映）。 */
	onRunComplete(canceled: boolean): void {
		if (!canceled) this.notifier.notify();
		this.plugin.refreshUsageStatusBar();
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

	/**
	 * 送信ボタン／Enter キー／プラグインコマンドから呼ばれるエントリ。
	 * view 側でユーザー入力を受け取り、スラッシュコマンドの早期インター
	 * セプト・cwd 検証・composeMessage を済ませてから ChatRuntime に
	 * 渡す。runtime は busy 中の二重実行を内部で弾く。
	 */
	private async send(): Promise<void> {
		if (this.runtime.isBusy()) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		// スラッシュコマンドはローカルで処理して runtime には渡さない。
		// /clear など UI 操作系はここで完結する。
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

		const composed = this.composer.composeMessage(text);

		// runtime に渡す前に入力欄と添付をクリアする（UI 即時フィードバック）。
		this.inputEl.value = "";
		this.composer.clearAttachments();

		await this.runtime.send(text, composed, cwd);
	}

	private getVaultPath(): string | null {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
			basePath?: string;
		};
		return adapter.getBasePath?.() ?? adapter.basePath ?? null;
	}
}
