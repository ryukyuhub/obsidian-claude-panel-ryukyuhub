/**
 * 設定スキーマと、それに関連する列挙・既定値・範囲定数。
 * UI もラベル関数も含めず、純粋なデータ定義だけに留める。
 * これにより `agent.ts` のような non-UI モジュールが UI を引き込まずに
 * 設定型だけを参照できる。
 */

/**
 * 思考（拡張思考）の制御。公式 Claude Code の思考トグル（Alt+T /
 * `alwaysThinkingEnabled`）+ `ultrathink` キーワードと同じ構成に保つ。
 *
 * - `on`  — 思考を有効化（公式の既定。CLI 仕様: alwaysThinkingEnabled が
 *           「未設定または true なら対応モデルで自動的に有効」）。
 * - `off` — 思考を無効化（alwaysThinkingEnabled: false — false のときだけ
 *           無効になる）。Fable 5 は常時オンのため効かない。
 * - `ultrathink` — 思考オンに加え、プロンプト先頭にキーワードを付けて
 *           そのターンの最深推論を要求する。公式で唯一残る思考キーワード
 *           （`think` / `think hard` / `think harder` / `megathink` は
 *           2026-01 に廃止され、ただの平文になった）。
 *
 * on / off は agent.ts がセッション単位の `--settings` で注入する。
 * v1 スキーマの旧値（キーワード前置方式の off / think 系）は main.ts の
 * ロード時に `on` へ移行される（旧 off は実際には思考を止めていなかった
 * ため、挙動を保存する移行先は on）。
 */
export type ThinkingMode = "on" | "off" | "ultrathink";

export const THINKING_MODES: ThinkingMode[] = ["on", "off", "ultrathink"];

/**
 * data.json に保存する設定スキーマの世代。値の「意味」が変わる変更
 * （例: v2 で thinkingMode の off がキーワード無しから思考無効化に変化）を
 * 一度きりの移行として実行するために使う。単なる選択肢の追加・削除は
 * ロード時の不正値ガードで足りるため、バージョンを上げる必要はない。
 */
export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * Claude Code の `--effort` フラグに渡す値。公式 `/effort` の選択肢
 * （low / medium / high / xhigh / max / auto）と同一に保つ。`auto` は
 * 「フラグを渡さない」を意味し、CLI 側のデフォルト（あるいは
 * `~/.claude/settings.json` の `effortLevel`）に処理を委ねる。
 * `xhigh` は Opus 4.7 以降 / Fable 5 / Sonnet 5 など対応モデルのみ。
 * Haiku など非対応モデルでは指定しても CLI が黙って無視する。
 * REPL 専用のセッション限定モード `ultracode`（xhigh 固定の
 * マルチエージェント動作）は意図的に含めない。
 */
