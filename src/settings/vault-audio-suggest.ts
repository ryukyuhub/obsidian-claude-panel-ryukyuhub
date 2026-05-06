import { App, FuzzySuggestModal, TFile } from "obsidian";

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
 * Vault 内の音声ファイルから 1 つを選ばせるモーダル。`getFiles()` の
 * 全件を拡張子フィルタしてから FuzzySuggest にかける（Vault が大きくても
 * 数千件オーダーなので素直なフィルタで十分速い）。
 */
export class VaultAudioFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onPick: (file: TFile) => void | Promise<void>
	) {
		super(app);
		this.setPlaceholder("Vault 内の音声ファイルを検索…");
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) =>
				NOTIFY_SOUND_EXTENSIONS.has(f.extension.toLowerCase())
			);
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		void this.onPick(item);
	}
}
