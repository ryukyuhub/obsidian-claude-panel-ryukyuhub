# ターン中プロンプト割り込み — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アシスタント応答中にユーザーが新プロンプトを送信できる「割り込み (interrupt + 即送信)」機能を追加する。

**Architecture:** `claude --input-format stream-json` の同一 stdin に `control_request { subtype: "interrupt" }` を書き、続けて新しい `user` メッセージを書く。CLI は同一プロセス・同一セッション ID のまま次ターンを生成する。既存の「次ターンキュー」UI / ロジックは削除する。

**Tech Stack:** TypeScript (strict null checks)、Obsidian Plugin API、esbuild。Spec: [docs/superpowers/specs/2026-05-26-midturn-prompt-injection-design.md](../specs/2026-05-26-midturn-prompt-injection-design.md)。

**Verification:** プロジェクトにテストスイートが存在しないため、各タスクの検証は (1) `npx tsc --noEmit` で型エラーなし、(2) `npm run build` で esbuild が成功、(3) 最終タスクで Obsidian での手動 QA を行う。

---

## File Structure

変更対象:

| ファイル | 責務 | 変更種別 |
|---|---|---|
| [src/agent.ts](../../src/agent.ts) | CLI サブプロセスレイヤー。stream-json プロトコル。 | `RunHandle.inject()` 追加、stdin 閉鎖を条件付きに |
| [src/chat-runtime.ts](../../src/chat-runtime.ts) | 会話エンジン。messages / busy / セッション管理。 | `inject()` メソッド追加、interrupted フラグ設定 |
| [src/chat-message.ts](../../src/chat-message.ts) | ChatMessage 型と part 操作。 | `interrupted?: boolean` フィールド追加 |
| [src/chat-message-render.ts](../../src/chat-message-render.ts) | メッセージ DOM 描画。 | role 行に「中断」バッジ描画 |
| [src/view.ts](../../src/view.ts) | サイドバー ItemView、コンポーザ、入力ハンドリング。 | queue UI / メソッド削除、send ボタンを interrupt に分岐 |
| [styles.css](../../../styles.css) | パネル全体のスタイル。 | `.claude-panel-queued-strip*` 削除、`.claude-panel-interrupted-badge` 追加 |
| [src/i18n/types.ts](../../src/i18n/types.ts) | i18n キーの TypeScript 型定義。 | queue 系キー削除、interrupt 系キー追加 |
| [src/i18n/ja.ts](../../src/i18n/ja.ts) | 日本語ロケール。 | 同上 |
| [src/i18n/en.ts](../../src/i18n/en.ts) | 英語ロケール。 | 同上 |

---

## Task 1: i18n キーの整理 (queue → interrupt)

**Files:**
- Modify: [src/i18n/types.ts](../../src/i18n/types.ts)
- Modify: [src/i18n/ja.ts](../../src/i18n/ja.ts)
- Modify: [src/i18n/en.ts](../../src/i18n/en.ts)

このタスクから始めるのは、後段で他ファイルが参照する型キーを先に確定させたいため。先に型定義を更新するとコンパイルエラーで漏れを検出できる。

- [ ] **Step 1: 既存キーと使用箇所を確認**

Run:
```bash
grep -rn "queueBtn\|queuedNotice\|queuedLabel\|queuedCancelAria" src/
```

期待出力: `i18n/types.ts`, `i18n/ja.ts`, `i18n/en.ts`, `view.ts` のみが該当する (それ以外で参照されていれば想定外なので調査)。

- [ ] **Step 2: types.ts のキー定義を更新**

[src/i18n/types.ts](../../src/i18n/types.ts) の `view` セクションを開き、以下の差し替えを行う:

削除する型:
```ts
queueBtn: string;
queuedNotice: string;
queuedLabel: (preview: string) => string;
queuedCancelAria: string;
```

追加する型:
```ts
interruptBtn: string;
interruptedNotice: string;
```

また [src/i18n/types.ts](../../src/i18n/types.ts) の `chat` セクションに次を追加:

```ts
interruptedBadge: string;
```

- [ ] **Step 3: ja.ts を types.ts に合わせて更新**

[src/i18n/ja.ts](../../src/i18n/ja.ts) の `view` セクションで:

