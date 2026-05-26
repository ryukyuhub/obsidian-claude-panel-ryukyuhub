import type ClaudePanelPlugin from "./main";
import {
	runAgent,
	type PermissionDecision,
	type PermissionRequest,
	type RunHandle,
} from "./agent";
import type {
	EffortLevel,
	ThinkingMode,
} from "./settings";
import {
	type ChatMessage,
	type MessageUsage,
	type RunResult,
	type SelectionRef,
	nextMsgId,
	appendText as appendTextToParts,
	pushPermission as pushPermissionToParts,
	pushTool as pushToolToParts,
	setPermissionStatus,
} from "./chat-message";
import { loadLatestSessionMessages } from "./session-history";
import { t } from "./i18n";

/**
 * 会話ランタイム。チャット 1 ターンの送信〜受信〜パーミッション処理を
 * 担う。view から「state とフロー制御」を切り離した結果、view は DOM と
 * ユーザー入力（添付・選択範囲・コンポーザー）の構築だけに専念できる。
 *
 * 設計上の境界:
 *   - **runtime が所有する**: messages 配列、currentRun、セッション ID、
 *     pending パーミッション、最新 usage、busy フラグ。
 *   - **view が所有する**: DOM、添付・アクティブファイル等の入力状態、
 *     composeMessage の組み立て。
 *   - **橋渡し**: `ChatRuntimeHost` インターフェース。runtime が状態を
 *     書き換えるたびに対応するイベントを呼び、view（host 実装）が DOM
 *     を高速パッチするか、必要に応じて 1 メッセージ／全体を再描画する。
 *
 * ストリーミングのテキスト追加は再描画ではなく直接 DOM に append する
 * 高速パスを取りたいので、runtime は part 配列を mutate したあと
 * `host.onStreamingText` を呼び、host 側に DOM 更新を任せる構造にしている。
 */

/** view 側で組み立て、runtime に渡す送信用メッセージ。 */
export interface ComposedMessage {
	mentions: string[];
	selectionRef?: SelectionRef;
	/** バブル本文。ユーザーの生入力に近い。 */
	body: string;
	/** Claude CLI に送る最終プロンプト（@-mention・選択範囲・thinking
	 *  プレフィックス込み）。 */
	fullPrompt: string;
	thinkingMode: ThinkingMode;
	/** ユーザーメッセージのバッジ表示用。`auto` やスラッシュコマンドでは
	 *  undefined にしておく。 */
	effortLevel?: EffortLevel;
}

/**
 * runtime → view への通知を集約したインターフェース。view が実装し、
 * runtime コンストラクタに渡す。`onStreamingText` 等は DOM の高速
 * パッチ（textContent への直接 append）を担い、`onMessageRerender`
 * は 1 メッセージの完全再描画を意味する。
 */
export interface ChatRuntimeHost {
	/** メッセージ配列の構造的変化（追加・置換・clear）。全体再描画する。 */
	onMessagesChanged(): void;
	/** 単一メッセージの内容更新（permission 状態変化、結果確定など）。 */
	onMessageRerender(msg: ChatMessage): void;
	/** ストリーミング中のテキストチャンク追加。DOM 高速パッチ向け。 */
	onStreamingText(msg: ChatMessage, chunk: string): void;
	/** ストリーミング中のツール実行追加。DOM 高速パッチ向け。 */
	onStreamingTool(msg: ChatMessage, name: string, input: unknown): void;
	/** busy 状態が変化した（送信ボタン UI 切り替え用）。 */
	onBusyChanged(busy: boolean): void;
	/** 累計トークン使用量が更新（コンテキストメーター駆動）。 */
	onUsageChanged(usage: MessageUsage | null): void;
	/** 1 ターン完了。`canceled` のときは通知音をスキップする想定。 */
	onRunComplete(canceled: boolean): void;
	/** 送信ボタン押下のユーザージェスチャ中に呼ばれ、AudioContext を
	 *  早期 resume させる（Chromium autoplay policy 対策）。 */
	onWarmup(): void;
	/** プロンプト履歴ナビ（textarea 内 Up/Down）の位置をリセット。 */
	onResetInputHistory(): void;
}

