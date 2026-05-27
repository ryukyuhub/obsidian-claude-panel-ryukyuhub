# トークン消費抑制 — 閾値超え要約バッジ

## 概要

会話が長くなるほど `--resume` 経由で過去履歴が毎ターン再送され、トークン消費が大きくなる。これを抑える第一弾として、コンテキスト使用量が閾値を超えたときにメーター右に控えめな「要約バッジ」を出し、ユーザーがクリックすると Claude 自身に会話を要約させ、その要約だけを引き継いで新セッションを開始する機能を追加する。

## 動機

実装点検で見つかった主な浪費源は、影響度の大きい順に以下:

1. **履歴蓄積 (本スペックで対応)** — `--resume <session_id>` でターンごとにコンテキストが積み上がり、短い質問でも過去の往復全部が再送される ([src/agent.ts:534-545](../../../src/agent.ts), [src/chat-runtime.ts:255-263](../../../src/chat-runtime.ts))。`/clear` でリセット可能だが、心理的コストが高い。
2. 起動時の自動セッション復元 (別スペック)
3. アクティブファイル自動 `@` メンション既定 ON (別スペック)
4. コンテキストメーターの警告がパッシブ (本スペックの一部で改善)

逆にロジック的に問題のない点(SYSTEM_PROMPT_APPENDIX は静的なので prompt cache 有効、添付パスは展開せずリスト化、`No conversation found` 時のリトライは履歴空でやり直すので軽い)は触らない。

## スコープ

### 対象

- コンテキスト使用率が閾値を超えたときに UI 上に要約バッジを出す
- ユーザー操作で「現会話を要約 → クリア → 要約だけ引き継いだ新セッション」のフローを実行する
- 既存の `/clear` フローとは独立した経路として実装する (置き換えではない)

### 対象外

- 過去会話の UI 上のアーカイブ・ブラウザ (別スペック)
- 閾値や要約プロンプトのユーザー設定化 (まずハードコード)
- 自動要約 (常にユーザークリック起点)
- Claude Code CLI の `/compact` 直接呼び出し検証 (できれば最適化として後追い)
- 多言語対応の要約プロンプト (英語固定で十分機能する想定)

## 機能仕様

### バッジ表示ルール

メーターを描画している [src/view.ts:339-373](../../../src/view.ts) の `renderHeader` で、`claude-panel-meter-item` の隣に新しい要約バッジ要素をマウントする。

| 状態 | バッジ | 補足 |
|---|---|---|
| `usage` が `null` または会話が空 | 非表示 | |
| 使用率 < 60% | 非表示 | |
| 60% ≤ 使用率 < 85% | warn 色で表示 (現行 [src/context-meter.ts:71](../../../src/context-meter.ts) の `is-warn` と同系統) | |
| 85% ≤ 使用率 | danger 色で表示 ([src/context-meter.ts:70](../../../src/context-meter.ts) の `is-danger` と同系統) | |
| busy 中 (通常ターン or 要約処理中) | クリック不可 (`pointer-events: none` または `disabled`) | 表示は維持 |

ラベルは「💬 要約して新会話」(`view.summarizeBadge` として i18n キー追加。日本語/英語両方)。絵文字は CLAUDE.md の方針上 UI 表示のみに留め、コードや i18n の鍵名には含めない。

### クリック時のフロー

1. クリック直後に確認モーダル (`Modal` を継承) を表示
   - タイトル: 「会話を要約して新規スタート」
   - 本文: 現在の使用率と、要約後の挙動 (チャット履歴がクリアされ、要約だけが残ること) を 1-2 行で説明
   - ボタン: 「要約して新会話」(mod-cta) / 「キャンセル」
2. Yes を選んだら `ChatRuntime.requestSummaryAndReset(cwd)` を呼ぶ
3. 内部で「要約依頼ターン」を 1 回走らせ、ストリーミング応答を取得
4. 応答 (assistant message の text パート結合) を要約として確保
5. `clear()` で UI / `currentSessionId` を破棄
6. 取得した要約をシステムメッセージ (`role: "system"`) として履歴に挿入
7. `pendingSummary` フィールドにも要約を保持
8. 次の `send()` の `fullPrompt` 先頭に要約ブロックを prepend し、`pendingSummary` を消費

要約依頼の発火中はバッジを「要約中…」スピナー表示にし、通常の busy と同じく送信ボタンも Stop 表示にする。

### 要約依頼プロンプト

英語固定で、ターン中の会話に submitted user message として送る:

```
Summarize this conversation so far in roughly 1500 characters or less.
The summary will be carried into a fresh session as context.
Cover: user's intent, key decisions made, files/paths touched, open questions.
Output only the summary itself — no preamble, no follow-up question.
```

### 新セッション初回 send での prepend フォーマット

```
[Previous conversation summary]
<summary text>

---

<user's actual message body, attachments, selection block, etc.>
```

