import { App, FuzzySuggestModal, type DataAdapter } from "obsidian";
import { t } from "../i18n";

/** Vault 内ファイルピッカーで対象とする拡張子。Web Audio の decodeAudioData
 *  が扱える主要なフォーマットを並べる（実際に再生できるかはブラウザ依存だが、
 *  候補として出す段階では緩めで OK）。 */
const NOTIFY_SOUND_EXTENSIONS: ReadonlySet<string> = new Set([
	"mp3",
	"wav",
	"ogg",
	"oga",
	"m4a",
	"flac",
	"aac",
	"opus",
	"webm",
]);

/**
 * Vault 配下のすべての音声ファイルを再帰列挙する。`vault.getFiles()` を
 * 使わずに `adapter.list()` で直接ファイルシステムを叩くのは、`.obsidian/`
 * 内（プラグインが同梱する音源など）も対象にしたいため。Obsidian は
 * `.obsidian/` を vault 内ファイルとしてインデックスしないので、
 * `getFiles()` だけでは漏れる。
 *
 * 戻り値は Vault 相対の POSIX パス（例: `sounds/done.mp3`）。
 * `.trash` は意図的にスキップ（誤選択を防ぐ）。
 */
export async function listVaultAudioFiles(
	adapter: DataAdapter
): Promise<string[]> {
	const out: string[] = [];
	const walk = async (folder: string): Promise<void> => {
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await adapter.list(folder);
		} catch {
			return;
		}
		for (const f of listed.files) {
			const ext = (f.split(".").pop() ?? "").toLowerCase();
			if (NOTIFY_SOUND_EXTENSIONS.has(ext)) out.push(f);
		}
		for (const sub of listed.folders) {
			// Obsidian の論理的なゴミ箱。誤選択防止のためスキャンしない。
			if (sub === ".trash") continue;
			await walk(sub);
		}
	};
	await walk("/");
	out.sort();
	return out;
}

/**
 * Vault 内の音声ファイルから 1 つを選ばせるモーダル。候補リストは
 * `listVaultAudioFiles` で事前に作って渡す（`adapter.list` が非同期な
 * ため、`getItems` から都度叩けない）。
 */
export class VaultAudioFileSuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private readonly paths: readonly string[],
		private readonly onPick: (path: string) => void | Promise<void>
	) {
		super(app);
		this.setPlaceholder(
			paths.length === 0
				? t("audio.emptyPlaceholder")
				: t("audio.searchPlaceholder")
		);
	}

	getItems(): string[] {
		return [...this.paths];
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		void this.onPick(item);
	}
}
