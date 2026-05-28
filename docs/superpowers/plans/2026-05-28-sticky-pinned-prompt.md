# 送信プロンプト最上部スティッキー固定 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 応答待ち(busy)中、直前に送信したユーザーメッセージの吹き出しをスクロール領域の最上部に sticky 固定し、応答完了で解除する。

**Architecture:** 純粋な表示状態。`ChatPanelView` に `applyPinnedPrompt()` を追加し、busy 中だけ最後の user メッセージ host に `claude-panel-msg-pinned` クラスを付ける。クラスは CSS で `position: sticky; top: 0` と高さ上限・下端フェードを担う。`onBusyChanged`(busy 切替)と `onMessagesChanged`(DOM 全再構築後)から呼ぶ。

**Tech Stack:** TypeScript (strict), Obsidian API (`ItemView`, augmented `HTMLElement`)、esbuild、プレーン CSS。

**テスト方針:** 本プロジェクトにはテストランナー・テストスイートが存在しない(CLAUDE.md 参照)。本機能は Obsidian の DOM/CSS 表示挙動であり、ユニットテスト基盤の新規導入はスコープ外。各タスクの検証は `npx tsc --noEmit`(型)+ `npm run build`(ビルド成功)+ Obsidian 実機での手動確認で行う。手動確認観点は spec の「確認観点」に従う。

参照 spec: [docs/superpowers/specs/2026-05-28-sticky-pinned-prompt-design.md](../specs/2026-05-28-sticky-pinned-prompt-design.md)

---

## ファイル構成

- 変更: `styles.css` — `.claude-panel-msg-pinned` と `.is-clipped` のスタイルを追記(`.claude-panel-msg-user` の定義近く)。
- 変更: `src/view.ts` — `applyPinnedPrompt()` メソッド新設、`onBusyChanged` と `onMessagesChanged` に呼び出しを追加。

他ファイルへの影響なし。永続化(`saveChat`/`loadChat`)・ランタイム(`src/chat-runtime.ts`)は変更しない。

---

## Task 1: 固定用 CSS を追加する

**Files:**
- Modify: `styles.css`(`.claude-panel-msg-user` 定義 = 745-747 行付近の直後に追記)

- [ ] **Step 1: CSS を追記する**

`styles.css` の `.claude-panel-msg-user { ... }` ブロックの直後に、以下を挿入する:

```css
/* 応答待ち中、送信したプロンプト吹き出しをスクロール領域の最上部に固定する。
   user 吹き出しは不透明背景を持つので、下を流れる本文は透けない。 */
.claude-panel-msg-pinned {
	position: sticky;
	top: 0;
	z-index: 1;
}

/* 長いプロンプトは数行で打ち切る。 */
.claude-panel-msg-pinned .claude-panel-msg-text {
	max-height: 7.5em;
	overflow: hidden;
}

/* 高さ上限で溢れているときだけ下端をフェードして「続きがある」ことを示す。
   短いプロンプトには出さない(is-clipped は JS が溢れ判定して付ける)。 */
.claude-panel-msg-pinned.is-clipped .claude-panel-msg-text {
	-webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
	        mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
```

- [ ] **Step 2: ビルドが通ることを確認する**

Run: `npm run build`
Expected: エラーなく完了し、`main.js` / `styles.css` が出力される。

- [ ] **Step 3: コミット**

```bash
git add styles.css
git commit -m "style: 送信プロンプト固定用のスティッキー/省略スタイルを追加"
```

---

## Task 2: `applyPinnedPrompt()` を実装する

**Files:**
- Modify: `src/view.ts`(`onMessageRerender` メソッド = 799-815 行の直後、`onBusyChanged` の直前あたりに新メソッドを追加)

- [ ] **Step 1: メソッドを追加する**

`src/view.ts` の `onMessageRerender(...)` の閉じ `}`(815 行)の直後に、以下のメソッドを挿入する:

```ts
	/** busy 中だけ、最後の user メッセージ吹き出しをスクロール領域の最上部に
	 *  sticky 固定する。応答完了(busy 解除)で外す。長いプロンプトは CSS の
	 *  max-height で打ち切り、実際に溢れている場合のみ is-clipped を付けて
	 *  下端フェードを出す(短いプロンプトには不要なフェードを出さないため、
	 *  scrollHeight > clientHeight を JS で判定する)。 */
	private applyPinnedPrompt(): void {
		// 既存の固定をすべて解除してから付け直す(対象の付け替え・解除を一本化)。
		this.messagesEl
			.querySelectorAll<HTMLElement>(".claude-panel-msg-pinned")
			.forEach((el) => {
				el.removeClass("claude-panel-msg-pinned");
				el.removeClass("is-clipped");
			});

		if (!this.runtime?.isBusy()) return;

		const messages = this.runtime.getMessages();
		let lastUserId: string | null = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserId = messages[i].id;
				break;
			}
		}
		if (!lastUserId) return;

		const host = this.messagesEl.querySelector(
			`[data-msg-id="${lastUserId}"]`
		) as HTMLElement | null;
		if (!host) return;

		host.addClass("claude-panel-msg-pinned");
		// clientHeight を読むと reflow が起き、直前に付けた max-height が反映される。
		const body = host.querySelector(
			".claude-panel-msg-text"
		) as HTMLElement | null;
		if (body && body.scrollHeight > body.clientHeight) {
			host.addClass("is-clipped");
		}
	}
```

- [ ] **Step 2: 型チェックが通ることを確認する**

Run: `npx tsc --noEmit`
Expected: エラーなし。`applyPinnedPrompt` はまだ呼ばれていないが、未使用 private メソッドは `noUnusedLocals` 非依存のため型エラーにはならない(本リポジトリは未設定)。エラーが出る場合は次タスクの配線まで一括で行ってから再確認する。

