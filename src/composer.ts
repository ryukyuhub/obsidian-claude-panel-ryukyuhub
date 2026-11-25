import { App, Notice, TFolder } from "obsidian";
import * as nodePath from "path";
import type ClaudePanelPlugin from "./main";
import type { ComposedMessage } from "./chat-runtime";
import type { SelectionCapture } from "./selection-capture";
import type { SelectionRef } from "./chat-message";
import type { EffortLevel, ThinkingMode } from "./settings";
import {
	extractPastedImages,
	importAttachments,
	pastedImageFileName,
	pickFilesViaDialog,
	storePastedImage,
} from "./attachments";
import { NoteContext, formatSelectionBlock, listFolderFiles } from "./note-context";
import { t } from "./i18n";

/**
 * チャット入力エリアの「何を Claude に送るか」を所有するコンポーネント。
 *
 * 担当範囲:
 *   - 添付パス（Vault 相対 / 絶対）の状態管理と UI チップ描画
 *   - アクティブファイル/フォルダと選択範囲（NoteContext に委譲）
 *   - 上記すべてを束ねた送信用プロンプトの組み立て (composeMessage)
 *
 * view 側は本クラスの公開メソッドを呼ぶだけで、自前で添付配列を持ったり
 * 添付チップを描画したりしない。DOM ホスト要素（activeFileEl 等）は
 * view が `renderComposer` の途中で生成し、`mount` で渡す。
 */
export class Composer {
	private app: App;
	private plugin: ClaudePanelPlugin;
	/** アクティブファイル/フォルダと選択範囲の状態と表示。 */
	readonly notes: NoteContext;

	private attachments: string[] = []; // Vault 相対 or OS 絶対パス
	// 貼り付けた画像のうち、まだディスクに書き出していないもの。送信時に
	// flushPendingPastes() でまとめて保存して `attachments` に移される。
	// クリップボードから来た File オブジェクトと、保存時に使う確定済み
	// ファイル名（チップ表示用にも使う）をセットで保持する。
	private pendingPastes: { file: File; fileName: string }[] = [];

