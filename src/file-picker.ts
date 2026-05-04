import { App, FuzzySuggestModal, TAbstractFile, TFolder } from "obsidian";

export class FilePickerModal extends FuzzySuggestModal<TAbstractFile> {
	constructor(app: App, private onPick: (item: TAbstractFile) => void) {
		super(app);
		this.setPlaceholder("添付するファイル / フォルダを選択");
	}

	getItems(): TAbstractFile[] {
		const items: TAbstractFile[] = [];
		const walk = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					items.push(child);
					walk(child);
				} else {
					items.push(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		return items;
	}

	getItemText(item: TAbstractFile): string {
		return item instanceof TFolder ? `${item.path}/` : item.path;
	}

	onChooseItem(item: TAbstractFile): void {
		this.onPick(item);
	}
}
