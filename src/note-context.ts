import { TFile, TFolder, type App, type ItemView } from "obsidian";
import type { CapturedSelection, SelectionCapture } from "./selection-capture";
import { t } from "./i18n";

/** Claude に渡す対象のノート / フォルダ（Vault 相対パス）。 */
export interface NoteTarget {
	path: string;
	isFolder: boolean;
}

/**
 * アクティブなノート / フォルダと選択範囲の「含める」状態と表示を持つ。
 * チャット UI とターミナル UI で共有する。
 */
export class NoteContext {
	private includeActive: boolean;
	// 直近にファイルエクスプローラーでクリックされたフォルダ。設定されている間は
	// アクティブファイルを置き換える。ファイルを開くと解除される。
	private activeFolderPath: string | null = null;
	private includeSelection = true;

	private activeFileEl: HTMLElement | null = null;
	private selectionEl: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		private readonly selection: SelectionCapture,
		includeByDefault: boolean
	) {
		this.includeActive = includeByDefault;
	}

	mount(hosts: { activeFileEl: HTMLElement; selectionEl: HTMLElement }): void {
		this.activeFileEl = hosts.activeFileEl;
		this.selectionEl = hosts.selectionEl;
	}

	setActiveFolderPath(path: string | null): void {
		this.activeFolderPath = path;
		this.renderActiveFile();
	}

	getActiveFolderPath(): string | null {
		return this.activeFolderPath;
	}

	toggleIncludeActive(): boolean {
		this.includeActive = !this.includeActive;
		this.renderActiveFile();
		return this.includeActive;
	}

	getIncludeActive(): boolean {
		return this.includeActive;
	}

	/** トグルコマンドの通知メッセージ用に「対象パス」を返す。 */
	getActiveTargetLabel(): string | null {
		if (this.activeFolderPath) return `${this.activeFolderPath}/`;
		return this.app.workspace.getActiveFile()?.path ?? null;
	}

	/** 「含める」がオンのときの対象。オフまたは対象なしなら null。 */
	getIncludedTarget(): NoteTarget | null {
		if (!this.includeActive) return null;
		// フォルダが設定されている間はフォルダだけを見る（ファイルとは相互排他）。
		if (this.activeFolderPath) {
			const folder = this.app.vault.getAbstractFileByPath(
				this.activeFolderPath
			);
			return folder instanceof TFolder
				? { path: folder.path, isFolder: true }
				: null;
		}
		const file = this.app.workspace.getActiveFile();
		return file ? { path: file.path, isFolder: false } : null;
	}

	/** 「含める」がオンのときの選択範囲。オフまたは選択なしなら null。 */
	getIncludedSelection(): CapturedSelection | null {
		return this.includeSelection ? this.selection.get() : null;
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
			if (folder instanceof TFolder) {
				const fileCount = listFolderFiles(this.app, folder.path).length;
				this.renderTarget(host, {
					text: `${folder.path}/ ×${fileCount}`,
					labelTooltip: t("composer.activeFolderTooltip"),
					pathTooltip: t(
						"composer.folderFileCount",
						folder.path,
						fileCount
					),
				});
				return;
			}
			// 削除済み等で実体が無い場合は黙ってクリアしてフォールバック
			this.activeFolderPath = null;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			host.createSpan({
				cls: "claude-panel-active-file-empty",
				text: t("composer.noActiveFile"),
			});
			return;
		}
		this.renderTarget(host, {
			text: file.path,
			labelTooltip: t("composer.activeFileTooltip"),
			pathTooltip: file.path,
		});
	}

	private renderTarget(
		host: HTMLElement,
		target: { text: string; labelTooltip: string; pathTooltip: string }
	): void {
		const label = host.createSpan({
			cls: "claude-panel-active-file-label",
			text: t("composer.activeLabel"),
		});
		label.title = target.labelTooltip;
		const pathEl = host.createSpan({
			cls: "claude-panel-active-file-path",
			text: target.text,
		});
		pathEl.title = target.pathTooltip;
		const toggle = host.createEl("button", {
			cls: "claude-panel-active-file-toggle",
			text: this.includeActive
				? t("composer.toggleIncluded")
				: t("composer.toggleExcluded"),
		});
		toggle.onclick = () => {
			this.toggleIncludeActive();
		};
	}

	renderSelection(): void {
		const host = this.selectionEl;
		if (!host) return;
		host.empty();
		const sel = this.selection.get();
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
}

