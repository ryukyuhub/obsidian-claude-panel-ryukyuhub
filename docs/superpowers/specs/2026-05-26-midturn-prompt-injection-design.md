# ターン中プロンプト割り込み (Interrupt + 即送信) — Design

## 背景

現状、アシスタントの応答がストリーミング中 (busy) にユーザーが新しいプロンプトを送ると、`queuedTurn` に保持され、現ターン完了 (`onResult` → `onBusyChanged(false)`) を待ってから `--resume` 付きで新規 subprocess として送られる。これは「次ターンキュー」であって、ユーザーが意図する「ターン中の割り込み」とは異なる。

VS Code 版 Claude Code 拡張のように、ユーザーがアシスタント応答中に新しい指示を打って送信した瞬間、進行中の生成を停止して新プロンプトで即やり直す挙動を実現する。

## ゴール

- アシスタント応答中でも、ユーザーは即座に新プロンプトを送信して現ターンに割り込める
- 既存の subprocess / セッション ID をそのまま使い、`--resume` による再起動オーバーヘッドを発生させない
- 割り込まれた部分応答は会話履歴に残し、「(中断)」と一目で分かる視覚バッジを付ける

## 非ゴール

- 「割り込まず次ターンへキュー」UI の温存。常に割り込みに統一する (ユーザー判断)
- アシスタント生成中の「追記」(キャンセルせず文脈を追加) のサポート。割り込み一択

## ユーザー体験

### 送信ボタンの状態 (busy 中)

| 状態 | ボタンラベル | クラス | 動作 |
|---|---|---|---|
| !busy | 送信 | mod-cta | 通常送信 (新ターン) |
| busy + textarea 空 | 停止 | mod-warning | 現ランを kill (SIGTERM → SIGKILL) |
| busy + textarea に入力 | **割り込み** | mod-cta | interrupt + 新プロンプト送信 |

### 部分応答の扱い

- 割り込み発火時、メッセージ DOM に `is-interrupted` クラスを付与
- メッセージヘッダー (`.claude-panel-msg-role`) の末尾に小さな「中断」バッジ (灰色ピル) を表示
- 部分テキスト・ツール呼び出し pill はそのまま残す (削除しない)
- フッター (`.claude-panel-msg-footer`) は通常通り `done in Xms · $Y` が出る (interrupted 時もコストは発生しているはず — CLI 側の `result` イベントで報告される)

## アーキテクチャ

### CLI 通信プロトコル

`claude --input-format stream-json --output-format stream-json --verbose` モード下では、stdin/stdout 双方が改行区切り JSON で会話する。サポートするメッセージ:

- stdin → CLI:
  - `{ type: "control_request", request_id, request: { subtype: "interrupt" } }` — 現生成を中断
  - `{ type: "user", session_id: "", parent_tool_use_id: null, message: { role, content } }` — ユーザーメッセージ
  - `{ type: "control_response", ... }` — 既存の permission 応答
- CLI → stdout:
  - 既存の `assistant`, `result`, `control_request`, `control_response`, `rate_limit_event` ...
  - 割り込み時の `result` イベントは `subtype: "interrupted"` (もしくは類似) が入る想定 — 実装中に確認

### 変更コンポーネント

#### [src/agent.ts](src/agent.ts) — サブプロセスレイヤー

**追加:**

```ts
export interface RunHandle {
    promise: Promise<void>;
    cancel: () => void;
    canceled: () => boolean;
    /** 進行中の生成を中断し、続けて新しいユーザーメッセージを同じ stdin に
     *  書き込む。CLI は同一セッションでそのまま次ターンを生成する。 */
    inject: (prompt: string) => void;
}
```

**`inject` の責務:**

1. `child.stdin` に `control_request { subtype: "interrupt" }` を書く
2. 続けて `user` メッセージを書く
3. `eventsWithEnd` の状態を「interrupt 中」にして、直後に来る `result { subtype: "interrupted" }` では stdin を閉じないようにする

**`eventsWithEnd` の変更:**

現状は `onResult` で必ず `child.stdin.end()` を呼ぶ。これを「interrupt フラグが立っているときはスキップ」する分岐に書き換える。

```ts
let interruptInFlight = false;
const eventsWithEnd: AgentEvents = {
    ...events,
    onResult: (info) => {
        events.onResult(info);
        if (interruptInFlight) {
            // interrupt によって発火した result。stdin は開けておく。
            interruptInFlight = false;
            return;
        }
        try { childRef.stdin?.end(); } catch { /* noop */ }
    },
};
```

