# 閾値超え要約バッジ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** コンテキスト使用率が 60% / 85% を超えたときにメーター右に「要約して新会話」バッジを出し、クリックで現会話を Claude に要約させ、要約だけを引き継いで新セッションを始める機能を追加する。

**Architecture:** 既存の `ChatRuntime` に `pendingSummary` と要約実行ヘルパー (`requestSummaryAndReset`) を追加し、新規 `SummaryBadge` コンポーネントを `ContextMeter` の隣にマウントする。要約は通常の `runAgent` を 1 回走らせて取得し、完了後に `clear()` 相当を実行してシステムメッセージを挿入。次の send で `fullPrompt` 先頭に要約を prepend してから消費する。

**Tech Stack:** TypeScript / Obsidian Plugin API / Claude Code CLI (stream-json) / esbuild

**Spec:** [docs/superpowers/specs/2026-05-27-token-saving-summary-badge-design.md](../specs/2026-05-27-token-saving-summary-badge-design.md)

このプロジェクトはテストスイートが無いため ([CLAUDE.md](../../../CLAUDE.md))、各タスクの検証は `npx tsc --noEmit` での型チェック + 手動動作確認で行う。コミットメッセージは日本語、Co-Authored-By なし(過去のフィードバックに従う)。

---

## File Structure

**新規作成:**

- `src/summary-badge.ts` — メーター右に並べる要約バッジコンポーネント。`update(fraction, isBusy)` で表示状態を制御。
- `src/summary-confirm-modal.ts` — バッジクリック時の確認モーダル。`Modal` を継承し、Yes / Cancel のシンプルな選択肢のみ。

**変更:**

- `src/chat-runtime.ts` — `pendingSummary`, `summarizing`, `isSummarizing()`, `requestSummaryAndReset()` の追加。`isBusy()` を `busy || summarizing` に拡張。`send()` で `pendingSummary` を `fullPrompt` 先頭に prepend して消費。
- `src/view.ts` — `SummaryBadge` をヘッダにマウント。`onUsageChanged` / `onBusyChanged` から `badge.update()` を呼ぶ。`send()` / `sendAskAnswer()` で `isSummarizing()` チェックして Notice。
- `src/i18n/ja.ts` / `src/i18n/en.ts` — バッジ・モーダル・Notice 用キーを `view` 名前空間に追加。
- `styles.css` — `.claude-panel-summary-badge` とその状態 (`is-warn` / `is-danger` / `is-disabled` / `is-hidden` / `is-summarizing`) を追加。

---

## Task 1: i18n キーの追加

新機能で使う文言を `view` 名前空間に追加する。日本語(マスタ辞書)を先に追加し、英語側にも対応する英訳を入れる。

**Files:**
- Modify: `src/i18n/ja.ts` (`view:` ブロックの末尾、`vaultPathUnavailable` の直後に追加)
- Modify: `src/i18n/en.ts` (同じ位置に英訳を追加)

- [ ] **Step 1: `src/i18n/ja.ts` に 8 キー追加**

[src/i18n/ja.ts](../../../src/i18n/ja.ts) の `view:` ブロック末尾(`vaultPathUnavailable` の次)に追加:

```ts
		summarizeBadgeLabel: "💬 要約して新会話",
		summarizeBadgeBusyLabel: "要約中…",
		summarizeBadgeAria: (percent: number) =>
			`コンテキスト使用率 ${percent}%。クリックで会話を要約し新規スタート。`,
		summarizeModalTitle: "会話を要約して新規スタート",
		summarizeModalBody: (percent: number) =>
			`現在の会話はコンテキストの ${percent}% を使用しています。Claude にここまでを要約してもらい、その要約だけを引き継いで新しい会話を始めます。表示中のメッセージはチャットからクリアされます(CLI 側の会話ログは残ります)。`,
		summarizeModalConfirm: "要約して新会話",
		summarizeModalCancel: "キャンセル",
		summarizingInProgress: "要約処理中です。完了するまでお待ちください。",
		summaryFailedNotice: "要約に失敗しました。会話はそのまま続行します。",
		summarySystemPrefix: "以前の会話の要約:",
```

- [ ] **Step 2: `src/i18n/en.ts` に同じキーを英訳で追加**

[src/i18n/en.ts](../../../src/i18n/en.ts) の `view:` ブロックの同じ位置に追加:

