import {
	ItemView,
	Notice,
	Platform,
	Scope,
	TFolder,
	setIcon,
	type Modifier,
	type WorkspaceLeaf,
} from "obsidian";
import * as fs from "fs";
import * as nodePath from "path";
import type ClaudePanelPlugin from "../main";
import { openAccountUsageModal } from "../account-modal";
import {
	importAttachments,
	pastedImageFileName,
	pickFilesViaDialog,
	storePastedImage,
} from "../attachments";
import { resolveClaudePath } from "../cli-resolver";
import { CompletionNotifier } from "../completion-notifier";
import { t } from "../i18n";
import { NoteContext, formatNoteContext, trackNoteContext } from "../note-context";
import { getVaultBasePath, loadSoundBuffer } from "../notify-sound-source";
import { getSettingModal } from "../obsidian-internals";
import { VIEW_TYPE_CLAUDE_PANEL, type PanelView } from "../panel-view";
import { SelectionCapture } from "../selection-capture";
import { HOOK_TOKEN_ENV, buildClaudeSettings, userPromptReply } from "./hook-settings";
import { buildLaunchArgs, buildLaunchEnv } from "./launch";
import { onKillAll, openPty } from "./pty";
import {
	PtyUnavailableError,
	type HookEndpoint,
	type HookReply,
	type HookRequest,
	type PtyExit,
	type PtySession,
	type SessionMode,
} from "./types";
import { isDarkTheme } from "./theme";
import { XtermPane } from "./xterm-pane";

type ErrorReason = "noVault" | "cliMissing" | "ptyUnavailable" | "bridge" | "launch";

type Status =
	| { kind: "idle" }
	| { kind: "starting" }
	| { kind: "running" }
	| { kind: "exited"; code: number | null }
	| { kind: "error"; reason: ErrorReason; detail: string };

interface Size {
	cols: number;
	rows: number;
}

// 寸法が取れないまま起動するとき（非表示中のコマンド実行など）の大きさ。
const FALLBACK_SIZE: Size = { cols: 80, rows: 24 };

// 起動の完了前に打たれた入力をためておく上限（バイト）。超えた分は捨てる。
const MAX_PENDING_INPUT_BYTES = 64 * 1024;

const INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";
const LOGIN_COMMAND = "claude /login";

/** Claude Code のターミナル UI を表示するパネル。 */
export class ClaudeTerminalView extends ItemView implements PanelView {
	private panelHeaderEl!: HTMLElement;
	private overlayEl!: HTMLElement;
	private exitEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private attachBtn: HTMLButtonElement | null = null;

	private pane!: XtermPane;
	private selection!: SelectionCapture;
	private notes!: NoteContext;
	private notifier!: CompletionNotifier;

