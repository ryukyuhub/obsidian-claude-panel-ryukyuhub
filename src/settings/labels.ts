import type {
	ClaudePanelSettings,
	NotifyOnComplete,
	PermissionMode,
	ThinkingMode,
} from "./types";
import { MODEL_PRESETS } from "./types";
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

export function thinkingModeLabel(m: ThinkingMode): string {
	switch (m) {
		case "on":
			return t("thinking.on");
		case "off":
			return t("thinking.off");
		case "ultrathink":
			// 公式のプロンプトキーワードそのものなので翻訳しない。
			return "ultrathink";
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
 *   claude-opus-5[1m]            → "opus 5 [1m]"
 *   opus[1m] / gpt-4 / unknown   → そのまま返す
 */
export function formatModelLabel(id: string): string {
	const oneM = id.endsWith("[1m]");
	const stripped = id
		.replace(/^claude-/, "")
		.replace(/\[1m\]$/, "");
	const m = stripped.match(/^([a-z]+)-(\d+)(?:-(\d+))?(?:-(.+))?$/);
	if (!m) return oneM ? `${stripped}[1m]` : stripped;
	const [, family, major, minor, suffix] = m;
	const version = minor ? `${major}.${minor}` : major;
	let label = `${family} ${version}`;
	if (suffix) label += ` (${suffix})`;
	if (oneM) label += " [1m]";
	return label;
}

/** モデルドロップダウンの 1 選択肢。`value` は `--model` に渡す値。 */
export interface ModelChoice {
	value: string;
	label: string;
	/** ホバー時のツールチップ用（CLI が返す 1 行説明）。 */
	description?: string;
}

/**
 * 解決先の正規 ID からモデルファミリとバージョン番号を取り出す。
 *   claude-opus-5[1m]          → { family: "opus",  version: "5" }
 *   claude-haiku-4-5-20251001  → { family: "haiku", version: "4.5" }
 *   claude-sonnet-4-6          → { family: "sonnet", version: "4.6" }
 * 形式が読めない場合は null（ラベルへのバージョン付与を諦める）。
 */
function parseResolvedModel(
	resolved: string
): { family: string; version: string } | null {
	const stripped = resolved
		.replace(/^claude-/, "")
		.replace(/\[1m\]$/, "");
	// 末尾の日付スナップショット（8 桁）は表示から省く。
	const m = stripped.match(/^([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/);
	if (!m) return null;
	const [, family, major, minor] = m;
	return { family, version: minor ? `${major}.${minor}` : major };
}

/**
 * 収穫済みモデルの表示ラベル。CLI の displayName（"Opus" 等）はバージョンを
 * 含まないため、resolvedModel から取り出したバージョンを合成する。
 *   Opus (1M context)     + claude-opus-5[1m] → "Opus 5 (1M context)"
 *   Fable                 + claude-fable-5    → "Fable 5"
 *   Default (recommended) + claude-opus-5[1m] → "Default (recommended) · Opus 5"
 * displayName がファミリ名で始まるときはその直後へ挿入し、そうでないとき
 * （Default 等）は解決先のファミリ名ごと接尾辞にする。resolvedModel が
 * 無い／読めないときは displayName をそのまま返す。
 */
function discoveredModelLabel(m: {
	displayName: string;
	resolvedModel?: string;
}): string {
	const parsed = m.resolvedModel
		? parseResolvedModel(m.resolvedModel)
		: null;
	if (!parsed) return m.displayName;
	const { family, version } = parsed;
	if (m.displayName.toLowerCase().startsWith(family)) {
		return (
			m.displayName.slice(0, family.length) +
			` ${version}` +
			m.displayName.slice(family.length)
		);
	}
	const familyLabel = family.charAt(0).toUpperCase() + family.slice(1);
	return `${m.displayName} · ${familyLabel} ${version}`;
}

/**
 * モデルドロップダウン（設定タブ・パネル・`/model`）の選択肢を返す。
 * ラン中の initialize ハンドシェイクで CLI から収穫した一覧（公式 /model
 * ピッカーと同一・プラン解決済み）があればそれを使い、未収穫（初回起動や
 * 旧 CLI）なら MODEL_PRESETS にフォールバックする。これで CLI 側のモデル
 * 増減にプラグインのリリースを待たず追従できる。
 */
export function modelChoices(settings: ClaudePanelSettings): ModelChoice[] {
	const discovered = settings.discoveredModels;
	if (discovered && discovered.length > 0) {
		return discovered.map((m) => ({
			value: m.value,
			label: discoveredModelLabel(m),
			description: m.description,
		}));
	}
	return MODEL_PRESETS.map((m) => ({ value: m, label: formatModelLabel(m) }));
}

/**
 * 設定値 `model` の表示ラベル。収穫済み一覧にあればバージョン付き
 * displayName（例: `claude-fable-5[1m]` → "Fable 5"）、無ければ
 * formatModelLabel の推測整形にフォールバックする。通知やシステム
 * メッセージ用。
 */
export function modelLabelFor(
	settings: ClaudePanelSettings,
	value: string
): string {
	const hit = settings.discoveredModels?.find((m) => m.value === value);
	return hit ? discoveredModelLabel(hit) : formatModelLabel(value);
}
