import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudePanelPlugin from "./main";
import { checkClaudeCli, resolveClaudePath, type CliStatus } from "./agent";
import { pickFilesViaDialog } from "./attachments";

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
	"claude-sonnet-4-5",
	"claude-opus-4-5",
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
	/** 完了通知に使う音声ファイルの絶対パス。空のときは内蔵チャイムを使う。
	 *  対応形式は実行環境（Electron / Chromium）が decodeAudioData できる
	 *  もの（mp3 / wav / ogg / m4a など）。 */
	notifySoundPath: string;
}

/** 通知音量スライダーの上下限（パーセント）。 */
export const NOTIFY_VOLUME_MIN = 0;
export const NOTIFY_VOLUME_MAX = 100;

/** フォントサイズスライダーの上下限。10px 未満ではチャットパネルが
 *  読めない大きさになり、20px を超えるとサイドパネルの横幅に収まらない。 */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;

export const DEFAULT_SETTINGS: ClaudePanelSettings = {
	claudePath: "",
	model: "claude-sonnet-4-5",
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
};

export class ClaudePanelSettingTab extends PluginSettingTab {
	plugin: ClaudePanelPlugin;

	constructor(app: App, plugin: ClaudePanelPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderSetupSection(containerEl);

		const resolvedEl = containerEl.createDiv({
			cls: "claude-panel-resolved-path",
		});
		const updateResolvedDisplay = () => {
			resolvedEl.empty();
			const configured = this.plugin.settings.claudePath;
			const resolved = resolveClaudePath(configured);
			if (resolved) {
				resolvedEl.addClass("is-found");
				resolvedEl.removeClass("is-missing");
				resolvedEl.createSpan({
					cls: "claude-panel-resolved-label",
					text: configured ? "✓ 解決済み:" : "✓ 自動検出:",
				});
				resolvedEl.createEl("code", {
					cls: "claude-panel-resolved-path-code",
					text: resolved,
				});
			} else {
				resolvedEl.addClass("is-missing");
				resolvedEl.removeClass("is-found");
				resolvedEl.createSpan({
					cls: "claude-panel-resolved-label",
					text: configured
						? "✗ 指定されたパスに claude CLI が見つかりません"
						: "✗ 自動検出対象の場所に claude CLI が見つかりません",
				});
			}
		};

		new Setting(containerEl)
			.setName("claude CLI のパス")
			.setDesc(
				"任意。`claude` 実行ファイルへの絶対パスです。" +
					"空欄の場合は次の場所を順に自動検出します: PATH、~/.local/bin、~/.claude/local、/usr/local/bin、/opt/homebrew/bin。" +
					"既存の Claude Code サブスクリプションログインを利用するため、API キーは不要です。"
			)
			.addText((text) =>
				text
					.setPlaceholder("/Users/you/.local/bin/claude")
					.setValue(this.plugin.settings.claudePath)
					.onChange(async (value) => {
						this.plugin.settings.claudePath = value.trim();
						await this.plugin.saveSettings();
						updateResolvedDisplay();
					})
			);

		// パス Setting の下に解決済みパス表示を挿入し、初期内容を描画する。
		// appendChild は既存 div を移動させる仕様を利用している。
		containerEl.appendChild(resolvedEl);
		updateResolvedDisplay();

		new Setting(containerEl)
			.setName("MCP サーバーを無効化")
			.setDesc(
				"オンにすると、起動した `claude` CLI は ~/.claude.json とプロジェクトの .mcp.json を無視し、" +
					"MCP サーバー無しで起動します。デフォルト: オフ（MCP 有効）。" +
					"Serena などのサーバーが開こうとするブラウザポップアップは、" +
					"PATH 上の `open`/`xdg-open` コマンドを上書きすることで別途ブロックされます。"
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.disableMcpServers)
					.onChange(async (v) => {
						this.plugin.settings.disableMcpServers = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("ツール実行の承認モード")
			.setDesc(
				"Claude が Edit / Bash / MCP などのツールを呼び出す際の挙動。" +
					"『Ask before edits』ではチャット内に Approve / Deny ボタンが表示されます。" +
					"『Edit automatically』はファイル編集のみ自動で許可し、Bash や MCP は確認します。" +
					"『Bypass permissions』は確認なしで実行します（旧バージョンの動作）。" +
					"『Plan mode』はツール実行なしで計画のみ返します。"
			)
			.addDropdown((dropdown) => {
				for (const m of PERMISSION_MODES) {
					dropdown.addOption(m, permissionModeLabel(m));
				}
				dropdown.setValue(this.plugin.settings.permissionMode);
				dropdown.onChange(async (value) => {
					this.plugin.settings.permissionMode = value as PermissionMode;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("モデル")
			.setDesc(
				"新規メッセージで使う Claude モデル。チャットパネル下部のドロップダウンからも変更できます。"
			)
			.addDropdown((dropdown) => {
				for (const m of MODEL_PRESETS) {
					dropdown.addOption(m, formatModelLabel(m));
				}
				const current = this.plugin.settings.model;
				if (current && !MODEL_PRESETS.includes(current)) {
					dropdown.addOption(
						current,
						`${formatModelLabel(current)} (custom)`
					);
				}
				dropdown.setValue(current);
				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Effort（推論密度）")
			.setDesc(
				"対応モデル（Sonnet 4.6 / Opus 4.6 など）の推論密度。`auto` は CLI/`~/.claude/settings.json` の既定値に委譲します。" +
					"Haiku は Effort 非対応のため、指定しても無視されます。"
			)
			.addDropdown((dropdown) => {
				for (const e of EFFORT_LEVELS) {
					dropdown.addOption(e, e);
				}
				dropdown.setValue(this.plugin.settings.effortLevel);
				dropdown.onChange(async (value) => {
					this.plugin.settings.effortLevel = value as EffortLevel;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("フォントサイズ")
			.setDesc(
				`チャットパネル全体の基準フォントサイズ (${FONT_SIZE_MIN}–${FONT_SIZE_MAX}px)。` +
					"変更は即座にパネルへ反映されます。"
			)
			.addSlider((slider) =>
				slider
					.setLimits(FONT_SIZE_MIN, FONT_SIZE_MAX, 1)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
						this.plugin.getView()?.applyFontSize();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip("デフォルトに戻す")
					.onClick(async () => {
						this.plugin.settings.fontSize =
							DEFAULT_SETTINGS.fontSize;
						await this.plugin.saveSettings();
						this.plugin.getView()?.applyFontSize();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("完了通知")
			.setDesc(
				"Claude の応答が完了したときの通知方式。" +
					"フラッシュはパネル枠を一瞬光らせます。音は内蔵チャイム、または下で指定した音声ファイルを再生します。" +
					"ユーザー自身がキャンセルしたランでは通知しません。"
			)
			.addDropdown((dropdown) => {
				for (const n of NOTIFY_ON_COMPLETE_OPTIONS) {
					dropdown.addOption(n, notifyOnCompleteLabel(n));
				}
				dropdown.setValue(this.plugin.settings.notifyOnComplete);
				dropdown.onChange(async (value) => {
					this.plugin.settings.notifyOnComplete =
						value as NotifyOnComplete;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("通知音の音量")
			.setDesc(
				`完了通知音の音量 (${NOTIFY_VOLUME_MIN}–${NOTIFY_VOLUME_MAX}%)。` +
					"テストボタンで現在の設定（音量・ファイル）の組み合わせを試聴できます。"
			)
			.addSlider((slider) =>
				slider
					.setLimits(NOTIFY_VOLUME_MIN, NOTIFY_VOLUME_MAX, 5)
					.setValue(this.plugin.settings.notifySoundVolume)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.notifySoundVolume = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("play")
					.setTooltip("通知音をテスト再生")
					.onClick(() => {
						this.plugin.getView()?.testNotificationSound();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip("デフォルトに戻す")
					.onClick(async () => {
						this.plugin.settings.notifySoundVolume =
							DEFAULT_SETTINGS.notifySoundVolume;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("通知音ファイル")
			.setDesc(
				"通知に使う音声ファイル（mp3 / wav / ogg / m4a など）。" +
					"空欄の場合は内蔵の短いチャイムを使います。「選択」で OS のファイルダイアログから選べます。"
			)
			.addText((text) =>
				text
					.setPlaceholder("（空欄 = 内蔵チャイム）")
					.setValue(this.plugin.settings.notifySoundPath)
					.onChange(async (value) => {
						this.plugin.settings.notifySoundPath = value.trim();
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("folder-open")
					.setTooltip("ファイルを選択")
					.onClick(async () => {
						const result = await pickFilesViaDialog();
						const picked = result.paths[0];
						if (!picked) return;
						this.plugin.settings.notifySoundPath = picked;
						await this.plugin.saveSettings();
						this.display();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("x")
					.setTooltip("クリア（内蔵チャイムに戻す）")
					.onClick(async () => {
						this.plugin.settings.notifySoundPath = "";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("ホットキー")
			.setDesc(
				"パネルを開く / 入力欄にフォーカス / 送信 / キャンセル / 会話クリア / モデル切替 などのコマンドは" +
					"Obsidian 標準の『ホットキー』設定画面で自由にキーを割り当てられます。"
			)
			.addButton((btn) =>
				btn
					.setButtonText("ホットキー設定を開く")
					.setCta()
					.onClick(() => {
						// Obsidian の設定モーダルは ID 指定で setting タブを開ける。
						// `hotkeys` は組み込みタブ。プラグイン ID を渡すと、
						// 表示されるコマンドを本プラグイン分に事前フィルタできる。
						const setting = (this.app as any).setting;
						setting?.open?.();
						setting?.openTabById?.("hotkeys");
						const tab = setting?.activeTab;
						if (tab && typeof tab.setQuery === "function") {
							tab.setQuery(this.plugin.manifest.id);
						}
					})
			);
	}

	/**
	 * 設定タブ最上部のセットアップ案内。`claude` CLI のインストール／
	 * ログイン状態を表示し、未セットアップなら手順カードを出す。タブを
	 * 開いた時点で 1 回だけ checkClaudeCli を走らせ、「再チェック」ボタン
	 * で再実行する。タブを再描画すると status は失われるが、副作用がない
	 * のでそれで構わない。
	 */
	private renderSetupSection(containerEl: HTMLElement): void {
		const section = containerEl.createDiv({ cls: "claude-panel-setup" });
		section.createEl("h3", {
			cls: "claude-panel-setup-title",
			text: "セットアップ状況",
		});
		const summaryEl = section.createDiv({ cls: "claude-panel-setup-summary" });
		const stepsEl = section.createDiv({ cls: "claude-panel-setup-steps" });
		const guideEl = section.createDiv({ cls: "claude-panel-setup-guide" });
		const actionsEl = section.createDiv({ cls: "claude-panel-setup-actions" });

		const renderState = (state: "loading" | CliStatus): void => {
			summaryEl.empty();
			stepsEl.empty();
			guideEl.empty();

			if (state === "loading") {
				summaryEl.addClass("is-loading");
				summaryEl.removeClass("is-ok", "is-warn", "is-error");
				summaryEl.setText("確認中…");
				return;
			}

			summaryEl.removeClass("is-loading");
			const ok = state.installed && state.loggedIn === true;
			const warn = state.installed && !state.loggedIn;
			summaryEl.toggleClass("is-ok", ok);
			summaryEl.toggleClass("is-warn", warn);
			summaryEl.toggleClass("is-error", !state.installed);
			summaryEl.setText(
				ok
					? "✓ 利用可能です。"
					: warn
						? "⚠ もう少しでセットアップ完了です。"
						: "✗ Claude CLI のセットアップが必要です。"
			);

			const step = (
				icon: "ok" | "warn" | "error",
				label: string,
				detail?: string
			): void => {
				const row = stepsEl.createDiv({
					cls: `claude-panel-setup-step is-${icon}`,
				});
				row.createSpan({
					cls: "claude-panel-setup-step-icon",
					text: icon === "ok" ? "✓" : icon === "warn" ? "⚠" : "✗",
				});
				const main = row.createDiv({ cls: "claude-panel-setup-step-main" });
				main.createDiv({
					cls: "claude-panel-setup-step-label",
					text: label,
				});
				if (detail) {
					main.createDiv({
						cls: "claude-panel-setup-step-detail",
						text: detail,
					});
				}
			};

			if (state.installed) {
				step(
					"ok",
					`Claude CLI をインストール済み${state.version ? ` (v${state.version})` : ""}`,
					state.resolvedPath
				);
			} else {
				step(
					"error",
					"Claude CLI が見つかりません",
					state.error || undefined
				);
			}
			if (state.installed) {
				if (state.loggedIn) {
					step(
						"ok",
						"ログイン済み",
						[state.email, state.subscriptionType, state.authMethod]
							.filter(Boolean)
							.join(" · ")
					);
				} else {
					step(
						"warn",
						"ログインが必要です",
						"ターミナルで `claude /login` を実行してください。"
					);
				}
			}

			if (!state.installed) {
				this.renderInstallGuide(guideEl);
			} else if (!state.loggedIn) {
				this.renderLoginGuide(guideEl);
			}
		};

		actionsEl.empty();
		const recheckBtn = actionsEl.createEl("button", {
			cls: "claude-panel-setup-recheck mod-cta",
			text: "再チェック",
		});
		const runCheck = async (): Promise<void> => {
			recheckBtn.disabled = true;
			renderState("loading");
			try {
				const status = await checkClaudeCli(this.plugin.settings.claudePath);
				renderState(status);
			} catch (err) {
				renderState({
					installed: false,
					error: (err as Error).message,
				});
			} finally {
				recheckBtn.disabled = false;
			}
		};
		recheckBtn.onclick = () => {
			void runCheck();
		};

		void runCheck();
	}

	/** インストール手順（未インストール時に表示）。 */
	private renderInstallGuide(host: HTMLElement): void {
		host.createDiv({
			cls: "claude-panel-setup-guide-title",
			text: "インストール手順",
		});
		const note = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		note.setText(
			"OS に合わせて以下のコマンドをターミナルで実行してください。" +
				"インストール後にこのタブの「再チェック」を押すと、自動検出されます。"
		);

		// Windows: winget で前提（Node.js / Git / PowerShell 7）→ npm でインストール、まで提示。
		// 標準同梱の PowerShell 5.1 ではブラウザ認証時の貼付に不具合があるため、
		// PowerShell 7 への切替を最初から強く促している。
		const winBlock = this.makeCodeBlock(
			host,
			"Windows（管理者権限の PowerShell で実行）",
			[
				"winget install --id OpenJS.NodeJS.LTS",
				"winget install --id Microsoft.PowerShell",
				"npm install -g @anthropic-ai/claude-code",
			].join("\n")
		);
		winBlock.setAttr(
			"title",
			"PowerShell 7 (pwsh) を入れてから新しいウィンドウで `claude /login` を実行してください。"
		);

		this.makeCodeBlock(
			host,
			"macOS（Terminal で実行 / Homebrew 必須）",
			["brew install node", "npm install -g @anthropic-ai/claude-code"].join("\n")
		);

		this.makeCodeBlock(
			host,
			"npm が既に使える環境（Linux ほか共通）",
			"npm install -g @anthropic-ai/claude-code"
		);

		const tip = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		tip.setText(
			"ヒント: 「npm: command not found」と出たら、Node.js が未インストールです。" +
				"上記の OS 別コマンドの 1 行目から順に実行してください。"
		);

		const linkRow = host.createDiv({ cls: "claude-panel-setup-guide-links" });
		const link = linkRow.createEl("a", {
			text: "公式インストールガイド",
			href: "https://docs.claude.com/claude-code/quickstart",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");
	}

	/** ログイン手順（CLI はあるが未ログイン時に表示）。 */
	private renderLoginGuide(host: HTMLElement): void {
		host.createDiv({
			cls: "claude-panel-setup-guide-title",
			text: "ログイン手順",
		});
		const note = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		note.setText(
			"ターミナル（macOS は Terminal、Windows は PowerShell 7 / pwsh）で次のコマンドを実行し、" +
				"画面の指示に従ってブラウザでログインしてください。Claude Pro / Max のサブスクリプションでも API キーでも利用できます。"
		);
		this.makeCodeBlock(host, "ログインコマンド", "claude /login");

		// よくある失敗のリカバリ。Windows の PowerShell 5.1 ではコピペが崩れる
		// ことが報告されているため、PowerShell 7 への切替を明示する。
		const tips = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		tips.createEl("strong", { text: "うまくいかないとき:" });
		const ul = tips.createEl("ul");
		ul.createEl("li", {
			text: "ブラウザが自動で開かない場合は、表示された URL を選択コピーしてブラウザのアドレスバーに貼り付け、戻ってきた認証コードをターミナルに貼り戻してください。",
		});
		ul.createEl("li", {
			text: "Windows で認証コードの貼り付けが崩れる場合は、`winget install Microsoft.PowerShell` で PowerShell 7 (pwsh) を入れ、新しいウィンドウで `claude /login` をやり直してください。",
		});
	}

	/**
	 * コピー可能なコードブロックを作る。クリックでクリップボードへ
	 * コピーし、Notice で確認を出す。
	 */
	private makeCodeBlock(
		host: HTMLElement,
		label: string,
		command: string
	): HTMLElement {
		const wrap = host.createDiv({ cls: "claude-panel-setup-code" });
		wrap.createDiv({
			cls: "claude-panel-setup-code-label",
			text: label,
		});
		const row = wrap.createDiv({ cls: "claude-panel-setup-code-row" });
		row.createEl("code", {
			cls: "claude-panel-setup-code-cmd",
			text: command,
		});
		const copyBtn = row.createEl("button", {
			cls: "claude-panel-setup-code-copy",
			text: "コピー",
		});
		copyBtn.onclick = async () => {
			try {
				await navigator.clipboard.writeText(command);
				new Notice("コピーしました");
			} catch {
				new Notice("コピーに失敗しました");
			}
		};
		return wrap;
	}
}
