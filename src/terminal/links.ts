import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
	type App,
	getLinkpath,
	Keymap,
	normalizePath,
	TFile,
} from "obsidian";
import { fileURLToPath } from "url";
import { getVaultBasePath } from "../notify-sound-source";

/**
 * 既定の正規表現に加えて、日本語の句読点・かっこでも URL を終える
 * （「https://example.com を参照。」のような文で後ろを巻き込まないため）。
 */
export const URL_REGEX =
	/(?:https?|HTTPS?):\/\/[^\s"'!*(){}|\\^<>`、。，．「」『』（）【】]*[^\s"':,.!?{}|\\^~[\]`()<>、。，．「」『』（）【】]/;

const WIKILINK_REGEX = /\[\[([^[\]\n]+)\]\]/g;
/** 拡張子とみなす部分。ここをパスの終端の候補にする。 */
const EXTENSION_REGEX = /\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/g;
/** パスの始まりの直前に来る文字。 */
const BOUNDARY_REGEX = /[\s"'`“”‘’「」『』()（）[\]<>【】{},:=@|、。：│]/;
const MAX_START_CANDIDATES = 10;
/** 折り返しをつなげて調べる最大行数。 */
const MAX_WRAPPED_ROWS = 50;

/** 折り返しをつなげた 1 行。`cells[i]` は `text[i]` が占めるセル。 */
interface LogicalLine {
	text: string;
	cells: { x: number; y: number; width: number }[];
}

interface LinkMatch {
	start: number;
	/** 含まない */
	end: number;
	open(event: MouseEvent): void;
}

/** wikilink と Vault 内のパスをリンクにする link provider。 */
export function createVaultLinkProvider(
	app: App,
	term: Terminal
): ILinkProvider {
	return {
		provideLinks(y, callback) {
			const line = readLogicalLine(term, y - 1);
			const wikilinks = findWikilinks(app, line.text);
			const links: ILink[] = [];
			for (const match of [
				...wikilinks,
				...findPaths(app, line.text, wikilinks),
			]) {
				const first = line.cells[match.start];
				const last = line.cells[match.end - 1];
				if (y - 1 < first.y || y - 1 > last.y) continue;
				links.push({
					text: line.text.slice(match.start, match.end),
					range: {
						start: { x: first.x + 1, y: first.y + 1 },
						end: { x: last.x + last.width, y: last.y + 1 },
					},
					activate: (event) => {
						if (isLinkClick(event, term)) match.open(event);
					},
				});
			}
			callback(links.length > 0 ? links : undefined);
		},
	};
}

/** xterm は右クリックや、リンク上で終わった範囲選択でも activate を呼ぶため除く。 */
export function isLinkClick(event: MouseEvent, term: Terminal): boolean {
	return (event.button === 0 || event.button === 1) && !term.hasSelection();
}

/** `file:` の URI を、Vault 内のファイルなら Obsidian で開く。それ以外は何もしない。 */
export function openFileUri(app: App, uri: string, event: MouseEvent): void {
	const path = fileUriToPath(uri);
	const file = path === null ? null : findVaultFile(app, path);
	if (file) openFile(app, file, event);
}

function fileUriToPath(uri: string): string | null {
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") return null;
		try {
			return fileURLToPath(url);
		} catch {
			// POSIX の fileURLToPath は `file://ホスト名/…` を受け付けない。
			return decodeURIComponent(url.pathname);
		}
	} catch {
		return null;
	}
}

function openFile(app: App, file: TFile, event: MouseEvent): void {
	void app.workspace.getLeaf(Keymap.isModEvent(event)).openFile(file);
}

// ---------- 検出 ----------

function findWikilinks(app: App, text: string): LinkMatch[] {
	const matches: LinkMatch[] = [];
	for (const m of text.matchAll(WIKILINK_REGEX)) {
		const target = m[1].split("|")[0].trim();
		// 実在するノートだけをリンクにする（誤クリックで新規ノートを作らない）。
		const dest = app.metadataCache.getFirstLinkpathDest(
			getLinkpath(target),
			""
		);
		if (!dest) continue;
		matches.push({
			start: m.index ?? 0,
			end: (m.index ?? 0) + m[0].length,
			open: (event) =>
				void app.workspace.openLinkText(
					target,
					"",
					Keymap.isModEvent(event)
				),
		});
	}
	return matches;
}

function findPaths(
	app: App,
	text: string,
	occupied: LinkMatch[]
): LinkMatch[] {
	const matches: LinkMatch[] = [];
	let searchFrom = 0;
	for (const m of text.matchAll(EXTENSION_REGEX)) {
		const end = (m.index ?? 0) + m[0].length;
		// 空白を含むノート名があるので、長い候補から順に実在を確かめる。
		for (const start of pathStartCandidates(text, searchFrom, end)) {
			if (occupied.some((o) => start < o.end && end > o.start)) continue;
			const file = findVaultFile(app, text.slice(start, end));
			if (!file) continue;
			matches.push({
				start,
				end,
				open: (event) => openFile(app, file, event),
			});
			searchFrom = end;
			break;
		}
	}
	return matches;
}

/** `end` で終わるパスの開始位置の候補を、長い順（左から）に返す。 */
function pathStartCandidates(
	text: string,
	from: number,
	end: number
): number[] {
	const starts: number[] = [];
	for (let i = end - 1; i >= from && starts.length < MAX_START_CANDIDATES; i--) {
		const isStart = i === from || BOUNDARY_REGEX.test(text[i - 1]);
		if (isStart && !/\s/.test(text[i])) starts.push(i);
	}
	return starts.reverse();
}

/** 表示されたパス（Vault 相対、または Vault 内の絶対パス）に当たるファイル。 */
function findVaultFile(app: App, path: string): TFile | null {
	const relative = toVaultRelative(app, path.replace(/\\/g, "/"));
	if (relative === null) return null;
	const file = app.vault.getAbstractFileByPath(normalizePath(relative));
	return file instanceof TFile ? file : null;
}

function toVaultRelative(app: App, path: string): string | null {
	if (!/^(?:\/|~|[A-Za-z]:\/)/.test(path)) return path.replace(/^\.\//, "");
	const base = getVaultBasePath(app)?.replace(/\\/g, "/").replace(/\/$/, "");
	if (!base) return null;
	const prefix = `${base}/`;
	// Windows のドライブ文字や大文字小文字の違いは同じ場所とみなす。
	const matches = /^[A-Za-z]:/.test(prefix)
		? path.toLowerCase().startsWith(prefix.toLowerCase())
		: path.startsWith(prefix);
	return matches ? path.slice(prefix.length) : null;
}

// ---------- 画面の読み取り ----------

function readLogicalLine(term: Terminal, row: number): LogicalLine {
	const buffer = term.buffer.active;
	let top = row;
	while (
		row - top < MAX_WRAPPED_ROWS &&
		top > 0 &&
		buffer.getLine(top)?.isWrapped
	) {
		top--;
	}
	let bottom = row;
	while (
		bottom - row < MAX_WRAPPED_ROWS &&
		buffer.getLine(bottom + 1)?.isWrapped
	) {
		bottom++;
	}

	let text = "";
	const cells: LogicalLine["cells"] = [];
	const cell = buffer.getNullCell();
	for (let y = top; y <= bottom; y++) {
		const line = buffer.getLine(y);
		if (!line) break;
		for (let x = 0; x < line.length; x++) {
			line.getCell(x, cell);
			const width = cell.getWidth();
			// 全角の 2 桁目
			if (width === 0) continue;
			// 全角が入りきらず次の行へ送られたときの行末の空き
			if (
				x === line.length - 1 &&
				y < bottom &&
				cell.getChars() === "" &&
				buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2
			) {
				continue;
			}
			const chars = cell.getChars() || " ";
			text += chars;
			for (let i = 0; i < chars.length; i++) cells.push({ x, y, width });
		}
	}
	return { text, cells };
}