`inject` 内で `interruptInFlight = true` をセットしてから書き込む。

#### [src/view.ts](src/view.ts) — UI レイヤー

**削除:**

- `queuedTurn` フィールド
- `queuedStrip`, `queuedTextEl` 要素および `renderComposer` 内の生成コード
- `cancelQueue()`, `refreshQueuedStrip()` メソッド
- `onBusyChanged` 内の queued 自動発火ロジック

**変更:**

- `refreshSendBtn`: busy + hasText のときラベルを `view.queueBtn` (`次のターンへ`) ではなく `view.interruptBtn` (`割り込み`) にする
- `send()` (または同等): busy 中なら `runtime.send` ではなく `runtime.inject` を呼ぶ
- 割り込み発火時、進行中のアシスタントメッセージ DOM に `is-interrupted` クラスを付与

#### [src/chat-runtime.ts](src/chat-runtime.ts) — 会話エンジン

**追加:**

- `inject(text, composed)`: 現 `RunHandle` に対して `inject(prompt)` を呼ぶ。失敗時 (run なし、または stdin 閉鎖済み) は通常の `send()` にフォールバック
- 割り込み発火時に「進行中のアシスタントメッセージ」をマーキングするコールバックをホスト側に通知

#### [src/chat-message.ts](src/chat-message.ts)

**追加:**

- `ChatMessage` 型に `interrupted?: boolean` を持たせる (永続化対象ではないので runtime-only でも可)
- レンダラーで `interrupted` が true のとき、role バッジ横に `claude-panel-interrupted-badge` を出す

#### [styles.css](styles.css)

**削除:**

- `.claude-panel-queued-strip`, `.claude-panel-queued-text`, `.claude-panel-queued-cancel` 関連 (`is-hidden` 含む)

**追加:**

```css
.claude-panel-interrupted-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    background: var(--background-modifier-hover);
    border: 1px solid var(--background-modifier-border);
}

.claude-panel-msg.is-interrupted {
    opacity: 0.85;
}
```

#### [src/i18n/](src/i18n/) — ロケール文言

- `view.queueBtn` (`次のターンへ`) を `view.interruptBtn` (`割り込み`) に置き換え
- `view.queuedLabel`, `view.queuedNotice`, `view.queuedCancelAria` を削除
- `chat.interruptedBadge` を新設 (`中断`)

## エラー処理

| ケース | 振る舞い |
|---|---|
| CLI が interrupt 受信後にプロセス死亡 | `onError` → エラーメッセージ表示。新プロンプトは送らずユーザー入力を保持。 |
| Permission リクエスト pending 中の割り込み | 自動で deny (interrupt フラグ付き) → interrupt 送信 → 新プロンプト送信 |
| 割り込み連打 (前 inject 完了前に再度) | 「割り込み」ボタンを inject 完了 (新 user メッセージが書かれた瞬間) まで disable |
| stdin がすでに閉じられている | `inject` は早期 return + console.warn。`send()` (新規 run) にフォールバック |

## テスト計画

このプラグインはテストスイートがない (CLAUDE.md 参照)。手動 QA で以下を確認する:

1. **基本フロー:** プロンプト送信 → 応答中に新プロンプト送信 → 部分応答が「(中断)」になり、新プロンプトで生成が始まる
2. **連打:** 短い応答を割り込みで連発 → エラーにならず順次処理される
3. **Permission 中の割り込み:** ツール承認ダイアログが出ている間に新プロンプト送信 → deny + interrupt が連動
4. **Stop ボタン:** busy + 空 textarea で「停止」を押す → 従来通りプロセス終了
5. **長文割り込み:** マークダウン整形完了直前で割り込み → 部分応答が pre-wrap で残り、新ターンが正しく続く
6. **セッション継続:** 割り込み後の続きのターンで `--resume` が走らないこと (同一 subprocess) を verbose ログで確認

## 不明点 / 実装中に詰める

1. CLI の interrupt control_request 後の正確な出力フォーマット
   - `result { subtype: "interrupted" }` が来るのか、`result` 自体が来ないのか
   - usage / cost フィールドは入るのか
2. interrupt 後すぐに `user` メッセージを書いても CLI が受理するか、ack を待つ必要があるか

これらは実装中に `--verbose` ログを観察して動作確認する。

## ロールバック計画

リスクが高いので feature flag 化はせず、シンプルにブランチで作業 → 動作確認 → コミットの順で進める。問題があれば revert で戻す。
