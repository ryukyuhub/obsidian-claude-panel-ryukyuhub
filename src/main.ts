import { Plugin, WorkspaceLeaf, normalizePath } from "obsidian";
import {
	ClaudePanelSettings,
	DEFAULT_SETTINGS,
	ClaudePanelSettingTab,
} from "./settings";
import { ClaudePanelView, VIEW_TYPE_CLAUDE_PANEL } from "./view";

export default class ClaudePanelPlugin extends Plugin {
	settings!: ClaudePanelSettings;

	// クリップボードからペーストした画像の保存先（Vault 相対パス）。
	// プラグイン自身のディレクトリ配下に置くことでユーザー側の
	// Vault を汚さない。プラグイン unload 時にクリアされる。
	getAttachmentFolder(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/attachments`
		);
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.cleanupLegacyChatState();

		this.registerView(
			VIEW_TYPE_CLAUDE_PANEL,
			(leaf: WorkspaceLeaf) => new ClaudePanelView(leaf, this)
		);

		this.addRibbonIcon("bot", "Claude パネルを開く", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-claude-panel",
			name: "Claude パネルを開く",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "focus-claude-panel-input",
			name: "Claude パネルの入力欄にフォーカス",
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
			name: "プロンプトを送信",
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandSend();
				return true;
			},
		});

		this.addCommand({
			id: "cancel-claude-panel-run",
			name: "実行中のエージェントを中断",
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandCancel();
				return true;
			},
		});

		this.addCommand({
			id: "clear-claude-panel-conversation",
			name: "会話をクリア",
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandClear();
				return true;
			},
		});

		this.addCommand({
			id: "cycle-claude-panel-model",
			name: "モデルを順送り",
			checkCallback: (checking) => {
				const view = this.getView();
				if (!view) return false;
				if (!checking) view.commandCycleModel();
				return true;
			},
		});

		this.addSettingTab(new ClaudePanelSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		// Leaf は Obsidian 側で自動的に切り離されるので明示的な処理は不要。
		await this.cleanupAttachments();
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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
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
