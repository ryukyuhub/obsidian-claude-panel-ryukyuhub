# モデル表記の自動追従 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** モデルのバージョンアップにコード変更なしで自動追従し、応答フッターに実際に走ったモデル（例: `opus 4.8`）を表示する。

**Architecture:** `MODEL_PRESETS` を正規 ID からエイリアス（`opus`/`sonnet`/`haiku`）へ変更して CLI に常に最新を解決させる。assistant ストリームが返す解決後の正規 ID を `onModel` イベントで捕捉し、`RunResult.model` 経由で応答フッターに表示する。

**Tech Stack:** TypeScript（strict null checks）、Obsidian Plugin API、esbuild、`claude` CLI（stream-json）。テストスイートは無いため、各タスクの検証は `npx tsc --noEmit` の型チェックと最終的な実機確認で行う。

---

## 注意: このプロジェクトにテストフレームワークは無い

`pytest` 等は使えない。各タスクの「検証ステップ」は `npx tsc --noEmit`（型エラーが消える / 出ないこと）で代替する。最終タスクでビルドと Obsidian 実機での挙動を確認する。コミットメッセージは日本語で、`Co-Authored-By` は付けない。

---

## File Structure

- `src/settings/types.ts` — `MODEL_PRESETS` をエイリアスへ、`DEFAULT_SETTINGS.model` を `"sonnet"` へ。
- `src/main.ts` — `loadSettings` に旧プリセット ID → エイリアスの限定移行を追加。
- `src/agent.ts` — `AssistantStreamMessage` 型に `model` を追加、`AgentEvents.onModel` を追加、`handleStreamLine` で発火。
- `src/chat-message.ts` — `RunResult` に `model?: string` を追加。
- `src/chat-runtime.ts` — `lastRunModel` を保持し `onResult` で `RunResult` に載せる。
- `src/chat-message-render.ts` — `renderResultFooter` でモデルラベルを先頭に表示。
- `src/i18n/ja.ts` / `src/i18n/en.ts` — `footerComplete` に `modelText` セグメントを追加。

---

## Task 1: 実行モデルを agent 層で捕捉する

CLI が assistant ストリームに流す解決後の正規 ID を `onModel` イベントとして view 側へ届ける。表示変更より先に「実モデルが取れる」配線を作る。

**Files:**
- Modify: `src/agent.ts`（型定義 `AssistantStreamMessage`、`AgentEvents`、`handleStreamLine`）

- [ ] **Step 1: `AssistantStreamMessage` の型に `model` を追加**

`src/agent.ts:179` 付近、現状:

```ts
interface AssistantStreamMessage {
	type: "assistant";
	message: { content: ContentBlock[]; usage?: RawUsage };
}
```

を次に変更:

```ts
interface AssistantStreamMessage {
	type: "assistant";
	message: { content: ContentBlock[]; usage?: RawUsage; model?: string };
}
```

> 注: `type:` 行の正確な内容はファイルに合わせること（`type: "assistant";` のフィールドが既存。`message:` の中括弧に `model?: string` を足すだけ）。

- [ ] **Step 2: `AgentEvents` に `onModel` を追加**

`src/agent.ts:30-52` の `AgentEvents` 内、`onUsage?` 宣言（39 行目）の直後に追加:

```ts
	/** assistant ストリームが報告する、CLI が解決した実モデルの正規 ID
	 *  （例 `claude-opus-4-8`）。プリセットがエイリアスでも、実際に走った
	 *  バージョンをフッター表示するために使う。1 ラン中に複数回来うる。 */
	onModel?: (model: string) => void;
```

- [ ] **Step 3: `handleStreamLine` の assistant 分岐で発火**

`src/agent.ts:240-251` の assistant 分岐、`if (msg.message?.usage) { ... }` ブロックの直後（`for (const block ...)` の前）に追加:

