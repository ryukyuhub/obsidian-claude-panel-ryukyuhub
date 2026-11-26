import { TFile, TFolder, type App, type ItemView } from "obsidian";
import type { CapturedSelection, SelectionCapture } from "./selection-capture";
import { t } from "./i18n";

/** Claude に渡す対象のノート / フォルダ（Vault 相対パス）。 */
export interface NoteTarget {
	path: string;
	isFolder: boolean;
}

/**
 * 「含める」の切り替えの見せ方。`button` は押すと切り替わるボタン（チャット UI）、
 * `checkbox` は今の状態が分かるチェックボックス（ターミナル UI）。
 */
export type IncludeToggleStyle = "button" | "checkbox";

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
	private activeFileRender: Rendered | null = null;
	private selectionRender: Rendered | null = null;

	constructor(
		private readonly app: App,
		private readonly selection: SelectionCapture,
		includeByDefault: boolean,
		private readonly toggleStyle: IncludeToggleStyle = "button"
	) {
		this.includeActive = includeByDefault;
	}

	mount(hosts: { activeFileEl: HTMLElement; selectionEl: HTMLElement }): void {
		this.activeFileEl = hosts.activeFileEl;
		this.selectionEl = hosts.selectionEl;
		// 描き直しで新しい要素が渡ったら、前の要素に描いた内容は使わない。
		this.activeFileRender = null;
		this.selectionRender = null;
	}

	setActiveFolderPath(path: string | null): void {
		this.activeFolderPath = path;
		this.renderActiveFile();
	}

	getActiveFolderPath(): string | null {
		return this.activeFolderPath;
	}

	toggleIncludeActive(): boolean {
		return this.setIncludeActive(!this.includeActive);
	}

	setIncludeActive(include: boolean): boolean {
		this.includeActive = include;
		this.renderActiveFile();
		return this.includeActive;
	}

	private setIncludeSelection(include: boolean): void {
		this.includeSelection = include;
		this.renderSelection();
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
		return this.includeActive ? this.getCurrentTarget() : null;
	}

	/** 「含める」の状態によらない、今の対象。実在しないフォルダは対象なしとみなす。 */
	private getCurrentTarget(): NoteTarget | null {
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

	/** 対象のノート / フォルダか選択範囲があるのに、「含める」がオフになっているか。 */
	hasExcludedContent(): boolean {
		return (
			(!this.includeActive && this.getCurrentTarget() !== null) ||
			(!this.includeSelection && this.selection.get() !== null)
		);
	}

	renderActiveFile(): void {
		const host = this.activeFileEl;
		if (!host) return;
		const target = this.describeActiveTarget();
		// エディタからパネルをクリックすると、押している間に active-leaf-change で
		// ここが呼ばれる。作り直すと押した要素が外れて click が届かないので、ターミナル
		// UI では内容が同じなら「含める」の状態だけを更新する（チャット UI は従来どおり
		// 毎回作り直す）。
		const key = JSON.stringify([
			this.toggleStyle,
			t("composer.activeLabel"),
			t("composer.includeCheckbox"),
			target,
		]);
		this.activeFileRender = renderOrUpdate(
			host,
			this.reusable(this.activeFileRender),
			key,
			this.includeActive,
			() => this.renderActiveFileInto(host, target)
		);
	}

	/** 作り直さずに更新してよい前回の描画。チャット UI では使わない。 */
	private reusable(prev: Rendered | null): Rendered | null {
		return this.toggleStyle === "checkbox" ? prev : null;
	}

	/** 表示する対象。削除済み等で実体が無いフォルダは、ここで解除する。 */
	private describeActiveTarget(): TargetView | null {
		// アクティブフォルダが設定されているとアクティブファイルより優先
		// （相互排他）。表示と挙動はファイルと対称。
		if (this.activeFolderPath) {
			const folder = this.app.vault.getAbstractFileByPath(
				this.activeFolderPath
			);
			if (folder instanceof TFolder) {
				const fileCount = listFolderFiles(this.app, folder.path).length;
				return {
					text: `${folder.path}/ ×${fileCount}`,
					labelTooltip: t("composer.activeFolderTooltip"),
					pathTooltip: t(
						"composer.folderFileCount",
						folder.path,
						fileCount
					),
					checkboxLabel: t("composer.includeFolderAria"),
				};
			}
			// 削除済み等で実体が無い場合は黙ってクリアしてフォールバック
			this.activeFolderPath = null;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		return {
			text: file.path,
			labelTooltip: t("composer.activeFileTooltip"),
			pathTooltip: file.path,
			checkboxLabel: t("composer.includeNoteAria"),
		};
	}

	private renderActiveFileInto(
		host: HTMLElement,
		target: TargetView | null
	): ToggleUpdater | null {
		if (!target) {
			host.createSpan({
				cls: "claude-panel-active-file-empty",
				text: t("composer.noActiveFile"),
			});
			return null;
		}
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
		if (this.toggleStyle === "checkbox") {
			return renderIncludeCheckbox(host, {
				checked: this.includeActive,
				ariaLabel: target.checkboxLabel,
				onChange: (checked) => this.setIncludeActive(checked),
			});
		}
		return renderIncludeButton(host, {
			cls: "claude-panel-active-file-toggle",
			included: this.includeActive,
			onClick: () => this.toggleIncludeActive(),
		});
	}

	renderSelection(): void {
		const host = this.selectionEl;
		if (!host) return;
		const sel = this.selection.get();
		host.toggleClass("is-empty", !sel);
		const view = sel ? this.describeSelection(sel) : null;
		const key = JSON.stringify([
			this.toggleStyle,
			t("composer.selectionLabel"),
			t("composer.includeCheckbox"),
			t("composer.includeSelectionAria"),
			view,
		]);
		this.selectionRender = renderOrUpdate(
			host,
			this.reusable(this.selectionRender),
			key,
			this.includeSelection,
			() => (view ? this.renderSelectionInto(host, view) : null)
		);
	}

	private describeSelection(sel: CapturedSelection): SelectionView {
		const charCount = sel.text.length;
		// ターミナル UI では、終わりが行頭の選択（Shift+↓ など）を正しい行数で数え、
		// 行が分からない選択（閲覧モード）には行番号を出さない。チャット UI は従来の
		// まま。
		const terminal = this.toggleStyle === "checkbox";
		const lines =
			terminal && !sel.lineUnknown
				? sel.endLine - sel.startLine + 1
				: sel.lineCount;
		const meta =
			terminal && sel.lineUnknown
				? t("composer.selectionMetaNoLine", lines, charCount)
				: t("composer.selectionMeta", lines, charCount, sel.startLine);
		const firstLine = sel.text.split("\n")[0];
		const truncated =
			firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
		const tail = lines > 1 ? t("composer.selectionMoreLines", lines - 1) : "";
		return { meta, preview: truncated + tail, title: sel.text };
	}

	private renderSelectionInto(
		host: HTMLElement,
		view: SelectionView
	): ToggleUpdater {
		const header = host.createDiv({
			cls: "claude-panel-selection-header",
		});
		header.createSpan({
			cls: "claude-panel-selection-label",
			text: t("composer.selectionLabel"),
		});
		header.createSpan({
			cls: "claude-panel-selection-meta",
			text: view.meta,
		});
		const update =
			this.toggleStyle === "checkbox"
				? renderIncludeCheckbox(header, {
						checked: this.includeSelection,
						ariaLabel: t("composer.includeSelectionAria"),
						onChange: (checked) => this.setIncludeSelection(checked),
					})
				: renderIncludeButton(header, {
						cls: "claude-panel-selection-toggle",
						included: this.includeSelection,
						onClick: () =>
							this.setIncludeSelection(!this.includeSelection),
					});

		const preview = host.createDiv({
			cls: "claude-panel-selection-preview",
		});
		preview.setText(view.preview);
		preview.title = view.title;
		return update;
	}
}

/** ノート欄に出す対象（アクティブなノート / フォルダ）の文字列。 */
interface TargetView {
	text: string;
	labelTooltip: string;
	pathTooltip: string;
	checkboxLabel: string;
}

/** ノート欄に出す選択範囲の文字列。 */
interface SelectionView {
	meta: string;
	preview: string;
	title: string;
}

/** 描いた要素の「含める」の状態を更新する。 */
type ToggleUpdater = (included: boolean) => void;

/** 前回描いた内容。同じ要素で `key` も同じなら作り直さない。 */
interface Rendered {
	host: HTMLElement;
	key: string;
	update: ToggleUpdater | null;
}

/**
 * 前回と同じ内容なら「含める」の状態と文字列だけを更新し、違えば描き直す。描き直す
 * ときは、チェックボックスにあったキーボードのフォーカスを引き継ぐ。
 */
function renderOrUpdate(
	host: HTMLElement,
	prev: Rendered | null,
	key: string,
	included: boolean,
	build: () => ToggleUpdater | null
): Rendered {
	if (prev && prev.host === host && prev.key === key) {
		prev.update?.(included);
		return prev;
	}
	const refocus = hasFocusedCheckbox(host);
	host.empty();
	const update = build();
	if (refocus) focusCheckbox(host);
	return { host, key, update };
}

const CHECKBOX_CLASS = "claude-panel-include-check-input";

/**
 * 今の状態を示すチェックボックスと「添付する」のラベル。本物の checkbox なので、
 * Space キーでの切り替えと、スクリーンリーダーへの状態の通知はブラウザに任せる。
 */
function renderIncludeCheckbox(
	host: HTMLElement,
	options: {
		checked: boolean;
		ariaLabel: string;
		onChange: (checked: boolean) => void;
	}
): ToggleUpdater {
	const label = host.createEl("label", { cls: "claude-panel-include-check" });
	const input = label.createEl("input", {
		cls: CHECKBOX_CLASS,
		type: "checkbox",
		attr: { "aria-label": options.ariaLabel },
	});
	input.checked = options.checked;
	input.onchange = () => options.onChange(input.checked);
	label.createSpan({
		cls: "claude-panel-include-check-text",
		text: t("composer.includeCheckbox"),
	});
	return (checked) => {
		input.checked = checked;
	};
}

/** 押すと切り替わる「✓ 含める / ○ 除外」のボタン（チャット UI）。 */
function renderIncludeButton(
	host: HTMLElement,
	options: { cls: string; included: boolean; onClick: () => void }
): ToggleUpdater {
	const toggle = host.createEl("button", { cls: options.cls });
	const update: ToggleUpdater = (included) => {
		toggle.setText(
			included ? t("composer.toggleIncluded") : t("composer.toggleExcluded")
		);
	};
	update(options.included);
	toggle.onclick = options.onClick;
	return update;
}

/** 描き直すとチェックボックスが作り直されるので、キーボードのフォーカスを引き継ぐ。 */
function hasFocusedCheckbox(host: HTMLElement): boolean {
	// ポップアウトのウィンドウでは instanceof が使えないので、classList で見る
	const active = host.doc.activeElement;
	return !!active && active.classList.contains(CHECKBOX_CLASS) && host.contains(active);
}

function focusCheckbox(host: HTMLElement): void {
	host.querySelector<HTMLElement>(`.${CHECKBOX_CLASS}`)?.focus();
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

/**
 * `hideUnknownLine` は、行が分からない選択範囲（閲覧モード）で行番号を書かない
 * （ターミナル UI）。チャット UI は従来どおり常に `L<開始行>` を書く。
 */
export function formatSelectionBlock(
	sel: CapturedSelection | null,
	options: { hideUnknownLine?: boolean } = {}
): string {
	if (!sel) return "";
	// プロンプトの構造は言語非依存(英語ラベル)で送る。Claude が読むため、
	// ユーザの Obsidian 言語設定とは独立。
	const line =
		options.hideUnknownLine && sel.lineUnknown ? "" : ` L${sel.startLine}`;
	const src = sel.filePath ? ` (source: \`${sel.filePath}\`${line})` : "";
	return `Selection${src}:\n\`\`\`\n${sel.text}\n\`\`\`\n\n`;
}

// additionalContext は 10,000 文字を超えると先頭しか渡らないので、全体が 8,000 文字
// ほどに収まるように選択範囲の本文を切る。
const SELECTION_MAX_CHARS = 7500;

/**
 * hook で渡した選択範囲。`omitted` は長すぎて省いた文字数。`lineUnknown` のときは
 * 行が分からない（startLine / endLine は使わない）。
 */
export interface SentSelection {
	filePath: string | null;
	startLine: number;
	endLine: number;
	lineUnknown: boolean;
	chars: number;
	omitted: number;
}

/** hook の additionalContext に入れる文字列と、そこに入れたもの。 */
export interface NoteContextPayload {
	text: string;
	target: NoteTarget | null;
	selection: SentSelection | null;
}

/**
 * hook の additionalContext に入れる文字列と、そこに入れたもの。渡すものが無ければ
 * null。チャット UI と同じく、ノートは本文を展開せずパスだけを渡す。
 */
export function buildNoteContext(
	target: NoteTarget | null,
	selection: CapturedSelection | null
): NoteContextPayload | null {
	const blocks: string[] = [];
	if (target) {
		const path = target.isFolder ? `${target.path}/` : target.path;
		blocks.push(
			`[Active ${target.isFolder ? "folder" : "note"} in Obsidian — read on demand with the Read / Glob tools]\n- ${path}`
		);
	}
	let sent: SentSelection | null = null;
	if (selection) {
		const { kept, omitted } = splitAtLimit(selection.text);
		let block = formatSelectionBlock(
			{ ...selection, text: kept },
			{ hideUnknownLine: true }
		).trimEnd();
		if (omitted > 0) {
			const line = selection.startLine + kept.split("\n").length - 1;
			const rest = !selection.filePath
				? ""
				: selection.lineUnknown
					? `; read \`${selection.filePath}\` for the rest`
					: `; read \`${selection.filePath}\` from L${line} for the rest`;
			block += `\n(selection truncated, ${omitted} characters omitted${rest})`;
		}
		blocks.push(block);
		sent = {
			filePath: selection.filePath,
			startLine: selection.startLine,
			endLine: selection.endLine,
			lineUnknown: selection.lineUnknown,
			chars: selection.text.length,
			omitted,
		};
	}
	if (blocks.length === 0) return null;
	return { text: blocks.join("\n\n"), target, selection: sent };
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