```ts
		summarizeBadgeLabel: "💬 Summarize & start fresh",
		summarizeBadgeBusyLabel: "Summarizing…",
		summarizeBadgeAria: (percent: number) =>
			`Context at ${percent}%. Click to summarize and start a fresh conversation.`,
		summarizeModalTitle: "Summarize and start a fresh conversation",
		summarizeModalBody: (percent: number) =>
			`Your current conversation is using ${percent}% of the context window. Claude will summarize everything so far, and the summary alone will be carried into a fresh conversation. The displayed messages will be cleared from the chat (the CLI-side log is preserved).`,
		summarizeModalConfirm: "Summarize & start fresh",
		summarizeModalCancel: "Cancel",
		summarizingInProgress: "Summarizing — please wait until it completes.",
		summaryFailedNotice: "Summarization failed. Continuing with the existing conversation.",
		summarySystemPrefix: "Previous conversation summary:",
```

- [ ] **Step 3: 型チェック**

```bash
cd /Users/candy/Documents/obsidian-plugins/claude-panel-ryukyuhub
npx tsc --noEmit
```

Expected: エラー無し(`ja.ts` をマスタとして `en.ts` の `Messages` 型整合性が取れる)。

- [ ] **Step 4: 単独でコミットしない**(Task 6 まで連続して動くため、Task 6 完了時にまとめてコミットする)

---

## Task 2: `SummaryBadge` コンポーネントの新規作成

メーター右に表示するバッジ。`update(fraction, isBusy)` でクラスを付け替えるだけのシンプルなコンポーネント。

**Files:**
- Create: `src/summary-badge.ts`

- [ ] **Step 1: `src/summary-badge.ts` を新規作成**

```ts
import { t } from "./i18n";

/**
 * コンテキスト使用率が閾値を超えたときに、メーター右に表示する
 * 「要約して新会話」バッジ。表示・色・disabled の切り替えだけを
 * 担い、クリック後の確認モーダル表示と要約処理の呼び出しは
 * 呼び出し側(view)が組み立てる。
 *
 * 閾値定数 (`0.6` / `0.85`) は ContextMeter の色判定と数値が
 * 同じだが、概念が別(色 vs 提案)なので共有化はしない。
 */

const THRESHOLD_WARN = 0.6;
const THRESHOLD_DANGER = 0.85;

export class SummaryBadge {
	private host: HTMLElement;
	private btn: HTMLButtonElement;
	private currentFraction: number | null = null;
	private isBusy = false;
	private isSummarizing = false;

	constructor(host: HTMLElement, opts: { onClick: () => void }) {
		this.host = host;
		this.btn = host.createEl("button", {
			cls: "claude-panel-summary-badge is-hidden",
		});
		this.btn.onclick = () => {
			if (this.btn.classList.contains("is-disabled")) return;
			opts.onClick();
		};
		this.renderLabel();
	}

	/** 使用率 [0, 1]。null のときは非表示。`isBusy` は通常ターンまたは
	 *  要約処理中で、どちらでもクリックを無効化する。 */
	update(usageFraction: number | null, isBusy: boolean): void {
		this.currentFraction = usageFraction;
		this.isBusy = isBusy;
		this.applyState();
	}

	/** 要約処理が始まったことを別ルートから通知する。クラスとラベルを
	 *  「要約中…」に切り替える。`update()` 側の `isBusy` は通常ターンと
	 *  共通なので、要約中かどうかをここで明示区別する。 */
	setSummarizing(active: boolean): void {
		this.isSummarizing = active;
		this.applyState();
	}

	private applyState(): void {
		const f = this.currentFraction;
		const visible = typeof f === "number" && f >= THRESHOLD_WARN;
		this.btn.classList.toggle("is-hidden", !visible);
		if (!visible) {
			this.btn.classList.remove("is-warn", "is-danger", "is-disabled", "is-summarizing");
			return;
		}
		this.btn.classList.toggle("is-danger", f! >= THRESHOLD_DANGER);
		this.btn.classList.toggle("is-warn", f! < THRESHOLD_DANGER);
		this.btn.classList.toggle("is-disabled", this.isBusy || this.isSummarizing);
		this.btn.classList.toggle("is-summarizing", this.isSummarizing);
		this.renderLabel();
		if (typeof f === "number") {
			this.btn.setAttr(
				"aria-label",
				t("view.summarizeBadgeAria", Math.round(f * 100))
			);
		}
	}

	private renderLabel(): void {
		this.btn.textContent = this.isSummarizing
			? t("view.summarizeBadgeBusyLabel")
			: t("view.summarizeBadgeLabel");
	}
}
```

- [ ] **Step 2: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。`is-summarizing` クラスを参照しているが、スタイル定義は Task 7 で追加する(クラス名がスタイル側で未定義でも TS エラーにはならない)。

---

## Task 3: `ChatRuntime` に `pendingSummary` / `summarizing` を追加