```ts
		if (typeof msg.message?.model === "string") {
			events.onModel?.(msg.message.model);
		}
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: 既存どおりエラー無しで完了（新フィールド/イベントは任意なので未配線でも通る）。

- [ ] **Step 5: コミット**

```bash
git add src/agent.ts
git commit -m "feat: assistant ストリームから実行モデルを onModel で捕捉"
```

---

## Task 2: RunResult に実モデルを伝搬し応答フッターに表示する

`onModel` で受けた実モデルを `RunResult` に載せ、`renderResultFooter` で `opus 4.8` のように先頭表示する。

**Files:**
- Modify: `src/chat-message.ts`（`RunResult`）
- Modify: `src/chat-runtime.ts`（`lastRunModel` 保持と `onModel`／`onResult` 配線）
- Modify: `src/chat-message-render.ts`（`renderResultFooter`）
- Modify: `src/i18n/ja.ts` / `src/i18n/en.ts`（`footerComplete`）

- [ ] **Step 1: `RunResult` に `model` を追加**

`src/chat-message.ts:34-37` 付近、現状:

```ts
export interface RunResult {
	durationMs: number;
	costUsd?: number;
}
```

を次に変更:

```ts
export interface RunResult {
	durationMs: number;
	costUsd?: number;
	/** CLI が解決した実モデルの正規 ID（例 `claude-opus-4-8`）。フッター表示用。 */
	model?: string;
}
```

- [ ] **Step 2: `chat-runtime.ts` に `lastRunModel` を追加**

`src/chat-runtime.ts:262` の `let lastRunUsage: MessageUsage | null = null;` の直後に追加:

```ts
			let lastRunModel: string | null = null;
```

- [ ] **Step 3: `onModel` ハンドラを配線**

`src/chat-runtime.ts:299` の `onUsage:` ハンドラの直前（`onResult` の後ろ）に、新しいハンドラを追加:

```ts
					onModel: (model) => {
						lastRunModel = model;
					},
```

- [ ] **Step 4: `onResult` で `RunResult` に `model` を載せる**

`src/chat-runtime.ts:289-298` の `onResult` ハンドラ、現状:

```ts
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
```

の `setMessageResult` の第2引数オブジェクトに `model` を追加:

```ts
						onResult: ({ durationMs, costUsd, sessionId: newSession }) => {
							this.setMessageResult(
								this.activeAssistantId ?? assistantMsgId,
								{
									durationMs,
									costUsd,
									model: lastRunModel ?? undefined,
								}
							);
							if (newSession) this.currentSessionId = newSession;
						},
```

- [ ] **Step 5: i18n `footerComplete`（ja）にモデルセグメントを追加**

`src/i18n/ja.ts:135-136`、現状:

```ts
		footerComplete: (duration: string, tokensText: string, cost: string) =>
			`完了 · ${duration}${tokensText}${cost}`,
```

を次に変更（先頭に `modelText` 引数を追加）:

```ts
		footerComplete: (modelText: string, duration: string, tokensText: string, cost: string) =>
			`${modelText}完了 · ${duration}${tokensText}${cost}`,
```

- [ ] **Step 6: i18n `footerComplete`（en）も同形に変更**

`src/i18n/en.ts:135-136`、現状:

```ts
		footerComplete: (duration: string, tokensText: string, cost: string) =>
			`Done · ${duration}${tokensText}${cost}`,
```

を次に変更:

```ts
		footerComplete: (modelText: string, duration: string, tokensText: string, cost: string) =>
			`${modelText}Done · ${duration}${tokensText}${cost}`,
```

> `Messages = typeof ja` のため ja/en の `footerComplete` シグネチャは一致必須。両方を同じ引数順に変更すること。

- [ ] **Step 7: `renderResultFooter` でモデルラベルを構築して渡す**

`src/chat-message-render.ts:962-975` の `renderResultFooter`。`formatModelLabel` が未 import なら import に追加すること（`src/settings/labels.ts` 由来。`src/chat-message-render.ts` 冒頭の import を確認）。

現状の本体:

```ts
	const cost = r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : "";
	footer.setText(t("chat.footerComplete", duration, tokensText, cost));
```

を次に変更:

```ts
	const cost = r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : "";
	const modelText = r.model ? `${formatModelLabel(r.model)} · ` : "";
	footer.setText(t("chat.footerComplete", modelText, duration, tokensText, cost));
