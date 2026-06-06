import { Plugin, WorkspaceLeaf, normalizePath } from "obsidian";
import {
	ClaudePanelSettings,
	DEFAULT_SETTINGS,
	ClaudePanelSettingTab,
} from "./settings";
import { ClaudePanelView, VIEW_TYPE_CLAUDE_PANEL } from "./view";
import { UsageHistory } from "./usage-history";
import {
	fetchAuthStatus,
	applyRateLimitEvent,
	loadCachedUsageFromDisk,
} from "./account-api";
import type { RateLimitInfo } from "./agent";
import type { MessageUsage } from "./chat-message";
import { t, setLanguageOverride } from "./i18n";
import { setRoleNames } from "./chat-message-render";

export default class ClaudePanelPlugin extends Plugin {
	settings!: ClaudePanelSettings;
	// チャットターン終了ごとの usage を vault 設定フォルダ配下に永続化する。
	// /usage モーダルとメッセージフッターから読み出す。
	usageHistory!: UsageHistory;
	// パネルの「Vault に保存」チェックボックスの現在値。プラグインインスタンス
	// に持たせることで、パネルの開閉・タブ切り替えをまたいで保持される。
	// 初期値は `settings.saveAttachmentsToVault`。設定タブで変更された場合も
	// ここを同期する。Obsidian 再起動・プラグイン再有効化でリセットされる。
	runtimeSaveAttachmentsToVault = false;