export class ChatRuntime {
	private messages: ChatMessage[] = [];
	private currentRun: RunHandle | null = null;
	private currentSessionId: string | null = null;
	// `/resume` で立つフラグ。次の send() で `--continue` を 1 回だけ
	// 渡し、CLI 側の cwd 直近セッションを拾い上げる。消費で false に戻る。
	private pendingContinue = false;
	private pendingPermDecisions = new Map<
		string,
		(d: PermissionDecision) => void
	>();
	private lastUsage: MessageUsage | null = null;
	private busy = false;
	// 現在ストリーミング書き込み先のアシスタントメッセージ ID。`send()` で
	// 開始時にセットし、`inject()` で割り込み時に新メッセージへ差し替える。
	// onText / onToolUse / onResult のコールバックはこのフィールドを毎回参照する
	// ことで、interrupt 後も古いメッセージへ書き続けないようにする。
	private activeAssistantId: string | null = null;
	// inject() の再入を防ぐロック。実際に inject() が CLI に書き込み
	// 終わる (= 新メッセージを push 済み) までを保護する。連続クリックや
	// 自動再送で interrupt が二重に走ると、最初に push された
	// アシスタントメッセージが新ターンの onText を受け取れず孤立する。
	private injecting = false;

	constructor(
		private readonly plugin: ClaudePanelPlugin,
		private readonly host: ChatRuntimeHost
	) {}

	// ------------------------------------------------------------------
	//   読み取り専用アクセサ（view から状態を引きたいときの窓口）
	// ------------------------------------------------------------------

	getMessages(): readonly ChatMessage[] {
		return this.messages;
	}

	isBusy(): boolean {
		return this.busy;
	}

	isCurrentRunActive(): boolean {
		return !!this.currentRun && !this.currentRun.canceled();
	}

	getLastUsage(): MessageUsage | null {
		return this.lastUsage;
	}

	/** PromptHistory に渡す履歴ソース。messages から user 入力だけを抽出する。 */
	getInputHistory(): string[] {
		const out: string[] = [];
		for (const m of this.messages) {
			if (m.role === "user" && typeof m.inputText === "string") {
				out.push(m.inputText);
			}
		}
		return out;
	}

	// ------------------------------------------------------------------
	//   会話操作
	// ------------------------------------------------------------------

	/**
	 * `/continue` から呼ばれる。指定 cwd に対応する Claude CLI の直近セッション
	 * ファイル（`~/.claude/projects/<encoded-cwd>/<session>.jsonl`）を読み出し、
	 * UI のチャット履歴を復元する。あわせて次回 send() 時に `--continue` を
	 * 1 回だけ付与し、CLI 側の会話コンテキストも続きから再開させる。
	 *
	 * 戻り値: 復元したメッセージ件数。0 件のとき（セッションファイルが
	 * 無いか有効メッセージが取れなかった）はフラグを立てず false ぽい挙動。
	 */
	restoreFromLatestSession(cwd: string): number {
		const restored = loadLatestSessionMessages(cwd);
		if (!restored) return 0;
		this.flushPendingPermissions(t("chatRuntime.conversationRestored"));
		this.messages = restored;
		this.currentSessionId = null;
		this.pendingContinue = true;
		this.host.onMessagesChanged();
		return restored.length;
	}

