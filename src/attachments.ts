import { type App, normalizePath } from "obsidian";
import * as nodePath from "path";
import * as fs from "fs";
import type { ClaudePanelSettings } from "./settings/types";
import { toVaultRelativeIfInside } from "./notify-sound-source";

/**
 * 添付ファイル関連のヘルパー群。view の状態には触らず、入出力だけを
 * 担当する純粋関数として切り出している。view は呼んで結果を受け取り、
 * 自身の attachments 配列の更新や再描画を行う。
 */

export interface FilePickerResult {
	paths: string[];
	unresolvedCount: number;
}

/**
 * Electron のネイティブ OS ファイル選択ダイアログを開き、選ばれた
 * ファイルの絶対パスを返す。
 *
 * キャンセル時は `paths` が空・`unresolvedCount` 0 で resolve する。
 */
export function pickFilesViaDialog(): Promise<FilePickerResult> {
	return new Promise((resolve) => {
		const input = activeDocument.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.hide();
		const cleanup = (): void => {
			input.remove();
		};
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			const paths: string[] = [];
			let unresolvedCount = 0;
			for (const f of files) {
				const p = getFilePath(f);
				if (!p) unresolvedCount++;
				else paths.push(p);
			}
			cleanup();
			resolve({ paths, unresolvedCount });
		});
		// Chromium 113+ で発火する `cancel` イベント。キャンセル時のみ
		// change が来ないので、ここで input を片付ける。
		input.addEventListener("cancel", () => {
			cleanup();
			resolve({ paths: [], unresolvedCount: 0 });
		});
		activeDocument.body.appendChild(input);
		input.click();
	});
}

/**
 * File の絶対パスを返す。取得できなければ null。旧 Electron では `File.path`、
 * Electron 32+ では `electron.webUtils.getPathForFile(file)` を使う。
 */
export function getFilePath(file: File): string | null {
	const fromProp = (file as File & { path?: string }).path;
	if (fromProp) return fromProp;
	const electron = (
		window as unknown as {
			require?: (id: string) => {
				webUtils?: { getPathForFile?: (f: File) => string };
			};
		}
	).require?.("electron");
	try {
		return electron?.webUtils?.getPathForFile?.(file) || null;
	} catch {
		return null;
	}
}

/**
 * OS 絶対パスのファイル群を参照用のパスに変える。Vault 内のファイルは Vault 相対、
 * 外のファイルは絶対パスのまま返す。`saveToVault` なら外のファイルを Vault へ
 * コピーし、コピー先の Vault 相対パスを返す。
 */
export async function importAttachments(
	app: App,
	settings: ClaudePanelSettings,
	absolutePaths: string[],
	saveToVault: boolean
): Promise<{ paths: string[]; copied: number; failed: number }> {
	const dir = saveToVault ? resolveAttachmentDir(app, settings) : "";
	const paths: string[] = [];
	let copied = 0;
	let failed = 0;
	for (const p of absolutePaths) {
		const rel = toVaultRelativeIfInside(p, app);
		if (!saveToVault || rel !== p) {
			paths.push(rel);
			continue;
		}
		try {
			paths.push(await copyFileToVault(app, dir, p));
			copied++;
		} catch (err) {
			console.warn("[claude-panel] copy attachment failed", p, err);
			failed++;
		}
	}
	return { paths, copied, failed };
}

/**
 * 貼り付け画像を保存し、Vault 相対パスを返す。`saveToVault` なら設定の保存先へ、
 * そうでなければ一時フォルダ（unload 時に掃除される）へ置く。
 */
export function storePastedImage(
	app: App,
	settings: ClaudePanelSettings,
	tempFolder: string,
	file: File,
	fileName: string,
	saveToVault: boolean
): Promise<string> {
	return saveToVault
		? savePastedImageToVault(
				app,
				resolveAttachmentDir(app, settings),
				file,
				fileName
			)
		: savePastedImage(app, tempFolder, file, fileName);
}

/** クリップボードイベントから画像ファイル群を抽出する。 */
export function extractPastedImages(e: ClipboardEvent): File[] {
	const items = e.clipboardData?.items;
	if (!items) return [];
	const images: File[] = [];
	for (const item of Array.from(items)) {
		if (item.kind === "file" && item.type.startsWith("image/")) {
			const f = item.getAsFile();
			if (f) images.push(f);
		}
	}
	return images;
}

/** ペースト画像のファイル名（拡張子つき）を MIME タイプとタイムスタンプから作る。
 *  ペースト時点で確定させ、後で保存先（Vault / 一時フォルダ）に渡せるよう
 *  export している。チップの表示と実保存パスのベース名が一致する。 */
export function pastedImageFileName(file: File): string {
	const subtype = (file.type.split("/")[1] || "png").toLowerCase();
	const ext = subtype === "jpeg" ? "jpg" : subtype;
	const ts = new Date()
		.toISOString()
		.replace("T", "_")
		.replace(/[:.]/g, "-")
		.slice(0, 19);
	return `clipboard-${ts}.${ext}`;
}