要約完了後に保持する `pendingSummary` フィールドと、要約中フラグ `summarizing`、それらにアクセスする API を追加する。

**Files:**
- Modify: `src/chat-runtime.ts:88-110` (フィールド宣言ブロック) + `src/chat-runtime.ts:125-127` (`isBusy()` 周辺)

- [ ] **Step 1: フィールドを追加**

[src/chat-runtime.ts:88-110](../../../src/chat-runtime.ts) の `ChatRuntime` クラスのフィールド宣言ブロックの末尾(`private injecting = false;` の次)に追加:

```ts
	// 要約バッジ経由で確定した「次回 send で fullPrompt 先頭に
	// 1 度だけ prepend する要約」。新セッションを開始したターンで
	// だけ送られ、それ以降は --resume の履歴に乗るので不要。
	private pendingSummary: string | null = null;
	// 要約依頼ターンの実行中フラグ。通常の busy とは別管理して、
	// view 側で「要約処理中です」用の Notice を出し分けるために
	// 独立公開する。`isBusy()` 側でも OR で扱う。
	private summarizing = false;
```

- [ ] **Step 2: `isBusy()` を拡張**

[src/chat-runtime.ts:125-127](../../../src/chat-runtime.ts) の現状:

```ts
	isBusy(): boolean {
		return this.busy;
	}
```

を以下に置き換える:

```ts
	isBusy(): boolean {
		return this.busy || this.summarizing;
	}

	/** 要約処理が実行中かどうか。view 側で「要約処理中です」の
	 *  Notice を `isBusy()` の通常 busy と区別するために独立公開する。 */
	isSummarizing(): boolean {
		return this.summarizing;
	}
```

- [ ] **Step 3: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。

---

## Task 4: `ChatRuntime.send()` で `pendingSummary` を prepend

新セッション初回 send のときに、`fullPrompt` 先頭に要約ブロックを付ける。`runOnce` を呼ぶ直前で 1 度だけ書き換え、`pendingSummary` を null に戻す。

**Files:**
- Modify: `src/chat-runtime.ts` の `send()` 内、`runOnce` 定義の直前

- [ ] **Step 1: `send()` 内に prepend を追加**

[src/chat-runtime.ts:220](../../../src/chat-runtime.ts) 付近の `const runOnce = async (` の **直前** に以下を挿入する:

```ts
		// 要約バッジで確定した「前会話の要約」が残っていれば、
		// 新セッション初回ターンの fullPrompt 先頭に prepend する。
		// 1 度だけ消費する(2 ターン目以降は --resume の履歴に乗るので不要)。
		// UI のユーザーバブル本文(composed.body)には乗らない —
		// ユーザーの実際の入力と要約が区別できなくなるため。
		const promptForCli = this.pendingSummary
			? `[Previous conversation summary]\n${this.pendingSummary}\n\n---\n\n${composed.fullPrompt}`
			: composed.fullPrompt;
		this.pendingSummary = null;
```

- [ ] **Step 2: `runOnce` 内で `composed.fullPrompt` を参照している箇所を `promptForCli` に置き換える**

[src/chat-runtime.ts:231](../../../src/chat-runtime.ts) 付近、`runAgent` の `prompt: composed.fullPrompt,` を以下に置き換える:

```ts
					prompt: promptForCli,
```

- [ ] **Step 3: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。

---

## Task 5: `ChatRuntime.requestSummaryAndReset()` の実装

バッジクリック → モーダル Yes 経路から呼ばれる本体。内部で `runAgent` を 1 回走らせて要約テキストを取得し、成功したら `clear()` 相当 + システムメッセージ追加 + `pendingSummary` セットを行う。

**Files:**
- Modify: `src/chat-runtime.ts` の `clear()` メソッドの直後

- [ ] **Step 1: 要約依頼プロンプト定数の追加**

[src/chat-runtime.ts](../../../src/chat-runtime.ts) のファイル先頭 import 群の直後(クラス定義の前)に追加:

```ts
const SUMMARIZE_PROMPT =
	"Summarize this conversation so far in roughly 1500 characters or less. " +
	"The summary will be carried into a fresh session as context. " +
	"Cover: user's intent, key decisions made, files/paths touched, open questions. " +
	"Output only the summary itself — no preamble, no follow-up question.";
```

- [ ] **Step 2: `runAgent` import を確認**

[src/chat-runtime.ts:2-7](../../../src/chat-runtime.ts) の既存 import で `runAgent` は既に取り込まれているのでそのまま。

- [ ] **Step 3: `clear()` メソッドの直後に `requestSummaryAndReset()` を追加**

[src/chat-runtime.ts:442-452](../../../src/chat-runtime.ts) の `clear()` メソッド の **直後** に以下を挿入:

