import { App, Notice, TFile, TFolder } from "obsidian";
import * as nodePath from "path";
import type ClaudePanelPlugin from "./main";
import type { ComposedMessage } from "./chat-runtime";
import type { CapturedSelection, SelectionCapture } from "./selection-capture";
import type { SelectionRef } from "./chat-message";
import type { EffortLevel, ThinkingMode } from "./settings";
import {
	copyFileToVault,
	extractPastedImages,
	pickFilesViaDialog,
	resolveAttachmentDir,
	savePastedImage,
	savePastedImageToVault,
} from "./attachments";
import { toVaultRelativeIfInside } from "./notify-sound-source";
import { t } from "./i18n";

/**
 * チャット入力エリアの「何を Claude に送るか」を所有するコンポーネント。
 *
 * 担当範囲:
 *   - 添付パス（Vault 相対 / 絶対）の状態管理と UI チップ描画
 *   - アクティブファイル/フォルダのプレビューと「含める」トグル
 *   - エディタ選択範囲のプレビューと「含める」トグル
 *   - 上記すべてを束ねた送信用プロンプトの組み立て (composeMessage)
 *
 * view 側は本クラスの公開メソッドを呼ぶだけで、自前で添付配列を持ったり
 * 添付チップを描画したりしない。DOM ホスト要素（activeFileEl 等）は
 * view が `renderComposer` の途中で生成し、`mount` で渡す。
 */
export class Composer {
	private app: App;
	private plugin: ClaudePanelPlugin;
	private selection: SelectionCapture;

	private attachments: string[] = []; // Vault 相対 or OS 絶対パス
	// 添付・貼り付けたファイルを Vault 内に保存するか。パネルの「Vault に
	// 保存」チェックボックスと同期する一時状態。初期値はプラグイン設定
	// `saveAttachmentsToVault` 由来だが、トグルしても設定は書き換えない。
	private saveToVault: boolean;
	private includeActiveFile = true;
	// 直近にファイルエクスプローラーでクリックされたフォルダ。
	// 設定されている間はアクティブファイルの自動メンションを置き換える。
	// ファイル選択（file-open）が発生したら view 側でクリアされる。
	private activeFolderPath: string | null = null;
	private includeSelection = true;