/**
 * ペーストされた画像をプラグイン専用の一時添付フォルダに保存し、Vault
 * 相対パスを返す。フォルダがなければ作成する。保存先は `.obsidian/` 配下
 * （Obsidian のファイルツリーには現れない）で、プラグイン unload 時に
 * 掃除される。「Vault に保存」が ON のときは代わりに
 * `savePastedImageToVault` を使う。
 */
async function savePastedImage(
	app: App,
	folder: string,
	file: File,
	fileName: string
): Promise<string> {
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) {
		await adapter.mkdir(folder);
	}
	const filePath = normalizePath(`${folder}/${fileName}`);
	const buf = await file.arrayBuffer();
	await adapter.writeBinary(filePath, buf);
	return filePath;
}

/**
 * 「Vault に保存」が ON のときの保存先フォルダ（Vault 相対パス）を設定から
 * 解決する。アクティブファイル基準のモードでアクティブファイルが無い場合は
 * Vault ルート（空文字）にフォールバックする。
 */
function resolveAttachmentDir(
	app: App,
	settings: ClaudePanelSettings
): string {
	const loc = settings.attachmentSaveLocation;
	if (loc === "vaultPath") {
		return normalizeDir(settings.attachmentVaultPath);
	}
	const active = app.workspace.getActiveFile();
	const parent =
		active?.parent && active.parent.path !== "/" ? active.parent.path : "";
	if (loc === "activeFileFolder") {
		return normalizeDir(parent);
	}
	// activeFileSubfolder
	const sub = settings.attachmentSubfolderName.trim() || "attachments";
	return normalizeDir(parent ? `${parent}/${sub}` : sub);
}

/** Vault 相対ディレクトリ文字列を正規化する。空・ルートは空文字に畳む。 */
function normalizeDir(dir: string): string {
	const trimmed = dir.trim();
	if (!trimmed || trimmed === "/") return "";
	const norm = normalizePath(trimmed);
	return norm === "/" ? "" : norm;
}

/**
 * Vault 相対フォルダを（必要なら再帰的に）作成する。Vault API を使うので、
 * 作成したフォルダは Obsidian のファイルツリーに即座に現れる。
 */
async function ensureVaultFolder(app: App, dir: string): Promise<void> {
	if (!dir) return; // Vault ルートは常に存在する
	if (app.vault.getAbstractFileByPath(dir)) return;
	const parts = dir.split("/");
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				/* 併発作成・既存フォルダ — 後続の存在チェックで吸収する */
			}
		}
	}
}

/** dir 配下で衝突しない Vault 相対パスを返す（衝突時は ` 1`, ` 2` … を付与）。 */
function uniqueVaultPath(
	app: App,
	dir: string,
	base: string,
	ext: string
): string {
	const join = (name: string): string =>
		normalizePath(dir ? `${dir}/${name}` : name);
	const suffix = ext ? `.${ext}` : "";
	let candidate = join(`${base}${suffix}`);
	let i = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = join(`${base} ${i}${suffix}`);
		i++;
	}
	return candidate;
}

/**
 * 与えたバイト列を dir 配下に Vault API（`createBinary`）で書き込み、Vault
 * 相対パスを返す。同名ファイルがあれば連番を付けて回避する。
 */
async function writeBinaryToVault(
	app: App,
	dir: string,
	fileName: string,
	data: ArrayBuffer
): Promise<string> {
	await ensureVaultFolder(app, dir);
	const dot = fileName.lastIndexOf(".");
	const base = dot > 0 ? fileName.slice(0, dot) : fileName;
	const ext = dot > 0 ? fileName.slice(dot + 1) : "";
	const dest = uniqueVaultPath(app, dir, base, ext);
	await app.vault.createBinary(dest, data);
	return dest;
}

/**
 * ペーストされた画像を Vault 内の dir に保存し、Vault 相対パスを返す。
 * `savePastedImage`（一時フォルダ）と違い Vault API で書き込むため、
 * 保存したファイルは Obsidian のファイルツリーに現れ、unload 時にも
 * 削除されない。
 */
async function savePastedImageToVault(
	app: App,
	dir: string,
	file: File,
	fileName: string
): Promise<string> {
	const data = await file.arrayBuffer();
	return writeBinaryToVault(app, dir, fileName, data);
}

/**
 * OS 絶対パスのファイルを Vault 内の dir にコピーし、Vault 相対パスを返す。
 * Vault 外のファイルは DataAdapter では読めないため、Node の fs で読み込む。
 */
async function copyFileToVault(
	app: App,
	dir: string,
	absolutePath: string
): Promise<string> {
	const buf = await fs.promises.readFile(absolutePath);
	// Node の Buffer は Uint8Array のサブクラス。pool 由来で offset が
	// 0 とは限らないので、該当範囲だけを ArrayBuffer として切り出す。
	const data = buf.buffer.slice(
		buf.byteOffset,
		buf.byteOffset + buf.byteLength
	);
	return writeBinaryToVault(app, dir, nodePath.basename(absolutePath), data);
}