	private status: Status = { kind: "idle" };
	private lastMode: SessionMode = { kind: "new" };
	// 起動のたびに増やす。非同期処理の途中で変わっていたら、その起動は古い。
	private generation = 0;
	private pty: PtySession | null = null;
	private endpoint: HookEndpoint | null = null;
	private size: Size | null = null;
	// hook で知った claude のセッション ID（発話するまで届かず、/clear で変わる）。
	// 発話の無いセッションは再開できないので、「再開」はこれがあるときだけ出す。
	private sessionId: string | null = null;
	// PTY が開くまで（this.pty が null の間）に打たれた入力。開いたら順に送る。
	private pendingInput: (string | Uint8Array)[] = [];
	private pendingInputBytes = 0;
	// Obsidian のステータスバーがこのビューの下端を覆っている高さ（px）。
	private statusBarInset = 0;
	private statusBar: HTMLElement | null = null;
	private statusBarObserver: ResizeObserver | null = null;
	private insetFrame: { win: Window; id: number } | null = null;
	private disposed = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ClaudePanelPlugin
	) {
		super(leaf);
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

	// ============================================================
	//   ライフサイクル
	// ============================================================

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("claude-panel-root", "claude-panel-terminal");
		this.applyRootStyles();

		this.panelHeaderEl = root.createDiv({ cls: "claude-panel-header" });
		const body = root.createDiv({ cls: "claude-panel-terminal-body" });
		const screen = body.createDiv({ cls: "claude-panel-terminal-screen" });
		this.overlayEl = body.createDiv({ cls: "claude-panel-terminal-overlay" });
		this.exitEl = root.createDiv({ cls: "claude-panel-terminal-exit" });
		this.contextEl = root.createDiv({ cls: "claude-panel-terminal-context" });
		const activeFileEl = this.contextEl.createDiv({
			cls: "claude-panel-active-file",
		});
		const selectionEl = this.contextEl.createDiv({
			cls: "claude-panel-selection is-empty",
		});

		this.selection = new SelectionCapture(this.app, this.containerEl, () =>
			this.notes.renderSelection()
		);
		this.notes = new NoteContext(
			this.app,
			this.selection,
			this.plugin.settings.includeActiveByDefault
		);
		this.notes.mount({ activeFileEl, selectionEl });
		trackNoteContext(this, this.notes, this.selection);

		this.notifier = new CompletionNotifier({
			getMode: () => this.plugin.settings.notifyOnComplete,
			getVolume: () => this.plugin.settings.notifySoundVolume,
			getSoundPath: () => this.plugin.settings.notifySoundPath,
			readSoundBytes: (path) => loadSoundBuffer(this.app, path),
			panelRoot: root,
		});
		// 完了通知は hook の受信時に鳴らすが、それはユーザー操作として扱われない。
		// プロンプトを送る Enter の時点で音を鳴らせる状態にしておく。
		this.registerDomEvent(
			root,
			"keydown",
			(e) => {
				if (e.key === "Enter") this.notifier.warmup();
			},
			{ capture: true }
		);

		this.renderHeader();
		this.renderStatus();
		this.notes.renderActiveFile();
		this.notes.renderSelection();
		this.selection.poll();

		// 端末にフォーカスがある間は、Obsidian のホットキーより端末を優先する。
		// undefined を返すと app.scope に流れ、true なら流れずに xterm へ届く。
		this.scope = new Scope(this.app.scope);
		this.scope.register(
			null as unknown as Modifier[],
			null,
			(evt) =>
				this.pane?.hasFocus() && !(Platform.isMacOS && evt.metaKey)
					? true
					: undefined
		);

		this.pane = new XtermPane({
			app: this.app,
			view: this,
			host: screen,
			getFontSize: () => this.plugin.settings.fontSize,
			onInput: (data) => this.sendInput(data),
			onResize: (cols, rows) => this.applySize({ cols, rows }),
			onVisible: () => {
				if (this.status.kind === "idle") {
					this.launch({ kind: "new" });
				} else {
					// 非表示のまま仮の大きさで起動していた。
					const size = this.pane.layout();
					if (size) this.applySize(size);
				}
			},
			onPasteImages: (files) => void this.pasteImages(files),
			onDropItems: (items) =>
				void this.insertReferences(
					items.osPaths,
					items.vaultPaths,
					items.unresolved
				),
		});

		// Obsidian の終了・リロードで claude を一括終了した。終了が取り消されたときに
		// 「実行中」のまま残らないよう、終了した表示にする。
		this.register(onKillAll(() => this.handleKilledAll()));

		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleInsetUpdate())
		);
		this.registerEvent(
			this.app.workspace.on("css-change", () => this.scheduleInsetUpdate())
		);
		this.register(
			this.containerEl.onWindowMigrated(() => this.scheduleInsetUpdate())
		);
		this.scheduleInsetUpdate();
	}

	async onClose(): Promise<void> {
		this.disposed = true;
		this.cancelInsetFrame();
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		this.stopSession();
		this.pane?.dispose();
		this.notifier?.dispose();
	}

	onResize(): void {
		this.pane?.scheduleLayout();
		this.scheduleInsetUpdate();
	}

	// ============================================================
	//   PanelView
	// ============================================================

	focusInput(): void {
		this.selection?.poll();
		this.selection?.markHandoff();
		this.pane?.focus();
	}

	applyFontSize(): void {
		this.applyRootStyles();
		this.pane?.applyAppearance();
	}

	applyComposerBottomPadding(): void {
		this.applyRootStyles();
		this.pane?.scheduleLayout();
	}

	/** 端末には触らず、ロケール文字列を含む部分だけを作り直す。 */
	rebuildLocalizedUI(): void {
		if (!this.notes) return;
		this.renderHeader();
		this.renderStatus();
		this.notes.renderActiveFile();
		this.notes.renderSelection();
	}

	testNotificationSound(): void {
		this.notifier?.playTest();
	}

	commandClear(): void {
		// まだ一度も表示されていなければ、表示されたときに新しいセッションで起動する。
		if (this.status.kind !== "idle") this.launch({ kind: "new" });
	}

	commandCancel(): boolean {
		if (this.status.kind !== "running" || !this.pty) return false;
		this.pty.write("\x1b");
		return true;
	}

	commandToggleIncludeActive(): void {
		const include = this.notes.toggleIncludeActive();
		const target = this.notes.getActiveTargetLabel();
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
	//   起動と終了
	// ============================================================

	/** いまのセッションを終えて、新しく起動する。 */
	private launch(mode: SessionMode): void {
		if (this.disposed) return;
		this.stopSession();
		const generation = this.generation;
		this.lastMode = mode;
		// 再開では同じ ID が続く。前回の続きでは、どの会話かは hook が届くまで分からない。
		this.sessionId = mode.kind === "resume" ? mode.sessionId : null;
		this.setStatus({ kind: "starting" });
		this.pane.clear();
		this.pane.setInputEnabled(true);
		this.openSession(mode, generation).catch((e: unknown) => {
			if (generation !== this.generation) return;
			this.fail(
				e instanceof PtyUnavailableError ? "ptyUnavailable" : "bridge",
				e instanceof Error ? e.message : String(e)
			);
		});
	}

	private async openSession(
		mode: SessionMode,
		generation: number
	): Promise<void> {
		const cwd = getVaultBasePath(this.app);
		if (!cwd) {
			this.fail("noVault", "");
			return;
		}
		const configured = resolveClaudePath(this.plugin.settings.claudePath);
		if (!configured) {
			this.fail("cliMissing", "");
			return;
		}
		const file = nodePath.resolve(configured);

		const endpoint = await this.registerHook(generation);
		if (generation !== this.generation) {
			endpoint?.dispose();
			return;
		}
		this.endpoint = endpoint;
		// hook が無いとノートの情報は claude に届かない。
		this.contextEl.toggle(endpoint !== null);

		const size = this.pane.layout() ?? this.size ?? FALLBACK_SIZE;
		let exited = false;
		const pty = await openPty(
			{
				file,
				args: buildLaunchArgs({
					mode,
					disableMcpServers: this.plugin.settings.disableMcpServers,
					settingsJson: buildClaudeSettings({
						hookUrl: endpoint?.url ?? null,
					}),
				}),
				cwd,
				env: buildLaunchEnv(file, {
					COLORFGBG: isDarkTheme(this.containerEl) ? "15;0" : "0;15",
					...(endpoint ? { [HOOK_TOKEN_ENV]: endpoint.token } : {}),
				}),
				...size,
			},
			{
				onData: (chunk) => {
					if (generation !== this.generation) return;
					if (this.status.kind === "starting") {
						this.setStatus({ kind: "running" });
					}
					this.pane.write(chunk);
				},
				onExit: (exit) => {
					exited = true;
					if (generation === this.generation) this.handleExit(exit);
				},
			}
		);
		if (exited) return;
		if (generation !== this.generation) {
			pty.kill();
			return;
		}
		this.pty = pty;
		this.pane.setFlow(pty);
		// openPty を待つ間に大きさが変わっていたら合わせる。
		const latest = this.size;
		if (latest && (latest.cols !== size.cols || latest.rows !== size.rows)) {
			pty.resize(latest.cols, latest.rows);
		}
		const pending = this.pendingInput;
		this.clearPendingInput();
		for (const data of pending) pty.write(data);
	}

	/** 起動中なら、PTY が開くまでためておく。 */
	private sendInput(data: string | Uint8Array): void {
		if (this.pty) {
			this.pty.write(data);
			return;
		}
		if (this.status.kind !== "starting" && this.status.kind !== "running") return;
		const bytes =
			typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
		if (this.pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) return;
		this.pendingInput.push(data);
		this.pendingInputBytes += bytes;
	}

	private clearPendingInput(): void {
		this.pendingInput = [];
		this.pendingInputBytes = 0;
	}

	private applySize(size: Size): void {
		this.size = size;
		this.pty?.resize(size.cols, size.rows);
	}

	private handleExit(exit: PtyExit): void {
		this.releaseSession();
		if (exit.failure) {
			this.fail(exit.failure.kind, exit.failure.detail);
			return;
		}
		this.pane.setInputEnabled(false);
		this.setStatus({ kind: "exited", code: exit.code });
	}

	private fail(reason: ErrorReason, detail: string): void {
		this.releaseSession();
		this.pane.setInputEnabled(false);
		this.setStatus({ kind: "error", reason, detail });
	}

	/** 進行中の起動を無効にし、動いている claude を終了する。 */
	private stopSession(): void {
		this.generation++;
		this.releaseSession();
	}

	/** killAllPtys で終了させられた。kill した PTY の onExit は届かない。 */
	private handleKilledAll(): void {
		if (this.disposed) return;
		if (this.status.kind !== "starting" && this.status.kind !== "running") return;
		// 起動の途中なら、開いた PTY は世代の違いで閉じられる。
		this.stopSession();
		this.pane.setInputEnabled(false);
		this.setStatus({ kind: "exited", code: null });
	}

	/** 起動を待っている入力も捨てる。 */
	private releaseSession(): void {
		this.clearPendingInput();
		this.pty?.kill();
		this.pty = null;
		this.pane?.setFlow(null);
		this.endpoint?.dispose();
		this.endpoint = null;
	}

	private setStatus(status: Status): void {
		this.status = status;
		this.renderStatus();
	}

	// ============================================================
	//   hook
	// ============================================================

	private async registerHook(generation: number): Promise<HookEndpoint | null> {
		try {
			return await this.plugin.hookServer.register((req) =>
				generation === this.generation ? this.handleHook(req) : null
			);
		} catch (e) {
			console.warn("[claude-panel] hook server unavailable", e);
			return null;
		}
	}

	private handleHook(req: HookRequest): HookReply | null {
		if (req.sessionId) this.sessionId = req.sessionId;
		switch (req.event) {
			case "UserPromptSubmit":
				return this.handleUserPrompt(req);
			case "Stop":
				this.notifier.notify();
				return null;
			default:
				return null;
		}
	}

	private handleUserPrompt(req: HookRequest): HookReply | null {
		if (req.prompt?.startsWith("/")) return null;
		return userPromptReply(
			formatNoteContext(
				this.notes.getIncludedTarget(),
				this.notes.getIncludedSelection()
			)
		);
	}

	// ============================================================
	//   添付・貼り付け・ドロップ
	// ============================================================

	private async attachFiles(): Promise<void> {
		const { paths, unresolvedCount } = await pickFilesViaDialog();
		await this.insertReferences(paths, [], unresolvedCount);
	}

	/** ファイル・フォルダへの `@` 参照を入力欄に入れる。 */
	private async insertReferences(
		osPaths: string[],
		vaultPaths: string[],
		unresolved: number
	): Promise<void> {
		if (!this.canInput()) return;
		const generation = this.generation;
		const { settings } = this.plugin;
		const osFolders = osPaths.filter(isDirectory);
		const osFiles = osPaths.filter((p) => !osFolders.includes(p));

		const files = await importAttachments(
			this.app,
			settings,
			osFiles,
			settings.saveAttachmentsToVault
		);
		// フォルダはコピーせず、元の場所を参照する。
		const folders = await importAttachments(
			this.app,
			settings,
			osFolders,
			false
		);
		const refs = new Set([
			...vaultPaths.map((p) => formatReference(p, this.isVaultFolder(p))),
			...files.paths.map((p) => formatReference(p, false)),
			...folders.paths.map((p) => formatReference(p, true)),
		]);

		if (files.copied > 0) {
			new Notice(t("composer.savedToVault", files.copied));
		}
		if (files.failed > 0) {
			new Notice(t("composer.copyFailed", files.failed));
		}
		if (unresolved > 0) {
			new Notice(t("composer.unresolvedPaths", unresolved));
		}
		if (refs.size === 0 || generation !== this.generation) return;
		this.pane.paste(` ${[...refs].join(" ")} `);
		this.pane.focus();
	}

	/** 画像を保存し、絶対パスを入力欄に入れる（claude が画像として読み込む）。 */
	private async pasteImages(files: File[]): Promise<void> {
		const base = getVaultBasePath(this.app);
		if (!base || !this.canInput()) return;
		const generation = this.generation;
		const { settings } = this.plugin;
		const usedNames = new Set<string>();
		const paths: string[] = [];
		for (const file of files) {
			try {
				const saved = await storePastedImage(
					this.app,
					settings,
					this.plugin.getAttachmentFolder(),
					file,
					uniqueName(pastedImageFileName(file), usedNames),
					settings.saveAttachmentsToVault
				);
				paths.push(nodePath.join(base, saved));
			} catch (e) {
				new Notice(
					t("composer.pasteFailed", e instanceof Error ? e.message : String(e))
				);
			}
		}
		if (paths.length > 0 && settings.saveAttachmentsToVault) {
			new Notice(t("composer.savedToVault", paths.length));
		}
		if (generation !== this.generation) return;
		if (paths.length > 0) this.pane.paste(paths.map(quoteImagePath).join(" "));
	}

	private canInput(): boolean {
		return this.pty !== null && this.status.kind === "running";
	}

	private isVaultFolder(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
	}

	// ============================================================
	//   描画
	// ============================================================

	private applyRootStyles(): void {
		const { fontSize, composerBottomPadding } = this.plugin.settings;
		const { style } = this.contentEl;
		style.setProperty("--claude-panel-font-size", `${fontSize}px`);
		// 設定の余白はステータスバーを避けるために使われてきたので、足さずに大きい方を使う。
		const bottom = Math.max(composerBottomPadding, this.statusBarInset);
		style.setProperty("--claude-panel-composer-bottom-padding", `${bottom}px`);
	}

	// ---------- ステータスバー ----------

	/** レイアウトが落ち着いた次のフレームで、ステータスバーとの重なりを測り直す。 */
	private scheduleInsetUpdate(): void {
		if (this.disposed) return;
		this.cancelInsetFrame();
		const { win } = this.containerEl;
		const id = win.requestAnimationFrame(() => {
			this.insetFrame = null;
			this.updateStatusBarInset();
		});
		this.insetFrame = { win, id };
	}

	private cancelInsetFrame(): void {
		if (!this.insetFrame) return;
		this.insetFrame.win.cancelAnimationFrame(this.insetFrame.id);
		this.insetFrame = null;
	}

	private updateStatusBarInset(): void {
		if (this.disposed) return;
		// ポップアウトのウィンドウにはステータスバーが無い。
		const bar = this.containerEl.doc.body.querySelector<HTMLElement>(".status-bar");
		if (bar !== this.statusBar) this.observeStatusBar(bar);
		const inset = bar ? this.measureOverlap(bar) : 0;
		if (inset === this.statusBarInset) return;
		this.statusBarInset = inset;
		this.applyRootStyles();
		this.pane?.scheduleLayout();
	}

	/** 項目が増減してステータスバーの幅が変わると、重なり方も変わる。 */
	private observeStatusBar(bar: HTMLElement | null): void {
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		this.statusBar = bar;
		if (!bar) return;
		const win = bar.win as Window & { ResizeObserver: typeof ResizeObserver };
		this.statusBarObserver = new win.ResizeObserver(() =>
			this.scheduleInsetUpdate()
		);
		// 余白や枠線で高さが変わることもあるので、枠の外側の大きさで見る。
		this.statusBarObserver.observe(bar, { box: "border-box" });
	}

	/**
	 * ステータスバーがこのビューに重なる高さ。余白は内側に付くので、測る枠は変わらない。
	 * 非表示・重ならないときは 0。
	 */
	private measureOverlap(bar: HTMLElement): number {
		const barRect = bar.getBoundingClientRect();
		if (barRect.width === 0 || barRect.height === 0) return 0;
		if (bar.win.getComputedStyle(bar).visibility === "hidden") return 0;
		const rect = this.contentEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return 0;
		const overlapsX = barRect.left < rect.right && barRect.right > rect.left;
		const overlapY =
			Math.min(rect.bottom, barRect.bottom) - Math.max(rect.top, barRect.top);
		return overlapsX && overlapY > 0 ? Math.ceil(overlapY) : 0;
	}

	private renderHeader(): void {
		this.panelHeaderEl.empty();
		this.panelHeaderEl.createEl("h3", { text: t("view.headerTitle") });
		const actions = this.panelHeaderEl.createDiv({
			cls: "claude-panel-terminal-actions",
		});
		const addButton = (
			icon: string,
			label: string,
			onClick: () => void
		): HTMLButtonElement => {
			const button = actions.createEl("button", {
				cls: "claude-panel-icon-btn",
				attr: { "aria-label": label },
			});
			setIcon(button, icon);
			button.onclick = onClick;
			return button;
		};
		addButton("plus", t("terminal.newSession"), () =>
			this.launchFromClick({ kind: "new" })
		);
		addButton("history", t("terminal.continueSession"), () =>
			this.launchFromClick({ kind: "continue" })
		);
		this.attachBtn = addButton(
			"paperclip",
			t("terminal.attach"),
			() => void this.attachFiles()
		);
		this.attachBtn.disabled = this.status.kind !== "running";
		addButton("user", t("view.accountBtnAria"), () =>
			openAccountUsageModal(
				this.app,
				this.plugin.settings,
				this.plugin.usageHistory
			)
		);
		addButton("settings", t("terminal.openSettings"), () =>
			this.openPluginSettings()
		);
	}

	private launchFromClick(mode: SessionMode): void {
		this.launch(mode);
		this.pane.focus();
	}

	private renderStatus(): void {
		const { status } = this;
		if (this.attachBtn) this.attachBtn.disabled = status.kind !== "running";

		this.overlayEl.empty();
		this.overlayEl.toggle(status.kind === "starting" || status.kind === "error");
		if (status.kind === "starting") {
			this.overlayEl.createDiv({
				cls: "claude-panel-terminal-starting",
				text: t("terminal.starting"),
			});
		} else if (status.kind === "error") {
			this.renderError(status.reason, status.detail);
		}

		this.exitEl.empty();
		this.exitEl.toggle(status.kind === "exited");
		if (status.kind === "exited") this.renderExitBar(status.code);
	}

	private renderExitBar(code: number | null): void {
		this.exitEl.createSpan({
			cls: "claude-panel-terminal-exit-label",
			text:
				code === null
					? t("terminal.exitedUnknown")
					: t("terminal.exited", code),
		});
		const actions = this.exitEl.createDiv({
			cls: "claude-panel-terminal-exit-actions",
		});
		const { sessionId } = this;
		if (sessionId) {
			this.addTextButton(actions, t("terminal.resume"), true, () =>
				this.launchFromClick({ kind: "resume", sessionId })
			);
		}
		this.addTextButton(actions, t("terminal.newSession"), !sessionId, () =>
			this.launchFromClick({ kind: "new" })
		);
	}

	private renderError(reason: ErrorReason, detail: string): void {
		const card = this.overlayEl.createDiv({ cls: "claude-panel-empty" });
		card.createDiv({
			cls: "claude-panel-empty-warn",
			text: errorMessage(reason),
		});
		if (reason === "cliMissing") {
			const steps = card.createEl("ol", { cls: "claude-panel-empty-steps" });
			const install = steps.createEl("li");
			install.createSpan({ text: t("view.emptyStepRunInTerminal") });
			install.createEl("code", {
				text: INSTALL_COMMAND,
			});
			const login = steps.createEl("li");
			login.createSpan({ text: t("view.emptyStepThenLogin") });
			login.createEl("code", { text: LOGIN_COMMAND });
		}
		if (reason === "ptyUnavailable") {
			card.createDiv({ text: t("terminal.errPtyUnavailableHint") });
		}
		if (detail) {
			card.createEl("pre", {
				cls: "claude-panel-terminal-error-detail",
				text: detail,
			});
		}

		const actions = card.createDiv({ cls: "claude-panel-empty-actions" });
		if (reason === "cliMissing" || reason === "launch") {
			this.addTextButton(actions, t("view.emptyOpenSettings"), true, () =>
				this.openPluginSettings()
			);
		}
		if (reason === "ptyUnavailable" || reason === "bridge") {
			this.addTextButton(
				actions,
				t("terminal.switchToChat"),
				true,
				() => void this.plugin.setInterfaceMode("chat")
			);
		}
		this.addTextButton(actions, t("terminal.retry"), false, () =>
			this.launchFromClick(this.lastMode)
		);
	}

	private addTextButton(
		host: HTMLElement,
		text: string,
		primary: boolean,
		onClick: () => void
	): void {
		const button = host.createEl("button", {
			cls: primary ? "mod-cta" : "",
			text,
		});
		button.onclick = onClick;
	}

	private openPluginSettings(): void {
		const setting = getSettingModal(this.app);
		setting?.open();
		setting?.openTabById(this.plugin.manifest.id);
	}
}