	// クリップボードからペーストした画像の保存先（Vault 相対パス）。
	// プラグイン自身のディレクトリ配下に置くことでユーザー側の
	// Vault を汚さない。プラグイン unload 時にクリアされる。
	getAttachmentFolder(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/attachments`
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Obsidian の onload は型上 `: void` だが async が公式パターン。戻り値の Promise はフレームワークが待たないので誤検知
	async onload(): Promise<void> {
		await this.loadSettings();
		// ribbon / command を登録する前に i18n の override を適用しないと、
		// ラベルが Obsidian 言語で固定されてしまう。
		setLanguageOverride(this.settings.language);
		setRoleNames(this.settings.userName, this.settings.assistantName);
		await this.cleanupLegacyChatState();
		this.usageHistory = new UsageHistory();
		await this.usageHistory.load();
		// 直前セッションで保存しておいた使用状況キャッシュを復元。これで
		// Obsidian リロード直後でも 5h/7d 表示が「—」にならず、API が 429
		// でも前回値を出し続けられる（次の rate_limit_event で自動更新）。
		await loadCachedUsageFromDisk();
		// アカウント識別キーは CLI 呼び出しが要るので非同期で解決する。
		// 解決前に来た usage は内部で pending キューに退避され、解決時に
		// 正しいアカウントキーで遡って記録される。
		void this.resolveCurrentAccount();

		this.registerView(
			VIEW_TYPE_CLAUDE_PANEL,
			(leaf: WorkspaceLeaf) => new ClaudePanelView(leaf, this)
		);

		this.addRibbonIcon("bot", t("ribbon.openPanel"), () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-claude-panel",
			name: t("command.openPanel"),
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "focus-claude-panel-input",
			name: t("command.focusInput"),
			callback: async () => {
				await this.activateView();
				const view = this.getView();
				view?.focusInput();
			},
		});

		// 以降のコマンドはすべて `checkCallback` を使用。パネルが開いて
		// いないときはコマンドがグレーアウトされ、ホットキーも無効化
		// されるので、Ctrl+Enter のようなグローバルホットキーがチャット
		// コンテキスト外ではエディタ用として温存される。
		this.addCommand({
			id: "send-claude-panel-prompt",
			name: t("command.sendPrompt"),
			// デフォルトのホットキーは付けない（Obsidian ガイドライン: 既定の
			// ショートカットは他のホットキーと競合しうる）。「Enter では送信しない」
			// 設定を使うユーザーは Obsidian のホットキー設定で送信キーを割り当てる。
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandSend();
				return true;
			},
		});

		this.addCommand({
			id: "cancel-claude-panel-run",
			name: t("command.cancelAgent"),
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandCancel();
				return true;
			},
		});

		this.addCommand({
			id: "clear-claude-panel-conversation",
			name: t("command.clearChat"),
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandClear();
				return true;
			},
		});

		this.addCommand({
			id: "cycle-claude-panel-model",
			name: t("command.cycleModel"),
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandCycleModel();
				return true;
			},
		});

		this.addCommand({
			id: "toggle-claude-panel-include-active",
			name: t("command.toggleActiveFile"),
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandToggleIncludeActive();
				return true;
			},
		});

		this.addSettingTab(new ClaudePanelSettingTab(this.app, this));
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises -- onunload も onload 同様 Obsidian の async ライフサイクルは型上 void で誤検知
	async onunload(): Promise<void> {
		// Leaf は Obsidian 側で自動的に切り離されるので明示的な処理は不要。
		// debounce 中の usage 書き込みを取りこぼさないよう即時 flush。
		await this.usageHistory?.flushNow();
		await this.cleanupAttachments();
	}

	/** ChatRuntime から 1 ターン分の usage を渡される。永続履歴に追記する。 */
	recordUsage(usage: MessageUsage): void {
		this.usageHistory?.record(usage);
	}

	/**
	 * ChatRuntime から `rate_limit_event` を受け取り、共有キャッシュに反映
	 * する。チャット実行のたびに 1〜2 回発火する「無料の」最新値で、
	 * AccountUsageModal を開いたときの初期表示を新鮮に保つ。
	 */
	applyRateLimitEvent(info: RateLimitInfo): void {
		applyRateLimitEvent(info);
	}

	/**
	 * `claude auth status --json` を叩いて現在のサブスクアカウント識別キーを
	 * 解決し、UsageHistory に渡す。失敗してもプラグインの動作は止めない。
	 * 設定タブからの再ログイン後など、外から呼び直すのにも使う。
	 */
	async resolveCurrentAccount(): Promise<void> {
		try {
			const status = await fetchAuthStatus(this.settings);
			this.usageHistory?.setAccount(status);
		} catch {
			this.usageHistory?.setAccount(null);
		}
	}

	/**
	 * 旧バージョンが書き出していた `chat.json`（チャット履歴の永続化）を
	 * 削除する。Vault を Google Drive 等で同期している環境で、片方の端末の
	 * セッション ID や絶対パス添付が他端末側に流れて誤動作するのを防ぐ
	 * ため、永続化機能を撤去した。残置ファイルは無害だが同期トラフィック
	 * の元になるので、起動時に一度だけ掃除する。
	 */
	private async cleanupLegacyChatState(): Promise<void> {
		const path = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/chat.json`
		);
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(path)) {
				await adapter.remove(path);
			}
		} catch {
			/* noop — 削除失敗してもユーザー体験は変わらないので握りつぶす */
		}
	}

	private async cleanupAttachments(): Promise<void> {
		const folder = this.getAttachmentFolder();
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(folder))) return;
		try {
			const list = await adapter.list(folder);
			for (const file of list.files) {
				try {
					await adapter.remove(file);
				} catch {
					/* ベストエフォート — 同期処理がファイルをロックしていることがある */
				}
			}
		} catch {
			/* noop — フォルダを読めない場合は何もしない */
		}
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<ClaudePanelSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
		// 旧プリセット（バージョン固定 ID）をエイリアスへ移行する。CLI に最新を
		// 解決させ「表示が古いバージョンのまま」問題を解消するため。意図的な
		// ピン留めを壊さないよう、旧プリセットの 3 文字列だけを対象にする。
		const LEGACY_PRESET_MIGRATION: Record<string, string> = {
			"claude-sonnet-4-6": "sonnet",
			"claude-opus-4-7": "opus",
			"claude-haiku-4-5": "haiku",
		};
		const migrated = LEGACY_PRESET_MIGRATION[this.settings.model];
		if (migrated) {
			this.settings.model = migrated;
			// 移行結果を即座に永続化し、毎起動での再実行とディスク上の古い値を避ける。
			await this.saveSettings();
		}
		this.runtimeSaveAttachmentsToVault = this.settings.saveAttachmentsToVault;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getView(): ClaudePanelView | null {
		const leaves = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CLAUDE_PANEL
		);
		const v = leaves[0]?.view;
		return v instanceof ClaudePanelView ? v : null;
	}

	/** パネル内のコンテキスト/セッション ドーナツメーターを再描画する
	 *  （セッションバジェット等の設定変更後に呼ばれる）。
	 *  パネルが閉じている場合は何もしない。 */
	refreshMeters(): void {
		this.getView()?.refreshMeters();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_PANEL);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: VIEW_TYPE_CLAUDE_PANEL,
				active: true,
			});
			workspace.revealLeaf(leaf);
		}
	}
}