削除:
```ts
queueBtn: "次のターンへ",
queuedNotice: "次のターンとしてキューに登録しました",
queuedLabel: (preview: string) => `次のターン: ${preview}`,
queuedCancelAria: "キューを取り消す",
```

追加:
```ts
interruptBtn: "割り込み",
interruptedNotice: "割り込み送信しました",
```

`chat` セクションに追加:
```ts
interruptedBadge: "中断",
```

- [ ] **Step 4: en.ts を types.ts に合わせて更新**

[src/i18n/en.ts](../../src/i18n/en.ts) の `view` セクションで:

削除:
```ts
queueBtn: "Queue next",
queuedNotice: "Queued for the next turn",
queuedLabel: (preview: string) => `Next: ${preview}`,
queuedCancelAria: "Cancel queued message",
```

追加:
```ts
interruptBtn: "Interrupt",
interruptedNotice: "Interrupt sent",
```

`chat` セクションに追加:
```ts
interruptedBadge: "Interrupted",
```

- [ ] **Step 5: 型チェック**

Run: `npx tsc --noEmit`

期待出力: `view.ts` 内の旧キー参照 (`view.queueBtn`, `view.queuedNotice`, `view.queuedLabel`, `view.queuedCancelAria`) で型エラーが複数発生する。これは Task 5 で view.ts を直すまで残るので、ここでは「想定エラー以外が出ていないこと」だけ確認する。

想定エラー以外があれば修正してから次に進む。

- [ ] **Step 6: コミット**

```bash
git add src/i18n/
git commit -m "i18n: queue 系キーを interrupt 系へ置き換え"
```

---

## Task 2: ChatMessage に `interrupted` フィールドを追加

**Files:**
- Modify: [src/chat-message.ts](../../src/chat-message.ts)

- [ ] **Step 1: 型定義に追加**

[src/chat-message.ts](../../src/chat-message.ts) の `ChatMessage` interface (52 行目付近) で、`usage?: MessageUsage;` の直前に以下を追加:

```ts
	// アシスタントメッセージ専用: ユーザーが割り込みで中断したターン。
	// 部分応答はそのまま残し、role 行の横に「中断」バッジを出すための
	// 描画用フラグ。`runtime.inject()` 発火時に true がセットされる。
	interrupted?: boolean;
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`

期待: view.ts の旧 queue キーエラー以外は新たに発生しない。

- [ ] **Step 3: コミット**

```bash
git add src/chat-message.ts
git commit -m "chat-message: アシスタントメッセージに interrupted フラグ追加"
```

---

## Task 3: agent.ts に `RunHandle.inject()` を追加

**Files:**
- Modify: [src/agent.ts](../../src/agent.ts)

このタスクは設計の中核。CLI の stream-json プロトコルに interrupt control_request と新しい user メッセージを送る。

- [ ] **Step 1: RunHandle 型に inject を追加**

[src/agent.ts](../../src/agent.ts) の `RunHandle` interface (295 行目付近) を以下に変更:

```ts
export interface RunHandle {
	promise: Promise<void>;
	cancel: () => void;
	canceled: () => boolean;
	/** 進行中の生成を中断し、続けて新しいユーザーメッセージを同じ stdin に
	 *  書き込む。CLI は同一セッションでそのまま次ターンを生成する。stdin
	 *  が既に閉じられている／canceled の場合は no-op で false を返す。 */
	inject: (prompt: string) => boolean;
}
```

- [ ] **Step 2: interruptInFlight ステートと eventsWithEnd の修正**

[src/agent.ts](../../src/agent.ts) の `runAgent` 関数内で、ステート変数を追加し、`eventsWithEnd` の `onResult` を書き換える。場所は 686 行目付近の `eventsWithEnd` 定義部分。

旧:
```ts
const eventsWithEnd: AgentEvents = {
	...events,
	onResult: (info) => {
		events.onResult(info);
		try {
			childRef.stdin?.end();
		} catch {
			/* noop */
		}
	},
};
```

