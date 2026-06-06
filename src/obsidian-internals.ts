import type { App } from "obsidian";

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