prepend は `ChatRuntime.send()` 内、`composer.composeMessage()` で組まれた `fullPrompt` をさらに包む形で行う。Composer は会話状態 (要約・セッション継続) を知らないので、prepend の責任は runtime 側に置く。

## アーキテクチャ

### 担当の置き場所

| 責務 | モジュール |
|---|---|
| `pendingSummary` の保持と消費 | [src/chat-runtime.ts](../../../src/chat-runtime.ts) (追記) |
| 要約依頼ターンの実行 (`requestSummaryAndReset`) | [src/chat-runtime.ts](../../../src/chat-runtime.ts) (追記) |
| 要約取得後の `clear()` + システムメッセージ挿入 | [src/chat-runtime.ts](../../../src/chat-runtime.ts) (追記) |
| バッジの DOM とクリックハンドラ | 新規 [src/summary-badge.ts](../../../src/summary-badge.ts) |
| バッジのマウントと「使用率 + busy」の流し込み | [src/view.ts](../../../src/view.ts) (追記) |
| 確認モーダル | 新規もしくは [src/view.ts](../../../src/view.ts) 内のローカル `class extends Modal` |
| i18n キー追加 | [src/i18n](../../../src/i18n) |

### 既存コンポーネントとの境界

- **`ContextMeter` は変更しない**。表示更新の窓口は今まで通り [src/view.ts](../../../src/view.ts) の `onUsageChanged`。同じハンドラから `SummaryBadge.update()` も呼ぶだけ。
- **`Composer` は変更しない**。`pendingSummary` の prepend は `ChatRuntime.send()` 内で `fullPrompt` に対して行う。
- **`runAgent` は変更しない**。要約依頼ターンも通常ターンと同じく `runAgent` を 1 回走らせる。

### `SummaryBadge` の API

```ts
class SummaryBadge {
  constructor(host: HTMLElement, opts: { onClick: () => void });
  /** usageFraction は [0, 1]。null のときは非表示。
   *  isBusy は通常ターンと要約処理の両方を含む「現在ボタン操作不可」。 */
  update(usageFraction: number | null, isBusy: boolean): void;
  /** view の rebuildLocalizedUI で再描画する際に呼ぶ。 */
  dispose(): void;
}
```

ロジック:
- `usageFraction < 0.6` または `null` → host を `is-hidden` クラスでフェード/非表示
- `0.6 ≤ usageFraction < 0.85` → `is-warn` クラス
- `0.85 ≤ usageFraction` → `is-danger` クラス
- `isBusy` → `is-disabled` クラス + クリック無効化

スタイルは [styles.css](../../../styles.css) に既存のメーター色トークンを使い回せるか確認しつつ追加する。

閾値定数 (`0.6` / `0.85`) は [src/context-meter.ts](../../../src/context-meter.ts) のメーター色判定と同じ数値だが、共有モジュールに切り出さず両者に同じリテラルを持たせる。理由: 現状の context-meter の閾値はメーター色専用の意味付け (60% = 黄、85% = 赤) で、要約バッジの「提案を出す境界」とは概念的に別物。将来一方だけ動かす可能性があるため、結合を増やさない。

### `ChatRuntime` の追加 API

```ts
class ChatRuntime {
  // 既存フィールド
  private pendingSummary: string | null = null;
  private summarizing = false;

  /** 要約処理中も「busy 表示」の対象。view の送信ボタン状態判定に使う。 */
  isSummarizing(): boolean;

  /** バッジクリック → 確認モーダル Yes 経路で呼ばれる。
   *  - busy / summarizing 中はノーオペで false を返す
   *  - 内部で要約依頼ターンを 1 回走らせ、応答を取得
   *  - 失敗 (キャンセル / 空応答 / エラー) なら状態を巻き戻して false を返す
   *  - 成功なら clear() → システムメッセージ挿入 → pendingSummary セットして true */
  async requestSummaryAndReset(cwd: string): Promise<boolean>;
}
```

`isBusy()` は内部で `this.busy || this.summarizing` を返すよう改める。これにより view 側の既存の `onBusyChanged` 経路と送信ボタン制御が、要約中も自動的に「Stop 表示」になる。

view 側の `send()` 経路では、要約中かどうかを判別するために `isSummarizing()` を別途参照する。`isBusy()` で弾くと「通常ターン中」と「要約中」が区別できず Notice 文言を切り分けられないため、要約中だけ専用の Notice (`view.summarizingInProgress`) を出して early return する。要約中は `inject` (割り込み) も同じ Notice で弾き、通常ターン中の「割り込み + 新ターン」フローには進ませない。

### `send()` の prepend ポイント

[src/chat-runtime.ts](../../../src/chat-runtime.ts) の `send()` で `composed.fullPrompt` を `runAgent` に渡す直前で、`pendingSummary` があれば以下に置き換える:

```ts
const prompt = this.pendingSummary
  ? `[Previous conversation summary]\n${this.pendingSummary}\n\n---\n\n${composed.fullPrompt}`
  : composed.fullPrompt;
this.pendingSummary = null;
```