	/**
	 * 1 ターンを送信する。view の composeMessage で組み立てたメタデータと
	 * cwd を受け取り、ユーザー／アシスタントメッセージの追加→ runAgent
	 * 起動→ストリーミング→ resume 失敗時の 1 度だけのリトライ→完了通知
	 * までを担う。busy 中の二重送信は無視する。
	 */
	async send(
		userText: string,
		composed: ComposedMessage,
		cwd: string
	): Promise<void> {
		if (this.busy) return;
		if (!userText) return;

		// Chromium の autoplay policy はユーザージェスチャの最中に
		// AudioContext を resume することを要求する。応答完了は別フレーム
		// で起きるため、送信ボタン押下と同期したこの瞬間に host へ通知し、
		// 内部の AudioContext を起こしてもらう。
		this.host.onWarmup();

		this.messages.push(
			{
				id: nextMsgId(),
				role: "user",
				mentions: composed.mentions.length ? composed.mentions : undefined,
				selectionRef: composed.selectionRef,
				parts: [{ type: "text", text: composed.body }],
				inputText: userText,
				thinkingMode:
					composed.thinkingMode !== "off"
						? composed.thinkingMode
						: undefined,
				effortLevel: composed.effortLevel,
			},
			{
				id: nextMsgId(),
				role: "assistant",
				parts: [],
				streaming: true,
			}
		);
		this.host.onResetInputHistory();
		const assistantMsgId = this.messages[this.messages.length - 1].id;
		this.activeAssistantId = assistantMsgId;
		this.host.onMessagesChanged();

		this.setBusy(true);

		const runOnce = async (
			sessionId: string | undefined,
			continueLast: boolean
		): Promise<{ canceled: boolean; errorMessage: string }> => {
			let errorMessage = "";
			// onUsage は 1 回の CLI 実行中に複数回（assistant チャンクごと
			// + 最終 result）来る。最後の値が cumulative なので、ここに
			// 退避し、runOnce 完了時に 1 回だけ永続履歴へ記録する。
			let lastRunUsage: MessageUsage | null = null;
			const handle = runAgent(
				{
					prompt: composed.fullPrompt,
					cwd,
					settings: this.plugin.settings,
					sessionId,
					continueLast,
				},
				{
					onText: (chunk) =>
						this.appendStreamingText(
							this.activeAssistantId ?? assistantMsgId,
							chunk
						),
					onToolUse: (name, input) =>
						this.appendStreamingTool(
							this.activeAssistantId ?? assistantMsgId,
							name,
							input
						),
					onPermissionRequest: (req, decide) =>
						this.appendPermissionRequest(
							this.activeAssistantId ?? assistantMsgId,
							req,
							decide
						),
					onResult: ({ durationMs, costUsd, sessionId: newSession }) => {
						this.setMessageResult(
							this.activeAssistantId ?? assistantMsgId,
							{
								durationMs,
								costUsd,
							}
						);
						if (newSession) this.currentSessionId = newSession;
					},
					onUsage: (usage) => {
						const targetId = this.activeAssistantId ?? assistantMsgId;
						const msg = this.findMessage(targetId);
						if (msg) msg.usage = usage;
						this.lastUsage = usage;
						lastRunUsage = usage;
						this.host.onUsageChanged(this.lastUsage);
					},
					onRateLimit: (info) => {
						// Claude が API 応答ヘッダから抽出した最新の rate limit。
						// 追加 API コール無しで取れる新鮮値なので、即時にキャッシュ
						// 反映してステータスバーを更新させる。
						this.plugin.applyRateLimitEvent(info);
					},
					onError: (err) => {
						errorMessage = err.message;
						this.appendStreamingText(
							this.activeAssistantId ?? assistantMsgId,
							t("chatRuntime.errorPrefix", err.message)
						);
					},
				}
			);
			this.currentRun = handle;
			await handle.promise;
			const canceled = handle.canceled();
			if (canceled) {
				this.flushPendingPermissions(t("chatRuntime.runInterrupted"));
				this.appendStreamingText(
					this.activeAssistantId ?? assistantMsgId,
					t("chatRuntime.userInterruptedInline")
				);
			} else {
				// 自然終了。残った pending（通常は発生しないがフェイルセーフ）
				// はもう古いので、ここでまとめて Deny で flush しておく。
				this.flushPendingPermissions(t("chatRuntime.runFinished"));
			}
			// 永続履歴（今日/7日/今月）への記録は runOnce 単位で 1 回だけ。
			// 中断時もそれまでに消費したトークンはアカウントに乗っているので
			// 記録する（記録漏れより、二重カウントしないことのほうが大事）。
			if (lastRunUsage) {
				this.plugin.recordUsage(lastRunUsage);
			}
			this.currentRun = null;
			return { canceled, errorMessage };
		};

		// `--continue` は session ID と排他。pendingContinue を消費するのは
		// 実際に CLI を起動するこの瞬間。runOnce 後にエラーで再試行する
		// ケースでも誤って 2 回 --continue を渡さないよう先に読み出す。
		const useContinue = this.pendingContinue;
		this.pendingContinue = false;

		const first = await runOnce(
			this.currentSessionId ?? undefined,
			useContinue
		);
		let canceled = first.canceled;

		// CLI 側でセッションが失われることがある（クリーンアップ、期限切れ、
		// ~/.claude/sessions の手動編集など）。--resume が存在しない
		// セッションを指したときの唯一の復旧策はリセットしてやり直すこと。
		// 保存していたセッション ID を破棄し、--resume なしで1度だけ再実行
		// することで、ユーザーが手動でリトライしなくても済むようにする。
		if (
			!first.canceled &&
			this.currentSessionId &&
			/No conversation found with session ID/i.test(first.errorMessage)
		) {
			this.currentSessionId = null;
			const msg = this.findMessage(assistantMsgId);
			if (msg) {
				// resume 失敗のエラーメッセージを消去する。これがないと
				// リトライの出力が古い赤バナーの下に描画されてしまう。
				msg.parts = [];
				msg.streaming = true;
				msg.result = undefined;
				msg.usage = undefined;
				this.host.onMessageRerender(msg);
			}
			const retry = await runOnce(undefined, false);
			canceled = retry.canceled;
		}

		this.finalizeStreamingMessage(this.activeAssistantId ?? assistantMsgId);
		this.activeAssistantId = null;
		this.setBusy(false);
		this.host.onRunComplete(canceled);
	}

