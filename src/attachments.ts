import { type App, normalizePath } from "obsidian";

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
 * ファイルの絶対パスを返す。File オブジェクトから絶対パスを取り出す
 * には旧 Electron では `File.path`、Electron 32+ では
 * `electron.webUtils.getPathForFile(file)` を使う。両方試して
 * 最初に成功したパスを採用する。
 *
 * キャンセル時は `paths` が空・`unresolvedCount` 0 で resolve する。
 */
export function pickFilesViaDialog(): Promise<FilePickerResult> {
	return new Promise((resolve) => {
		const electron = (
			window as unknown as {
				require?: (id: string) => {
					webUtils?: { getPathForFile?: (f: File) => string };
				};
			}
		).require?.("electron");
		const getPathForFile = electron?.webUtils?.getPathForFile;
		const resolvePath = (f: File): string | null => {
			const fromProp = (f as File & { path?: string }).path;
			if (fromProp) return fromProp;
			if (getPathForFile) {
				try {
					const p = getPathForFile(f);
					if (p) return p;
				} catch {
					/* fall through */
				}
			}
			return null;
		};

		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.style.display = "none";
		const cleanup = (): void => {
			input.remove();
		};
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			const paths: string[] = [];
			let unresolvedCount = 0;
			for (const f of files) {
				const p = resolvePath(f);
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
		document.body.appendChild(input);
		input.click();
	});
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

/**
 * ペーストされた画像をプラグイン専用の添付フォルダに保存し、Vault
 * 相対パスを返す。フォルダがなければ作成する。
 */
export async function savePastedImage(
	app: App,
	folder: string,
	file: File
): Promise<string> {
	const subtype = (file.type.split("/")[1] || "png").toLowerCase();
	const ext = subtype === "jpeg" ? "jpg" : subtype;
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) {
		await adapter.mkdir(folder);
	}
	const ts = new Date()
		.toISOString()
		.replace("T", "_")
		.replace(/[:.]/g, "-")
		.slice(0, 19);
	const filePath = normalizePath(`${folder}/clipboard-${ts}.${ext}`);
	const buf = await file.arrayBuffer();
	await adapter.writeBinary(filePath, buf);
	return filePath;
}