- [ ] **Step 3: コミットは次タスクとまとめる**

このタスク単体ではコミットしない(配線まで含めて Task 3 で 1 コミットにする)。

---

## Task 3: busy 切替と DOM 再構築のフックに配線する

**Files:**
- Modify: `src/view.ts`(`onMessagesChanged` = 794-796 行、`onBusyChanged` = 818-825 行)

- [ ] **Step 1: `onMessagesChanged` で再適用する**

現在の実装:

```ts
	onMessagesChanged(): void {
		this.renderMessages();
	}
```

を、以下に変更する(DOM 全再構築後に固定を貼り直す。inject による新プロンプト追加や履歴再描画に追従するため):

```ts
	onMessagesChanged(): void {
		this.renderMessages();
		this.applyPinnedPrompt();
	}
```

- [ ] **Step 2: `onBusyChanged` で固定/解除する**

現在の実装:

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

を、末尾に固定処理を足した以下に変更する:

```ts
	onBusyChanged(busy: boolean): void {
		this.refreshSendBtn();
		this.summaryBadge?.update(
			this.toUsageFraction(this.runtime?.getLastUsage() ?? null),
			busy
		);
		this.summaryBadge?.setSummarizing(this.runtime?.isSummarizing() ?? false);
		// busy 開始で最後の user プロンプトを固定、busy 解除で外す。
		this.applyPinnedPrompt();
	}
```

- [ ] **Step 3: 型チェックとビルドが通ることを確認する**

Run: `npx tsc --noEmit && npm run build`
Expected: 両方ともエラーなし。`applyPinnedPrompt` が参照され、未使用警告も出ない。

- [ ] **Step 4: コミット**

```bash
git add src/view.ts
git commit -m "view: 応答待ち中に送信プロンプトを最上部へ固定"
```

---

## Task 4: Obsidian 実機で手動確認し、高さ上限と上端覗き込みを詰める

**Files:**
- (必要なら) Modify: `styles.css`(`max-height` 値、`top` 微調整など視覚調整)

- [ ] **Step 1: dev ビルドを起動してプラグインをリロードする**

Run: `npm run dev`
その後 Obsidian でプラグインをオフ→オンで再読み込み(または Hot Reload)。

- [ ] **Step 2: 短いプロンプトを確認する**

1 行の短いプロンプトを送信。応答ストリーミング中に:
- プロンプト吹き出しがスクロール領域の最上部に貼り付くこと。
- 下端フェード(`is-clipped`)が**出ない**こと。
- 応答テキストは下端へオートスクロールで追従し、プロンプトと同時に見えること。

- [ ] **Step 3: 長いプロンプトを確認する**

10 行以上の長いプロンプトを送信。応答中に:
- 固定吹き出しが `max-height`(7.5em)で打ち切られ、下端フェードが出ること。
- 応答完了後、履歴上で同じプロンプトの**全文**が読めること(固定解除後は省略されない)。
- フェード位置・高さが不自然なら `styles.css` の `max-height` / mask の `70%` を調整する。

- [ ] **Step 4: 解除タイミングを確認する**

- 応答が正常完了したら固定が外れ、通常スクロールに戻ること。
- 応答中に Stop(送信ボタン)で中断 → 固定が外れること。
- (可能なら)エラー発生時も固定が外れること。

- [ ] **Step 5: 割り込み送信(inject)を確認する**

応答ストリーミング中に textarea へ入力して送信(割り込み)。
- 固定対象が**新しい**プロンプトへ付け替わること(古いプロンプトの固定が残らないこと)。

- [ ] **Step 6: 上端の覗き込みを確認する**

スクロール領域を上下にスクロールし、固定吹き出しの**上**(`.claude-panel-messages` の padding 14px 領域)に後続本文が覗かないことを確認する。覗く場合は以下のいずれかで対処:
- 固定要素に上方向の覆い背景を持たせる(例: `.claude-panel-msg-pinned` に `box-shadow: 0 -14px 0 var(--background-primary)` 相当、または `::before` で上を塗る)。
- もしくは `.claude-panel-messages` の `padding-top` を 0 にして内側ラッパに padding を移す。
採用した対処に応じて `styles.css`(必要なら `src/view.ts`)を最小修正する。

- [ ] **Step 7: 調整があればコミット**

視覚調整で `styles.css` 等を変更した場合のみ:

```bash
git add styles.css
git commit -m "style: 固定プロンプトの高さ・上端覗き込みを実機調整"
```

変更がなければコミット不要。

---

## Self-Review(計画作成者による確認)

- **spec カバレッジ**:
  - 固定対象=最後の user メッセージ → Task 2。
  - busy true で固定 / false で解除 → Task 3(onBusyChanged)。
  - inject で付け替え → Task 3(onMessagesChanged)+ Task 4 Step 5 で確認。
  - 高さ上限 + 溢れ時のみフェード → Task 1(CSS)+ Task 2(is-clipped 判定)。
  - 上端覗き込みの懸念 → Task 4 Step 6。
  - オートスクロール共存 → 既存挙動を変更せず維持(明示的な変更なし)、Task 4 Step 2 で確認。
  - 永続化非対象 → どのタスクも `saveChat`/`loadChat` を触らない。
- **プレースホルダ**: コード手順はすべて実コードを記載。`max-height: 7.5em` は具体値を置いた上で Task 4 で視覚調整する手順を明示。
- **型・名称整合**: `applyPinnedPrompt`(全タスク同名)、クラス名 `claude-panel-msg-pinned` / `is-clipped`(CSS と JS で一致)、`runtime.getMessages()` / `runtime.isBusy()`(既存 API)を使用。