	/**
	 * 進行中のターンに割り込み、新しいユーザーメッセージを即送信する。
	 * 進行中のアシスタントメッセージは `interrupted = true` でマークされ、
	 * 部分応答はそのまま履歴に残る。新ユーザー / 新アシスタントメッセージを
	 * 追加して、CLI 側の続きの assistant ストリーミングを新メッセージへ流す
	 * (`activeAssistantId` 経由)。失敗時 (run なし／stdin 閉鎖済み等) は
	 * 通常の `send()` にフォールバックする。
	 */
	async inject(
		userText: string,
		composed: ComposedMessage,
		cwd: string
	): Promise<void> {
		if (this.injecting) return;
		this.injecting = true;
		try {
			const run = this.currentRun;
			if (!this.busy || !run || run.canceled()) {
				// 何らかの理由で busy でない (race condition 含む) — 通常送信。
				return this.send(userText, composed, cwd);
			}
			if (!userText) return;

			this.host.onWarmup();

			const ok = run.inject(composed.fullPrompt);
			if (!ok) {
				// CLI subprocess が既に死んでいる／stdin 閉鎖。現在の run の
				// 自然終了を待ってから (busy が false に戻る) 新規 send() で
				// やり直す。await しないと send() が busy 早期 return で
				// ユーザー入力をサイレントに捨ててしまう。
				await run.promise;
				return this.send(userText, composed, cwd);
			}

			// 中断 + 新ターン継続が CLI 側に受理された。ここから先は UI 状態の
			// 反映: 進行中アシスタントメッセージに interrupted フラグを立て、
			// pending permission を flush し、新しい user / assistant ペアを push する。
			this.flushPendingPermissions(t("chatRuntime.runInterrupted"));
			const interruptedAssistant = this.findStreamingAssistant();
			if (interruptedAssistant) {
				interruptedAssistant.interrupted = true;
				interruptedAssistant.streaming = false;
				this.host.onMessageRerender(interruptedAssistant);
			}

			// 新しい user / assistant メッセージを履歴に積み、後続のストリーミング
			// イベント (onText 等) を新 assistant メッセージへ流す。runAgent 側の
			// イベントコールバックは this.activeAssistantId を毎回参照するように
			// 書き換えてあるので、ここでの差し替えだけで自然に新メッセージへ
			// ルーティングされる。
			const newAssistantId = nextMsgId();
			this.messages.push(
				{
					id: nextMsgId(),
					role: "user",
					mentions: composed.mentions.length ? composed.mentions : undefined,
					selectionRef: composed.selectionRef,
					parts: [{ type: "text", text: composed.body }],
					inputText: userText,
					thinkingMode:
						composed.thinkingMode !== "off"
							? composed.thinkingMode
							: undefined,
					effortLevel: composed.effortLevel,
				},
				{
					id: newAssistantId,
					role: "assistant",
					parts: [],
					streaming: true,
				}
			);
			this.host.onResetInputHistory();
			this.host.onMessagesChanged();
			this.activeAssistantId = newAssistantId;
		} finally {
			this.injecting = false;
		}
	}

	cancel(): void {
		if (this.currentRun && !this.currentRun.canceled()) {
			this.currentRun.cancel();
		}
	}

	clear(): void {
		// セッション ID も lastUsage も破棄して、次のターンは完全に新しい
		// claude セッション（コンテキストメーターも 0 から）で開始する。
		this.flushPendingPermissions(t("chatRuntime.conversationCleared"));
		this.messages = [];
		this.currentSessionId = null;
		this.pendingContinue = false;
		this.lastUsage = null;
		this.host.onMessagesChanged();
		this.host.onUsageChanged(null);
	}

