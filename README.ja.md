# Claude Panel — 日本語ドキュメント

> **提供: [琉球HUB株式会社 (Ryukyu HUB Inc.)](https://ryukyuhub.co.jp)**

Claude Panel は、Obsidian の右サイドバーに [Claude Code](https://docs.claude.com/claude-code) のチャットパネルを表示するプラグインです。アクティブな Vault をワーキングディレクトリとして `claude` CLI をサブプロセスで起動し、ノートの読み書き・検索・コマンド実行までを Obsidian 内で完結できます。

> デスクトップ専用です。事前に `claude` CLI のインストールと、Claude Code へのログイン(サブスクリプションまたは Anthropic API キー)が必要です。

## 主な機能

- 右サイドバーのチャットパネル(ストリーミング応答、ツール実行ピル、ターン毎のコスト・所要時間・トークン使用量を表示)
- アクティブノート(またはアクティブフォルダ)を毎回 `@filename` として自動メンション(オフ切り替え可)
- ファイルピッカーから追加メンション、クリップボード画像をそのまま添付
- エディタ／プレビューの選択範囲を取り込み、コピペなしで「ここを説明して」と質問可能
- 選択肢のある質問はクリック可能なボタンで表示。散文中の「はい／いいえ」質問も自動検出して GUI 化
- ターン完了時にサウンドとパネルのフラッシュで通知(設定で切替可)
- `claude --resume <session>` を内部で利用して会話コンテキストを維持(Claude Code の自動コンパクションも有効)
- アカウント＆使用状況パネル — Claude プラン、組織、レートリミット消費(5時間／7日／Sonnet)をリアルタイム表示
- スラッシュコマンド: `/clear`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/login`
- プロジェクトレベルの MCP サーバー: Vault ルートに `.mcp.json` を置けば自動で読み込まれます
- UI 言語は Obsidian の設定(English / 日本語)に追従

## インストール

> **Claude CLI を使っていない方へ**: 途中でターミナル(コマンドラインツール)を使います。Windows なら **PowerShell**、macOS なら **Terminal** を起動して、各コードブロックをコピー＆ペーストで 1 行ずつ実行してください。「コマンドが見つからない」場合の対処は末尾の[トラブルシューティング](#トラブルシューティング)にまとめています。

### 1. 前提ソフトウェアをインストール

`claude CLI` は Node.js 上で動作します。まず Node.js(と Git、Windows なら PowerShell 7)を入れてください。

#### Windows — `winget` で一括導入(推奨)

PowerShell を**管理者として実行**で開き、次の 3 行を順番に実行します:

```powershell
winget install --id OpenJS.NodeJS.LTS         # Node.js + npm
winget install --id Git.Git                   # Git
winget install --id Microsoft.PowerShell      # PowerShell 7(古い 5.1 では認証コードの貼付が崩れるため必須)
```

インストール後は **PowerShell を一度閉じて、新しい PowerShell 7 (`pwsh`) を開き直して** 以降の作業を続けてください(PATH の再読み込みが必要です)。

> `winget` が使えない古い Windows の場合は、各公式サイトから直接インストールしても同等です: [Node.js LTS](https://nodejs.org/) / [Git for Windows](https://git-scm.com/download/win) / [PowerShell 7](https://aka.ms/PSWindows)

#### macOS — `brew` で一括導入(推奨)

Terminal で実行:

```bash
# Homebrew 未導入の場合のみ最初に実行:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js(npm 同梱)と Git
brew install node git
```

### 2. Claude Code CLI をインストール

OS 共通で 1 コマンドです:

```bash
npm install -g @anthropic-ai/claude-code
```

完了後 `claude --version` でバージョンが表示されれば OK です。

> macOS のみ Homebrew Cask 経由でも導入できます: `brew install --cask claude-code`

### 3. Claude にログイン

```bash
claude /login
```

ブラウザが自動で開き、Anthropic のログイン画面が表示されます。Claude Pro / Max のサブスクリプション、もしくは Anthropic API キーで認証してください。

> **ブラウザが自動で開かない場合**: ターミナルに表示された `https://claude.ai/...` で始まる URL を選択コピーし、自分でブラウザのアドレスバーに貼り付けてください。ログイン後に画面に出る**認証コード**をコピーして、ターミナルに貼り戻せば完了です。
>
> **Windows で認証コードの貼り付けが崩れる場合**: Windows 標準の PowerShell 5.1 にコピペの不具合があります。前述の `winget install Microsoft.PowerShell` で **PowerShell 7(pwsh)に切り替えて** から再実行してください。

### 4. Obsidian プラグインを導入

1. Obsidian → 設定 → コミュニティプラグイン → **新着プラグイン** から `Claude Panel` を検索して **インストール**
2. コミュニティプラグイン一覧で **Claude Panel** を有効化
3. プラグイン設定を開くと先頭に「セットアップ状況」が表示されます。`claude` CLI が自動検出されない場合は CLI バイナリの絶対パスを入力してください(例: macOS なら `/usr/local/bin/claude`、Windows なら `C:\Users\<you>\AppData\Roaming\npm\claude.cmd`)

> 開発版や先行リリースを試したい場合は [BRAT](https://github.com/TfTHacker/obsidian42-brat) で本リポジトリから直接インストールできます。

## トラブルシューティング

### `claude: command not found` / `claude.exe' は内部または外部コマンドではありません`
`npm install -g @anthropic-ai/claude-code` の直後はターミナルが PATH を再読み込みしていません。**ターミナルを一度閉じて開き直す** とほぼ解決します。それでも検出されない場合は、Obsidian の本プラグイン設定画面の「**claude CLI のパス**」に絶対パスを入力してください:

- macOS (Intel): `/usr/local/bin/claude`
- macOS (Apple Silicon, Homebrew): `/opt/homebrew/bin/claude`
- macOS (npm global): `~/.nvm/versions/node/<ver>/bin/claude` など
- Windows (npm global): `C:\Users\<you>\AppData\Roaming\npm\claude.cmd`

### Windows で認証コードの貼付が崩れる / 入力が空欄になる
標準同梱の PowerShell 5.1 ターミナルにコピペの不具合があります。`winget install Microsoft.PowerShell` で **PowerShell 7 (`pwsh`)** を入れ、新しいウィンドウで `claude /login` をやり直してください。

### ブラウザが自動で開かない(Windows / WSL / リモートデスクトップなど)
ターミナルに表示された URL を手動でコピーしてブラウザのアドレスバーに貼り付け、認証後に表示される認証コードをターミナルに貼り戻してください。

### `npm: command not found` / `npm は内部コマンドではありません`
Node.js が未インストールです。[1. 前提ソフトウェアをインストール](#1-前提ソフトウェアをインストール) に戻り、`winget install OpenJS.NodeJS.LTS`(Windows)または `brew install node`(macOS)から実行してください。

### Obsidian でプラグインが起動しない / チャット送信時に失敗する
プラグイン設定の「セットアップ状況」が **✓ 利用可能です** になっているか確認してください。 ✗ や ⚠ が出ているときは、その下に表示されるインストール／ログイン手順に従ってください。「再チェック」ボタンで状態を更新できます。

## 使い方

- リボンアイコンをクリック、またはコマンドパレットで **Open Claude Panel** を実行してパネルを開きます
- プロンプトを入力して `Enter`(または Send ボタン)で送信。`Esc` で実行中のターンを中断、`Shift+Enter` で改行
- **Attach** ボタンから追加ノートをメンション、またはクリップボード画像をそのまま貼り付け
- パネルヘッダーのユーザーアイコンから、Claude のアカウント情報とレートリミット消費状況を確認できます

## 開発

```bash
git clone https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub.git
cd obsidian-claude-panel-ryukyuhub
npm install
cp esbuild.config.local.example.mjs esbuild.config.local.mjs
# esbuild.config.local.mjs を編集して、VAULT_OUT_DIRS を自分の Vault のプラグインフォルダに向ける
npm run dev      # esbuild の watch モード — main.js とアセットを Vault 内に直接書き出す
```

ビルドは `main.js` / `manifest.json` / `styles.css` を、設定済みの Vault プラグインフォルダへ直接書き出すので、トグル OFF/ON(または [Hot Reload](https://github.com/pjeby/hot-reload) プラグイン)でリロードがすぐ反映されます。

`esbuild.config.local.mjs` は gitignore 対象なので、各開発者が自分のパスを保持します。ファイルを置かずに `OUT_DIR=...` を毎回渡しても構いません:

```bash
OUT_DIR=/path/to/vault/.obsidian/plugins/claude-panel-ryukyuhub npm run dev
```

どちらも未設定の場合は `./build/` にフォールバックします(CI のリリースパッケージング用)。

テストスイートや lint 設定はありません。型チェックを厳密に行いたい場合は `npx tsc --noEmit` を実行してください。

## アーキテクチャ

`src/` のファイル構成:

- `main.ts` — `Plugin` のエントリ。View・リボンアイコン・コマンド・設定タブを登録
- `view.ts` — サイドバー用 `ItemView`。チャット履歴、コンポーザー、添付ファイル、ペースト処理、プロンプト組み立て、ストリーミング描画を担当
- `agent.ts` — サブプロセス層。`runAgent()` が `claude` を stream-json 入出力で起動し、JSON 行ごとに text / tool-use / result / error / usage イベントへディスパッチ
- `chat-message.ts` — メッセージとパートの型、レンダラー。ツール実行は生 JSON ではなく装飾されたピルとして表示
- `selection-capture.ts` — 250ms ポーリングでアクティブな markdown ビューの選択範囲(編集／プレビュー両対応)を取得。1.5 秒の "handoff grace" でパネルクリック時にも選択を保持
- `slash-commands.ts` — `/clear`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/login` のローカルハンドラ。マッチしなかったスラッシュ入力は CLI に転送
- `account-usage.ts` — アカウント＆使用状況モーダル。`claude auth status --json` と OAuth トークン(macOS は Keychain、Linux/Windows は `~/.claude/.credentials.json`)を読み、Anthropic OAuth usage エンドポイントを叩く
- `file-picker.ts` — Attach ボタン用のファジーファイルピッカー
- `settings.ts` — 設定の型、デフォルト値、設定タブ

サブプロセスは子環境から `ANTHROPIC_API_KEY` を除去するので、CLI は既存の Claude Code ログイン(サブスクリプション認証)を使います。また macOS / Linux では一時ディレクトリに no-op の `open` / `xdg-open` シェルスクリプトを置いて PATH の先頭に差し込み、ブラウザを起動するタイプの MCP サーバー(Serena の自動ダッシュボード等)の挙動を抑制します。Windows では代わりに `BROWSER=true` を渡しています。

## リリース

semver タグを push するとリリースが作成されます。[.github/workflows/release.yml](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/.github/workflows/release.yml) がビルドと zip 添付を自動化します。

```bash
npm version 0.1.8 -m "Release %s"
git push --follow-tags
```

`npm version` は `version-bump.mjs` を実行し、`manifest.json` と `versions.json` のバージョンを同期させます。

## ライセンス

MIT — © 2026 [琉球HUB株式会社 (Ryukyu HUB Inc.)](https://ryukyuhub.co.jp). 詳細は [LICENSE](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/LICENSE) を参照。