新:
```ts
// 割り込み (inject) 進行中フラグ。interrupt control_request を送った
// 直後に CLI が返してくる "中断された result" イベントでは stdin を閉じない
// — 続けて新ユーザーメッセージを書き込むため。新メッセージが書かれたら
// false に戻り、その新ターンの完了 result で通常通り stdin を閉じる。
let interruptInFlight = false;
const eventsWithEnd: AgentEvents = {
	...events,
	onResult: (info) => {
		events.onResult(info);
		if (interruptInFlight) {
			// 中断 result — stdin は開けたまま、新ユーザーメッセージの到着を待つ。
			return;
		}
		try {
			childRef.stdin?.end();
		} catch {
			/* noop */
		}
	},
};
```

- [ ] **Step 3: inject 関数を定義し RunHandle に同梱して return**

[src/agent.ts](../../src/agent.ts) の `runAgent` 末尾 `return { promise, cancel, canceled: () => canceled };` (773 行目付近) を以下に置き換える:

```ts
	const inject = (newPrompt: string): boolean => {
		if (canceled) return false;
		if (!child || child.killed) return false;
		const stdin = child.stdin;
		if (!stdin || stdin.writableEnded) return false;
		// 1) 進行中生成を中断する control_request。
		interruptInFlight = true;
		try {
			stdin.write(
				JSON.stringify({
					type: "control_request",
					request_id: randomRequestId(),
					request: { subtype: "interrupt" },
				}) + "\n"
			);
		} catch {
			interruptInFlight = false;
			return false;
		}
		// 2) 新しい user メッセージ。CLI は同一セッション ID で次ターンを生成する。
		try {
			stdin.write(
				JSON.stringify({
					type: "user",
					session_id: "",
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [{ type: "text", text: newPrompt }],
					},
				}) + "\n"
			);
		} catch {
			interruptInFlight = false;
			return false;
		}
		// 新ターン開始 — 次の result イベントは通常終了として stdin を閉じてよい。
		interruptInFlight = false;
		return true;
	};

	return { promise, cancel, canceled: () => canceled, inject };
```

実装メモ: `interruptInFlight` を true → false に閉じるタイミングは「新 user メッセージを書き終えた瞬間」。これにより interrupt 直後に来る `result { subtype: "interrupted" }` ではフラグが立っていて stdin を閉じないが、それ以降の result (新ターンの完了) では false なので通常通り閉じる。

注意: `child` は `let` 変数。スコープを跨いで参照されるが、`spawn` 後に必ず代入されるためここでは null チェックで早期 return している。

- [ ] **Step 4: 型チェック + ビルド**

Run:
```bash
npx tsc --noEmit && npm run build
```

期待: agent.ts に関する型エラーは出ない。view.ts の旧 queue キーエラーは残存。`npm run build` は成功する (esbuild は型を見ない)。

- [ ] **Step 5: コミット**

```bash
git add src/agent.ts
git commit -m "agent: RunHandle.inject で割り込み + 新メッセージ送信"
```

---

## Task 4: ChatRuntime に `inject()` を追加

**Files:**
- Modify: [src/chat-runtime.ts](../../src/chat-runtime.ts)

- [ ] **Step 1: inject メソッドを追加**

[src/chat-runtime.ts](../../src/chat-runtime.ts) の `cancel()` メソッド (332 行目付近) の直前に以下を追加:

```ts
	/**
	 * 進行中のターンに割り込み、新しいユーザーメッセージを即送信する。
	 * 進行中のアシスタントメッセージは `interrupted = true` でマークされ、
	 * 部分応答はそのまま履歴に残る。新ユーザーメッセージ + 新アシスタント
	 * メッセージを追加して、CLI 側の続きの assistant ストリーミングを
	 * その新メッセージへ流す。失敗時 (run なし／stdin 閉鎖済み等) は
	 * 通常の `send()` にフォールバックする。
	 */
	async inject(
		userText: string,
		composed: ComposedMessage,
		cwd: string
	): Promise<void> {
		const run = this.currentRun;
		if (!this.busy || !run || run.canceled()) {
			// 何らかの理由で busy でない (race condition 含む) — 通常送信。
			return this.send(userText, composed, cwd);
		}
		if (!userText) return;

		this.host.onWarmup();

		// 進行中アシスタントメッセージに interrupted フラグを立て、再描画で
		// 「中断」バッジを出す。pending permission も deny + interrupt で flush
		// する (run の cancel 経路と同じ扱い)。
		this.flushPendingPermissions(t("chatRuntime.runInterrupted"));
		const interruptedAssistant = this.findStreamingAssistant();
		if (interruptedAssistant) {
			interruptedAssistant.interrupted = true;
			interruptedAssistant.streaming = false;
			this.host.onMessageRerender(interruptedAssistant);
		}

		// CLI に interrupt + 新 user メッセージを送る。失敗時は subprocess が
		// 死んでいる等の状況なので、通常の send() で新規 run を開始する。
		const ok = run.inject(composed.fullPrompt);
		if (!ok) {
			return this.send(userText, composed, cwd);
		}

		// 新しい user / assistant メッセージを履歴に積み、後続のストリーミング
		// イベント (`onText` 等) を新 assistant メッセージへ流す。runAgent 側の
		// イベントコールバックは「現在の assistant msgId」を closure で握って
		// いるため、新メッセージ向けにコールバックを差し替える必要がある。
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
	}
```

