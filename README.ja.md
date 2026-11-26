# Claude Panel — 日本語ドキュメント

> **提供: [琉球HUB株式会社 (Ryukyu HUB Inc.)](https://ryukyuhub.co.jp)**

Claude Panel は、Obsidian の右サイドバーに [Claude Code](https://docs.claude.com/claude-code) のパネルを表示するプラグインです。アクティブな Vault をワーキングディレクトリとして `claude` CLI を起動し、ノートの読み書き・検索・コマンド実行までを Obsidian 内で完結できます。

パネルの UI は 2 種類あります。

- **ターミナル UI(既定)** — Claude Code 公式の対話画面です。[xterm.js](https://xtermjs.org/) で作ったターミナルの中で、対話モードの `claude` を動かします。
- **チャット UI** — このプラグイン独自のチャット画面です。`claude` を stream-json 入出力のサブプロセスとして起動します。

切り替えはプラグイン設定の「**UI の種類**」で行います。以前から使っている場合は、更新後にターミナル UI へ切り替わり、戻し方を知らせる通知が表示されます。

> デスクトップ専用です。事前に `claude` CLI のインストールと、Claude Code へのログイン(サブスクリプションまたは Anthropic API キー)が必要です。

## 主な機能

### ターミナル UI(既定)

- サイドバーに Claude Code 自身の画面を表示。モデル・effort・思考・承認モードは、このプラグインの設定ではなく Claude Code 自身の設定と画面(`/model`、`Shift+Tab` など)に従います
- プロンプトを送るたびに、アクティブなノート(またはフォルダ)とエディタ／プレビューの選択範囲を Claude Code に渡す(オフ切り替え可。[制約](#制約)を参照)
- 出力中の `[[wikilink]]`、Vault 内のファイルパス、URL をクリックで開ける
- クリップボタンや、OS・Obsidian のファイルエクスプローラーからのドラッグ&ドロップでファイルを添付。クリップボード画像もそのまま貼り付け可能
- ヘッダーのボタンで、新しいセッション・前回の続き・ファイル添付・アカウントと使用状況・設定を操作。Claude Code の終了後は、同じセッションの再開か新しいセッションを選べる
- ターン完了時にサウンドとパネルのフラッシュで通知(設定で切替可)
- ターミナルの配色と等幅フォントは Obsidian のテーマに追従

### チャット UI

- ストリーミング応答のチャットパネル(ツール実行ピル、ターン毎のコスト・所要時間・トークン使用量を表示)
- アクティブノート(またはアクティブフォルダ)を毎回 `@filename` として自動メンション(オフ切り替え可)
- ファイルピッカーから追加メンション、クリップボード画像をそのまま添付
- エディタ／プレビューの選択範囲を取り込み、コピペなしで「ここを説明して」と質問可能
- 選択肢のある質問はクリック可能なボタンで表示。散文中の「はい／いいえ」質問も自動検出して GUI 化
- ターン完了時にサウンドとパネルのフラッシュで通知(設定で切替可)
- `claude --resume <session>` を内部で利用して会話コンテキストを維持(Claude Code の自動コンパクションも有効)
- パネル内で処理するスラッシュコマンド: `/clear`, `/continue`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/compact` など
- ツール実行の承認モードは 5 種類(編集前に確認 / 編集を自動承認 / オートモード / 全ての確認をスキップ / プランモード)。オートモードは Claude Code の分類器が低リスクな操作を自動で実行し、危険な操作をブロックします。対応モデルとプランが必要で(Haiku は非対応)、使えない場合は「編集前に確認」で動作します。オートモードの判定リクエストは Claude Code から Anthropic に送られ、使用量に数えられる場合があります

### 両方の UI 共通

- アカウント＆使用状況パネル — Claude プラン、組織、レートリミット消費(5時間／7日／Sonnet)を表示
- プロジェクトレベルの MCP サーバー: Vault ルートに `.mcp.json` を置けば Claude Code が読み込みます。設定で MCP サーバーなしで起動することもできます
- プラグインの UI 言語は Obsidian の設定(English / 日本語)に追従

## 動作条件

- Obsidian デスクトップ版と、インストール・ログイン済みの `claude` CLI([インストール](#インストール)を参照)
- ターミナル UI を使う場合:
  - **Windows**: Windows 10 バージョン 1809 以降(ターミナルに Windows の疑似コンソール ConPTY を使うため)と、標準搭載の Windows PowerShell 5.1
  - **macOS / Linux**: Python 3.8 以降(`python3`)、または `script` コマンド
- ターミナル UI は macOS ではまだ動作を確認していません。うまく動かない場合は、プラグイン設定の「**UI の種類**」でチャット UI に切り替えてください

## 外部プログラム・ネットワーク・ファイルの利用

このプラグインが実行するプログラム、行うネットワーク通信、Vault の外に書き出すファイルと、その理由をまとめます。ネイティブバイナリの同梱やダウンロードは行いません。

### 実行するプログラム

- **`claude` CLI** — インストールした Claude Code CLI です。Anthropic との通信はこれが行います。アカウント情報の表示のために `claude auth status --json` も実行します。
- **Windows(ターミナル UI): Windows PowerShell 5.1。** ネイティブモジュールを使わずに `claude` へ本物のターミナルを渡すため、`main.js` に同梱した PowerShell スクリプトを実行します:
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <スクリプト>`(コンソールウィンドウは表示しません)。
  - `-ExecutionPolicy Bypass` が効くのはその PowerShell プロセスだけです。システムの実行ポリシーは変更しません。
  - スクリプトは、埋め込んだ C# のソースを `Add-Type` で実行時にコンパイルし、Windows の ConPTY API を呼び出します。
  - スクリプトは `%TEMP%\claude-panel-pty-bridge-<ハッシュ>.ps1` に書き出します([書き出すファイル](#書き出すファイル)を参照)。
- **macOS / Linux(ターミナル UI): `python3`、使える Python が無ければ `script`。** 同梱の Python スクリプトをコマンドラインで渡して(`python3 -I -S -u -X utf8 -c <ソース>`)ターミナルを作ります。
  - Python は次の順に探します。macOS: `/Library/Developer/CommandLineTools/usr/bin/python3`、`/Applications/Xcode.app/Contents/Developer/usr/bin/python3`、`/opt/homebrew/bin/python3`、`/usr/local/bin/python3`、`/Library/Frameworks/Python.framework/Versions/Current/bin/python3`、そして `xcode-select -p` が成功したときだけ `/usr/bin/python3`(そうでないと開発ツールのインストールを促す画面が出るため)。Linux: `PATH` 上の絶対パスの各ディレクトリの `python3`、続いて `/usr/bin`、`/usr/local/bin`。
  - 各候補は、短い確認処理(Python 3.8 以降で `os.forkpty` があるか)で一度実行して確かめます。
  - どれも使えなければ、同梱のシェルスクリプトを `/bin/sh` で実行し、`PATH` 上の `script` コマンド(リサイズには `stty`)を使います。
- **macOS: `security`** — アカウント＆使用状況パネルのために、Claude Code の OAuth トークンをキーチェーンから読みます。

### ネットワーク

- **ローカルの hook サーバー(ターミナル UI)。** `127.0.0.1` のランダムなポートで HTTP サーバーを開きます。他のマシンからは接続できません。Claude Code が HTTP hook(`UserPromptSubmit` と `Stop`)でここを呼びます。プロンプトの送信時には、アクティブなノートまたはフォルダのパスと選択範囲を返し、Claude Code がそれを文脈に加えます。`Stop` では完了通知を鳴らします。
  - パネルごとにランダムな URL パスとトークンを発行します。トークンはコマンドラインではなく環境変数で `claude` に渡し、すべての要求にトークンが必要です。
  - ブラウザーから来た要求(`Origin` ヘッダーがある、`Host` が違う)は拒否します。
  - hook の通信がプロキシを通らないよう、`claude` の `NO_PROXY` に `127.0.0.1` と `localhost` を追加します。
- **Anthropic の使用状況エンドポイント。** アカウント＆使用状況パネルは、レートリミット消費を読むために OAuth トークンを付けて `https://api.anthropic.com/api/oauth/usage` に問い合わせます。
- それ以外(チャット、ツール、MCP サーバー)の通信はすべて `claude` CLI 自身が行います。

### 書き出すファイル

OS の一時フォルダ(`os.tmpdir()`。Windows では `%TEMP%`)の一時ファイル:

| ファイル | 書き出す場面 | 用途 |
|---|---|---|
| `claude-panel-pty-bridge-<ハッシュ>.ps1` | Windows、ターミナル UI | 上記の PowerShell スクリプト。内容が同じ間は再利用し、プラグインの更新で内容が変わると新しいファイルを書きます。書き込み中だけ一時的な `.tmp` ファイルを使います |
| `ptyb.XXXXXX/`(`$TMPDIR` または `/tmp` の下) | macOS / Linux、ターミナル UI、`script` を使うときのみ | プロセス ID を受け渡す小さなファイル。セッションの終了時に削除します |
| `claude-panel-empty-mcp.json` | 「MCP サーバーを無効化」がオンのとき | `claude` に渡す空の MCP 設定 |
| `claude-panel-thinking-on.json` / `claude-panel-thinking-off.json` | チャット UI | 思考のオン／オフを `claude` に渡す設定 |
| `claude-panel-shadow-bin/open`、`claude-panel-shadow-bin/xdg-open` | チャット UI、macOS / Linux | MCP サーバーがブラウザを開くのを止める何もしないスクリプト([アーキテクチャ](#アーキテクチャ)を参照) |

その他のファイル:

- 貼り付けた画像は `<Vault>/.obsidian/plugins/claude-panel-ryukyuhub/attachments/`(`.obsidian` は Vault の設定フォルダ)に保存し、プラグインの終了時に削除します。「添付ファイルを Vault 内に保存」がオンのときは Vault 内に保存し、削除しません。
- `~/.claude-panel/usage-history.json` と `~/.claude-panel/usage-cache.json` に、アカウント＆使用状況パネル用のローカル累計と、直近のレートリミット値を保存します。

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

> PowerShell 7 は、ご自身がターミナルで作業するためのものです。プラグインのターミナル UI は標準搭載の Windows PowerShell 5.1 を使います(PowerShell 7 を入れても 5.1 はそのまま残ります)。

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
>
> ターミナル UI では、パネル内で `/login` を実行してもログインできます。

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

### ブラウザが自動で開かない(Windows / WSL / リモートデスクトップ / SSH)
ターミナルに表示された URL を手動でコピーしてブラウザのアドレスバーに貼り付け、認証後に表示される認証コードをターミナルに貼り戻してください。

### `npm: command not found` / `npm は内部コマンドではありません`
Node.js が未インストールです。[1. 前提ソフトウェアをインストール](#1-前提ソフトウェアをインストール) に戻り、`winget install OpenJS.NodeJS.LTS`(Windows)または `brew install node`(macOS)から実行してください。

### Obsidian でプラグインが起動しない / チャット送信時に失敗する
プラグイン設定の「セットアップ状況」が **✓ 利用可能です。** になっているか確認してください。 ✗ や ⚠ が出ているときは、その下に表示されるインストール／ログイン手順に従ってください。「再チェック」ボタンで状態を更新できます。

### 「この環境ではターミナルを開けません。」(macOS / Linux)
ターミナル UI が、使える Python(3.8 以降)も `script` コマンドも見つけられませんでした。Python 3 を入れてから(macOS なら `xcode-select --install` でのコマンドラインツールや `brew install python`、Linux ならディストリビューションの `python3` パッケージなど)、パネルの **再試行** を押してください。**チャット UI に切り替える** を押すこともできます。

### 「ターミナルを開けませんでした。」/ PowerShell が止められる(Windows)
ターミナル UI が使う PowerShell のプロセスを実行できませんでした。メッセージの下に、PowerShell が報告した理由が表示されます。よくある原因:

- グループポリシーで設定された実行ポリシー。コマンドラインの `-ExecutionPolicy Bypass` は、グループポリシーで設定されたポリシーを上書きしません。
- アプリケーション制御(AppLocker、WDAC)やセキュリティソフトが、`powershell.exe`、`%TEMP%` のスクリプト、`Add-Type` による C# のコンパイルを止めている。PowerShell の制約付き言語モードでも `Add-Type` は使えません。
- `%TEMP%` に書き込めない。

これらは通常、管理者が設定しています。管理者に相談するか、PowerShell を使わない **チャット UI に切り替える** を押してください。

### 「Claude Code を起動できませんでした。」
ターミナルは開けましたが、`claude` を起動できませんでした。「claude CLI のパス」の設定を確認してください(**設定を開く** ボタンから移動できます)。

### ターミナル UI での日本語入力
変換中の文字はターミナルのカーソル位置に表示されます。変換中の `Enter` は確定だけで、プロンプトは送信されません。狭いパネルでは、長い変換中の文字列を左にずらして末尾が見えるようにします。それでもお使いの IME でうまく入力できない場合は、通常の入力欄を使うチャット UI に切り替えてください。

### ノートが渡らない・完了通知が鳴らない・「再開」が出ない(ターミナル UI)
これらは Claude Code の hooks を使っています。[制約](#制約)を参照してください。

## 使い方

- リボンアイコンをクリック、またはコマンドパレットで **Claude パネルを開く** を実行してパネルを開きます
- UI を切り替えるには、プラグイン設定の「**UI の種類**」を変更します。パネルを開き直し、実行中の処理は終了します

### ターミナル UI

- パネルが初めて表示されたときに、新しいセッションで Claude Code が起動します。通常のターミナルと同じように使えます。`/login`、`/model`、`Shift+Tab` など Claude Code の機能もそのまま使えます
- キー操作:
  - `Shift+Enter` で改行
  - Windows / Linux: `Ctrl+C` は、文字を選択しているときはコピー、していないときは Claude Code に送られます。`Ctrl+Shift+C` でコピー、`Ctrl+V` / `Ctrl+Shift+V` で貼り付け
  - macOS: `Cmd+C` / `Cmd+V` でコピーと貼り付け
  - Claude Code がマウスを使っているときは、`Shift`(Windows / Linux)または `Option`(macOS)を押しながらドラッグすると文字を選択できます
  - ターミナルにフォーカスがある間はキーがターミナルに送られるため、Obsidian のホットキーは効きません(macOS の `Cmd` 系のショートカットは効きます)。Obsidian のホットキーを使うときは、別のペインをクリックしてください
- リンク: URL はブラウザで開きます。実在するノートへの `[[wikilink]]` と、Vault 内のファイルのパス(Vault 相対、または Vault 内の絶対パス)は Obsidian で開きます。`Ctrl` / `Cmd` を押しながらクリックすると新しいタブで開きます
- 下端の欄に、アクティブなノート(またはファイルエクスプローラーで最後にクリックしたフォルダ)と選択範囲が、それぞれ「✓ 含める / ○ 除外」の切り替えと一緒に表示されます。`/` で始まらないプロンプトを送ると、含めるノートまたはフォルダのパスと選択した文字列が Claude Code に渡ります。ノートの本文は送らず、Claude Code が必要なときに読みます。7,500 文字を超える選択範囲は切り詰め、続きをどこから読むかを Claude Code に伝えます
- クリップボタン、または OS や Obsidian のファイルエクスプローラーからのドラッグ&ドロップで、ファイルやフォルダを添付できます。`@パス` の参照として入力されます。「添付ファイルを Vault 内に保存」がオンなら、Vault 外のファイルは Vault にコピーします。フォルダはコピーせず、元の場所を参照します。Claude Code の `@` 参照では、パスに `#` を含むファイルや、`"` と空白の両方を含むパスは添付できません。これらは `@` を付けずにパスだけを入力するので、Claude には中身ではなくパスが伝わります。必要なら Claude に読むよう頼んでください
- パネルの下端が Obsidian のステータスバーに隠れないよう、ターミナル UI では重なる分だけ自動で下に余白を入れます。「下端の余白」の設定は、それより大きいときだけ効きます
- クリップボード画像を貼り付けると、画像を保存して絶対パスを入力します。Claude Code はこれを画像として読み込みます。クリップボードに文字と画像の両方があるときは、文字を貼り付けます
- ヘッダーのボタン: **新しいセッション**、**前回の続き**(`claude --continue`)、**ファイルを添付**、**アカウントと使用状況**、**設定を開く**
- Claude Code が終了したら(`/exit` など)、**再開**(同じセッション。プロンプトを送ってセッションが分かった後に表示)か **新しいセッション** を選べます
- コマンド: **実行中のエージェントを中断** は Claude Code に `Esc` を送り、**会話をクリア** は新しいセッションを始めます。**アクティブなファイル/フォルダを含めるをトグル** はチャット UI と同じです。**プロンプトを送信** と **モデルを順送り** はチャット UI 専用です
- 承認モード・モデル・思考・Effort・表示名・送信キーの設定はチャット UI 専用で、ターミナル UI を選んでいる間は設定画面に表示されません

### チャット UI

- プロンプトを入力して `Enter`(または送信ボタン)で送信。`Esc` で実行中のターンを中断、`Shift+Enter` で改行
- **添付** ボタンから追加ノートをメンション、またはクリップボード画像をそのまま貼り付け
- パネルヘッダーのユーザーアイコンから、Claude のアカウント情報とレートリミット消費状況を確認できます

## 制約

- **ターミナル UI のノート連携には Claude Code の hooks が必要です。** アクティブなノートと選択範囲の受け渡し、完了通知、終了後の **再開** ボタンは、Claude Code がプラグインのローカル hook サーバーを呼ぶことで動いています。`disableAllHooks` で hooks を無効にしている場合や、組織の管理設定の `allowedHttpHookUrls` で HTTP hook が制限されている場合などは働きません。ターミナル自体は使えます。
- **UI 言語の設定は、プラグイン自身の UI にだけ効きます。** ターミナル UI の Claude Code の画面の言語は変わりません。
- **ターミナル UI のテーマ。** Obsidian のライト／ダークに合わせるため、`theme: auto` で Claude Code を起動します。パネル内で `/theme` を選んでも、次にパネルで Claude Code を起動したときに `auto` に戻ります。
- **Windows で Claude Code の実行中にライト／ダークを切り替えたとき。** Claude Code 側の文字色は、次に起動するまで変わりません。ターミナルの背景色は追従し、起動時の明暗は正しく決まります。Windows の疑似コンソール(ConPTY)が、Claude Code の背景色の問い合わせを中継しないためです。macOS / Linux では実行中も追従します。
- **アカウント＆使用状況パネルの「ローカル累計」はチャット UI の分だけです。** ターミナル UI での使用量はここに記録されません。レートリミット消費(5時間／7日)は Anthropic から読むので、チャット UI の分に限られません。
- **ターミナルにフォーカスがある間の Obsidian のホットキー。** [使い方](#ターミナル-ui)を参照してください。
- 「UI の種類」の設定はプラグインの `data.json` に保存されるため、Vault の `.obsidian` フォルダを同期している端末の間で共有されます。

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

テストスイートはありません。変更前に `npm run lint`(ESLint。設定は `eslint.config.mjs`)と `npx tsc --noEmit`(型チェック)を実行してください。本番用のビルドは `npm run build` です。

## アーキテクチャ

`src/` のファイル構成:

- `main.ts` — `Plugin` のエントリ。View(「UI の種類」に応じてチャットまたはターミナルのビュー)・リボンアイコン・コマンド・設定タブを登録。設定の移行、hook サーバーの保持、終了・再読み込み・無効化時のターミナルのプロセスの終了も担当
- `panel-view.ts` — 両方の UI が共有する View の種類と、`main.ts` と設定タブが呼ぶ `PanelView` インターフェース
- `view.ts` — チャット UI の `ItemView`。チャット履歴、ヘッダーの操作、コンポーザー、描画を担当
- `chat-runtime.ts` — チャット 1 ターン分の送信・ストリーミング受信・ツール承認
- `agent.ts` — チャット UI のサブプロセス層。`runAgent()` が `claude` を stream-json 入出力で起動し、JSON 行ごとに text / tool-use / result / error / usage イベントへディスパッチ。両方の UI で使う Vault 用のシステムプロンプトと空の MCP 設定もここに置く
- `chat-message.ts` / `chat-message-render.ts` — メッセージのデータモデルと、レンダラー(ツールピル、承認カード、質問ボタン)
- `composer.ts` — チャット UI の入力欄。添付とプロンプトの組み立て
- `note-context.ts` — 両方の UI が共有するアクティブなノート／フォルダと選択範囲の状態と、ターミナル UI に渡す文脈の文字列
- `selection-capture.ts` — 250ms ごとにアクティブな markdown ビューの選択範囲(編集／プレビュー両対応)を取得。1.5 秒の "handoff grace" でパネルクリック時にも選択を保持
- `attachments.ts` — OS のファイル選択ダイアログ、Vault へのファイルのコピー、貼り付け画像の保存
- `slash-commands.ts` / `slash-suggest.ts` / `skill-discovery.ts` — チャット UI のスラッシュコマンド、`/` の候補一覧、スキルとカスタムコマンドの検出
- `session-history.ts` — チャット UI の `/continue` のために Claude Code のセッションログを読む
- `prompt-history.ts`、`context-meter.ts`、`summary-badge.ts`、`summary-confirm-modal.ts` — チャット UI の入力履歴、コンテキストメーター、「要約して新会話」
- `completion-notifier.ts` / `notify-sound-source.ts` — 完了時のサウンドとフラッシュ、サウンドファイルの読み込み
- `account-api.ts` / `account-modal.ts` — アカウント＆使用状況。`claude auth status --json` と OAuth トークン(macOS は Keychain、Linux/Windows は `~/.claude/.credentials.json`)を読み、Anthropic OAuth usage エンドポイントを叩く
- `usage-history.ts` — ローカル累計(チャット UI)
- `cli-resolver.ts` — `claude` の実行ファイルを探し、起動時の環境変数を作る
- `obsidian-internals.ts` — 使っている Obsidian の非公開 API(`app.setting`、`app.dragManager`)への型付きアクセス
- `assets.d.ts` — esbuild が文字列として取り込むブリッジスクリプトの型
- `i18n/` — `en.ts` / `ja.ts` の辞書、共通の型、`t()`
- `settings/` — 設定の型と既定値(`types.ts`)、表示ラベル、設定タブ(`tab.ts`)、Vault 内のサウンドファイル選択
- `terminal/` — ターミナル UI:
  - `terminal-view.ts` — ターミナル UI の `ItemView`。ヘッダー、起動中／終了／エラーの状態、ノート欄、hook の処理、添付
  - `xterm-pane.ts` — xterm.js のラッパー。サイズ、キー、貼り付け、ドラッグ&ドロップ、流量制御、OSC 52 によるコピー
  - `links.ts` — wikilink・Vault のパス・URL のリンク検出
  - `theme.ts` — Obsidian の CSS 変数からターミナルの配色とフォントを作る
  - `launch.ts` — `claude` の起動引数と環境変数
  - `hook-server.ts` / `hook-settings.ts` — ループバックの HTTP サーバーと、`--settings` の JSON・hook の応答
  - `pty.ts`、`pty-process.ts`、`pty-windows.ts`、`pty-posix.ts`、`types.ts` — OS ごとのターミナルのプロセスの起動と終了
  - `bridge/` — `bridge.ps1`(Windows の ConPTY)、`bridge.py`(Python)、`script-pty.sh`(`script` による代替)

どちらの UI も子環境から `ANTHROPIC_API_KEY` を除去するので、CLI は既存の Claude Code ログイン(サブスクリプション認証)を使います。また、`claude` の実行ファイルのフォルダとよく使われるインストール先を `PATH` に加えます。

チャット UI はさらに、起動時にブラウザを開くタイプの MCP サーバー(Serena の自動ダッシュボード等)の挙動を抑制します。macOS / Linux では一時ディレクトリに no-op の `open` / `xdg-open` シェルスクリプトを置いて PATH の先頭に差し込み、`BROWSER=true` を渡しています。ターミナル UI ではこれを行わないので、`/login` でブラウザを開けます。

ターミナル UI は `claude` を `--append-system-prompt`(チャット UI と同じ Vault の説明)、`--settings`(テーマと 2 つの HTTP hook)、必要に応じて `--continue` / `--resume` / `--strict-mcp-config --mcp-config` を付けて起動します。また、Obsidian を起動したターミナルや Claude Code のセッションから引き継いだ環境変数を取り除き、`TERM=xterm-256color` と `COLORTERM=truecolor` を設定します。

ターミナルには [xterm.js](https://github.com/xtermjs/xterm.js) と、その fit・web-links・unicode11 アドオン(MIT License)を使っています。`styles.css` には、パネル内だけに効くようにした xterm.js の CSS を、ライセンス表記と一緒に含めています。

## リリース

semver タグを push するとリリースが作成されます。[.github/workflows/release.yml](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/.github/workflows/release.yml) がビルドと zip 添付を自動化し、リリースアセットの GitHub artifact attestation も発行します。

```bash
npm version 0.1.8 -m "Release %s"
git push --follow-tags
```

`npm version` は `version-bump.mjs` を実行し、`manifest.json` と `versions.json` のバージョンを同期させます。

## ライセンス

MIT — © 2026 [琉球HUB株式会社 (Ryukyu HUB Inc.)](https://ryukyuhub.co.jp). 詳細は [LICENSE](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/LICENSE) を参照。

本プラグインは MIT License の [xterm.js](https://github.com/xtermjs/xterm.js) とそのアドオンを同梱しています。
