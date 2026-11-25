import { TAbstractFile, type App } from "obsidian";

/**
 * Obsidian の設定モーダル API（`app.setting`）は obsidian.d.ts に型が無い非公開 API。
 * `any` でアクセスすると no-unsafe-* 警告が出るため、利用する分だけ最小限の型を宣言する。
 */
interface SettingTab {
	setQuery?(query: string): void;
}

interface SettingModal {
	open(): void;
	openTabById(id: string): void;
	activeTab?: SettingTab | null;
}

/** 非公開の `app.setting` へ安全な型でアクセスするためのヘルパー。存在しなければ undefined。 */
export function getSettingModal(app: App): SettingModal | undefined {
	return (app as App & { setting?: SettingModal }).setting;
}

/**
 * ドラッグ中の項目を持つ `app.dragManager` も非公開 API。`file` はファイル / フォルダ /
 * リンク（リンク切れなら null）、`files` は複数選択のときに入る。
 */
interface DragManager {
	draggable?: { file?: unknown; files?: unknown } | null;
}

/** Obsidian 内（ファイルツリーなど）からドラッグ中のファイル / フォルダ。無ければ空。 */
export function getDragged(app: App): TAbstractFile[] {
	const draggable = (app as App & { dragManager?: DragManager }).dragManager
		?.draggable;
	if (!draggable) return [];
	const items: unknown[] = Array.isArray(draggable.files)
		? draggable.files
		: [draggable.file];
	return items.filter(
		(item): item is TAbstractFile => item instanceof TAbstractFile
	);
}
