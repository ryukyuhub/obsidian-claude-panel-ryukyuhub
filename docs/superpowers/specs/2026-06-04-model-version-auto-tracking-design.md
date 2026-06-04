# モデル表記の自動追従 — 設計

## 背景・課題

`MODEL_PRESETS`（[src/settings/types.ts](../../../src/settings/types.ts)）にモデルのバージョン番号がハードコードされている（`claude-opus-4-7` 等）。Anthropic が Opus 4.8 をリリースしても、UI はリクエスト時のハードコード文字列（`formatModelLabel` が生成する `opus 4.7`）を表示し続ける。一方 CLI は旧 ID を最新（4.8）へ解決して実行しており、**表示と実行が乖離**している。

ゴール: モデルのバージョンアップに**コード変更なしで自動追従**し、UI に**実際に走ったモデル**を表示する。

## 方針

1. プリセットを正規 ID からエイリアス（`opus` / `sonnet` / `haiku`）へ変更し、CLI に常に最新を解決させる。
2. assistant ストリームが返す解決後の正規 ID を捕捉し、応答フッターに実モデルを表示する。

ドロップダウン自体はバージョン番号を持たず `sonnet` / `opus` / `haiku` 表示になる。実バージョンは応答フッターにのみ出す（ユーザー要望）。

## 変更コンポーネント

### 1. プリセットのエイリアス化 — [src/settings/types.ts](../../../src/settings/types.ts)

```ts
export const MODEL_PRESETS: string[] = ["sonnet", "opus", "haiku"];
```

`DEFAULT_SETTINGS.model` を `"claude-sonnet-4-6"` → `"sonnet"` に変更。

`/model <任意ID>` は自由入力を受け付ける（[src/slash-commands.ts:304](../../../src/slash-commands.ts)）ため、特定バージョンへのピン留めは `/model claude-opus-4-7` で従来どおり可能。

### 2. 既存ユーザーの移行 — [src/main.ts](../../../src/main.ts) `loadSettings`

保存済み `settings.model` が**旧プリセットの 3 文字列そのもの**のときだけエイリアスへ正規化する:

| 旧 ID | 新エイリアス |
| --- | --- |
| `claude-sonnet-4-6` | `sonnet` |
| `claude-opus-4-7` | `opus` |
| `claude-haiku-4-5` | `haiku` |

それ以外（ユーザーが `/model` で意図的にピン留めした ID）は触らない。意図的なピン留めを壊さないための限定的な移行。`loadData` 後・`runtimeSaveAttachmentsToVault` 設定前に行う。

### 3. 実行モデルの捕捉 — [src/agent.ts](../../../src/agent.ts)

- `AssistantStreamMessage.message` 型（[agent.ts:179](../../../src/agent.ts)）に `model?: string` を追加。CLI は assistant ストリームに解決後の正規 ID（例 `claude-opus-4-8`）を流す。
- `AgentEvents` に `onModel?: (model: string) => void` を追加。
- `handleStreamLine` の assistant 分岐で `msg.message?.model` が文字列なら `events.onModel?.(...)` を発火。

### 4. RunResult への伝搬とフッター描画

- [src/chat-message.ts](../../../src/chat-message.ts) `RunResult` に `model?: string` を追加。
- [src/chat-runtime.ts](../../../src/chat-runtime.ts): 既存の `lastRunUsage` と同じ要領でラン内ローカル `lastRunModel` を保持。`onModel` でセットし、`onResult` 時に `setMessageResult` の `RunResult` へ含める。
- [src/chat-message-render.ts:962](../../../src/chat-message-render.ts) `renderResultFooter`: `r.model` があれば `formatModelLabel(r.model)` を先頭セグメントとして追加。
  - 例: `opus 4.8 · 完了 · 1.2秒 · 1,234 tokens · $0.0312`
  - `model` 不在時は従来どおり省略。
  - `formatModelLabel` はフル ID → `opus 4.8` 変換に既に対応済みのため流用（[src/settings/labels.ts:60](../../../src/settings/labels.ts)）。

### 5. i18n — [src/i18n/ja.ts](../../../src/i18n/ja.ts) / [src/i18n/en.ts](../../../src/i18n/en.ts)

`footerComplete` に先頭の `modelText` セグメントを追加（ja/en 両方）。`modelText` は呼び出し側で `r.model ? formatModelLabel(r.model) + " · " : ""` として構築。

## データフロー

```
claude CLI (--model opus)
  → stream-json assistant: { message: { model: "claude-opus-4-8", ... } }
    → handleStreamLine → events.onModel("claude-opus-4-8")
      → chat-runtime: lastRunModel = "claude-opus-4-8"
  → stream-json result: { duration_ms, total_cost_usd, ... }
    → events.onResult(...)
      → setMessageResult(id, { durationMs, costUsd, model: lastRunModel })
        → msg.result.model
          → finalizeStreamingMessage → renderResultFooter
            → "opus 4.8 · 完了 · ..."
```

## エラー / エッジケース

- **model 不在**: 古い CLI 等で `message.model` が来ない場合、フッターはモデル無しで従来表示。
- **マルチ assistant ターン**: 1 ラン内でモデルは一定。最後に見た model をランの結果に付与する（既存 `lastRunUsage` と同パターン）。
- **カスタムピン**: ユーザーが `/model claude-opus-4-8` 等を入力 → CLI が実行 → ストリームが同 ID を返す → フッターに `opus 4.8`。ドロップダウンは `(custom)` 表示。

## テスト / 検証

テストスイートが無いプロジェクトのため、`superpowers:verification-before-completion` に従い実コマンドで確認:

1. `npx tsc --noEmit` で型チェック（esbuild は型チェックしない）。
2. `npm run build` でビルド成功。
3. 実機（Obsidian）でプロンプト送信 → 応答フッターに実モデル（`opus 4.8` 等）が出ることを確認。
4. 既存設定（`claude-opus-4-7` 保存済み）が `opus` に移行されること、ドロップダウンが正しく選択状態になることを確認。

## スコープ外（YAGNI）

- ドロップダウン／設定タブ／`/model` ノーティスへの実バージョン表示（今回は応答フッターのみ）。
- 解決済みモデルのキャッシュ永続化。
