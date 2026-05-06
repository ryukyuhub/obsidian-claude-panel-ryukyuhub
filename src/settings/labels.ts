import type { NotifyOnComplete, PermissionMode } from "./types";

/**
 * 設定値（enum）→ UI 表示文字列への変換関数群。
 * 設定タブだけでなく view やステータスバー等から使えるよう、UI 構築から
 * 切り離した純粋関数として並べる。`switch` で網羅性を保ち、enum を
 * 増やしたとき型エラーで気付けるようにしている。
 */

export function notifyOnCompleteLabel(n: NotifyOnComplete): string {
	switch (n) {
		case "none":
			return "なし";
		case "sound":
			return "音のみ";
		case "flash":
			return "フラッシュのみ";
		case "both":
			return "音とフラッシュ";
	}
}

export function permissionModeLabel(m: PermissionMode): string {
	switch (m) {
		case "default":
			return "編集前に確認";
		case "acceptEdits":
			return "編集を自動承認";
		case "bypassPermissions":
			return "全ての確認をスキップ";
		case "plan":
			return "プランモード";
	}
}

/** 各オプションのホバー時に表示する 1 文の説明。 */
export function permissionModeTooltip(m: PermissionMode): string {
	switch (m) {
		case "default":
			return "ツール（編集・Bash・MCP など）を実行するたびに承認を求めます。";
		case "acceptEdits":
			return "ファイル編集は自動承認。Bash や MCP などは引き続き確認します。";
		case "bypassPermissions":
			return "確認なしで全てのツールを実行します。エージェントを信頼できるときのみ。";
		case "plan":
			return "プラン作成のみ。ツールは実行せず、提案だけを返します。";
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