	/**
	 * パーミッションカードの Allow/Deny クリックを処理する。決定を agent 層に
	 * 転送し、part を終了状態に更新したうえで該当メッセージを再描画する
	 * （ボタンがステータスバッジに置き換わる）。
	 */
	applyPermissionDecision(
		toolUseId: string,
		decision: PermissionDecision
	): void {
		const decide = this.pendingPermDecisions.get(toolUseId);
		if (!decide) return;
		this.pendingPermDecisions.delete(toolUseId);
		decide(decision);
		const msg = this.findMessageWithPermission(toolUseId);
		if (!msg) return;
		setPermissionStatus(
			msg.parts,
			toolUseId,
			decision.allow ? "approved" : "denied"
		);
		this.host.onMessageRerender(msg);
	}

	appendSystemMessage(text: string): void {
		this.messages.push({
			id: nextMsgId(),
			role: "system",
			parts: [{ type: "text", text }],
		});
		this.host.onMessagesChanged();
	}

	appendInteractiveSystemMessage(
		render: (container: HTMLElement) => void
	): void {
		this.messages.push({
			id: nextMsgId(),
			role: "system",
			parts: [],
			interactive: render,
		});
		this.host.onMessagesChanged();
	}

	// ------------------------------------------------------------------
	//   内部状態遷移（send() のコールバック契約から呼ばれる）
	// ------------------------------------------------------------------

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.host.onBusyChanged(busy);
	}

	private appendStreamingText(msgId: string, chunk: string): void {
		const msg = this.findMessage(msgId);
		if (!msg) return;
		appendTextToParts(msg.parts, chunk);
		this.host.onStreamingText(msg, chunk);
	}

	private appendStreamingTool(
		msgId: string,
		name: string,
		input: unknown
	): void {
		const msg = this.findMessage(msgId);
		if (!msg) return;
		pushToolToParts(msg.parts, name, input);
		this.host.onStreamingTool(msg, name, input);
	}

	/**
	 * ストリーミング中のアシスタントメッセージにインラインの承認カードを
	 * 追加し、agent から渡された resolver を登録する。Allow / Deny クリック
	 * は `applyPermissionDecision()` 経由で resolver を呼び、CLI に
	 * control_response を返す。
	 */
	private appendPermissionRequest(
		msgId: string,
		req: PermissionRequest,
		decide: (d: PermissionDecision) => void
	): void {
		const msg = this.findMessage(msgId);
		if (!msg) {
			// 通常起こらないが、CLI をハングさせないよう fail-closed で拒否しておく。
			decide({
				allow: false,
				message: t("chatRuntime.noActiveMessage"),
			});
			return;
		}
		this.pendingPermDecisions.set(req.toolUseId, decide);
		pushPermissionToParts(
			msg.parts,
			req.toolName,
			req.input,
			req.toolUseId,
			req.reason
		);
		this.host.onMessageRerender(msg);
	}

	/**
	 * ラン結果を保存する。フッターの実描画は finalizeStreamingMessage
	 * 側で1度だけ行う（メッセージ全体のコンテキストが必要なため）。
	 */
	private setMessageResult(msgId: string, result: RunResult): void {
		const msg = this.findMessage(msgId);
		if (!msg) return;
		msg.result = result;
	}

	private finalizeStreamingMessage(msgId: string): void {
		const msg = this.findMessage(msgId);
		if (!msg) return;
		msg.streaming = false;
		this.host.onMessageRerender(msg);
	}

	/** 未解決のパーミッションカードをすべてキャンセルする。CLI に
	 *  Deny+interrupt を送り、UI 上のステータスを "denied" に更新する。
	 *  cancel 処理および /clear から呼ばれる。 */
	private flushPendingPermissions(reason = t("chatRuntime.interruptedDefault")): void {
		for (const [toolUseId, decide] of this.pendingPermDecisions) {
			decide({ allow: false, message: reason, interrupt: true });
			const msg = this.findMessageWithPermission(toolUseId);
			if (msg) {
				setPermissionStatus(msg.parts, toolUseId, "denied");
				this.host.onMessageRerender(msg);
			}
		}
		this.pendingPermDecisions.clear();
	}

	private findMessage(msgId: string): ChatMessage | null {
		return this.messages.find((m) => m.id === msgId) ?? null;
	}

	private findStreamingAssistant(): ChatMessage | null {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role === "assistant" && m.streaming) return m;
		}
		return null;
	}

	private findMessageWithPermission(toolUseId: string): ChatMessage | null {
		for (const m of this.messages) {
			for (const p of m.parts) {
				if (p.type === "permission" && p.toolUseId === toolUseId) {
					return m;
				}
			}
		}
		return null;
	}
}
