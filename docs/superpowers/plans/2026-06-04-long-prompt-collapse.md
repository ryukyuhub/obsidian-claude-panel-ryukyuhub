# 長いユーザプロンプトの省略表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 長いユーザプロンプトをチャット内で既定 6 行に省略表示し、クリックで全文展開／再折りたたみできるようにする。

**Architecture:** 描画レイヤー（`chat-message-render.ts`）で user ロールの本文だけを専用ラッパに包み、マークダウン確定後に JS で高さを計測。6 行ぶん（行高 × 6）を超えたら `max-height` ＋ `overflow:hidden` ＋ 下端フェードでクランプし、トグルボタンを足す。状態は CSS クラスの付け外しのみでデータモデルは変更しない。トグルで高さが変わったら view 側の上端固定スペーサーを再計算する。

**Tech Stack:** TypeScript（strict）, Obsidian API（`createDiv`/`createEl`/`MarkdownRenderer`）, esbuild。テストランナー・Lint は無いため検証は `npx tsc --noEmit` ＋ Obsidian 上の手動確認。

---

## File Structure

- **Modify** [src/i18n/ja.ts](../../../src/i18n/ja.ts) — `chat` ブロックにトグル文言キーを 2 つ追加（型の単一の真実）。
- **Modify** [src/i18n/en.ts](../../../src/i18n/en.ts) — 同じキーの英語訳を追加（`typeof ja` の shape を満たす必要がある）。
- **Modify** [src/chat-message-render.ts](../../../src/chat-message-render.ts) — `renderPart` を `Promise<void>` 返しに変更。`renderMessage` に user 専用分岐とクランプ適用 `applyUserClamp` を追加。`onUserContentResize` コールバック引数を追加。
- **Modify** [src/view.ts](../../../src/view.ts) — `renderMessage` の 2 つの呼び出し元にコールバックを渡し、`recomputeActiveSpacer()` 公開メソッドを追加。
- **Modify** [styles.css](../../../styles.css) — `.claude-panel-user-clamp` 系のスタイル（クランプ・フェード・トグルボタン）を追加。

各タスクは独立してコンパイル可能（オプショナル引数追加のため既存呼び出しは壊れない）。コミットは論理単位ごと。

---

## Task 1: i18n トグル文言キーを追加

**Files:**
- Modify: `src/i18n/ja.ts`（`chat` ブロック内、`interruptedBadge` の直後）
- Modify: `src/i18n/en.ts`（同じ位置）

- [ ] **Step 1: ja.ts にキーを追加**

`src/i18n/ja.ts` の `chat` ブロックの `interruptedBadge: "中断",` の次の行に追加する。

変更前:
```ts
		interruptedBadge: "中断",
	},
	chatTool: {
```

変更後:
```ts
		interruptedBadge: "中断",
		userClampExpand: "続きを表示",
		userClampCollapse: "折りたたむ",
	},
	chatTool: {
```

- [ ] **Step 2: en.ts に対応する英訳を追加**

`src/i18n/en.ts` の `chat` ブロックの `interruptedBadge: "Interrupted",` の次の行に追加する。

変更前:
```ts
		interruptedBadge: "Interrupted",
	},
	chatTool: {
```

変更後:
```ts
		interruptedBadge: "Interrupted",
		userClampExpand: "Show more",
		userClampCollapse: "Collapse",
	},
	chatTool: {
```

- [ ] **Step 3: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし（`Messages = typeof ja` なので ja.ts に足したキーが en.ts でも要求され、両方揃っていれば通る）。

- [ ] **Step 4: コミット**

```bash
git add src/i18n/ja.ts src/i18n/en.ts
git commit -m "feat: プロンプト省略トグルの文言を i18n に追加"
```

---

## Task 2: `renderPart` を `Promise<void>` 返しに変更

`renderMessage` がマークダウン描画完了後に高さを測れるよう、`renderPart` がマークダウン描画の promise を返すようにする。

**Files:**
- Modify: `src/chat-message-render.ts:134-168`

- [ ] **Step 1: `renderPart` のシグネチャと本体を変更**