```ts
	/**
	 * 現セッションを Claude に要約させて、その要約だけを引き継いだ
	 * 新セッションを始める。バッジ → 確認モーダル Yes 経路から呼ばれる。
	 *
	 * フロー:
	 *  1. summarizing = true → host へ busy 通知
	 *  2. 現セッションに SUMMARIZE_PROMPT を投げる(UI には流さない)
	 *  3. assistant の text パートを summaryBuf に蓄積
	 *  4. result を受けたら summarizing = false
	 *  5. 成功なら clear 相当 + システムメッセージ追加 + pendingSummary セット
	 *  6. 失敗(空応答 / エラー / キャンセル)なら現状の会話を保持して戻る
	 */
	async requestSummaryAndReset(cwd: string): Promise<boolean> {
		if (this.busy || this.summarizing) return false;
		if (this.messages.length === 0) return false;
		if (!this.currentSessionId && !this.pendingContinue) {
			// 既存セッションが無いのに要約を頼むのは不整合(空チャットや
			// セッション失効直後)。安全側で何もしない。
			return false;
		}

		this.summarizing = true;
		this.host.onBusyChanged(this.isBusy());

		let summaryBuf = "";
		let hadError = false;
		let canceledByUser = false;

		const handle = runAgent(
			{
				prompt: SUMMARIZE_PROMPT,
				cwd,
				settings: this.plugin.settings,
				sessionId: this.currentSessionId ?? undefined,
				continueLast: false,
			},
			{
				onText: (chunk) => {
					summaryBuf += chunk;
				},
				onToolUse: () => {
					// 要約依頼に対してツール呼び出しが来る想定は無いが、
					// 念のため無視する(プロンプトで「summary のみ」と
					// 指示しているので Claude は自由にツールを使わない)。
				},
				onPermissionRequest: (_req, decide) => {
					// 万が一の保護パス書き込み等は即時 deny する。
					decide({ allow: false, message: "summary turn — tool use not permitted" });
				},
				onResult: () => {
					/* 完了は handle.promise の resolve で扱う */
				},
				onUsage: (usage) => {
					// 要約ターンも本物のトークン消費があるので、永続履歴と
					// メーターには反映する。次の通常 send が新セッション
					// (--resume 無し)で始まるため、lastUsage の意味は
					// 「直近の Claude 応答時点の消費」として一貫する。
					this.lastUsage = usage;
					this.plugin.recordUsage(usage);
					this.host.onUsageChanged(this.lastUsage);
				},
				onRateLimit: (info) => {
					this.plugin.applyRateLimitEvent(info);
				},
				onError: (_err) => {
					hadError = true;
				},
			}
		);

		// view 側からの ESC キャンセルにも反応できるよう、現 run として登録。
		this.currentRun = handle;
		await handle.promise;
		canceledByUser = handle.canceled();
		this.currentRun = null;

		this.summarizing = false;

		const trimmed = summaryBuf.trim();
		if (canceledByUser || hadError || trimmed.length === 0) {
			// 失敗 → 会話と sessionId をそのまま保持。busy 状態だけ戻す。
			this.host.onBusyChanged(this.isBusy());
			return false;
		}

		// 成功 → 既存メッセージ列を破棄し、要約をシステムメッセージとして 1 件挿入。
		// pendingPermissions は要約ターンには無いはずだが、過去の取りこぼし
		// 保護として既存の flushPendingPermissions を呼んで掃除する。
		this.flushPendingPermissions(t("chatRuntime.conversationCleared"));
		this.messages = [];
		this.currentSessionId = null;
		this.pendingContinue = false;
		this.lastUsage = null;
		this.pendingSummary = trimmed;
		this.messages.push({
			id: nextMsgId(),
			role: "system",
			parts: [
				{
					type: "text",
					text: `${t("view.summarySystemPrefix")}\n\n${trimmed}`,
				},
			],
		});

		this.host.onMessagesChanged();
		this.host.onUsageChanged(null);
		this.host.onBusyChanged(this.isBusy());
		return true;
	}
```

- [ ] **Step 4: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。`nextMsgId`, `flushPendingPermissions`, `t` はそれぞれ既存 import / メソッドで使えるはず。エラーが出たら不足を import する。

---

## Task 6: ここまでをコミット

`SummaryBadge` 自体は view にマウントされていない状態だが、ロジックレイヤと UI コンポーネントが完成して型は通る。i18n と runtime を中心とした論理的なまとまり。

- [ ] **Step 1: 変更状況の確認**

```bash
git status
git diff --stat
```