function errorMessage(reason: ErrorReason): string {
	switch (reason) {
		case "noVault":
			return t("view.vaultPathUnavailable");
		case "cliMissing":
			return t("view.emptyCliMissing");
		case "ptyUnavailable":
			return t("terminal.errPtyUnavailable");
		case "bridge":
			return t("terminal.errBridge");
		case "launch":
			return t("terminal.errLaunch");
	}
}

/** 引用しなくてよい `@` 参照のパス。 */
const PLAIN_REFERENCE = /^[\w./][\w./-]*$/;
/** 引用しなくてよい画像のパス（Windows の絶対パスの `\` と `:` を含む）。 */
const PLAIN_IMAGE_PATH = /^[\w./\\:-]+$/;

/**
 * claude の `@` 参照。空白や日本語などを含むパスは引用符で囲む。`#` を含むパスは
 * 参照として認識されないので、パスだけにする。引用が要り `"` も含むパスは `'…'` で
 * 囲む（`@'…'` は参照にならないので `@` は付けない）。`'` も含むならそのまま入れる。
 */
function formatReference(path: string, isFolder: boolean): string {
	const unified = nodePath.sep === "\\" ? path.replace(/\\/g, "/") : path;
	const target = isFolder && !unified.endsWith("/") ? `${unified}/` : unified;
	if (!target.includes('"')) {
		if (PLAIN_REFERENCE.test(target)) return `@${target}`;
		return target.includes("#") ? `"${target}"` : `@"${target}"`;
	}
	// `"` のほかに引用の要る文字が無ければ、これまでどおり引用しない。
	if (PLAIN_REFERENCE.test(target.replace(/"/g, ""))) {
		return target.includes("#") ? target : `@${target}`;
	}
	return target.includes("'") ? target : `'${target}'`;
}

/**
 * 貼り付けた画像の絶対パス。claude は `"…"` と `'…'` のどちらで囲んでも画像として
 * 読み込む。引用の仕方は formatReference に合わせ、`'` と `"` の両方を含み引用が要る
 * ならそのまま入れる。
 */
function quoteImagePath(path: string): string {
	if (!path.includes('"')) {
		return PLAIN_IMAGE_PATH.test(path) ? path : `"${path}"`;
	}
	if (PLAIN_IMAGE_PATH.test(path.replace(/"/g, ""))) return path;
	return path.includes("'") ? path : `'${path}'`;
}

/** 同じ名前が既にあれば拡張子の前に `-2`, `-3` … を付ける。 */
function uniqueName(name: string, used: Set<string>): string {
	const { name: base, ext } = nodePath.parse(name);
	let candidate = name;
	for (let i = 2; used.has(candidate); i++) candidate = `${base}-${i}${ext}`;
	used.add(candidate);
	return candidate;
}

function isDirectory(path: string): boolean {
	try {
		return fs.statSync(path).isDirectory();
	} catch {
		return false;
	}
}