- [ ] **Step 2: activeAssistantId フィールドと send() の onText/onTool/onResult ターゲット切り替えを実装**

`inject()` だけだと、runAgent 起動時に closure で握られた `assistantMsgId` のままで、新しい part が古いメッセージに append されてしまう。これを `this.activeAssistantId` というインスタンスフィールド経由で動的解決にする。

[src/chat-runtime.ts](../../src/chat-runtime.ts) のクラスフィールド定義 (88-100 行目付近) に追加:

```ts
	// 現在ストリーミング書き込み先のアシスタントメッセージ ID。`send()` で
	// 開始時にセットし、`inject()` で割り込み時に新メッセージへ差し替える。
	// onText/onToolUse/onResult のコールバックはこのフィールドを毎回参照する
	// ことで、interrupt 後も古いメッセージへ書き続けないようにする。
	private activeAssistantId: string | null = null;
```

`send()` メソッド内 (168 行目以降) の以下の部分:

```ts
		const assistantMsgId = this.messages[this.messages.length - 1].id;
		this.host.onMessagesChanged();
```

を:

```ts
		const assistantMsgId = this.messages[this.messages.length - 1].id;
		this.activeAssistantId = assistantMsgId;
		this.host.onMessagesChanged();
```

に変更する。

さらに、`runOnce` 内のコールバック群で `assistantMsgId` を直参照している箇所を `this.activeAssistantId ?? assistantMsgId` に置き換える。具体的には:

```ts
				onText: (chunk) =>
					this.appendStreamingText(assistantMsgId, chunk),
				onToolUse: (name, input) =>
					this.appendStreamingTool(assistantMsgId, name, input),
				onPermissionRequest: (req, decide) =>
					this.appendPermissionRequest(
						assistantMsgId,
						req,
						decide
					),
				onResult: ({ durationMs, costUsd, sessionId: newSession }) => {
					this.setMessageResult(assistantMsgId, {
						durationMs,
						costUsd,
					});
					if (newSession) this.currentSessionId = newSession;
				},
				onUsage: (usage) => {
					const msg = this.findMessage(assistantMsgId);
					if (msg) msg.usage = usage;
					...
```

を以下に変更:

```ts
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
					...
```

そして `send()` の末尾、`finalizeStreamingMessage(assistantMsgId);` の手前で activeAssistantId のクリア:

```ts
		this.finalizeStreamingMessage(this.activeAssistantId ?? assistantMsgId);
		this.activeAssistantId = null;
		this.setBusy(false);
		this.host.onRunComplete(canceled);
```

実装メモ: 「resume 失敗時のリトライ」分岐で `findMessage(assistantMsgId)` を直接呼んでいるところ (313 行目付近) は、リトライは interrupt が走る前 (busy=true の初期段階) でしか起きないので `assistantMsgId` のままで OK。

- [ ] **Step 3: findStreamingAssistant ヘルパを追加**

[src/chat-runtime.ts](../../src/chat-runtime.ts) のクラス末尾の private ヘルパ群 (`findMessage` の隣) に追加:

```ts
	private findStreamingAssistant(): ChatMessage | null {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role === "assistant" && m.streaming) return m;
		}
		return null;
	}
```

- [ ] **Step 4: 型チェック + ビルド**