	// mount 後に有効。レンダラ側からのみ参照する。
	private activeFileEl: HTMLElement | null = null;
	private selectionEl: HTMLElement | null = null;
	private attachmentsEl: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: ClaudePanelPlugin,
		selection: SelectionCapture
	) {
		this.app = app;
		this.plugin = plugin;
		this.selection = selection;
		this.saveToVault = plugin.settings.saveAttachmentsToVault;
	}

	mount(hosts: {
		activeFileEl: HTMLElement;
		selectionEl: HTMLElement;
		attachmentsEl: HTMLElement;
	}): void {
		this.activeFileEl = hosts.activeFileEl;
		this.selectionEl = hosts.selectionEl;
		this.attachmentsEl = hosts.attachmentsEl;
	}

	// ============================================================
	//   公開ステート操作
	// ============================================================

	setActiveFolderPath(path: string | null): void {
		this.activeFolderPath = path;
		this.renderActiveFile();
	}

	getActiveFolderPath(): string | null {
		return this.activeFolderPath;
	}

	toggleIncludeActive(): boolean {
		this.includeActiveFile = !this.includeActiveFile;
		this.renderActiveFile();
		return this.includeActiveFile;
	}

	getIncludeActive(): boolean {
		return this.includeActiveFile;
	}

	/** パネルの「Vault に保存」チェックボックスの現在値。 */
	getSaveToVault(): boolean {
		return this.saveToVault;
	}

	/** パネルの「Vault に保存」チェックボックスの値を反映する。一時状態
	 *  なので、プラグイン設定 `saveAttachmentsToVault` は書き換えない。 */
	setSaveToVault(value: boolean): void {
		this.saveToVault = value;
	}

	/** トグルコマンドの通知メッセージ用に「対象パス」を返す。 */
	getActiveTargetLabel(): string | null {
		if (this.activeFolderPath) return `${this.activeFolderPath}/`;
		const f = this.getActiveFile();
		return f ? f.path : null;
	}

	/** 会話クリア時など、添付状態を全部リセットする。 */
	clearAttachments(): void {
		this.attachments = [];
		this.renderAttachments();
	}

	// ============================================================
	//   ピッカー / ペースト
	// ============================================================

	async openAttachPicker(): Promise<void> {
		const { paths, unresolvedCount } = await pickFilesViaDialog();
		// 「Vault に保存」が ON のときは、Vault 外ファイルを Vault 内へ
		// コピーする。保存先はピッカーを閉じた時点のアクティブファイル基準。
		const toVault = this.saveToVault;
		const dir = toVault
			? resolveAttachmentDir(this.app, this.plugin.settings)
			: "";
		let added = 0;
		let copied = 0;
		let copyFailed = 0;
		for (const p of paths) {
			let attachPath = p;
			if (toVault) {
				// 既に Vault 配下のファイルはコピーせず相対パスで参照する。
				const rel = toVaultRelativeIfInside(p, this.app);
				if (rel !== p) {
					attachPath = rel;
				} else {
					try {
						attachPath = await copyFileToVault(this.app, dir, p);
						copied++;
					} catch (err) {
						console.warn(
							"[claude-panel] copy attachment failed",
							p,
							err
						);
						copyFailed++;
						continue;
					}
				}
			}
			if (!this.attachments.includes(attachPath)) {
				this.attachments.push(attachPath);
				added++;
			}
		}
		if (added > 0) this.renderAttachments();
		if (copied > 0) new Notice(t("composer.savedToVault", copied));
		if (copyFailed > 0) new Notice(t("composer.copyFailed", copyFailed));
		if (unresolvedCount > 0) {
			new Notice(t("composer.unresolvedPaths", unresolvedCount));
		} else if (paths.length > 0 && added === 0 && copyFailed === 0) {
			new Notice(t("composer.alreadyAttached"));
		}
	}

	async handlePaste(e: ClipboardEvent): Promise<void> {
		const images = extractPastedImages(e);
		if (images.length === 0) return;
		// バイナリ文字列が textarea に貼り付けられないよう抑止する。
		e.preventDefault();
		// 「Vault に保存」が ON なら設定どおりの Vault 内フォルダへ、OFF なら
		// プラグインの一時フォルダ（unload 時に掃除される）へ書き出す。
		const toVault = this.saveToVault;
		const dir = toVault
			? resolveAttachmentDir(this.app, this.plugin.settings)
			: "";
		for (const img of images) {
			try {
				const savedPath = toVault
					? await savePastedImageToVault(this.app, dir, img)
					: await savePastedImage(
							this.app,
							this.plugin.getAttachmentFolder(),
							img
						);
				if (!this.attachments.includes(savedPath)) {
					this.attachments.push(savedPath);
				}
				this.renderAttachments();
				new Notice(t("composer.pasted", savedPath));
			} catch (err) {
				new Notice(
					t("composer.pasteFailed", (err as Error).message)
				);
			}
		}
	}

	// ============================================================
	//   レンダリング
	// ============================================================

	renderAll(): void {
		this.renderActiveFile();
		this.renderSelection();
		this.renderAttachments();
	}

	renderActiveFile(): void {
		const host = this.activeFileEl;
		if (!host) return;
		host.empty();

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
				const label = host.createSpan({
					cls: "claude-panel-active-file-label",
					text: t("composer.activeLabel"),
				});
				label.title = t("composer.activeFolderTooltip");
				const pathEl = host.createSpan({
					cls: "claude-panel-active-file-path",
					text: `${folder.path}/ ×${fileCount}`,
				});
				pathEl.title = t("composer.folderFileCount", folder.path, fileCount);
				const toggle = host.createEl("button", {
					cls: "claude-panel-active-file-toggle",
					text: this.includeActiveFile
						? t("composer.toggleIncluded")
						: t("composer.toggleExcluded"),
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
			host.createSpan({
				cls: "claude-panel-active-file-empty",
				text: t("composer.noActiveFile"),
			});
			return;
		}
		const label = host.createSpan({
			cls: "claude-panel-active-file-label",
			text: t("composer.activeLabel"),
		});
		label.title = t("composer.activeFileTooltip");
		const pathEl = host.createSpan({
			cls: "claude-panel-active-file-path",
			text: file.path,
		});
		pathEl.title = file.path;
		const toggle = host.createEl("button", {
			cls: "claude-panel-active-file-toggle",
			text: this.includeActiveFile
				? t("composer.toggleIncluded")
				: t("composer.toggleExcluded"),
		});
		toggle.onclick = () => {
			this.includeActiveFile = !this.includeActiveFile;
			this.renderActiveFile();
		};
	}

	renderSelection(): void {
		const host = this.selectionEl;
		if (!host) return;
		host.empty();
		const sel = this.selection?.get() ?? null;
		if (!sel) {
			host.addClass("is-empty");
			return;
		}
		host.removeClass("is-empty");

		const charCount = sel.text.length;

		const header = host.createDiv({
			cls: "claude-panel-selection-header",
		});
		header.createSpan({
			cls: "claude-panel-selection-label",
			text: t("composer.selectionLabel"),
		});
		header.createSpan({
			cls: "claude-panel-selection-meta",
			text: t("composer.selectionMeta", sel.lineCount, charCount, sel.startLine),
		});
		const toggle = header.createEl("button", {
			cls: "claude-panel-selection-toggle",
			text: this.includeSelection
				? t("composer.toggleIncluded")
				: t("composer.toggleExcluded"),
		});
		toggle.onclick = () => {
			this.includeSelection = !this.includeSelection;
			this.renderSelection();
		};

		const preview = host.createDiv({
			cls: "claude-panel-selection-preview",
		});
		const firstLine = sel.text.split("\n")[0];
		const truncated =
			firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
		const tail = sel.lineCount > 1 ? t("composer.selectionMoreLines", sel.lineCount - 1) : "";
		preview.setText(truncated + tail);
		preview.title = sel.text;
	}

	renderAttachments(): void {
		const host = this.attachmentsEl;
		if (!host) return;
		host.empty();
		for (const path of this.attachments) {
			const isFolder = this.isFolderPath(path);
			const isAbs = nodePath.isAbsolute(path);
			const chip = host.createDiv({ cls: "claude-panel-chip" });
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
					attr: { title: t("composer.fileCount", count) },
				});
			}
			const x = chip.createEl("button", { text: "×" });
			x.onclick = () => {
				this.attachments = this.attachments.filter((p) => p !== path);
				this.renderAttachments();
			};
		}
	}

	// ============================================================
	//   送信プロンプト組み立て
	// ============================================================

	composeMessage(userText: string): ComposedMessage {
		const isSlash = userText.startsWith("/");

		// 表示用ラベル（フォルダは末尾 `/` 付きで1チップ）と、CLI に渡す
		// パスを別々に組み立てる。フォルダは中身を展開せず、フォルダパス
		// 自体を1つの @-mention として送る。配下が大きいフォルダで全
		// ファイルを読み込ませて context を溢れさせないため。Claude Code
		// 側で必要なファイルだけ Glob/Read で探索してもらう前提。
		const mentionLabels: string[] = [];
		const promptPaths: string[] = [];
		const addMention = (path: string, isFolder: boolean): void => {
			const label = isFolder ? `${path}/` : path;
			if (!mentionLabels.includes(label)) mentionLabels.push(label);
			const promptPath = isFolder ? `${path}/` : path;
			if (!promptPaths.includes(promptPath)) promptPaths.push(promptPath);
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
		const thinkingMode: ThinkingMode = isSlash
			? "off"
			: this.plugin.settings.thinkingMode;

		// claude へ送る添付パスは Vault 相対 / 絶対を区別せず、すべて
		// 「添付パス」ブロックに列挙する。@-mention で送ると Claude Code
		// が解決時にファイル本文をプロンプトへ自動展開してしまい、フォルダ
		// や巨大ファイル指定で context が溢れるため、内容ではなくパスだけ
		// を渡し、必要に応じて Read/Glob ツールで読ませる方針に統一する。
		// 絶対パスはバックスラッシュをフォワードスラッシュへ正規化する。
		const attachPaths = promptPaths.map((p) =>
			nodePath.isAbsolute(p) ? p.replace(/\\/g, "/") : p
		);
		const attachBlock = attachPaths.length
			? `[Attached paths — read on demand with the Read / Glob tools]\n${attachPaths
					.map((p) => `- ${p}`)
					.join("\n")}\n\n`
			: "";

		const fullPrompt = `${attachBlock}${selectionBlock}${thinkPrefix}${userText}`;

		// effortLevel は user メッセージのバッジ表示用。スラッシュコマンドや
		// `auto` のときは保存しない（バッジが出ないことで「明示的な選択」と
		// 「既定」を区別する）。
		const effortLevel: EffortLevel | undefined =
			!isSlash && this.plugin.settings.effortLevel !== "auto"
				? this.plugin.settings.effortLevel
				: undefined;

		return {
			mentions: mentionLabels,
			selectionRef,
			body,
			fullPrompt,
			thinkingMode,
			effortLevel,
		};
	}

	// ============================================================
	//   内部ヘルパー
	// ============================================================

	private getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
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
}

function formatSelectionBlock(sel: CapturedSelection | null): string {
	if (!sel) return "";
	// プロンプトの構造は言語非依存(英語ラベル)で送る。Claude が読むため、
	// ユーザの Obsidian 言語設定とは独立。
	const src = sel.filePath
		? ` (source: \`${sel.filePath}\` L${sel.startLine})`
		: "";
	return `Selection${src}:\n\`\`\`\n${sel.text}\n\`\`\`\n\n`;
}