Expected: 以下 4 ファイルに変更があるはず:
- `src/i18n/ja.ts` (8 キー追加)
- `src/i18n/en.ts` (8 キー追加)
- `src/chat-runtime.ts` (`pendingSummary` / `summarizing` / `isSummarizing()` / `requestSummaryAndReset()` 追加、`isBusy()` 拡張、`send()` で prepend)
- `src/summary-badge.ts` (新規ファイル)

- [ ] **Step 2: コミット**

```bash
git add src/i18n/ja.ts src/i18n/en.ts src/chat-runtime.ts src/summary-badge.ts
git commit -m "agent: 会話要約と pendingSummary 注入の土台を追加"
```

(コミットメッセージは日本語、Co-Authored-By なし。本人が書いたように。)

---

## Task 7: `styles.css` にバッジスタイルを追加

ヘッダ内、メーターとアカウントアイコンの間に置く前提でスタイルを書く。色トークンは既存のメーターと揃える。

**Files:**
- Modify: `styles.css` (`.claude-panel-meter-fg.is-danger` の直後、`.claude-panel-clear` の直前 — line 440 付近)

- [ ] **Step 1: スタイルブロックを追加**

[styles.css:440](../../../styles.css) 付近、`.claude-panel-meter-fg.is-danger { ... }` ブロックの **直後** に以下を挿入:

```css
/* ---------- 要約バッジ ---------- */

.claude-panel-summary-badge {
	font-size: 11px;
	height: 26px;
	padding: 0 10px;
	margin-right: 6px;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	background: transparent;
	border: 1px solid var(--background-modifier-border);
	color: var(--text-muted);
	border-radius: 4px;
	cursor: pointer;
	transition:
		background 120ms ease,
		color 120ms ease,
		border-color 120ms ease,
		opacity 120ms ease;
}

.claude-panel-summary-badge.is-hidden {
	display: none;
}

.claude-panel-summary-badge.is-warn {
	color: var(--text-warning, #d29922);
	border-color: var(--text-warning, #d29922);
}

.claude-panel-summary-badge.is-warn:hover {
	background: rgba(210, 153, 34, 0.1);
}

.claude-panel-summary-badge.is-danger {
	color: var(--text-on-accent, #fff);
	background: var(--text-error, #f85149);
	border-color: var(--text-error, #f85149);
}

.claude-panel-summary-badge.is-danger:hover {
	filter: brightness(1.1);
}

.claude-panel-summary-badge.is-disabled {
	opacity: 0.6;
	cursor: not-allowed;
	pointer-events: none;
}

.claude-panel-summary-badge.is-summarizing::before {
	content: "";
	display: inline-block;
	width: 10px;
	height: 10px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: claude-panel-spin 800ms linear infinite;
}

@keyframes claude-panel-spin {
	to {
		transform: rotate(360deg);
	}
}
```

- [ ] **Step 2: 開発ビルドで反映確認**

```bash
npm run dev
```

Expected: watch モードで `main.js` がプラグインフォルダに書き出されることを確認(エラー無し)。スタイル自体の見た目は Task 9 で view にマウントしてから Obsidian で目視確認する。

---

## Task 8: 確認モーダルの新規作成

バッジクリック時の確認ダイアログ。`Modal` を継承し、Yes / Cancel のみのシンプルな構造。

**Files:**
- Create: `src/summary-confirm-modal.ts`

- [ ] **Step 1: `src/summary-confirm-modal.ts` を新規作成**

```ts
import { App, Modal } from "obsidian";
import { t } from "./i18n";

/**
 * 要約バッジクリック時に出す確認モーダル。
 * Yes で onConfirm() が呼ばれ、Cancel または ×・Esc で何もせず閉じる。
 * モーダルを閉じる時点ではすでに onConfirm が呼ばれた後 — 呼び出し側で
 * 非同期処理を進めるか待機するかは決めてよい(本プラグインでは
 * fire-and-forget で view 側が requestSummaryAndReset を呼ぶ)。
 */
export class SummaryConfirmModal extends Modal {
	private usageFraction: number;
	private onConfirm: () => void;

	constructor(
		app: App,
		opts: { usageFraction: number; onConfirm: () => void }
	) {
		super(app);
		this.usageFraction = opts.usageFraction;
		this.onConfirm = opts.onConfirm;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("claude-panel-summary-modal");
		contentEl.empty();

		contentEl.createEl("h3", { text: t("view.summarizeModalTitle") });

		const percent = Math.round(this.usageFraction * 100);
		contentEl.createEl("p", {
			text: t("view.summarizeModalBody", percent),
		});

		const buttons = contentEl.createDiv({
			cls: "claude-panel-summary-modal-actions",
		});
		const cancelBtn = buttons.createEl("button", {
			text: t("view.summarizeModalCancel"),
		});
		cancelBtn.onclick = () => this.close();

		const confirmBtn = buttons.createEl("button", {
			cls: "mod-cta",
			text: t("view.summarizeModalConfirm"),
		});
		confirmBtn.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
```