Run:
```bash
npx tsc --noEmit && npm run build
```

期待: chat-runtime.ts に関する型エラーは出ない。view.ts の旧キーエラーは Task 5 まで残る。

- [ ] **Step 5: コミット**

```bash
git add src/chat-runtime.ts
git commit -m "chat-runtime: inject() で割り込み + 新ターン継続"
```

---

## Task 5: View の queue UI 削除と割り込みボタン化

**Files:**
- Modify: [src/view.ts](../../src/view.ts)

このタスクで全 i18n キーエラーが解消する。

- [ ] **Step 1: queue 系フィールドを削除**

[src/view.ts](../../src/view.ts) のクラスフィールド定義 (82-91 行目) で以下を削除:

```ts
	// ターン実行中にユーザーが追加プロンプトを送信したときの「次のターン」
	// 用キュー。現ターン完了時の onBusyChanged で発火する。スロット数は 1。
	// 二度目の送信は上書き。Stop ボタン／× ボタン／ESC で破棄される。
	private queuedTurn: {
		text: string;
		composed: ComposedMessage;
		cwd: string;
	} | null = null;
	private queuedStrip!: HTMLElement;
	private queuedTextEl!: HTMLElement;
```

- [ ] **Step 2: renderComposer から queue UI を削除**

[src/view.ts](../../src/view.ts) の `renderComposer` 内 (404-417 行目付近) の以下のブロックを削除:

```ts
		// キュー登録された次ターンの表示行。busy 中に送信したプロンプトを
		// 1 件だけ保持し、× で取り消せる。未登録時は is-hidden で消す。
		this.queuedStrip = composer.createDiv({
			cls: "claude-panel-queued-strip is-hidden",
		});
		this.queuedTextEl = this.queuedStrip.createSpan({
			cls: "claude-panel-queued-text",
		});
		const queuedCancelBtn = this.queuedStrip.createEl("button", {
			cls: "claude-panel-queued-cancel clickable-icon",
		});
		setIcon(queuedCancelBtn, "x");
		queuedCancelBtn.setAttr("aria-label", t("view.queuedCancelAria"));
		queuedCancelBtn.onclick = () => this.cancelQueue();
```

合わせて、もし `setIcon` の import がこの後不要になるなら除去するが、他の場所でも使われている可能性があるので Step 7 でビルドエラーが出てから対応。

- [ ] **Step 3: cancelQueue と refreshQueuedStrip メソッドを削除**

[src/view.ts](../../src/view.ts) の以下のメソッドを丸ごと削除:

- `refreshQueuedStrip()` (848 行目付近、`if (!this.queuedStrip || !this.queuedTextEl) return;` から始まるメソッド)
- `cancelQueue()` (860 行目付近)

- [ ] **Step 4: onBusyChanged からキュー自動発火を削除**

[src/view.ts](../../src/view.ts) の `onBusyChanged` (808 行目付近) を以下に簡略化:

```ts
	/** busy 状態が変わったら送信ボタンの表示を更新する。 */
	onBusyChanged(busy: boolean): void {
		void busy;
		this.refreshSendBtn();
	}
```

- [ ] **Step 5: refreshSendBtn を interrupt ラベルに変更**

[src/view.ts](../../src/view.ts) の `refreshSendBtn` (829 行目付近) で:

```ts
		} else if (busy && hasText) {
			this.sendBtn.removeClass("mod-warning");
			this.sendBtn.addClass("mod-cta");
			this.sendBtn.setText(t("view.queueBtn"));
		} else {
```

を:

```ts
		} else if (busy && hasText) {
			this.sendBtn.removeClass("mod-warning");
			this.sendBtn.addClass("mod-cta");
			this.sendBtn.setText(t("view.interruptBtn"));
		} else {
```

に変更。

- [ ] **Step 6: send() を inject 分岐に書き換え**

[src/view.ts](../../src/view.ts) の `send()` (972 行目付近) の以下のブロック:

```ts
		// runtime に渡す（あるいはキューに積む）前に入力欄と添付をクリア
		// する（UI 即時フィードバック）。
		this.inputEl.value = "";
		this.composer.clearAttachments();

		if (busy) {
			this.queuedTurn = { text, composed, cwd };
			this.refreshQueuedStrip();
			this.refreshSendBtn();
			new Notice(t("view.queuedNotice"));
			return;
		}

		this.refreshSendBtn();
		await this.runtime.send(text, composed, cwd);
```

