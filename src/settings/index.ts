/**
 * 設定モジュールのバレル。外部からは引き続き `from "./settings"` で
 * 必要なシンボルを取り出せるようにし、内部で types / labels / tab /
 * vault-audio-suggest に分割した事実を意識させない。
 *
 * ファイル分割の意図:
 *   - types.ts          — 純粋な設定スキーマと既定値（UI 非依存）
 *   - labels.ts         — enum → 表示文字列への変換
 *   - tab.ts            — Obsidian の SettingTab 実装（UI）
 *   - vault-audio-suggest.ts — 通知音用の Vault 内ファイル選択モーダル
 */

export * from "./types";
export * from "./labels";
export { ClaudePanelSettingTab } from "./tab";
export {
	VaultAudioFileSuggestModal,
	listVaultAudioFiles,
} from "./vault-audio-suggest";