- [ ] **Step 2: モーダルのアクションスタイルを `styles.css` に追加**

[styles.css](../../../styles.css) の Task 7 で追加した要約バッジブロックの **末尾** に追加:

```css
.claude-panel-summary-modal-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 16px;
}
```

- [ ] **Step 3: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。

---

## Task 9: `view.ts` で `SummaryBadge` をマウントし、ハンドラ配線

バッジを `renderHeader` の中、メーターアイテムとアカウントボタンの間にマウントする。`onUsageChanged` / `onBusyChanged` から `badge.update()` を呼ぶ。クリックハンドラはモーダル → `runtime.requestSummaryAndReset(cwd)` を呼ぶ。

**Files:**
- Modify: `src/view.ts` (import 群、フィールド、`renderHeader`、`onUsageChanged`、`onBusyChanged`、`refreshMeters`)

- [ ] **Step 1: import 追加**

[src/view.ts:32-33](../../../src/view.ts) 付近の import 群に追加:

```ts
import { SummaryBadge } from "./summary-badge";
import { SummaryConfirmModal } from "./summary-confirm-modal";
```

- [ ] **Step 2: フィールド宣言を追加**

[src/view.ts:73](../../../src/view.ts) 付近、`private contextMeter: ContextMeter | null = null;` の次に追加:

```ts
	private summaryBadge: SummaryBadge | null = null;
```

- [ ] **Step 3: `renderHeader` でバッジをマウント**

[src/view.ts:355-356](../../../src/view.ts) の `this.contextMeter = new ContextMeter(meterHost);` と `this.contextMeter.update(...)` の **直後**、`const accountBtn = header.createEl(...)` の **直前** に挿入:

```ts
		this.summaryBadge = new SummaryBadge(header, {
			onClick: () => this.openSummaryConfirm(),
		});
		// 初期状態を反映(初回マウント時は usage が無いことが多い)。
		this.summaryBadge.update(
			toUsageFraction(this.runtime?.getLastUsage() ?? null),
			this.runtime?.isBusy() ?? false
		);
```

ファイル末尾の helper として `toUsageFraction` を追加(ファイル末尾、`getVaultPath()` の直後あたり):

```ts
	private openSummaryConfirm(): void {
		const usage = this.runtime?.getLastUsage() ?? null;
		const fraction = toUsageFractionStatic(usage);
		if (fraction === null || fraction < 0.6) return;
		const cwd = this.getVaultPath();
		if (!cwd) {
			new Notice(t("view.vaultPathUnavailable"));
			return;
		}
		new SummaryConfirmModal(this.app, {
			usageFraction: fraction,
			onConfirm: () => {
				void this.runtime.requestSummaryAndReset(cwd);
			},
		}).open();
	}
```

ファイル末尾(`export class ClaudePanelView` の閉じ括弧の **外**)に共通ヘルパーを追加:

```ts
const CONTEXT_WINDOW_TOKENS = 200_000;

function toUsageFractionStatic(
	usage: import("./chat-message").MessageUsage | null
): number | null {
	if (!usage) return null;
	const used =
		usage.inputTokens +
		usage.cacheCreationTokens +
		usage.cacheReadTokens +
		usage.outputTokens;
	return used / CONTEXT_WINDOW_TOKENS;
}
```

クラス内の `renderHeader` で参照しやすいよう、もうひとつの thin wrapper をクラス内に追加(`refreshMeters` の直前など):

```ts
	private toUsageFraction(
		usage: import("./chat-message").MessageUsage | null
	): number | null {
		return toUsageFractionStatic(usage);
	}
```

(`renderHeader` 内の `this.summaryBadge.update(toUsageFraction(...), ...)` 呼び出しは、`this.toUsageFraction(...)` に直す。Step 2 のコード片の `toUsageFraction(...)` を `this.toUsageFraction(...)` に置き換える。)

- [ ] **Step 4: `onUsageChanged` でバッジ更新**

[src/view.ts:807-809](../../../src/view.ts) の現状:

```ts
	onUsageChanged(usage: MessageUsage | null): void {
		this.contextMeter?.update(usage);
	}
```

を以下に置き換える:

```ts
	onUsageChanged(usage: MessageUsage | null): void {
		this.contextMeter?.update(usage);
		this.summaryBadge?.update(
			this.toUsageFraction(usage),
			this.runtime?.isBusy() ?? false
		);
	}
```