を以下に変更:

```ts
		// runtime に渡す前に入力欄と添付をクリアする (UI 即時フィードバック)。
		this.inputEl.value = "";
		this.composer.clearAttachments();
		this.refreshSendBtn();

		if (busy) {
			new Notice(t("view.interruptedNotice"));
			await this.runtime.inject(text, composed, cwd);
			return;
		}

		await this.runtime.send(text, composed, cwd);
```

- [ ] **Step 7: sendAskAnswer() を inject 分岐に書き換え**

[src/view.ts](../../src/view.ts) の `sendAskAnswer()` (943 行目付近) の以下のブロック:

```ts
		const composed = this.composer.composeMessage(text);
		if (this.runtime.isBusy()) {
			this.queuedTurn = { text, composed, cwd };
			this.refreshQueuedStrip();
			this.refreshSendBtn();
			new Notice(t("view.queuedNotice"));
			return;
		}
		void this.runtime.send(text, composed, cwd);
```

を以下に変更:

```ts
		const composed = this.composer.composeMessage(text);
		if (this.runtime.isBusy()) {
			new Notice(t("view.interruptedNotice"));
			void this.runtime.inject(text, composed, cwd);
			return;
		}
		void this.runtime.send(text, composed, cwd);
```

- [ ] **Step 8: ESC キーバインドの queue 参照を除去**

[src/view.ts](../../src/view.ts) の textarea keydown ハンドラ (447 行目付近):

```ts
				} else if (e.key === "Escape" && this.runtime.isBusy()) {
					e.preventDefault();
					this.cancelQueue();
					this.runtime.cancel();
				}
```

を以下に簡略化:

```ts
				} else if (e.key === "Escape" && this.runtime.isBusy()) {
					e.preventDefault();
					this.runtime.cancel();
				}
```

- [ ] **Step 9: send ボタンの click ハンドラの queue 参照を除去**

[src/view.ts](../../src/view.ts) の `this.sendBtn.onclick` (508 行目付近):

```ts
		this.sendBtn.onclick = () => {
			// textarea が空のときだけ「停止」として振る舞う。何か入力されて
			// いれば busy でも送信（→ キュー登録）する。Stop は実行中の
			// ターンとキューの両方を破棄する。
			if (this.runtime.isBusy() && !this.inputEl.value.trim()) {
				this.cancelQueue();
				this.runtime.cancel();
			} else {
				void this.send();
			}
		};
```

を以下に変更:

```ts
		this.sendBtn.onclick = () => {
			// textarea が空のときだけ「停止」として振る舞う。入力があれば
			// busy 中でも送信し、send() 側で割り込み (interrupt) として処理する。
			if (this.runtime.isBusy() && !this.inputEl.value.trim()) {
				this.runtime.cancel();
			} else {
				void this.send();
			}
		};
```

- [ ] **Step 10: ESC Scope ハンドラの queue 参照を確認**

[src/view.ts](../../src/view.ts) 内で `cancelQueue` が他に残っていないか確認。

Run:
```bash
grep -n "queuedTurn\|queuedStrip\|queuedTextEl\|cancelQueue\|refreshQueuedStrip" src/view.ts
```

期待: 出力なし。残っていたら削除して再 grep。

- [ ] **Step 11: 型チェック + ビルド**

Run:
```bash
npx tsc --noEmit && npm run build
```

期待: 全て成功。i18n の旧キーエラーも解消される。

- [ ] **Step 12: コミット**

```bash
git add src/view.ts
git commit -m "view: queue UI を削除し送信ボタンを割り込み動作に統一"
```

---

## Task 6: 中断バッジの DOM 描画

**Files:**
- Modify: [src/chat-message-render.ts](../../src/chat-message-render.ts)

- [ ] **Step 1: renderMessage で interrupted バッジを描画**

[src/chat-message-render.ts](../../src/chat-message-render.ts) の `renderMessage` 関数 (31 行目以降) で、role バッジ群 (`claude-panel-effort-badge` の追加直後、72 行目付近) の末尾に以下を追加:

