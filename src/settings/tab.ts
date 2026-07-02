import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudePanelPlugin from "../main";
import { checkClaudeCli, type CliStatus } from "../agent";
import { resolveClaudePath } from "../cli-resolver";
import { getSettingModal } from "../obsidian-internals";
import { pickFilesViaDialog } from "../attachments";
import { toVaultRelativeIfInside } from "../notify-sound-source";
import {
	ATTACHMENT_SAVE_LOCATIONS,
	COMPOSER_BOTTOM_PADDING_MAX,
	COMPOSER_BOTTOM_PADDING_MIN,
	DEFAULT_SETTINGS,
	EFFORT_LEVELS,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	MODEL_PRESETS,
	NOTIFY_ON_COMPLETE_OPTIONS,
	NOTIFY_VOLUME_MAX,
	NOTIFY_VOLUME_MIN,
	PERMISSION_MODES,
	THINKING_MODES,
	UI_LANGUAGES,
	type AttachmentSaveLocation,
	type EffortLevel,
	type NotifyOnComplete,
	type PermissionMode,
	type ThinkingMode,
	type UiLanguage,
} from "./types";
import {
	formatModelLabel,
	notifyOnCompleteLabel,
	permissionModeLabel,
	thinkingModeLabel,
} from "./labels";
import {
	VaultAudioFileSuggestModal,
	listVaultAudioFiles,
} from "./vault-audio-suggest";
import { t, setLanguageOverride } from "../i18n";
import { setRoleNames } from "../chat-message-render";

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
					text: configured
						? t("settings.resolved.labelResolved")
						: t("settings.resolved.labelAutoDetected"),
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
						? t("settings.resolved.labelNotFoundConfigured")
						: t("settings.resolved.labelNotFoundAuto"),
				});
			}
		};

		new Setting(containerEl)
			.setName(t("settings.claudePath.name"))
			.setDesc(t("settings.claudePath.desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.claudePath.placeholder"))
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
			.setName(t("settings.disableMcp.name"))
			.setDesc(t("settings.disableMcp.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.disableMcpServers)
					.onChange(async (v) => {
						this.plugin.settings.disableMcpServers = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.permissionMode.name"))
			.setDesc(t("settings.permissionMode.desc"))
			.addDropdown((dropdown) => {
				for (const m of PERMISSION_MODES) {
					dropdown.addOption(m, permissionModeLabel(m));
				}
				dropdown.setValue(this.plugin.settings.permissionMode);
				dropdown.onChange(async (value) => {
					this.plugin.settings.permissionMode = value as PermissionMode;
					await this.plugin.saveSettings();
					this.plugin.getView()?.refreshControls();
				});
			});

		new Setting(containerEl)
			.setName(t("settings.model.name"))
			.setDesc(t("settings.model.desc"))
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
					this.plugin.getView()?.refreshControls();
				});
			});

		new Setting(containerEl)
			.setName(t("settings.thinking.name"))
			.setDesc(t("settings.thinking.desc"))
			.addDropdown((dropdown) => {
				for (const mode of THINKING_MODES) {
					dropdown.addOption(mode, thinkingModeLabel(mode));
				}
				dropdown.setValue(this.plugin.settings.thinkingMode);
				dropdown.onChange(async (value) => {
					this.plugin.settings.thinkingMode = value as ThinkingMode;
					await this.plugin.saveSettings();
					this.plugin.getView()?.refreshControls();
				});
			});

		new Setting(containerEl)
			.setName(t("settings.effort.name"))
			.setDesc(t("settings.effort.desc"))
			.addDropdown((dropdown) => {
				for (const e of EFFORT_LEVELS) {
					dropdown.addOption(e, e);
				}
				dropdown.setValue(this.plugin.settings.effortLevel);
				dropdown.onChange(async (value) => {
					this.plugin.settings.effortLevel = value as EffortLevel;
					await this.plugin.saveSettings();
					this.plugin.getView()?.refreshControls();
				});
			});

		new Setting(containerEl)
			.setName(t("settings.includeActiveDefault.name"))
			.setDesc(t("settings.includeActiveDefault.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.includeActiveByDefault)
					.onChange(async (v) => {
						this.plugin.settings.includeActiveByDefault = v;
						await this.plugin.saveSettings();
					})
			);

		this.renderAttachmentSection(containerEl);

		new Setting(containerEl)
			.setName(t("settings.language.name"))
			.setDesc(t("settings.language.desc"))
			.addDropdown((dropdown) => {
				for (const lang of UI_LANGUAGES) {
					dropdown.addOption(lang, t(`settings.language.option.${lang}`));
				}
				dropdown.setValue(this.plugin.settings.language);
				dropdown.onChange(async (value) => {
					this.plugin.settings.language = value as UiLanguage;
					await this.plugin.saveSettings();
					setLanguageOverride(this.plugin.settings.language);
					// 設定タブ自身、および開いているチャットパネルの DOM を
					// その場で再描画する。ribbon / コマンドパレットのラベルは
					// `addRibbonIcon` / `addCommand` 時に Obsidian 側に確定し、
					// 動的更新の API がないため、完全な反映には再読み込みが
					// 必要 — Notice で案内する。
					this.display();
					this.plugin.getView()?.rebuildLocalizedUI();
					new Notice(t("settings.language.restartHint"));
				});
			});

		const applyRoleNames = () => {
			setRoleNames(
				this.plugin.settings.userName,
				this.plugin.settings.assistantName
			);
			// 既にレンダリング済みのチャットバブルへ即座に反映する。
			this.plugin.getView()?.rerenderMessages();
		};

		new Setting(containerEl)
			.setName(t("settings.roleNames.userName"))
			.setDesc(t("settings.roleNames.userDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.roleNames.userPlaceholder"))
					.setValue(this.plugin.settings.userName)
					.onChange(async (value) => {
						this.plugin.settings.userName = value.trim();
						await this.plugin.saveSettings();
						applyRoleNames();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.roleNames.assistantName"))
			.setDesc(t("settings.roleNames.assistantDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.roleNames.assistantPlaceholder"))
					.setValue(this.plugin.settings.assistantName)
					.onChange(async (value) => {
						this.plugin.settings.assistantName = value.trim();
						await this.plugin.saveSettings();
						applyRoleNames();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.fontSize.name"))
			.setDesc(t("settings.fontSize.desc", FONT_SIZE_MIN, FONT_SIZE_MAX))
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
					.setTooltip(t("settings.resetToDefault"))
					.onClick(async () => {
						this.plugin.settings.fontSize =
							DEFAULT_SETTINGS.fontSize;
						await this.plugin.saveSettings();
						this.plugin.getView()?.applyFontSize();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.composerPadding.name"))
			.setDesc(
				t(
					"settings.composerPadding.desc",
					COMPOSER_BOTTOM_PADDING_MIN,
					COMPOSER_BOTTOM_PADDING_MAX
				)
			)
			.addSlider((slider) =>
				slider
					.setLimits(
						COMPOSER_BOTTOM_PADDING_MIN,
						COMPOSER_BOTTOM_PADDING_MAX,
						2
					)
					.setValue(this.plugin.settings.composerBottomPadding)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.composerBottomPadding = value;
						await this.plugin.saveSettings();
						this.plugin.getView()?.applyComposerBottomPadding();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip(t("settings.resetToDefault"))
					.onClick(async () => {
						this.plugin.settings.composerBottomPadding =
							DEFAULT_SETTINGS.composerBottomPadding;
						await this.plugin.saveSettings();
						this.plugin.getView()?.applyComposerBottomPadding();
						this.display();
					})
			);

		this.renderNotificationSection(containerEl);

		new Setting(containerEl)
			.setName(t("settings.submitWithModEnter.name"))
			.setDesc(t("settings.submitWithModEnter.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.submitWithModEnter)
					.onChange(async (v) => {
						this.plugin.settings.submitWithModEnter = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.hotkeys.name"))
			.setDesc(t("settings.hotkeys.desc"))
			.addButton((btn) =>
				btn
					.setButtonText(t("settings.hotkeys.openBtn"))
					.setCta()
					.onClick(() => {
						// Obsidian の設定モーダルは ID 指定で setting タブを開ける。
						// `hotkeys` は組み込みタブ。プラグイン ID を渡すと、
						// 表示されるコマンドを本プラグイン分に事前フィルタできる。
						const setting = getSettingModal(this.app);
						setting?.open();
						setting?.openTabById("hotkeys");
						const tab = setting?.activeTab;
						if (tab?.setQuery) {
							tab.setQuery(this.plugin.manifest.id);
						}
					})
			);

		this.renderAboutSection(containerEl);
	}

	/** リポジトリ URL とバージョンを表示する。コミュニティプラグイン
	 *  カードの説明欄全体がクリッカブルでリンクを置けないため、設定
	 *  画面側で誘導する。 */
	private renderAboutSection(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName(t("settings.about.name"))
			.setDesc(t("settings.about.desc", this.plugin.manifest.version));
		setting.controlEl.createEl("a", {
			text: t("settings.about.repoLink"),
			href: "https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/releases",
			cls: "claude-panel-repo-link",
			attr: { target: "_blank", rel: "noopener" },
		});
	}

	/**
	 * 添付ファイルまわりの設定を描画する。「Vault に保存」トグルと、その
	 * サブ設定（保存先の決め方ドロップダウン + 選択モードに応じた補助入力欄）
	 * を出す。保存先関連はトグル直下の字下げコンテナにまとめ、トグルに
	 * ぶら下がるサブ設定であることを視覚的に示す。補助入力欄の出し分けは
	 * ドロップダウン変更時に `display()` で再描画して行う。
	 */
	private renderAttachmentSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.saveAttachments.name"))
			.setDesc(t("settings.saveAttachments.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.saveAttachmentsToVault)
					.onChange(async (v) => {
						this.plugin.settings.saveAttachmentsToVault = v;
						// パネル側トグルの実体（プラグイン上の一時状態）も同期。
						// 設定タブから変えたつもりが現在開いているパネルだけ
						// 取り残される、という違和感を防ぐ。
						this.plugin.runtimeSaveAttachmentsToVault = v;
						await this.plugin.saveSettings();
					})
			);

		// 保存先関連は「Vault に保存」トグルのサブ設定として、字下げした
		// コンテナにまとめてネスト表示する。
		const sub = containerEl.createDiv({
			cls: "claude-panel-attachment-suboptions",
		});

		new Setting(sub)
			.setName(t("settings.attachmentLocation.name"))
			.setDesc(t("settings.attachmentLocation.desc"))
			.addDropdown((dropdown) => {
				for (const loc of ATTACHMENT_SAVE_LOCATIONS) {
					dropdown.addOption(
						loc,
						t(`settings.attachmentLocation.option.${loc}`)
					);
				}
				dropdown.setValue(
					this.plugin.settings.attachmentSaveLocation
				);
				dropdown.onChange(async (value) => {
					this.plugin.settings.attachmentSaveLocation =
						value as AttachmentSaveLocation;
					await this.plugin.saveSettings();
					// 選択モードに対応する補助入力欄に切り替えるため再描画。
					this.display();
				});
			});

		const location = this.plugin.settings.attachmentSaveLocation;
		if (location === "vaultPath") {
			new Setting(sub)
				.setName(t("settings.attachmentVaultPath.name"))
				.setDesc(t("settings.attachmentVaultPath.desc"))
				.addText((text) =>
					text
						.setPlaceholder(
							t("settings.attachmentVaultPath.placeholder")
						)
						.setValue(this.plugin.settings.attachmentVaultPath)
						.onChange(async (value) => {
							this.plugin.settings.attachmentVaultPath =
								value.trim();
							await this.plugin.saveSettings();
						})
				);
		} else if (location === "activeFileSubfolder") {
			new Setting(sub)
				.setName(t("settings.attachmentSubfolder.name"))
				.setDesc(t("settings.attachmentSubfolder.desc"))
				.addText((text) =>
					text
						.setPlaceholder(
							t("settings.attachmentSubfolder.placeholder")
						)
						.setValue(
							this.plugin.settings.attachmentSubfolderName
						)
						.onChange(async (value) => {
							this.plugin.settings.attachmentSubfolderName =
								value.trim();
							await this.plugin.saveSettings();
						})
				);
		}
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
			.setName(t("settings.notify.completeName"))
			.setDesc(t("settings.notify.completeDesc"))
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
			.setName(t("settings.notify.volumeName"))
			.setDesc(
				t(
					"settings.notify.volumeDesc",
					NOTIFY_VOLUME_MIN,
					NOTIFY_VOLUME_MAX
				)
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
					.setTooltip(t("settings.notify.testTooltip"))
					.onClick(() => {
						this.plugin.getView()?.testNotificationSound();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip(t("settings.resetToDefault"))
					.onClick(async () => {
						this.plugin.settings.notifySoundVolume =
							DEFAULT_SETTINGS.notifySoundVolume;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.notify.soundFileName"))
			.setDesc(t("settings.notify.soundFileDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.notify.soundPlaceholder"))
					.setValue(this.plugin.settings.notifySoundPath)
					.onChange(async (value) => {
						this.plugin.settings.notifySoundPath = value.trim();
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("library")
					.setTooltip(t("settings.notify.pickFromVault"))
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
					.setTooltip(t("settings.notify.pickFromOs"))
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
					.setTooltip(t("settings.notify.clearSound"))
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
		section.createEl("div", {
			cls: "claude-panel-setup-title",
			text: t("settings.setup.title"),
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
				summaryEl.setText(t("settings.setup.checking"));
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
					? t("settings.setup.summaryOk")
					: warn
						? t("settings.setup.summaryWarn")
						: t("settings.setup.summaryError")
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
					t("settings.setup.stepInstalled", state.version ?? ""),
					state.resolvedPath
				);
			} else {
				step(
					"error",
					t("settings.setup.stepNotFound"),
					state.error || undefined
				);
			}
			if (state.installed) {
				if (state.loggedIn) {
					step(
						"ok",
						t("settings.setup.stepLoggedIn"),
						[state.email, state.subscriptionType, state.authMethod]
							.filter(Boolean)
							.join(" · ")
					);
				} else {
					step(
						"warn",
						t("settings.setup.stepLoginNeeded"),
						t("settings.setup.stepLoginNeededDetail")
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
			text: t("settings.setup.recheck"),
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
			text: t("settings.setup.installTitle"),
		});
		const note = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		note.setText(t("settings.setup.installNote"));

		// Windows: winget で前提（Node.js / Git / PowerShell 7）→ npm でインストール、まで提示。
		// 標準同梱の PowerShell 5.1 ではブラウザ認証時の貼付に不具合があるため、
		// PowerShell 7 への切替を最初から強く促している。
		const winBlock = this.makeCodeBlock(
			host,
			t("settings.setup.installWinLabel"),
			[
				"winget install --id OpenJS.NodeJS.LTS",
				"winget install --id Microsoft.PowerShell",
				"npm install -g @anthropic-ai/claude-code",
			].join("\n")
		);
		winBlock.setAttr("title", t("settings.setup.installWinTooltip"));

		this.makeCodeBlock(
			host,
			t("settings.setup.installMacLabel"),
			["brew install node", "npm install -g @anthropic-ai/claude-code"].join("\n")
		);

		this.makeCodeBlock(
			host,
			t("settings.setup.installNpmLabel"),
			"npm install -g @anthropic-ai/claude-code"
		);

		const tip = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		tip.setText(t("settings.setup.installTip"));

		const linkRow = host.createDiv({ cls: "claude-panel-setup-guide-links" });
		const link = linkRow.createEl("a", {
			text: t("settings.setup.installOfficialGuide"),
			href: "https://docs.claude.com/claude-code/quickstart",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");
	}

	/** ログイン手順（CLI はあるが未ログイン時に表示）。 */
	private renderLoginGuide(host: HTMLElement): void {
		host.createDiv({
			cls: "claude-panel-setup-guide-title",
			text: t("settings.setup.loginTitle"),
		});
		const note = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		note.setText(t("settings.setup.loginNote"));
		this.makeCodeBlock(host, t("settings.setup.loginCmdLabel"), "claude /login");

		// よくある失敗のリカバリ。Windows の PowerShell 5.1 ではコピペが崩れる
		// ことが報告されているため、PowerShell 7 への切替を明示する。
		const tips = host.createDiv({ cls: "claude-panel-setup-guide-note" });
		tips.createEl("strong", { text: t("settings.setup.loginTroubleHeading") });
		const ul = tips.createEl("ul");
		ul.createEl("li", {
			text: t("settings.setup.loginTroubleAutoOpen"),
		});
		ul.createEl("li", {
			text: t("settings.setup.loginTroublePaste"),
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
			text: t("settings.setup.copyBtn"),
		});
		copyBtn.onclick = async () => {
			try {
				await navigator.clipboard.writeText(command);
				new Notice(t("settings.setup.copyDone"));
			} catch {
				new Notice(t("settings.setup.copyFail"));
			}
		};
		return wrap;
	}
}