- [ ] **Step 5: `onBusyChanged` でバッジに busy 状態を流す**

[src/view.ts:778-780](../../../src/view.ts) の現状:

```ts
	onBusyChanged(_busy: boolean): void {
		this.refreshSendBtn();
	}
```

を以下に置き換える:

```ts
	onBusyChanged(busy: boolean): void {
		this.refreshSendBtn();
		this.summaryBadge?.update(
			this.toUsageFraction(this.runtime?.getLastUsage() ?? null),
			busy
		);
		this.summaryBadge?.setSummarizing(this.runtime?.isSummarizing() ?? false);
	}
```

- [ ] **Step 6: `refreshMeters` でバッジも再描画**

[src/view.ts:377-379](../../../src/view.ts) の `refreshMeters()` を以下に置き換える:

```ts
	refreshMeters(): void {
		const usage = this.runtime?.getLastUsage() ?? null;
		this.contextMeter?.update(usage);
		this.summaryBadge?.update(
			this.toUsageFraction(usage),
			this.runtime?.isBusy() ?? false
		);
	}
```

- [ ] **Step 7: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。

---

## Task 10: `view.ts` の `send()` / `sendAskAnswer()` で要約中弾き

通常 send と `ask` ブロックからの送信両方で、要約中なら専用の Notice を出して early return する。

**Files:**
- Modify: `src/view.ts` (`send()` の冒頭、`sendAskAnswer()` の冒頭)

- [ ] **Step 1: `sendAskAnswer()` の先頭にチェックを追加**

[src/view.ts:881-883](../../../src/view.ts) の `private async sendAskAnswer(answer: string): Promise<void> {` の **直後**、`const text = answer.trim();` の **前** に挿入:

```ts
		if (this.runtime.isSummarizing()) {
			new Notice(t("view.summarizingInProgress"));
			return;
		}
```

- [ ] **Step 2: `send()` の先頭にも同じチェックを追加**

[src/view.ts:907-909](../../../src/view.ts) の `private async send(): Promise<void> {` の **直後**、`const text = this.inputEl.value.trim();` の **前** に挿入:

```ts
		if (this.runtime.isSummarizing()) {
			new Notice(t("view.summarizingInProgress"));
			return;
		}
```

- [ ] **Step 3: 型チェック**

```bash
npx tsc --noEmit
```

Expected: エラー無し。

---

## Task 11: ビルドと手動動作確認

ここまでの変更がランタイムで意図通り動くか、Obsidian で手動チェックする。

- [ ] **Step 1: プロダクションビルド**

```bash
npm run build
```

Expected: `main.js` がプラグインフォルダに書き出される(エラー無し)。

- [ ] **Step 2: Obsidian でプラグインリロード**

Obsidian の「コミュニティプラグイン」設定で `Candy Claudian` を一度オフにしてオンに戻す。または Hot Reload プラグインを使う。

- [ ] **Step 3: 手動チェックリストを順に消化**