```ts
	if (msg.role === "assistant" && msg.interrupted) {
		roleRow.createSpan({
			cls: "claude-panel-interrupted-badge",
			text: t("chat.interruptedBadge"),
			attr: { title: t("chat.interruptedBadge") },
		});
	}
```

これにより `[アシスタント] [中断]` のような並びになる (effort/thinking バッジはユーザー側専用なのでアシスタント側では並ばない)。

- [ ] **Step 2: ホスト要素にもクラスを付与**

renderMessage の冒頭 (43-45 行目):

```ts
	host.empty();
	host.addClass("claude-panel-msg");
	host.addClass(`claude-panel-msg-${msg.role}`);
	host.setAttr("data-msg-id", msg.id);
```

の直後に以下を追加:

```ts
	host.toggleClass("is-interrupted", !!msg.interrupted);
```

`toggleClass` は Obsidian の HTMLElement 拡張。第 2 引数 true で付与、false で削除する。再描画時に正しく状態同期される。

- [ ] **Step 3: 型チェック + ビルド**

Run:
```bash
npx tsc --noEmit && npm run build
```

期待: 全て成功。

- [ ] **Step 4: コミット**

```bash
git add src/chat-message-render.ts
git commit -m "chat-message-render: 中断バッジと is-interrupted クラスを描画"
```

---

## Task 7: スタイル更新 (queue 削除 + 中断バッジ)

**Files:**
- Modify: [styles.css](../../../styles.css)

- [ ] **Step 1: queued-strip 系スタイルを削除**

[styles.css](../../../styles.css) で `.claude-panel-queued-strip`, `.claude-panel-queued-text`, `.claude-panel-queued-cancel` のセレクタブロック (1965-1991 行目付近) を全て削除する。具体的には以下のセクションを除く:

```css
/* キュー登録された次ターンの 1 行表示。busy 中に追加プロンプトを
   送ると textarea が空になる代わりにここに preview が出る。× で
   キャンセル。 */
.claude-panel-queued-strip {
	...
}

.claude-panel-queued-strip.is-hidden {
	display: none;
}

.claude-panel-queued-text {
	...
}

.claude-panel-queued-cancel {
	...
}
```

- [ ] **Step 2: 中断バッジと is-interrupted スタイルを追加**

[styles.css](../../../styles.css) 内、`.claude-panel-effort-badge` の直後 (730 行目付近、`box-shadow: ...` 系の前) に以下を追加:

```css
/* 割り込みでユーザーが中断したアシスタントメッセージに付くバッジ。
   thinking/effort バッジと並ぶ位置で、形状は共通、色だけ neutral に
   して「これは状態表示で意味は中立 (失敗ではない)」と伝える。 */
.claude-panel-interrupted-badge {
	display: inline-flex;
	align-items: center;
	padding: 1px 7px;
	border-radius: 8px;
	font-size: 9px;
	font-weight: 700;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	white-space: nowrap;
	color: var(--text-muted);
	background: var(--background-modifier-hover);
	border: 1px solid var(--background-modifier-border);
}

/* 中断されたメッセージは本文をうっすら薄くして「途中で止まったもの」
   と分かるようにする。完全に消すと文脈が読めなくなるので opacity だけ。 */
.claude-panel-msg.is-interrupted {
	opacity: 0.85;
}
```

- [ ] **Step 3: ビルド**

Run: `npm run build`

期待: ビルド成功 (CSS は esbuild が型を見ないので問題は出ない)。

- [ ] **Step 4: コミット**

```bash
git add styles.css
git commit -m "styles: queue 系を削除し中断バッジを追加"
```

---

## Task 8: 手動 QA

**Files:** (修正なし — Obsidian での挙動確認のみ)

このプラグインはテストスイートがないため、機能の正しさはここでの手動 QA で担保する。

- [ ] **Step 1: ビルドと再読み込み**

Run: `npm run build`

その後 Obsidian を起動 (もしくは既に起動中なら設定 → コミュニティプラグイン → Candy Claudian をオフ→オン)。サイドバーパネルを開く。

- [ ] **Step 2: 基本送信フロー (回帰確認)**

