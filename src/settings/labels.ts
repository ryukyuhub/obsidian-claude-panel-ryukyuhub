import type { NotifyOnComplete, PermissionMode } from "./types";
import { t } from "../i18n";

/**
 * 設定値（enum）→ UI 表示文字列への変換関数群。
 * 設定タブだけでなく view やステータスバー等から使えるよう、UI 構築から
 * 切り離した純粋関数として並べる。`switch` で網羅性を保ち、enum を
 * 増やしたとき型エラーで気付けるようにしている。
 */

export function notifyOnCompleteLabel(n: NotifyOnComplete): string {
	switch (n) {
		case "none":
			return t("notify.none");
		case "sound":
			return t("notify.sound");
		case "flash":
			return t("notify.flash");
		case "both":
			return t("notify.both");
	}
}

export function permissionModeLabel(m: PermissionMode): string {
	switch (m) {
		case "default":
			return t("permission.default");
		case "acceptEdits":
			return t("permission.acceptEdits");
		case "bypassPermissions":
			return t("permission.bypassPermissions");
		case "plan":
			return t("permission.plan");
	}
}

/** 各オプションのホバー時に表示する 1 文の説明。 */
export function permissionModeTooltip(m: PermissionMode): string {
	switch (m) {
		case "default":
			return t("permission.tooltip.default");
		case "acceptEdits":
			return t("permission.tooltip.acceptEdits");
		case "bypassPermissions":
			return t("permission.tooltip.bypassPermissions");
		case "plan":
			return t("permission.tooltip.plan");
	}
}

/**
 * モデル ID 用の UI ラベルを生成する。"claude-" プレフィックスを除去し
 * （Claude モデルしか使わない）、`4-5` のようなハイフン区切りバージョンを
 * `4.5` に変換する。CLI 側に渡す正規 ID（`--model claude-sonnet-4-5`）は
 * そのまま保持される。
 *   claude-sonnet-4-5            → "sonnet 4.5"
 *   claude-haiku-4-5-20251001    → "haiku 4.5 (20251001)"
 *   gpt-4 / unknown              → そのまま返す
 */
export function formatModelLabel(id: string): string {
	const stripped = id.startsWith("claude-")
		? id.slice("claude-".length)
		: id;
	const m = stripped.match(/^([a-z]+)-(\d+)-(\d+)(?:-(.+))?$/);
	if (!m) return stripped;
	const [, family, major, minor, suffix] = m;
	const version = `${major}.${minor}`;
	return suffix ? `${family} ${version} (${suffix})` : `${family} ${version}`;
}