export type EffortLevel = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: EffortLevel[] = [
	"auto",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

// 公式 Claude Code が `--model` / `/model` で受け付けるエイリアス一覧と
// 同一に保つ（CLI v2.1.170 のエイリアス表 + `default` で確認）。
// エイリアスは CLI が常に最新バージョンへ解決し（例: opus → 4.8）、
// `default` はアカウント既定（プランに応じて解決）、`best` は Fable 5
// が使えればそれ、なければ最新 Opus。`[1m]` は 1M コンテキスト版。
// バージョンを固定したい場合はユーザーが `/model claude-opus-4-8` の
// ように具体的なフル ID を入力すればよい（任意のバージョンを指定可能）。
// CLI 側に新モデルが増えたらこの配列を更新する（KEEP IN SYNC）。
export const MODEL_PRESETS: string[] = [
	"default",
	"sonnet",
	"opus",
	"haiku",
	"fable",
	"best",
	"sonnet[1m]",
	"opus[1m]",
	"fable[1m]",
	"opusplan",
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

/**
 * 添付ファイルを Vault 内に保存する際の、保存先フォルダの決め方。
 *
 * - `activeFileFolder`    — 現在アクティブなファイルと同じフォルダ。
 * - `vaultPath`           — `attachmentVaultPath` で指定した Vault 内の固定パス。
 * - `activeFileSubfolder` — アクティブファイルと同じ階層に作る、
 *                           `attachmentSubfolderName` で指定した名前のサブフォルダ。
 *
 * アクティブファイル基準のモードでアクティブファイルが無い場合は、いずれも
 * Vault ルートにフォールバックする。
 */
export type AttachmentSaveLocation =
	| "activeFileFolder"
	| "vaultPath"
	| "activeFileSubfolder";

export const ATTACHMENT_SAVE_LOCATIONS: AttachmentSaveLocation[] = [
	"activeFileFolder",
	"vaultPath",
	"activeFileSubfolder",
];

export interface ClaudePanelSettings {
	/** 設定スキーマの世代。SETTINGS_SCHEMA_VERSION を参照。 */
	settingsSchemaVersion: number;
	claudePath: string;
	model: string;
	thinkingMode: ThinkingMode;
	effortLevel: EffortLevel;
	/** チャットパネルを開いた時／会話をクリアした時に、アクティブ
	 *  ファイル（またはフォルダ）をプロンプトに含めた状態で始めるか。
	 *  パネル内の「含める／除外」トグルの初期値になる。トグル操作は
	 *  一時的で、この設定値は書き換えない。 */
	includeActiveByDefault: boolean;
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
	/** 添付・貼り付けたファイルを Vault 内に保存するかどうか。チャット
	 *  パネルの「Vault に保存」チェックボックスの初期状態にもなる。
	 *  チェックボックス側のトグルは一時的で、この設定値は書き換えない。 */
	saveAttachmentsToVault: boolean;
	/** `saveAttachmentsToVault` が ON のときの、保存先フォルダの決め方。 */
	attachmentSaveLocation: AttachmentSaveLocation;
	/** `attachmentSaveLocation` が `vaultPath` のときの保存先（Vault 相対）。
	 *  空文字のときは Vault ルートに保存する。 */
	attachmentVaultPath: string;
	/** `attachmentSaveLocation` が `activeFileSubfolder` のときの
	 *  サブフォルダ名。空文字のときは `attachments` を使う。 */
	attachmentSubfolderName: string;
	/** ON のとき、プロンプト送信は Ctrl+Enter（mac は Cmd+Enter も可）に
	 *  なり、素の Enter は改行を挿入する。OFF（既定）は従来通り Enter で
	 *  送信、Shift+Enter で改行。 */
	submitWithModEnter: boolean;
	/** チャットで自分（ユーザー）のメッセージに表示する名前。空文字なら
	 *  言語設定に応じた既定ラベル（「ユーザー」/「User」）を使う。 */
	userName: string;
	/** チャットで Claude のメッセージに表示する名前。空文字なら言語設定に
	 *  応じた既定ラベル（「アシスタント」/「Assistant」）を使う。 */
	assistantName: string;
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
	settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
	claudePath: "",
	model: "sonnet",
	// 公式 Claude Code の既定に合わせて思考はオン。
	thinkingMode: "on",
	effortLevel: "auto",
	// 既定は ON（従来動作を維持）。アクティブファイル／フォルダは
	// 含めた状態でパネルが開く。
	includeActiveByDefault: true,
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
	// 既定は OFF（従来動作を維持）。貼り付け画像はプラグインの一時フォルダ、
	// 添付ファイルは元の絶対パス参照のまま。ユーザーが必要に応じて ON にする。
	saveAttachmentsToVault: false,
	attachmentSaveLocation: "activeFileFolder",
	attachmentVaultPath: "attachments",
	attachmentSubfolderName: "attachments",
	// 既定は OFF（従来動作を維持）。Enter 即送信のままで、Shift+Enter が改行。
	submitWithModEnter: false,
	userName: "",
	assistantName: "",
};
