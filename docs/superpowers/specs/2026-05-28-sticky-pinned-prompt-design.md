# 送信プロンプトの最上部スティッキー固定

## 概要

プロンプトを送信して応答待ち(busy)になっている間、直前に送信したユーザーメッセージの吹き出しをスクロール領域の最上部に `position: sticky` で貼り付ける。応答がストリームされる間も「自分が何を頼んだか」が常に見える状態を作り、応答完了で固定を解除して通常表示に戻す。claude.ai / ChatGPT で送信した質問が上端に留まる挙動の踏襲。

## 動機

応答が長くなるとオートスクロールで下端に流れ、ユーザーは自分の送ったプロンプトを見失う。スクロールで戻れば確認できるが、ストリーミング中は最下部に引き戻されるため確認しづらい。送信プロンプトを上端に固定すれば、応答とプロンプトを同時に見ながら待てる。

## スコープ

### 対象

- 応答待ち(busy)中、最後の user ロールメッセージの吹き出しをスクロール領域の最上部に固定する
- 応答完了 / 中断 / エラー / キャンセル(= busy 解除)で固定を解除する
- busy 中の割り込み送信(`inject`)で新しい user メッセージが増えたら、固定対象を新しい方へ付け替える
- 長いプロンプトは固定部分に高さ上限を設け、超過時のみ下端をフェードして省略する

### 対象外

- ON/OFF 設定の追加(要望どおり常時有効でハードコード)
- チャット永続化(`saveChat`/`loadChat`)への保存(純粋な表示状態のみで永続化しない)
- 「次の送信まで固定維持」「常に最後の user を固定」といった別解除ポリシー(応答完了で解除に確定)
- コンパクトバー方式・スクロールのみ方式(吹き出しごと固定に確定)

## 機能仕様

### 固定対象の特定

固定するのは「DOM 上の最後の user ロールメッセージの host 要素」。`renderMessage` が host に `claude-panel-msg` と `claude-panel-msg-user` を付与し、`data-msg-id` も持つ([src/chat-message.ts:132-169](../../../src/chat-message.ts))。host は `renderMessages` 内で `this.messagesEl.createDiv()` した要素そのもの([src/view.ts:660-680](../../../src/view.ts))で、スクロール領域 `.claude-panel-messages`(`overflow-y: auto`)の直接の子なので sticky が効く。

### 固定の適用 / 解除

[src/view.ts](../../../src/view.ts) に `applyPinnedPrompt()` を新設する。処理:

1. 現在 `claude-panel-msg-pinned`(および `is-clipped`)が付いている要素から全てクラスを外す。
2. `runtime.isBusy()` が false なら、ここで終了(= 解除)。
3. busy なら `runtime.getMessages()` から最後の `role === "user"` のメッセージを探し、その `data-msg-id` に対応する host に `claude-panel-msg-pinned` を付与する。
4. 付与した host の本文 `.claude-panel-msg-text` で `scrollHeight > clientHeight`(= 高さ上限で溢れている)なら `is-clipped` も付け、フェードを有効化する。

呼び出し箇所:

| フック | 行 | 目的 |
|---|---|---|
| `onBusyChanged(busy)` | [view.ts:818](../../../src/view.ts) | busy true で固定、false で解除する中心点 |
| `onMessagesChanged()` | [view.ts:794](../../../src/view.ts) | `renderMessages()` で DOM 全再構築した後に再適用(inject / 履歴再描画に追従) |

`onMessageRerender`([view.ts:799](../../../src/view.ts))は host の中身を `empty()` するだけで host 自身のクラスは残るため追加対応は不要。防御的に末尾で `applyPinnedPrompt()` を呼んでもよいが必須ではない。

呼び出し順序は問題ない: `ChatRuntime.send` は user メッセージ追加(`onMessagesChanged`)→ `setBusy(true)`(`onBusyChanged`)の順で発火する([src/chat-runtime.ts:240-242](../../../src/chat-runtime.ts))ため、`onBusyChanged(true)` の時点で固定対象の DOM は既に存在する。

### スタイル

[styles.css](../../../styles.css) に追加する。`.claude-panel-msg-user` は既に不透明背景(`var(--background-modifier-hover)`)を持つ([styles.css:745-747](../../../styles.css))ので、下を流れる本文は透けない。

```css
.claude-panel-msg-pinned {
	position: sticky;
	top: 0;
	z-index: 1;
}

.claude-panel-msg-pinned .claude-panel-msg-text {
	max-height: <5〜6 行相当・実装時に視覚調整>;
	overflow: hidden;
}

/* 高さ上限で溢れているときだけ下端フェード(短いプロンプトには出さない) */
.claude-panel-msg-pinned.is-clipped .claude-panel-msg-text {
	-webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
	        mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
```

高さ上限の具体値は実装時に実際の表示で調整する(目安 5〜6 行)。

## 既知の懸念 / 実装時に詰める点

- **上端の覗き込み**: `.claude-panel-messages` は `padding: 14px` と `gap: 10px` を持つ([styles.css:727-734](../../../styles.css))。`top: 0` 固定だとスクロール時に固定吹き出しの上(padding 領域)へ後続本文が一瞬覗く可能性がある。実装時に `top` の微調整、または固定要素背後を覆う処理で潰す。視覚確認必須。
- **flex 子の sticky**: `.claude-panel-messages` は `display: flex; flex-direction: column`。Obsidian(Electron/Chromium)では flex 子の `position: sticky` は機能するが、実機で必ず確認する。
- **オートスクロール共存**: ストリーミング中の最下部オートスクロール([view.ts:782](../../../src/view.ts) 等)は維持する。上端固定 + 下端追従の同居が狙いどおり動くことを確認する。

## 確認観点(手動)

- 短いプロンプト送信 → 応答中、上端に固定され、フェードが出ないこと。
- 長いプロンプト送信 → 上限で省略 + 下端フェードが出ること。応答完了後に履歴で全文が読めること。
- 応答完了 / Stop / エラーで固定が外れ、通常スクロールに戻ること。
- busy 中の割り込み送信(`inject`)で固定が新しいプロンプトへ付け替わること。
- 上端に後続本文が覗かないこと。