```

- [ ] **Step 8: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー無し。特に `footerComplete` の呼び出し側（`chat-message-render.ts`）が新シグネチャと一致し、ja/en が `Messages` 型として整合していること。

- [ ] **Step 9: コミット**

```bash
git add src/chat-message.ts src/chat-runtime.ts src/chat-message-render.ts src/i18n/ja.ts src/i18n/en.ts
git commit -m "feat: 応答フッターに実行モデルのバージョンを表示"
```

---

## Task 3: プリセットをエイリアス化し既存設定を移行する

`MODEL_PRESETS` をエイリアスに変え、CLI に常に最新を解決させる。旧プリセット ID を保存済みのユーザーをエイリアスへ限定移行する。

**Files:**
- Modify: `src/settings/types.ts`（`MODEL_PRESETS`、`DEFAULT_SETTINGS.model`）
- Modify: `src/main.ts`（`loadSettings`）

- [ ] **Step 1: `MODEL_PRESETS` をエイリアスへ変更**

`src/settings/types.ts:40-44`、現状:

```ts
export const MODEL_PRESETS: string[] = [
	"claude-sonnet-4-6",
	"claude-opus-4-7",
	"claude-haiku-4-5",
];
```

を次に変更:

```ts
// エイリアスを使うことで CLI が常に最新バージョンを解決する（例: opus → 4.8）。
// バージョンを固定したい場合はユーザーが `/model claude-opus-4-7` のように
// フル ID を入力すればよい。
export const MODEL_PRESETS: string[] = ["sonnet", "opus", "haiku"];
```

- [ ] **Step 2: `DEFAULT_SETTINGS.model` を更新**

`src/settings/types.ts:192` 付近、現状:

```ts
	model: "claude-sonnet-4-6",
```

を次に変更:

```ts
	model: "sonnet",
```

- [ ] **Step 3: `loadSettings` に限定移行を追加**

`src/main.ts:222-229` の `loadSettings`、現状:

```ts
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		this.runtimeSaveAttachmentsToVault = this.settings.saveAttachmentsToVault;
	}
```

を次に変更（`Object.assign` の後、`runtimeSaveAttachmentsToVault` 設定の前に移行を挿入）:

```ts
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		// 旧プリセット（バージョン固定 ID）をエイリアスへ移行する。CLI に最新を
		// 解決させ「表示が古いバージョンのまま」問題を解消するため。意図的な
		// ピン留めを壊さないよう、旧プリセットの 3 文字列だけを対象にする。
		const LEGACY_PRESET_MIGRATION: Record<string, string> = {
			"claude-sonnet-4-6": "sonnet",
			"claude-opus-4-7": "opus",
			"claude-haiku-4-5": "haiku",
		};
		const migrated = LEGACY_PRESET_MIGRATION[this.settings.model];
		if (migrated) this.settings.model = migrated;
		this.runtimeSaveAttachmentsToVault = this.settings.saveAttachmentsToVault;
	}
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー無し。`MODEL_PRESETS` を参照する `view.ts` / `slash-commands.ts` / `settings/tab.ts` は `string[]` のままで影響なし。

- [ ] **Step 5: コミット**

```bash
git add src/settings/types.ts src/main.ts
git commit -m "feat: モデルプリセットをエイリアス化し旧設定を移行"
```

---

## Task 4: 検証（型チェック・ビルド・実機）

`superpowers:verification-before-completion` に従い、実コマンドと実機で確認する。

- [ ] **Step 1: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー無しで完了。

- [ ] **Step 2: ビルド**

Run: `npm run build`
Expected: 成功し、`main.js` が出力される。

- [ ] **Step 3: 実機確認（Obsidian）**

1. Obsidian でプラグインをリロード（コミュニティプラグインのオン/オフ、または Hot Reload）。
2. ドロップダウンが `sonnet` / `opus` / `haiku` 表示になっていること。
3. プロンプトを送信し、応答完了後のフッターが `opus 4.8 · 完了 · …` のように**実際のモデル名**を含むこと。
4. 旧設定（`data.json` の `model` が `claude-opus-4-7`）からの起動で、ドロップダウンが `opus` に移行・選択されていること（必要なら一時的に `data.json` を手編集して確認）。

- [ ] **Step 4: 確認結果を報告**

型チェック / ビルドの出力と、実機フッターの実モデル表示を確認できたことを明記する。失敗時は出力ごと共有する。

---

## Self-Review（記入済み）

- **Spec coverage**: 設計の 1（エイリアス化）=Task 3 / 2（移行）=Task 3 Step 3 / 3（捕捉）=Task 1 / 4（RunResult・フッター）=Task 2 / 5（i18n）=Task 2 Step 5-6。全項目に対応タスクあり。
- **Placeholder scan**: TODO/TBD 無し。各コード変更ステップに実コードを記載。
- **Type consistency**: `onModel?: (model: string) => void`（agent.ts 定義 / chat-runtime.ts 利用）、`RunResult.model?: string`（chat-message.ts 定義 / chat-runtime.ts 設定 / chat-message-render.ts 利用）、`footerComplete(modelText, duration, tokensText, cost)`（ja/en/呼び出し側で一致）すべて整合。