`src/chat-message-render.ts` の現在の `renderPart`（戻り値 `void`）を以下に置き換える。

変更前:
```ts
export function renderPart(
	body: HTMLElement,
	part: Part,
	app: App,
	owner: Component,
	streaming: boolean,
	onPermissionDecision?: (toolUseId: string, decision: PermissionDecision) => void,
	onAskAnswer?: (answer: string) => void,
	yesNoFallbackEligible = false
): void {
	if (part.type === "text") {
		const span = body.createDiv({
			cls: "claude-panel-msg-text-part",
		});
		if (streaming) {
			span.textContent = part.text;
		} else {
			span.addClass("claude-panel-md");
			const partText = part.text;
			void MarkdownRenderer.render(app, partText, span, "", owner)
				.then(() => {
					linkifyPaths(span, app);
					highlightQuestions(span);
					renderAskBlocks(span, onAskAnswer);
					if (yesNoFallbackEligible) {
						maybeRenderYesNoFallback(span, partText, onAskAnswer);
					}
				});
		}
	} else if (part.type === "tool") {
		renderToolPill(body, part.name, part.input);
	} else {
		renderPermissionCard(body, part, onPermissionDecision);
	}
}
```

変更後:
```ts
export function renderPart(
	body: HTMLElement,
	part: Part,
	app: App,
	owner: Component,
	streaming: boolean,
	onPermissionDecision?: (toolUseId: string, decision: PermissionDecision) => void,
	onAskAnswer?: (answer: string) => void,
	yesNoFallbackEligible = false
): Promise<void> {
	if (part.type === "text") {
		const span = body.createDiv({
			cls: "claude-panel-msg-text-part",
		});
		if (streaming) {
			span.textContent = part.text;
			return Promise.resolve();
		}
		span.addClass("claude-panel-md");
		const partText = part.text;
		return MarkdownRenderer.render(app, partText, span, "", owner).then(() => {
			linkifyPaths(span, app);
			highlightQuestions(span);
			renderAskBlocks(span, onAskAnswer);
			if (yesNoFallbackEligible) {
				maybeRenderYesNoFallback(span, partText, onAskAnswer);
			}
		});
	} else if (part.type === "tool") {
		renderToolPill(body, part.name, part.input);
		return Promise.resolve();
	} else {
		renderPermissionCard(body, part, onPermissionDecision);
		return Promise.resolve();
	}
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし。`renderMessage` 内の `renderPart(...)` 呼び出しは戻り値を使っていない（`forEach` 内）ため、`Promise<void>` を無視しても問題ない。

- [ ] **Step 3: コミット**

```bash
git add src/chat-message-render.ts
git commit -m "refactor: renderPart がマークダウン描画の Promise を返すよう変更"
```

---

## Task 3: `renderMessage` に user 分岐とクランプ適用を追加

**Files:**
- Modify: `src/chat-message-render.ts`（`renderMessage` のシグネチャと本体、および新規ヘルパー `applyUserClamp` とモジュール定数 `MAX_USER_LINES`）

- [ ] **Step 1: `renderMessage` のシグネチャに `onUserContentResize` を追加**

`src/chat-message-render.ts` の `renderMessage` 引数の末尾（`onAskAnswer?` の後）に追加する。

変更前:
```ts
export function renderMessage(
	host: HTMLElement,
	msg: ChatMessage,
	app: App,
	owner: Component,
	onPermissionDecision?: (
		toolUseId: string,
		decision: PermissionDecision
	) => void,
	onAskAnswer?: (answer: string) => void
): void {
```

変更後:
```ts
export function renderMessage(
	host: HTMLElement,
	msg: ChatMessage,
	app: App,
	owner: Component,
	onPermissionDecision?: (
		toolUseId: string,
		decision: PermissionDecision
	) => void,
	onAskAnswer?: (answer: string) => void,
	// ユーザプロンプトの省略トグルで本文の高さが変わったとき、view 側に
	// 上端固定スペーサーの再計算を促すためのコールバック。
	onUserContentResize?: () => void
): void {
```

- [ ] **Step 2: 本文描画の分岐に user 専用パスを追加**

現在の `if (msg.interactive) { ... } else { ... }` ブロック（`renderMessage` 内、`body` 生成より後）を以下に置き換える。

変更前:
```ts
	if (msg.interactive) {
		msg.interactive(body);
	} else {
		// 散文中の yes/no 質問の自動 GUI フォールバックは「メッセージ最終の
		// テキスト part」にだけ載せたい（途中の text → tool → text のような
		// パターンで、ツール前の text 末尾を質問と誤認しないため）。
		let lastTextIdx = -1;
		for (let i = msg.parts.length - 1; i >= 0; i--) {
			if (msg.parts[i].type === "text") {
				lastTextIdx = i;
				break;
			}
		}
		msg.parts.forEach((part, idx) => {
			renderPart(
				body,
				part,
				app,
				owner,
				!!msg.streaming,
				onPermissionDecision,
				onAskAnswer,
				idx === lastTextIdx && msg.role === "assistant" && !msg.streaming
			);
		});
	}
```

変更後:
```ts
	if (msg.interactive) {
		msg.interactive(body);
	} else if (msg.role === "user") {
		// ユーザプロンプトは本文だけを専用ラッパに包み、長文を 6 行に省略する。
		// チップ（refs）はラッパの外＝常時表示のまま残す。
		const clamp = body.createDiv({ cls: "claude-panel-user-clamp" });
		const renders = msg.parts.map((part) =>
			renderPart(
				clamp,
				part,
				app,
				owner,
				!!msg.streaming,
				onPermissionDecision,
				onAskAnswer
			)
		);
		// マークダウンが実 DOM に入った後に高さを測る。
		void Promise.all(renders).then(() =>
			applyUserClamp(clamp, body, onUserContentResize)
		);
	} else {
		// 散文中の yes/no 質問の自動 GUI フォールバックは「メッセージ最終の
		// テキスト part」にだけ載せたい（途中の text → tool → text のような
		// パターンで、ツール前の text 末尾を質問と誤認しないため）。
		let lastTextIdx = -1;
		for (let i = msg.parts.length - 1; i >= 0; i--) {
			if (msg.parts[i].type === "text") {
				lastTextIdx = i;
				break;
			}
		}
		msg.parts.forEach((part, idx) => {
			renderPart(
				body,
				part,
				app,
				owner,
				!!msg.streaming,
				onPermissionDecision,
				onAskAnswer,
				idx === lastTextIdx && msg.role === "assistant" && !msg.streaming
			);
		});
	}
```

- [ ] **Step 3: モジュール定数と `applyUserClamp` ヘルパーを追加**

`src/chat-message-render.ts` の `renderPart` 関数の直後（同ファイル内のトップレベル）に、定数とヘルパーを追加する。

```ts
/** ユーザプロンプトを折りたたむ既定行数。これを超えた本文だけクランプする。 */
const MAX_USER_LINES = 6;

/**
 * ユーザメッセージ本文 `wrap` が 6 行ぶんを超えていたらクランプし、`body`
 * 直下に展開/折りたたみトグルを足す。マークダウン確定後に呼ぶこと（高さ計測
 * のため）。クランプ状態は CSS クラス `is-clamped` ＋ インライン max-height の
 * 付け外しのみで表現し、データモデルは変更しない。`onResize` はトグルで高さが
 * 変わったとき view 側のスペーサー再計算を促すためのコールバック。
 */
function applyUserClamp(
	wrap: HTMLElement,
	body: HTMLElement,
	onResize?: () => void
): void {
	const cs = getComputedStyle(wrap);
	let lineHeight = parseFloat(cs.lineHeight);
	if (!isFinite(lineHeight) || lineHeight <= 0) {
		// line-height が "normal" 等で数値化できないときのフォールバック。
		const fontSize = parseFloat(cs.fontSize) || 16;
		lineHeight = fontSize * 1.5;
	}
	const maxHeight = Math.round(lineHeight * MAX_USER_LINES);

	const full = wrap.scrollHeight;
	// scrollHeight が 0 = パネル非表示/幅 0。計測不能なのでクランプしない。
	if (full <= 0) return;
	// 6 行以内（数 px の許容）なら省略不要。トグルも出さない。
	if (full <= maxHeight + 4) return;

	const collapse = () => {
		wrap.addClass("is-clamped");
		wrap.style.maxHeight = `${maxHeight}px`;
	};
	const expand = () => {
		wrap.removeClass("is-clamped");
		wrap.style.maxHeight = "";
	};

	let collapsed = true;
	collapse();

	const toggle = body.createEl("button", {
		cls: "claude-panel-user-clamp-toggle",
		text: t("chat.userClampExpand"),
	});
	toggle.onclick = () => {
		collapsed = !collapsed;
		if (collapsed) collapse();
		else expand();
		toggle.setText(
			collapsed ? t("chat.userClampExpand") : t("chat.userClampCollapse")
		);
		onResize?.();
	};
}
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/chat-message-render.ts
git commit -m "feat: 長いユーザプロンプトを6行に省略しトグルで展開"
```

---

## Task 4: view 側でコールバックを配線

トグル展開/折りたたみで本文の高さが変わったとき、上端固定プロンプトのスペーサーを追従させる。

**Files:**
- Modify: `src/view.ts`（`renderMessages` 内の `renderMessage` 呼び出し ≈719、`onMessageRerender` 内の `renderMessage` 呼び出し ≈868、新規公開メソッド `recomputeActiveSpacer`）

- [ ] **Step 1: `renderMessages` の `renderMessage` 呼び出しにコールバックを渡す**

`src/view.ts` の `renderMessages()` 内の呼び出しを変更する。

変更前:
```ts
			renderMessage(
				host,
				messages[i],
				this.app,
				this,
				(toolUseId, decision) =>
					this.runtime.applyPermissionDecision(toolUseId, decision),
				(answer) => this.sendAskAnswer(answer)
			);
```

変更後:
```ts
			renderMessage(
				host,
				messages[i],
				this.app,
				this,
				(toolUseId, decision) =>
					this.runtime.applyPermissionDecision(toolUseId, decision),
				(answer) => this.sendAskAnswer(answer),
				() => this.recomputeActiveSpacer()
			);
```

- [ ] **Step 2: `onMessageRerender` の `renderMessage` 呼び出しにコールバックを渡す**

`src/view.ts` の `onMessageRerender()` 内の呼び出しを変更する。

変更前:
```ts
			renderMessage(
				host,
				msg,
				this.app,
				this,
				(toolUseId, decision) =>
					this.runtime.applyPermissionDecision(toolUseId, decision),
				(answer) => this.sendAskAnswer(answer)
			);
```

変更後:
```ts
			renderMessage(
				host,
				msg,
				this.app,
				this,
				(toolUseId, decision) =>
					this.runtime.applyPermissionDecision(toolUseId, decision),
				(answer) => this.sendAskAnswer(answer),
				() => this.recomputeActiveSpacer()
			);
```

- [ ] **Step 3: `recomputeActiveSpacer` 公開メソッドを追加**

`src/view.ts` の `refreshActiveSpacer()`（private）メソッドの直後に、公開メソッドを追加する。

```ts
	/** ユーザプロンプトの省略トグルで本文高が変わったとき、上端固定中の
	 *  下端スペーサーを再計算して追従させる（固定対象が無ければ何もしない）。 */
	recomputeActiveSpacer(): void {
		this.refreshActiveSpacer();
	}
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/view.ts
git commit -m "feat: 省略トグルの高さ変化で上端固定スペーサーを再計算"
```

---

## Task 5: CSS を追加

**Files:**
- Modify: `styles.css`（`.claude-panel-msg-user` 関連スタイルの近く、例えば `.claude-panel-msg-user { ... }` ブロックの直後）

- [ ] **Step 1: クランプ・フェード・トグルのスタイルを追加**

`styles.css` の `.claude-panel-msg-user { ... }` ブロック（≈749-751 行）の直後に追加する。

```css
/* 長いユーザプロンプトの省略表示。本文を 6 行ぶん（max-height は JS が
   行高 × 6 をインラインで付与）にクランプし、下端をバブル色へフェードさせる。
   フェード背景はユーザバブル背景 --background-modifier-hover に合わせる。 */
.claude-panel-user-clamp {
	position: relative;
}
.claude-panel-user-clamp.is-clamped {
	overflow: hidden;
}
.claude-panel-user-clamp.is-clamped::after {
	content: "";
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	height: 2em;
	background: linear-gradient(
		transparent,
		var(--background-modifier-hover)
	);
	pointer-events: none;
}
.claude-panel-user-clamp-toggle {
	display: inline-block;
	background: none;
	border: none;
	box-shadow: none;
	padding: 2px 0;
	margin-top: 4px;
	font-size: 12px;
	color: var(--text-muted);
	cursor: pointer;
}
.claude-panel-user-clamp-toggle:hover {
	color: var(--text-normal);
}
```

- [ ] **Step 2: コミット**

```bash
git add styles.css
git commit -m "style: ユーザプロンプト省略表示のスタイルを追加"
```

---

## Task 6: ビルドと手動検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 型チェックとビルド**

Run: `npx tsc --noEmit && npm run build`
Expected: 型エラーなし、`main.js` が vault のプラグインフォルダ（または `./build`）に出力される。

- [ ] **Step 2: Obsidian でプラグインをリロード**

コミュニティプラグインのオン/オフ、または Hot Reload プラグインでリロードする。

- [ ] **Step 3: 手動確認（仕様の各項目を観察）**

以下を Claude パネルで確認する:

1. 6 行を超える長い平文プロンプトを送信 → 本文が 6 行＋下端フェードに省略され、「続きを表示」が出る。
2. 短い平文プロンプト（2〜3 行）→ 変化なし、トグルも出ない。
3. コードブロックや複数段落を含む長いプロンプト → 6 行で崩れずに切れる。
4. 「続きを表示」クリック → 全文展開＋ボタンが「折りたたむ」に変化。再クリックで戻る。
5. 長いプロンプトを送信して応答がストリーミングされても（追記のみ描画）省略状態が維持される。展開後にストリーミングしても展開が維持される。
6. `/clear` 実行後やプラグインリロード後は折りたたみが既定に戻る。
7. 上端固定中の長文プロンプトを展開／折りたたみしてもピン位置・スクロールが破綻しない（スペーサーが追従して下端に過剰な空白が残らない）。
8. Mention チップ・選択 pill 付きの長いプロンプトで、チップは常時表示・本文だけが省略される。

Expected: 上記すべて期待どおり。崩れがあれば該当タスクに戻って修正。

- [ ] **Step 4: 最終確認コミット（コード変更があった場合のみ）**

検証で修正が出た場合は該当ファイルをコミットする。修正不要なら本ステップはスキップ。

---

## Self-Review

- **Spec coverage:**
  - スコープ（user のみ・本文だけ・設定なし）→ Task 3 の user 分岐（チップは clamp 外）でカバー。
  - 方式（JS 計測・max-height・フェード）→ Task 3 `applyUserClamp` ＋ Task 5 CSS。
  - `renderPart` の Promise 化 → Task 2。
  - 計測タイミング（Promise.all 後）→ Task 3 Step 2。
  - line-height フォールバック・scrollHeight 0 ガード → Task 3 Step 3。
  - 状態管理（CSS クラスのみ・データモデル不変・リロードで既定折りたたみ）→ Task 3（ChatMessage 非変更）。
  - CSS（クランプ/フェード/トグル、背景色 --background-modifier-hover）→ Task 5。
  - 上端固定スペーサー追従 → Task 4。
  - i18n キー → Task 1。
  - テスト（手動 ＋ tsc）→ Task 6。
- **Placeholder scan:** プレースホルダなし。全ステップに実コードまたは実コマンドあり。
- **Type consistency:** `applyUserClamp(wrap, body, onResize)`、`renderPart(): Promise<void>`、`renderMessage(..., onUserContentResize?)`、`recomputeActiveSpacer()`、i18n キー `chat.userClampExpand` / `chat.userClampCollapse` — 全タスクで名称一致を確認済み。