export function listFolderFiles(app: App, folderPath: string): string[] {
	const folder = app.vault.getAbstractFileByPath(folderPath);
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

export function formatSelectionBlock(sel: CapturedSelection | null): string {
	if (!sel) return "";
	// プロンプトの構造は言語非依存(英語ラベル)で送る。Claude が読むため、
	// ユーザの Obsidian 言語設定とは独立。
	const src = sel.filePath
		? ` (source: \`${sel.filePath}\` L${sel.startLine})`
		: "";
	return `Selection${src}:\n\`\`\`\n${sel.text}\n\`\`\`\n\n`;
}

// additionalContext は 10,000 文字を超えると先頭しか渡らないので、全体が 8,000 文字
// ほどに収まるように選択範囲の本文を切る。
const SELECTION_MAX_CHARS = 7500;

/**
 * hook の additionalContext に入れる文字列。渡すものが無ければ null。
 * チャット UI と同じく、ノートは本文を展開せずパスだけを渡す。
 */
export function formatNoteContext(
	target: NoteTarget | null,
	selection: CapturedSelection | null
): string | null {
	const blocks: string[] = [];
	if (target) {
		const path = target.isFolder ? `${target.path}/` : target.path;
		blocks.push(
			`[Active ${target.isFolder ? "folder" : "note"} in Obsidian — read on demand with the Read / Glob tools]\n- ${path}`
		);
	}
	if (selection) {
		const { kept, omitted } = splitAtLimit(selection.text);
		let block = formatSelectionBlock({ ...selection, text: kept }).trimEnd();
		if (omitted > 0) {
			const line = selection.startLine + kept.split("\n").length - 1;
			const rest = selection.filePath
				? `; read \`${selection.filePath}\` from L${line} for the rest`
				: "";
			block += `\n(selection truncated, ${omitted} characters omitted${rest})`;
		}
		blocks.push(block);
	}
	return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function splitAtLimit(text: string): { kept: string; omitted: number } {
	if (text.length <= SELECTION_MAX_CHARS) return { kept: text, omitted: 0 };
	// サロゲートペアの途中で切らない。
	const last = text.charCodeAt(SELECTION_MAX_CHARS - 1);
	const end =
		last >= 0xd800 && last <= 0xdbff
			? SELECTION_MAX_CHARS - 1
			: SELECTION_MAX_CHARS;
	return { kept: text.slice(0, end), omitted: text.length - end };
}

/** アクティブなノート / フォルダと選択範囲を追うイベントを view に登録する。 */
export function trackNoteContext(
	view: ItemView,
	context: NoteContext,
	selection: SelectionCapture
): void {
	const { app } = view;
	view.registerEvent(
		app.workspace.on("active-leaf-change", () => {
			context.renderActiveFile();
			selection.poll();
		})
	);
	view.registerEvent(
		app.workspace.on("file-open", () => {
			// ファイル選択でアクティブフォルダは解除（相互排他）
			context.setActiveFolderPath(null);
			selection.poll();
		})
	);
	// ファイルエクスプローラーでフォルダをクリックしたら
	// activeFolderPath として記録し、アクティブファイル表示と入れ替える。
	// `.nav-folder-title` は Obsidian のファイルツリーが各フォルダに
	// 描画する要素で、`data-path` にフォルダの Vault 相対パスが入る。
	// パネルを作る時点のアクティブなウィンドウは設定画面のこともあるので、メインの
	// ウィンドウを明示する。
	view.registerDomEvent(app.workspace.containerEl.doc, "click", (e) => {
		const titleEl = (e.target as HTMLElement | null)?.closest(
			".nav-folder-title"
		);
		if (!titleEl) return;
		const path = titleEl.getAttribute("data-path");
		if (!path) return; // ルート（path="" / null）は無視
		if (!(app.vault.getAbstractFileByPath(path) instanceof TFolder)) return;
		context.setActiveFolderPath(path);
	});
	// Grace-period handoff（猶予期間の引き継ぎ）: パネル内クリックで
	// キャプチャ済みの markdown 選択を失わないようにする。これがないと
	// パネルがアクティブな leaf になった瞬間に選択が消える。
	view.registerDomEvent(view.containerEl, "pointerdown", () => {
		selection.markHandoff();
	});
	view.registerInterval(window.setInterval(() => selection.poll(), 250));
}