スペック [G. テスト戦略](../specs/2026-05-27-token-saving-summary-badge-design.md#手動検証チェックリスト) の項目を順に確認する:

1. **発火閾値**: 長文(数 MB のテキストファイル)を `@` 添付して数ターン会話し、メーター下のバッジが 60% 付近で warn 色 / 85% 付近で danger 色に切り替わるか。会話が空のとき・閾値未満では非表示か。
2. **要約フロー (Happy Path)**:
   - 60% 超でバッジクリック → 確認モーダル → 「要約して新会話」を押す
   - バッジが「要約中…」スピナー表示、送信ボタンが Stop 表示
   - 完了後にチャットがシステムメッセージ 1 件(要約)だけになる
   - 続けて通常メッセージを送ると、`npm run dev` のコンソールに出る stream-json payload の `prompt` 先頭に `[Previous conversation summary]` ブロックが含まれていること
3. **中断**: 要約ストリーミング中に ESC キーで止めて、元の会話メッセージ列と `currentSessionId` が保たれているか
4. **空応答**: 一時的に `SUMMARIZE_PROMPT` を `"."` のような無意味な文字列に書き換えてリビルドし、空応答時に `Notice` が出て会話が保たれるか(検証後は元に戻す)
5. **境界**: `usage` が `null`(初回)、100% 超のケースでクラッシュしないか
6. **busy 中**: 通常ターン進行中にバッジが disabled になり、押せないか
7. **再起動**: 要約後に Obsidian を再起動して `/continue` 自動復元が「要約だけの新セッション」を拾うか(`~/.claude/projects/<encoded-cwd>/` 内の最新 jsonl が短い要約セッションになっていることを確認)
8. **i18n**: 設定で UI 言語を `ja` / `en` 切り替えて、バッジラベルとモーダル文言が両方とも表示されるか

- [ ] **Step 4: 動作確認で見つかった問題を修正**

問題があれば該当タスクへ戻って修正。修正後は再度 `npm run build` + リロード。

---

## Task 12: 最終コミット

スタイル・モーダル・view 配線・動作確認後の修正をまとめてコミットする。

- [ ] **Step 1: 変更状況の確認**

```bash
git status
git diff --stat
```

Expected: 以下のファイル群に変更があるはず:
- `styles.css`
- `src/summary-confirm-modal.ts` (新規)
- `src/view.ts`
- (動作確認中に見つかった修正があれば該当ファイル)

- [ ] **Step 2: コミット**

```bash
git add styles.css src/summary-confirm-modal.ts src/view.ts
git commit -m "view: 要約バッジと確認モーダルをヘッダに配線"
```

(変更したファイルがほかにあれば適宜追加する。コミットメッセージは日本語、Co-Authored-By なし。)

- [ ] **Step 3: 動作再確認**

リリースするわけではないので、ここまでで PR / タグ作成は不要(ユーザー判断)。Plan 完了。

---

## Self-Review

### Spec coverage

- [機能仕様 - バッジ表示ルール](../specs/2026-05-27-token-saving-summary-badge-design.md#バッジ表示ルール) → Task 2 / Task 7 / Task 9
- [機能仕様 - クリック時のフロー](../specs/2026-05-27-token-saving-summary-badge-design.md#クリック時のフロー) → Task 8 / Task 9 / Task 5
- [機能仕様 - 要約依頼プロンプト](../specs/2026-05-27-token-saving-summary-badge-design.md#要約依頼プロンプト) → Task 5 Step 1
- [機能仕様 - 新セッション初回 send での prepend フォーマット](../specs/2026-05-27-token-saving-summary-badge-design.md#新セッション初回-send-での-prepend-フォーマット) → Task 4
- [アーキテクチャ - 担当の置き場所](../specs/2026-05-27-token-saving-summary-badge-design.md#担当の置き場所) → File Structure に明示
- [SummaryBadge の API](../specs/2026-05-27-token-saving-summary-badge-design.md#summarybadge-の-api) → Task 2(`dispose()` だけはこのプランでは省略 — view は再描画でホスト要素ごと差し替えるためバッジインスタンスを保持しない)
- [ChatRuntime の追加 API](../specs/2026-05-27-token-saving-summary-badge-design.md#chatruntime-の追加-api) → Task 3 / Task 5
- [send() の prepend ポイント](../specs/2026-05-27-token-saving-summary-badge-design.md#send-の-prepend-ポイント) → Task 4
- [エラーハンドリング](../specs/2026-05-27-token-saving-summary-badge-design.md#エラーハンドリング) → Task 5(キャンセル / 空応答 / エラー)、Task 10(要約中の send / inject)
- [テスト戦略](../specs/2026-05-27-token-saving-summary-badge-design.md#手動検証チェックリスト) → Task 11

### Notes

- `SummaryBadge.dispose()` はスペックに記載があるがプランでは不要と判断(view 再描画時はホスト要素を `root.empty()` で破棄するので、バッジ DOM ごと消える)。スペック側を後追いで簡素化してもよい。
- `view.ts` の `rebuildLocalizedUI()`(ロケール切替時の再描画)は `renderHeader` を呼び直すので、バッジは自動的に再マウントされる。明示の対応は不要。
- 型チェックは各タスクで `npx tsc --noEmit` を走らせる。CI / pre-commit hook は無いため明示的に実行する。

### Placeholder scan

- "TBD" / "TODO" / "fill in details" の類: なし
- 「Similar to Task N」: なし(各タスクで完全なコード片を提示)

### Type consistency

- `pendingSummary: string | null` → Task 3 で宣言、Task 4 / Task 5 で参照(整合)
- `summarizing: boolean` → Task 3 で宣言、Task 5 で読み書き、Task 3 の `isBusy()` / `isSummarizing()` から参照(整合)
- `requestSummaryAndReset(cwd: string): Promise<boolean>` → Task 5 で宣言、Task 9 の `openSummaryConfirm()` から呼び出し(整合)
- `SummaryBadge.update(fraction, isBusy)` / `SummaryBadge.setSummarizing(active)` → Task 2 で宣言、Task 9 の `renderHeader` / `onUsageChanged` / `onBusyChanged` / `refreshMeters` から呼び出し(整合)
- i18n キー → Task 1 で定義、各タスクで `t("view.summarize…")` 形式で参照(整合)
