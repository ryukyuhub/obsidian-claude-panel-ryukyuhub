import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudePanelPlugin from "../main";
import { checkClaudeCli, resolveClaudePath, type CliStatus } from "../agent";
import { pickFilesViaDialog } from "../attachments";
import { toVaultRelativeIfInside } from "../notify-sound-source";
import {
	DEFAULT_SETTINGS,
	EFFORT_LEVELS,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	MODEL_PRESETS,
	NOTIFY_ON_COMPLETE_OPTIONS,
	NOTIFY_VOLUME_MAX,
	NOTIFY_VOLUME_MIN,
	PERMISSION_MODES,
	type EffortLevel,
	type NotifyOnComplete,
	type PermissionMode,
} from "./types";
import {
	formatModelLabel,
	notifyOnCompleteLabel,
	permissionModeLabel,
} from "./labels";
import {
	VaultAudioFileSuggestModal,
	listVaultAudioFiles,
} from "./vault-audio-suggest";

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

		this.renderNotificationSection(containerEl);

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
	 * 完了通知まわりの 3 設定（モード・音量・音声ファイル）をまとめて描画する。
	 *
	 * 音声ファイル設定は 4 つのアクション（Vault 内ピッカー / OS ピッカー /
	 * クリア + 直接入力）を持ち、保存形式は「絶対 OS パス」「Vault 相対パス」
	 * の 2 通り。Vault 同期で別環境に移っても追従させるため、OS ピッカーで
	 * 選ばれたファイルが Vault 配下なら自動で相対パス化して保存する。
	 */
	private renderNotificationSection(containerEl: HTMLElement): void {
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
					"Vault 内のファイルは相対パスとして保存され、Vault 同期で別環境に移っても追従します。" +
					"空欄の場合は内蔵の短いチャイムを使います。"
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
					.setIcon("library")
					.setTooltip("Vault 内のファイルから選択")
					.onClick(async () => {
						// `.obsidian/` 配下も拾うため、`vault.getFiles()` ではなく
						// `adapter.list` で再帰スキャンしてからモーダルを開く。
						const paths = await listVaultAudioFiles(
							this.plugin.app.vault.adapter
						);
						new VaultAudioFileSuggestModal(
							this.plugin.app,
							paths,
							async (path) => {
								this.plugin.settings.notifySoundPath = path;
								await this.plugin.saveSettings();
								this.display();
							}
						).open();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("folder-open")
					.setTooltip("OS のファイルダイアログから選択")
					.onClick(async () => {
						const result = await pickFilesViaDialog();
						const picked = result.paths[0];
						if (!picked) return;
						// Vault 配下なら相対パスへ。外部ならそのまま絶対パス。
						this.plugin.settings.notifySoundPath =
							toVaultRelativeIfInside(picked, this.plugin.app);
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
