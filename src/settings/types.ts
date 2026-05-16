/**
 * 設定スキーマと、それに関連する列挙・既定値・範囲定数。
 * UI もラベル関数も含めず、純粋なデータ定義だけに留める。
 * これにより `agent.ts` のような non-UI モジュールが UI を引き込まずに
 * 設定型だけを参照できる。
 */

export type ThinkingMode =
	| "off"
	| "think"
	| "think hard"
	| "think harder"
	| "ultrathink";

export const THINKING_MODES: ThinkingMode[] = [
	"off",
	"think",
	"think hard",
	"think harder",
	"ultrathink",
];

/**
 * Claude Code の `--effort` フラグに渡す値。`auto` は「フラグを渡さない」を
 * 意味し、CLI 側のデフォルト（あるいは `~/.claude/settings.json` の
 * `effortLevel`）に処理を委ねる。`low`/`medium`/`high`/`max` は新しめの
 * モデル（Sonnet 4.6 / Opus 4.6 など）の推論密度を制御する。Haiku など
 * 非対応モデルでは指定しても CLI が黙って無視する。
 */
export type EffortLevel = "auto" | "low" | "medium" | "high" | "max";

export const EFFORT_LEVELS: EffortLevel[] = [
	"auto",
	"low",
	"medium",
	"high",
	"max",
];

export const MODEL_PRESETS: string[] = [
	"claude-sonnet-4-6",
	"claude-opus-4-7",
	"claude-haiku-4-5",
];

/**
 * `claude` CLI が受け付けるパーミッションモード。SDK の PermissionMode から
 * ユーザー向けの4種類を露出している。SDK 内部用の `delegate` / `dontAsk`
 * は本プラグインでは扱わない（不要なため意図的に非公開）。
 *
 * - `default`            — リスクのあるツールごとに毎回確認（パネル内で Approve / Deny）。
 * - `acceptEdits`        — ファイル編集は自動許可、それ以外は引き続き確認。
 * - `bypassPermissions`  — 完全自律実行（旧デフォルト。全ての確認をスキップ）。
 * - `plan`               — 読み取り専用のプラン作成。ツール実行はしない。
 */
export type PermissionMode =
	| "default"
	| "acceptEdits"
	| "bypassPermissions"
	| "plan";

export const PERMISSION_MODES: PermissionMode[] = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
];

/**
 * 応答完了時の通知方式。`flash` はパネル枠を一瞬 accent カラーで光らせる。
 * `sound` は Web Audio で短いビープを鳴らす（音声ファイルは同梱しない）。
 * ユーザーがキャンセルしたランでは通知しない（自分で止めたので不要）。
 */
export type NotifyOnComplete = "none" | "sound" | "flash" | "both";

export const NOTIFY_ON_COMPLETE_OPTIONS: NotifyOnComplete[] = [
	"none",
	"sound",
	"flash",
	"both",
];

/**
 * パネル UI の言語。`auto` は Obsidian 本体の言語設定
 * (`localStorage.getItem("language")`) に追従する。Obsidian 全体は日本語に
 * しつつパネルだけ英語、といった切替も可能にするため明示的な override も
 * 提供する。
 */
export type UiLanguage = "auto" | "ja" | "en";

export const UI_LANGUAGES: UiLanguage[] = ["auto", "ja", "en"];

export interface ClaudePanelSettings {
	claudePath: string;
	model: string;
	thinkingMode: ThinkingMode;
	effortLevel: EffortLevel;
	disableMcpServers: boolean;
	permissionMode: PermissionMode;
	/** チャットパネルの基準フォントサイズ（px）。パネルルート要素の
	 *  `--claude-panel-font-size` CSS 変数を駆動する。 */
	fontSize: number;
	/** 応答完了時の通知方式。既定はフラッシュ（控えめに目立たせる）。 */
	notifyOnComplete: NotifyOnComplete;
	/** 完了通知音の音量（0-100）。既定値の中央を採用。 */
	notifySoundVolume: number;
	/** 完了通知に使う音声ファイルのパス。
	 *
	 *  - **Vault 相対パス**（例: `sounds/done.mp3`）— Vault 配下のファイル。
	 *    Vault 同期で別マシンに移っても追従するため推奨。
	 *  - **絶対 OS パス**（例: `C:\Users\you\sounds\done.mp3`）— Vault 外
	 *    のファイル。同期はされないが、共有したくない大きな音源等に。
	 *  - **空文字** — 内蔵チャイムを使う。
	 *
	 *  対応形式は実行環境（Electron / Chromium）が decodeAudioData できる
	 *  もの（mp3 / wav / ogg / m4a など）。 */
	notifySoundPath: string;
	/** コンポーザー下端に追加で確保する余白（px）。テーマによっては
	 *  Obsidian のステータスバーが右サイドバーの最下部に被ってしまい、
	 *  送信ボタンやモデル選択が隠れることがある。0 では現状の見た目を
	 *  維持し、必要な人だけ値を上げて余白を確保できるようにする。 */
	composerBottomPadding: number;
	/** パネル UI の表示言語。`auto` で Obsidian の言語設定に追従する。 */
	language: UiLanguage;
}

/** 通知音量スライダーの上下限（パーセント）。 */
export const NOTIFY_VOLUME_MIN = 0;
export const NOTIFY_VOLUME_MAX = 100;

/** フォントサイズスライダーの上下限。10px 未満ではチャットパネルが
 *  読めない大きさになり、20px を超えるとサイドパネルの横幅に収まらない。 */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;

/** コンポーザー下端の追加余白の上下限（px）。0 で現状維持、最大 80px
 *  あれば大半のテーマのステータスバー高をカバーできる。 */
export const COMPOSER_BOTTOM_PADDING_MIN = 0;
export const COMPOSER_BOTTOM_PADDING_MAX = 80;

export const DEFAULT_SETTINGS: ClaudePanelSettings = {
	claudePath: "",
	model: "claude-sonnet-4-6",
	thinkingMode: "off",
	effortLevel: "auto",
	disableMcpServers: false,
	// 既定は明示的なプロンプト（"default"）。0.1.8 以前は
	// `bypassPermissions` をハードコードしており、agent が ~/.claude.json
	// を黙って書き換える挙動になっていた。アップグレード時の既存ユーザーは
	// 自動的に "default" に移行される（saveData が欠落キーにこの既定値を
	// マージするため）。
	permissionMode: "default",
	fontSize: 13,
	notifyOnComplete: "flash",
	notifySoundVolume: 70,
	notifySoundPath: "",
	composerBottomPadding: 0,
	language: "auto",
};
