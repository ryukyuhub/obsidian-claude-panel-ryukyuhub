import { type App, normalizePath } from "obsidian";
import * as nodePath from "path";

/**
 * 通知音ファイルの「どこから読むか」を一手に引き受けるモジュール。
 *
 * 設定値 `notifySoundPath` には 2 種類の形式が混在する:
 *   - **絶対 OS パス**（例: `C:\\Users\\you\\done.mp3`）— Vault 外。
 *     Node の fs で直接読む。Vault 同期では追従しない。
 *   - **Vault 相対パス**（例: `sounds/done.mp3`）— Vault 配下。
 *     Obsidian の DataAdapter 経由で読む。Vault 同期で追従する。
 *
 * `CompletionNotifier` がこの分岐を意識せずに済むよう、ここに集約している。
 * 設定タブ側の「OS ピッカーで選んだファイルを Vault 配下なら相対化する」
 * ヘルパーも同居させ、保存形式と読み込み戦略を 1 ファイルで対応させる。
 */

/**
 * 絶対パスが Vault 配下なら Vault 相対パス（POSIX 区切り）へ変換する。
 * 配下でなければ引数をそのまま返す（外部ファイルは絶対パスとして保存し続ける）。
 *
 * Vault 同期や別マシンへの移行時に追従させるため、`data.json` には
 * 可能な限り相対パスを書きたい。判定は Node の `path.relative` に委ね、
 * 結果が `..` で始まる／別ドライブを跨ぐ場合は「外」と判定する。
 */
export function toVaultRelativeIfInside(
	absolutePath: string,
	app: App
): string {
	const base = getVaultBasePath(app);
	if (!base) return absolutePath;
	const rel = nodePath.relative(base, absolutePath);
	if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) {
		return absolutePath;
	}
	return normalizePath(rel);
}

/**
 * 設定値のパスを ArrayBuffer として読み込む。空文字や読み込み失敗時は null。
 * 絶対 / Vault 相対 の判定は Node の `path.isAbsolute` に委譲する
 * （Windows のドライブ／UNC／POSIX をすべて適切に扱える）。
 */
export async function loadSoundBuffer(
	app: App,
	rawPath: string
): Promise<ArrayBuffer | null> {
	const path = rawPath.trim();
	if (!path) return null;
	if (nodePath.isAbsolute(path)) {
		return readAbsoluteFile(path);
	}
	try {
		return await app.vault.adapter.readBinary(path);
	} catch (e) {
		console.warn("[claude-panel] read vault sound failed", path, e);
		return null;
	}
}

function getVaultBasePath(app: App): string | null {
	const adapter = app.vault.adapter as unknown as {
		getBasePath?: () => string;
		basePath?: string;
	};
	return adapter.getBasePath?.() ?? adapter.basePath ?? null;
}

/**
 * 絶対パスの音声ファイルを Node の fs で読み、ArrayBuffer に変換する。
 * Electron 環境前提（Obsidian デスクトップ版）。HTTP fetch は file:// で
 * 動かない環境があり、Vault.adapter は Vault 外の絶対パスを扱えないため、
 * Node の require("fs") を直接使うのが最も確実。
 */
async function readAbsoluteFile(path: string): Promise<ArrayBuffer | null> {
	try {
		const req = (
			window as unknown as {
				require?: (id: string) => unknown;
			}
		).require;
		if (!req) return null;
		const fs = req("fs") as {
			promises: { readFile: (p: string) => Promise<Buffer> };
		};
		const buf = await fs.promises.readFile(path);
		// Node の Buffer は Uint8Array のサブクラス。ArrayBuffer 部分を
		// 切り出して渡す（offset/length が 0 とは限らないので注意）。
		return buf.buffer.slice(
			buf.byteOffset,
			buf.byteOffset + buf.byteLength
		) as ArrayBuffer;
	} catch (e) {
		console.warn("[claude-panel] read sound file failed", path, e);
		return null;
	}
}