	// mount 後に有効。レンダラ側からのみ参照する。
	private attachmentsEl: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: ClaudePanelPlugin,
		selection: SelectionCapture
	) {
		this.app = app;
		this.plugin = plugin;
		// パネル内のトグルは一時状態で、設定値は書き換えない。
		this.notes = new NoteContext(
			app,
			selection,
			plugin.settings.includeActiveByDefault
		);
	}

	mount(hosts: {
		activeFileEl: HTMLElement;
		selectionEl: HTMLElement;
		attachmentsEl: HTMLElement;
	}): void {
		this.notes.mount(hosts);
		this.attachmentsEl = hosts.attachmentsEl;
	}

	// ============================================================
	//   公開ステート操作
	// ============================================================

	setActiveFolderPath(path: string | null): void {
		this.notes.setActiveFolderPath(path);
	}

	getActiveFolderPath(): string | null {
		return this.notes.getActiveFolderPath();
	}

	toggleIncludeActive(): boolean {
		return this.notes.toggleIncludeActive();
	}

	getIncludeActive(): boolean {
		return this.notes.getIncludeActive();
	}

	/** パネルの「Vault に保存」チェックボックスの現在値。プラグインインスタンス
	 *  に持たせた一時状態を直接返すので、パネルの開閉やタブ切り替えを跨いでも
	 *  値が保持される。 */
	getSaveToVault(): boolean {
		return this.plugin.runtimeSaveAttachmentsToVault;
	}

	/** パネルの「Vault に保存」チェックボックスの値を反映する。一時状態
	 *  なので、プラグイン設定 `saveAttachmentsToVault` は書き換えない。 */
	setSaveToVault(value: boolean): void {
		this.plugin.runtimeSaveAttachmentsToVault = value;
	}

	/** トグルコマンドの通知メッセージ用に「対象パス」を返す。 */
	getActiveTargetLabel(): string | null {
		return this.notes.getActiveTargetLabel();
	}

	/** 会話クリア時など、添付状態を全部リセットする。未保存のペースト画像は
	 *  ディスクに書き出されないまま破棄される（これが本機能の狙い）。 */
	clearAttachments(): void {
		this.attachments = [];
		this.pendingPastes = [];
		this.renderAttachments();
	}

	// ============================================================
	//   ピッカー / ペースト
	// ============================================================

	async openAttachPicker(): Promise<void> {
		const { paths, unresolvedCount } = await pickFilesViaDialog();
		// 「Vault に保存」が ON のときは、Vault 外ファイルを Vault 内へ
		// コピーする。保存先はピッカーを閉じた時点のアクティブファイル基準。
		const toVault = this.plugin.runtimeSaveAttachmentsToVault;
		const imported = toVault
			? await importAttachments(this.app, this.plugin.settings, paths, true)
			: { paths, copied: 0, failed: 0 };
		let added = 0;
		for (const p of imported.paths) {
			if (!this.attachments.includes(p)) {
				this.attachments.push(p);
				added++;
			}
		}
		if (added > 0) this.renderAttachments();
		const { copied, failed } = imported;
		if (copied > 0) new Notice(t("composer.savedToVault", copied));
		if (failed > 0) new Notice(t("composer.copyFailed", failed));
		if (unresolvedCount > 0) {
			new Notice(t("composer.unresolvedPaths", unresolvedCount));
		} else if (paths.length > 0 && added === 0 && failed === 0) {
			new Notice(t("composer.alreadyAttached"));
		}
	}

	handlePaste(e: ClipboardEvent): void {
		const images = extractPastedImages(e);
		if (images.length === 0) return;
		// バイナリ文字列が textarea に貼り付けられないよう抑止する。
		e.preventDefault();
		// 添付チップだけ即時表示し、実ファイルの書き出しは送信時に
		// flushPendingPastes() がまとめて行う（× で取り消した画像は
		// ディスクに残らない）。ファイル名はこの時点で確定させ、表示と
		// 実際の保存名を一致させる。
		for (const img of images) {
			this.pendingPastes.push({
				file: img,
				fileName: pastedImageFileName(img),
			});
		}
		this.renderAttachments();
	}

	/** 未保存のペースト画像を実際にディスクへ書き出し、`attachments` に
	 *  パスを積む。送信直前に view から呼ばれる。 */
	async flushPendingPastes(): Promise<void> {
		if (this.pendingPastes.length === 0) return;
		const toVault = this.plugin.runtimeSaveAttachmentsToVault;
		const pending = this.pendingPastes;
		this.pendingPastes = [];
		let savedToVault = 0;
		for (const { file, fileName } of pending) {
			try {
				const savedPath = await storePastedImage(
					this.app,
					this.plugin.settings,
					this.plugin.getAttachmentFolder(),
					file,
					fileName,
					toVault
				);
				if (!this.attachments.includes(savedPath)) {
					this.attachments.push(savedPath);
				}
				if (toVault) savedToVault++;
			} catch (err) {
				new Notice(t("composer.pasteFailed", (err as Error).message));
			}
		}
		if (savedToVault > 0) {
			new Notice(t("composer.savedToVault", savedToVault));
		}
		this.renderAttachments();
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
		this.notes.renderActiveFile();
	}

	renderSelection(): void {
		this.notes.renderSelection();
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
				const count = listFolderFiles(this.app, path).length;
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
		// 未保存のペースト画像。送信時に flush するまでディスクには書き
		// 出されていないので、確定パスではなく仮ファイル名だけを表示する。
		for (const entry of this.pendingPastes) {
			const chip = host.createDiv({ cls: "claude-panel-chip is-pending" });
			const labelEl = chip.createSpan({ text: `@${entry.fileName}` });
			labelEl.title = t("composer.pendingPaste", entry.fileName);
			const x = chip.createEl("button", { text: "×" });
			x.onclick = () => {
				this.pendingPastes = this.pendingPastes.filter(
					(p) => p !== entry
				);
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
			const target = this.notes.getIncludedTarget();
			if (target) addMention(target.path, target.isFolder);
			for (const fp of this.attachments) {
				addMention(fp, this.isFolderPath(fp));
			}
		}

		// キーワード前置は ultrathink のみ（公式で唯一残る思考キーワード）。
		// on / off は agent.ts が --settings（alwaysThinkingEnabled）で制御する。
		const thinkPrefix =
			!isSlash && this.plugin.settings.thinkingMode === "ultrathink"
				? "ultrathink: "
				: "";

		const sel = isSlash ? null : this.notes.getIncludedSelection();
		const selectionBlock = formatSelectionBlock(sel);
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

		// model は effort と違い「未指定」を表す値がない（`default` も
		// アカウント既定への明示的な指名）ため、スラッシュコマンド以外は
		// 常にバッジ表示する。
		const model: string | undefined = !isSlash
			? this.plugin.settings.model
			: undefined;

		return {
			mentions: mentionLabels,
			selectionRef,
			body,
			fullPrompt,
			thinkingMode,
			effortLevel,
			model,
		};
	}

	// ============================================================
	//   内部ヘルパー
	// ============================================================

	private isFolderPath(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
	}
}