`pendingSummary` は 1 度だけ消費される (`--resume` で 2 ターン目以降は session 履歴に乗るので再送不要)。チャットのユーザーバブル本文 (`composed.body`) には要約は乗らない — UI 上のユーザー発言として要約を見せると、ユーザーの実際の入力と見分けがつかなくなるため。要約は新セッション初回ターンの CLI 入力にだけ含める。

### `requestSummaryAndReset` の内部実装メモ

要約依頼を「専用の runtime ヘルパー」として切り出し、`send()` のターン管理ロジック (assistant メッセージ追加 / activeAssistantId / pendingPermissions など) を直接巻き込まないようにする。具体的には:

1. `summarizing = true` をセット → `onBusyChanged(true)` を発火 (送信ボタン更新)
2. `runAgent({ prompt: SUMMARIZE_PROMPT, cwd, settings, sessionId: this.currentSessionId, continueLast: false }, events)` を内部生成のイベントオブジェクトで起動
3. assistant の text パートをローカル変数 `summaryBuf` に蓄積 (UI には流さない / ストリーミングメッセージも作らない)
4. `onResult` で完了したら `summaryBuf.trim()` を要約として確保
5. `summarizing = false` をセット
6. 要約が空文字 or キャンセルなら `Notice` 表示して early return
7. `flushPendingPermissions()` → `messages = []` → `currentSessionId = null` → `pendingContinue = false` → `lastUsage = null` (これは既存 `clear()` と同じ流れ)
8. システムメッセージとして「以前の会話を要約しました」+ 要約本文を履歴に追加
9. `pendingSummary = summaryBuf` をセット
10. `host.onMessagesChanged()` / `host.onUsageChanged(null)` で UI を更新

要約処理中はストリーミングメッセージを作らないので、チャット UI 上には何も表示されない。代わりにバッジ自体を「要約中…」スピナーにすることで進行状況を示す。

## エラーハンドリング

| 事象 | 挙動 |
|---|---|
| 要約ストリーミング中に ESC / Stop で中断 | `pendingSummary` を立てず、`clear()` もしない (現状の会話を保持) |
| 応答が空文字 / 空白のみ | `Notice` で「要約に失敗しました。会話はそのまま続行します」を出して何もしない |
| `runAgent` が `onError` を発火 | 同上 |
| 要約処理中にユーザーが通常 send | `Notice` で「要約処理中です」を出して弾く。 `inject` (割り込み) も無効 |
| 要約処理中にバッジを再クリック | `summarizing` 中は disabled なので発火しない |
| 新セッション初回 send で CLI エラー | 通常の `send` と同じく `chatRuntime` のリトライ経路。`pendingSummary` は既に消費済みなので 2 重 prepend は起きない |
| バッジクリック時点で会話が空になっていた (他要因) | 確認モーダルは表示しないか、Yes でも `requestSummaryAndReset` 側で早期 return |

## テスト戦略

このプラグインはテストスイートが無いので、手動検証手順を以下にまとめる ([CLAUDE.md](../../../CLAUDE.md) の「テストスイート、Lint 設定、型チェックスクリプトはいずれも存在しない」方針)。`npx tsc --noEmit` での型チェックは PR 前に通すこと。

### 手動検証チェックリスト

1. **発火閾値**: 長文を貼って `lastUsage` が 60% / 85% を跨ぐようにし、バッジの表示有無と色 (`is-warn` / `is-danger`) が切り替わるか
2. **要約フロー (Happy Path)**:
   - 60% 超の状態でバッジをクリック → 確認モーダル → Yes
   - 要約中はバッジが「要約中…」表示、送信ボタンが Stop 表示
   - 完了後にチャット履歴がシステムメッセージ 1 件 (要約) だけになる
   - 次に通常メッセージを送ると、`fullPrompt` の先頭に `[Previous conversation summary]` ブロックが入る (`npm run dev` のコンソールで stream-json の payload を確認)
3. **中断**: 要約ストリーミング中に ESC で止めて、元の会話と `currentSessionId` が保たれているか
4. **空応答**: 要約依頼に対して空の応答が来た場合 (テスト用にプロンプトを差し替えて再現) に `Notice` が出て、会話が保たれるか
5. **境界**: `usage = null` / 100% 超 / `inputTokens = 0` などでクラッシュしないか
6. **busy 中**: 通常ターン進行中はバッジが disabled、押せないか
7. **再起動**: 要約後に Obsidian を再起動して `/continue` 自動復元が「要約だけの新セッション」を拾うか (新セッションの jsonl が `~/.claude/projects/<encoded-cwd>/` に書かれていることを確認)
8. **i18n**: 日本語/英語の両方でバッジラベル・モーダル文言が出るか

## 関連

- 別途進める予定の改善 (本スペックの対象外):
  - 起動時自動セッション復元の挙動見直し (新規スタートを既定にする選択肢の追加)
  - アクティブファイル自動 `@` メンションの既定値・配信タイミング見直し
  - 過去会話を UI から再ロードするブラウザ
