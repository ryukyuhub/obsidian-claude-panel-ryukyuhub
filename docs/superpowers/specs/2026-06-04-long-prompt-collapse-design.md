# 長いユーザプロンプトの省略表示

## 目的

ユーザが打ったプロンプトが長いと、チャット履歴で大きな縦スペースを占める。特に
送信直後のプロンプトは `.claude-panel-prompt-pinned` で上端に sticky 固定されるため、
長文だと画面上部を圧迫する。長いユーザメッセージを既定で 6 行に省略表示し、クリックで
全文展開できるようにする。

## スコープ

- 対象は `role === "user"` のメッセージのみ（アシスタント／システムは対象外）。
- 省略するのは本文（散文）だけ。Mention チップ・選択参照 pill は常時表示のまま残す。
- 設定項目は追加しない（しきい値 6 行は固定、機能は常時 ON）。

## 方式

JS で実際の高さを計測してクランプする（純粋 CSS の `-webkit-line-clamp` は採用しない）。
ユーザ本文は `MarkdownRenderer` で段落・コードブロックなど複数ブロックに展開され得るため、
`line-clamp` では 6 行で確実に切れない。`max-height`（行高 × 6）＋ `overflow:hidden` ＋
下端フェードなら構造に依存せず確実に省略できる。

## 描画の変更（[src/chat-message-render.ts](../../../src/chat-message-render.ts)）

### `renderPart` を `Promise<void>` 返しにする

現状の `renderPart` はマークダウン描画を `void MarkdownRenderer.render(...).then(...)` で
撃ちっぱなしにしている。これを `Promise<void>` を返すよう変更する。

- `text` part: `MarkdownRenderer.render(...)`（および後続の linkify などを含む）の promise を返す。
  ストリーミング中（プレーンテキスト分岐）は解決済み promise を返す。
- `tool` / `permission` part: 同期描画なので解決済み promise を返す。

呼び出し元は `renderMessage` 内の 1 箇所のみ（`grep` で確認済み）なので影響は局所的。

### `renderMessage` の user 分岐

`role === "user"` かつ `msg.interactive` でないとき:

1. 本文 `body` 内に、チップ（refs）の **後ろ** へ専用ラッパ
   `.claude-panel-user-clamp` を作り、テキスト part 群をその中へ描画する。
   チップはラッパの外（上）に置き、省略対象に含めない。
2. 各 `renderPart` の返す promise を集め、`Promise.all(...)` の解決後に
   クランプ判定 `applyUserClamp(wrap)` を呼ぶ（マークダウンが実 DOM に
   入った後に測るため）。

user 以外（assistant / system）は従来どおり `body` 直下に描画し、ラッパを挟まない。

### `applyUserClamp(wrap: HTMLElement)`

新規ヘルパー。マークダウン確定後に呼ばれる。

1. `getComputedStyle(wrap).lineHeight` から 1 行の px を得る。`"normal"` の場合は
   `fontSize * 1.5` にフォールバックする。
2. `maxHeightPx = lineHeightPx * 6` を算出。
3. `wrap.scrollHeight` を測る。`0`（パネル非表示・幅 0）のときは何もしない。
4. `scrollHeight <= maxHeightPx + EPSILON`（EPSILON は数 px の許容）なら何もしない
   （クランプもトグルも付けない）。
5. はみ出していれば:
   - `wrap` のインラインスタイルに `max-height: ${maxHeightPx}px` を設定し、
     `is-clamped` クラスを付ける（CSS 側で `overflow:hidden` ＋ フェード）。
   - `wrap` の直後に `.claude-panel-user-clamp-toggle` ボタンを追加。文言は
     折りたたみ時「続きを表示」／展開時「折りたたむ」。
   - クリックで `is-clamped` クラスと `max-height` インラインスタイルをセットで
     付け外しし、ボタン文言を切り替える。展開時は両方を外し（全文表示）、
     再折りたたみ時は両方を付け直す。

## 状態管理

クリック時の CSS クラス切替のみで完結し、`ChatMessage` データモデルは変更しない。

- 追記のみ描画（`renderMessages` の append-only 経路）では既存ユーザメッセージを
  再描画しないため、セッション中は展開状態が DOM に保持される。
- 全再構築（`/clear`・要約リセット・リロード・セッション復元）では折りたたみに戻る。
  これは要件「リロード後は折りたたみが既定」と一致する。

## CSS（[styles.css](../../../styles.css)）

```css
.claude-panel-user-clamp {
	position: relative;
}
.claude-panel-user-clamp.is-clamped {
	overflow: hidden;
	/* max-height は JS がインラインで付与（行高 × 6） */
}
.claude-panel-user-clamp.is-clamped::after {
	/* 下端フェード。背景はユーザバブル色 --background-modifier-hover に合わせる */
	content: "";
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	height: 2em;
	background: linear-gradient(transparent, var(--background-modifier-hover));
	pointer-events: none;
}
.claude-panel-user-clamp-toggle {
	background: none;
	border: none;
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

フェードの背景色は user バブルの背景 `--background-modifier-hover`（[styles.css](../../../styles.css) の
`.claude-panel-msg-user`）に合わせる。

## 上端固定プロンプト／スペーサーとの関係

- 折りたたみで送信直後プロンプトが短くなるのは縦スペース的に有利。
- 展開／折りたたみで高さが変わるため、トグルのクリックハンドラ末尾で既存の
  プロンプト追従ロジック（`updatePromptPin` 相当 ／ bottom-spacer 高さ再計算）を
  一度呼び、ピン位置がズレないようにする。`renderMessage` は view を知らないため、
  必要なら view 側で再計算するコールバックを渡すか、`scroll` イベントを軽く発火させる
  などの最小手段で対応する（実装計画で確定）。

## i18n

トグル文言「続きを表示」「折りたたむ」は [src/i18n](../../../src/i18n) の仕組みに合わせて
キーを追加する（既存の `t("...")` 呼び出しと同じ流儀）。

## テスト

テストスイート・Lint・型チェックスクリプトは存在しない。検証は手動 ＋ `npx tsc --noEmit`。

手動確認項目:

1. 6 行を超える平文プロンプト → 6 行＋下端フェード＋「続きを表示」に省略される。
2. 短い平文プロンプト → 変化なし（トグルも出ない）。
3. コードブロックや複数段落を含むプロンプト → 6 行で崩れずに切れる。
4. 「続きを表示」クリック → 全文展開＋「折りたたむ」に変化。再クリックで戻る。
5. 展開状態でストリーミング応答が来ても（追記のみ描画）展開が維持される。
6. `/clear` ／リロード後は折りたたみが既定。
7. 上端固定中の長文プロンプトを展開／折りたたみしてもピン位置が破綻しない。
8. `npx tsc --noEmit` がパスする。

## 非目標（YAGNI）

- アシスタント／システムメッセージの省略。
- しきい値・機能 ON/OFF の設定項目化。
- 折りたたみ状態のディスク永続化（セッション復元後の展開維持）。
