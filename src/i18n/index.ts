import { ja } from "./ja";
import { en } from "./en";
import type { Messages } from "./types";

const dict: Record<string, Messages> = { ja, en };

export type UiLanguage = "auto" | "ja" | "en";

let override: UiLanguage = "auto";

function detectAutoLanguage(): "ja" | "en" {
	const lang = window.localStorage.getItem("language");
	if (lang && lang.toLowerCase().startsWith("ja")) return "ja";
	return "en";
}

function resolveLanguage(): "ja" | "en" {
	if (override === "ja" || override === "en") return override;
	return detectAutoLanguage();
}

let active: Messages = dict[resolveLanguage()];

/** 設定タブ変更時などに呼び、`auto` のときは Obsidian 本体の言語を再検出する。 */
export function refreshLocale(): void {
	active = dict[resolveLanguage()];
}

/** プラグイン設定の言語 override を反映する。 */
export function setLanguageOverride(lang: UiLanguage): void {
	override = lang;
	refreshLocale();
}

/**
 * ドット区切りのパスから messages dict を引く。値が関数なら args で評価。
 * 未登録のキーはキー文字列をそのまま返す(開発中の取りこぼし検出用)。
 */
export function t(key: string, ...args: unknown[]): string {
	const segments = key.split(".");
	let cursor: unknown = active;
	for (const seg of segments) {
		if (cursor && typeof cursor === "object" && seg in cursor) {
			cursor = (cursor as Record<string, unknown>)[seg];
		} else {
			return key;
		}
	}
	if (typeof cursor === "function") {
		return (cursor as (...a: unknown[]) => string)(...args);
	}
	if (typeof cursor === "string") return cursor;
	return key;
}
