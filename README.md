# Claude Panel for Obsidian

> **Provided by [琉球HUB株式会社 (Ryukyu HUB Inc.)](https://ryukyuhub.co.jp).**

Claude Panel for Obsidian は、Obsidian の右サイドバーに [Claude Code](https://docs.claude.com/claude-code) のチャットパネルを表示するプラグインです。アクティブな Vault をワーキングディレクトリとして `claude` CLI をサブプロセスで起動し、ノートの読み書き・検索・コマンド実行までを Obsidian 内で完結できます。

> デスクトップ専用です。事前に `claude` CLI のインストールと、Claude Code へのログイン（サブスクリプションまたは Anthropic API キー）が必要です。

## 主な機能

- 右サイドバーのチャットパネル（ストリーミング応答、ツール実行ピル、ターン毎のコスト・所要時間表示）
- アクティブノートを毎回 `@filename` として自動メンション（オフ切り替え可）
- ファイルピッカーから追加メンション、クリップボード画像をそのまま添付
- エディタ／プレビューの選択範囲を取り込み、コピペなしで「ここを説明して」と質問可能
- `claude --resume <session>` を内部で利用して会話コンテキストを維持（Claude Code の自動コンパクションも有効）
- アカウント＆使用状況パネル — Claude プラン、組織、レートリミット消費（5時間／7日／Sonnet）をリアルタイム表示
- スラッシュコマンド: `/clear`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/login`
- プロジェクトレベルの MCP サーバー: Vault ルートに `.mcp.json` を置けば自動で読み込まれます

## インストール

### 1. Claude Code CLI をインストール

本プラグインは Anthropic 公式の `claude` CLI（[Claude Code](https://docs.claude.com/claude-code)）をサブプロセスとして起動して動作します。先に CLI 本体を導入してください:

```bash
# macOS / Linux / Windows 共通（Node.js が必要）
npm install -g @anthropic-ai/claude-code

# あるいは macOS なら Homebrew
brew install --cask claude-code
```

インストール後、ターミナルでログイン:

```bash
claude /login
```

ブラウザが開くので、Claude Pro / Max のサブスクリプション、もしくは Anthropic API キーで認証してください。

### 2. Obsidian プラグインを導入

1. [最新リリース](https://github.com/candypopbeat/obsidian-claude-panel-ryukyuhub/releases) から `claude-panel-ryukyuhub-<version>.zip` をダウンロード
2. zip を解凍し、`claude-panel-ryukyuhub/` フォルダを `<your-vault>/.obsidian/plugins/` 直下に配置
3. Obsidian → 設定 → コミュニティプラグイン → **Claude Panel for Obsidian** を有効化
4. プラグイン設定を開くと先頭にセットアップ状況が表示されます。`claude` CLI が自動検出されない場合は CLI バイナリの絶対パスを入力してください（例: macOS なら `/usr/local/bin/claude`、Windows なら `C:\Users\<you>\.local\bin\claude.exe`）

> BRAT には対応していません — リリース成果物は zip 形式で配布しています。

## 使い方

- リボンアイコンをクリック、またはコマンドパレットで **Open Claude Panel** を実行してパネルを開きます
- プロンプトを入力して `Enter`（または Send ボタン）で送信。`Esc` で実行中のターンを中断、`Shift+Enter` で改行
- **Attach** ボタンから追加ノートをメンション、またはクリップボード画像をそのまま貼り付け
- パネルヘッダーのユーザーアイコンから、Claude のアカウント情報とレートリミット消費状況を確認できます

## 開発

```bash
git clone https://github.com/candypopbeat/obsidian-claude-panel-ryukyuhub.git
cd obsidian-claude-panel-ryukyuhub
npm install
cp esbuild.config.local.example.mjs esbuild.config.local.mjs
# esbuild.config.local.mjs を編集して、VAULT_OUT_DIRS を自分の Vault のプラグインフォルダに向ける
npm run dev      # esbuild の watch モード — main.js とアセットを Vault 内に直接書き出す
```

ビルドは `main.js` / `manifest.json` / `styles.css` を、設定済みの Vault プラグインフォルダへ直接書き出すので、トグルOFF/ON（または [Hot Reload](https://github.com/pjeby/hot-reload) プラグイン）でリロードがすぐ反映されます。

`esbuild.config.local.mjs` は gitignore 対象なので、各開発者が自分のパスを保持します。ファイルを置かずに `OUT_DIR=...` を毎回渡しても構いません:

```bash
OUT_DIR=/path/to/vault/.obsidian/plugins/claude-panel-ryukyuhub npm run dev
```

どちらも未設定の場合は `./build/` にフォールバックします（CI のリリースパッケージング用）。

テストスイートや lint 設定はありません。型チェックを厳密に行いたい場合は `npx tsc --noEmit` を実行してください。

## アーキテクチャ

`src/` のファイル構成:

- `main.ts` — `Plugin` のエントリ。View・リボンアイコン・コマンド・設定タブを登録
- `view.ts` — サイドバー用 `ItemView`。チャット履歴、コンポーザー、添付ファイル、ペースト処理、プロンプト組み立て、ストリーミング描画を担当
- `agent.ts` — サブプロセス層。`runAgent()` が `claude` を stream-json 入出力で起動し、JSON 行ごとに text / tool-use / result / error / usage イベントへディスパッチ
- `chat-message.ts` — メッセージとパートの型、レンダラー。ツール実行は生 JSON ではなく装飾されたピルとして表示
- `selection-capture.ts` — 250ms ポーリングでアクティブな markdown ビューの選択範囲（編集／プレビュー両対応）を取得。1.5秒の "handoff grace" でパネルクリック時にも選択を保持
- `slash-commands.ts` — `/clear`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/login` のローカルハンドラ。マッチしなかったスラッシュ入力は CLI に転送
- `account-usage.ts` — アカウント＆使用状況モーダル。`claude auth status --json` と OAuth トークン（macOS は Keychain、Linux/Windows は `~/.claude/.credentials.json`）を読み、Anthropic OAuth usage エンドポイントを叩く
- `file-picker.ts` — Attach ボタン用のファジーファイルピッカー
- `settings.ts` — 設定の型、デフォルト値、設定タブ

サブプロセスは子環境から `ANTHROPIC_API_KEY` を除去するので、CLI は既存の Claude Code ログイン（サブスクリプション認証）を使います。また macOS / Linux では一時ディレクトリに no-op の `open` / `xdg-open` シェルスクリプトを置いて PATH の先頭に差し込み、ブラウザを起動するタイプの MCP サーバー（Serena の自動ダッシュボード等）の挙動を抑制します。Windows では代わりに `BROWSER=true` を渡しています。

## リリース

`v*` タグを push するとリリースが作成されます。[.github/workflows/release.yml](.github/workflows/release.yml) がビルドと zip 添付を自動化します。

```bash
npm version 0.1.8 -m "Release %s"
git push --follow-tags
```

`npm version` は `version-bump.mjs` を実行し、`manifest.json` と `versions.json` のバージョンを同期させます。

## ライセンス

MIT — © 2026 [琉球HUB株式会社 (Ryukyu HUB Inc.)](https://ryukyuhub.co.jp). 詳細は [LICENSE](LICENSE) を参照。