1. プロンプト「現在時刻を教えて」を送信
2. アシスタントが応答開始 → 完了するまで待つ
3. 通常の `done in Xms · $Y` フッターが出ることを確認

期待: 既存挙動が変わらない。

- [ ] **Step 3: 中断割り込み (golden path)**

1. 長めのプロンプトを送信: 「README.md を 5 段落で要約して」
2. アシスタントが応答開始 → 数行流れた段階で textarea に「やっぱり 1 段落で」と入力
3. 「割り込み」ボタンを押す
4. 期待:
   - 進行中のアシスタントメッセージが途中で止まる
   - そのメッセージの役割行に「中断」バッジが出る
   - 直後に新しい user メッセージ「やっぱり 1 段落で」が追加され、新しい assistant メッセージで 1 段落の要約が始まる
5. 新ターン完了後、通常通り `done in Xms · $Y` が出ることを確認

- [ ] **Step 4: 連続割り込み**

1. 長めの応答中に「割り込みテスト 1」と入力 → 割り込み
2. その応答中にさらに「割り込みテスト 2」と入力 → 割り込み
3. 期待: エラーなく順次処理され、メッセージ履歴に user/assistant が交互に並ぶ。中断バッジが 2 メッセージに付く。

- [ ] **Step 5: Stop ボタン (回帰確認)**

1. 応答中、textarea を空にして送信ボタン (「停止」ラベル) を押す
2. 期待: subprocess が終了し、進行中メッセージは現状の `userInterruptedInline` を末尾に表示する (中断バッジは付かない — これは割り込みではなく完全停止のため)

- [ ] **Step 6: Permission 中の割り込み**

1. プロンプト「ファイルを書き込んで」(承認モードが bypass でないこと)
2. CLI が Edit/Write の承認ダイアログを出す
3. ダイアログを開いたまま textarea に「やめて検索だけして」と入力 → 割り込み
4. 期待: 承認ダイアログが自動 deny + interrupt 状態になり、新プロンプトでの応答が始まる

- [ ] **Step 7: セッション継続性の確認**

1. 「1 つ目のプロンプト」送信 → 完了
2. 「2 つ目のプロンプト」送信 → 応答中に「3 つ目のプロンプト (やはり 2 つ目のテーマで答えて)」で割り込み
3. 完了後、再度「直前まで何の話をしていた?」と送信
4. 期待: アシスタントが「1 つ目 → 2 つ目 (中断) → 3 つ目」の流れを正しく把握している (= 同一セッション ID で会話が継続している)

verbose ログから --resume が走っていないことを確認するには、Obsidian の dev tools コンソール (Cmd+Opt+I) に出る subprocess の引数を見るか、`claude` コマンドが新規 spawn されていない (= 連続で 1 プロセスのまま) ことを確認する。

- [ ] **Step 8: エッジケース — 入力がほぼ同時**

1. 応答開始直後、アシスタントの最初のチャンクが出る前に「割り込み」
2. 期待: クラッシュせず、新ターンが正しく開始される (CLI が assistant トークンを出す前の interrupt は安全に処理される想定)

ここで問題があれば、`agent.ts` 側で「最初のチャンク到達まで inject を待つ」キューイングを追加する必要があるかもしれない (Task 9 として追加)。

- [ ] **Step 9: 全 QA をクリアしたらコミット**

QA 中に追加修正があれば、それぞれ個別コミットする。最終的に何も変更がなければ Task 8 のコミットは不要 (空コミットはしない)。

---

## Self-review notes (作成者用)

- 全 7 ファイルの spec 要件に対応するタスクが存在する: i18n (T1)、ChatMessage (T2)、agent (T3)、chat-runtime (T4)、view (T5)、render (T6)、CSS (T7)、QA (T8)
- Placeholder スキャン: TBD / TODO は本プランに無し
- 型整合性: `RunHandle.inject` のシグネチャは agent.ts (T3) で `(prompt: string) => boolean`、chat-runtime.ts (T4) でも同じ戻り値を受ける書き方になっている
- i18n キー: T1 で `view.interruptBtn`, `view.interruptedNotice`, `chat.interruptedBadge` を追加、T5/T6 で参照する。整合済み
- 不明点 (spec の「実装中に詰める」セクション) は T8 Step 8 でカバー
