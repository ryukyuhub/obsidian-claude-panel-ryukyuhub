// 日本語辞書(ベース)。新しい UI 文字列はまずここに追加し、`en.ts` に
// 対応する英訳を入れる。階層構造は `t("category.key")` でアクセスする。
// 値が関数の場合は引数で動的に組み立てる。
export const ja = {
	ribbon: {
		openPanel: "Claude パネルを開く",
	},
	command: {
		openPanel: "Claude パネルを開く",
		focusInput: "Claude パネルの入力欄にフォーカス",
		sendPrompt: "プロンプトを送信",
		cancelAgent: "実行中のエージェントを中断",
		clearChat: "会話をクリア",
		cycleModel: "モデルを順送り",
		toggleActiveFile: "アクティブなファイル/フォルダを含めるをトグル",
	},
	notify: {
		none: "なし",
		sound: "音のみ",
		flash: "フラッシュのみ",
		both: "音とフラッシュ",
	},
	permission: {
		default: "編集前に確認",
		acceptEdits: "編集を自動承認",
		bypassPermissions: "全ての確認をスキップ",
		plan: "プランモード",
		tooltip: {
			default: "ツール（編集・Bash・MCP など）を実行するたびに承認を求めます。",
			acceptEdits: "ファイル編集は自動承認。Bash や MCP などは引き続き確認します。",
			bypassPermissions: "確認なしで全てのツールを実行します。エージェントを信頼できるときのみ。",
			plan: "プラン作成のみ。ツールは実行せず、提案だけを返します。",
		},
	},
	composer: {
		unresolvedPaths: (n: number) =>
			`${n} 件のファイルパスを取得できませんでした（Electron 環境制約）。`,
		alreadyAttached: "選択されたファイルはすでに添付済みです。",
		pasted: (path: string) => `貼り付け: ${path}`,
		pasteFailed: (msg: string) => `貼り付け画像の保存に失敗: ${msg}`,
		activeLabel: "アクティブ:",
		activeFolderTooltip:
			"フォルダパスを @メンションとして Claude に送ります（配下のファイルは Claude が必要に応じて読みます）",
		activeFileTooltip:
			"メッセージ送信のたびに @メンションとして Claude に送られます",
		folderFileCount: (path: string, n: number) =>
			`${path} (${n} ファイル)`,
		toggleIncluded: "✓ 含める",
		toggleExcluded: "○ 除外",
		noActiveFile: "アクティブファイルなし",
		selectionLabel: "選択範囲:",
		selectionMeta: (lines: number, chars: number, startLine: number) =>
			`${lines} 行 · ${chars} 文字 · L${startLine}`,
		selectionMoreLines: (n: number) => ` ⋯ 他 ${n} 行`,
		fileCount: (n: number) => `${n} ファイル`,
	},
	account: {
		modalTitle: "アカウントと使用状況",
		loading: "読み込み中…",
		sectionAccount: "アカウント",
		sectionUsage: "使用状況",
		sectionLocalTotal: "ローカル累計（このプラグインが記録した分）",
		authFetchFailed: (msg: string) =>
			`認証ステータスを取得できません: ${msg}`,
		notLoggedIn: "サインインしていません。ターミナルで `claude /login` を実行してください。",
		cacheNote: (age: string) => `${age} のキャッシュを表示しています。`,
		rateLimitedNote:
			"レート制限中のため最新の使用状況を取得できませんでした。しばらくしてから「更新」をクリックしてください。",
		usageFetchFailed: (msg: string) => `使用状況を取得できません: ${msg}`,
		manageOnClaudeAi: "claude.ai で使用状況を管理",
		refresh: "更新",
		refreshDisabledRateLimited: "レート制限中のため更新できません",
		openModalFailed: (msg: string) =>
			`「アカウントと使用状況」を開けません: ${msg}`,
		rowAuthMethod: "認証方式",
		rowEmail: "メール",
		rowOrg: "組織",
		rowPlan: "プラン",
		historyToday: "今日",
		historyThisMonth: "今月",
		historyTooltip: (count: number, inT: string, outT: string, cc: string, cr: string) =>
			`${count} ターン分\n入力: ${inT}\n出力: ${outT}\nキャッシュ作成: ${cc}\nキャッシュ読込: ${cr}`,
		historyResolving:
			"アカウント情報を解決中… 表示値は全アカウント合算の可能性があります。",
		historyFootnote:
			"このプラグインから送ったプロンプト分のみ。Claude.ai Web や他 CLI セッションは含まれません。7日間の正確な値は上の「週間（7日）」を参照してください。",
		windowFiveHour: "セッション（5時間）",
		windowSevenDay: "週間（7日）",
		windowSevenDayOpus: "週間 Opus",
		windowSevenDaySonnet: "週間 Sonnet",
		noUsageData: "使用状況データはありません。",
		utilizationRateLimited: (min: number) =>
			`使用率（%）は Anthropic API のレート制限中のため取得できません。あと ${min} 分後に「更新」をクリックしてください。`,
		utilizationFetchHint:
			"使用率（%）は API から取得します。「更新」をクリックすると最新値を取りにいきます。",
		utilizationPending: "API 取得待ち（チャットを 1 回送ると更新されます）",
		resetSoon: "まもなくリセット",
		resetInMinutes: (n: number) => `${n} 分後にリセット`,
		resetInHours: (n: number) => `${n} 時間後にリセット`,
		resetInDays: (n: number) => `${n} 日後にリセット`,
		cacheAgeLessThanMinute: "1 分未満前",
		cacheAgeMinutes: (n: number) => `${n} 分前`,
		cacheAgeHours: (n: number) => `${n} 時間前`,
		errClaudeCliNotFound:
			"`claude` CLI が見つかりません。プラグイン設定で絶対パスを指定してください。",
		errAuthJsonParse: (msg: string) =>
			`認証ステータスの JSON を解析できません: ${msg}`,
		errNotLoggedInForUsage:
			"Claude Code にサインインしていません。ターミナルで `claude /login` を実行してください。",
		errUsageAuthHttp: (status: number) =>
			`Anthropic API が HTTP ${status} を返しました。OAuth トークンの有効期限が切れている可能性があります — ターミナルで \`claude /login\` を実行して更新してください。`,
		errUsageRateLimited: (suffix: string) =>
			`Anthropic API のレート制限に達しました (HTTP 429)。${suffix}`,
		errUsageRateLimitedHintDefault: " 少し待ってから「更新」をクリックしてください。",
		errUsageServer: (status: number) =>
			`Anthropic API のサーバエラー (HTTP ${status})。しばらくしてから再試行してください。`,
		errUsageGeneric: (status: number) =>
			`Anthropic API が HTTP ${status} を返しました。`,
	},
	chat: {
		roleUser: "ユーザー",
		roleAssistant: "アシスタント",
		permPendingTitle: "ツール実行の承認",
		permApprovedTitle: "承認済み",
		permDeniedTitle: "拒否しました",
		permAllow: "許可",
		permDeny: "拒否",
		permUserDenied: "ユーザーが拒否しました。",
		footerComplete: (duration: string, tokensText: string, cost: string) =>
			`完了 · ${duration}${tokensText}${cost}`,
		footerDurationSec: (sec: string) => `${sec}秒`,
		footerDurationMs: (ms: number) => `${ms}ms`,
		footerUsageTooltip: (inT: string, outT: string, cc: string, cr: string) =>
			`入力: ${inT}\n出力: ${outT}\nキャッシュ作成: ${cc}\nキャッシュ読込: ${cr}`,
		selRefRangeMulti: (start: number, lines: number) =>
			`L${start} · ${lines}行`,
		selRefRangeSingle: (start: number) => `L${start}`,
	},
	chatTool: {
		changeOfN: (i: number, n: number) => `変更 ${i} / ${n}`,
		writeContent: "書き込む内容",
		bashCommand: "コマンド",
		notebookCell: (id: string) => `セル: ${id}`,
		moreLines: (n: number) => `… 他 ${n} 行`,
	},
	chatRuntime: {
		conversationRestored: "会話を復元しました。",
		runInterrupted: "ユーザーが実行を中断しました。",
		runFinished: "実行終了。",
		conversationCleared: "会話をクリアしました。",
		interruptedDefault: "実行を中断しました。",
		errorPrefix: (msg: string) => `\n\n**エラー:** ${msg}`,
		userInterruptedInline: "\n\n_**[ユーザーが中断しました]**_",
		noActiveMessage: "アクティブなチャットメッセージがありません。",
	},
	view: {
		displayText: "Claude パネル",
		headerTitle: "Claude パネル",
		meterLabelContext: "コンテキスト",
		accountBtnAria: "アカウントと使用状況",
		clearBtn: "クリア",
		attachBtn: "添付",
		sendBtn: "送信",
		stopBtn: "停止 (Esc)",
		queueBtn: "次のターンへ",
		queuedNotice: "次のターンとしてキューに登録しました",
		queuedLabel: (preview: string) => `次のターン: ${preview}`,
		queuedCancelAria: "キューを取り消す",
		slashBlockedBusy:
			"実行中はスラッシュコマンドを使えません。Esc で停止してから入力してください。",
		controlLabelModel: "モデル",
		controlLabelThinking: "思考",
		controlLabelEffort: "Effort",
		controlLabelPermission: "承認",
		effortTooltip:
			"対応モデル（Sonnet 4.6 / Opus 4.7 など）の推論密度。auto は CLI / ~/.claude/settings.json の既定値に委譲。Haiku は非対応のため指定は無視されます。",
		modelChangedNotice: (label: string) => `モデル: ${label}`,
		includeStateIncluded: "含める",
		includeStateExcluded: "除外",
		toggleActiveNoticeWithTarget: (target: string, state: string) =>
			`「${target}」を${state}`,
		toggleActiveNoticeDefault: (state: string) => `アクティブを${state}`,
		emptyTitle: "Claude パネルへようこそ",
		emptyCheckingSetup: "セットアップを確認しています…",
		emptyReady:
			"下の入力欄からメッセージを送信してください。`/help` でローカルコマンド一覧を表示できます。",
		emptyCliMissing: "Claude CLI が見つかりません。",
		emptyLoginRequired: "Claude CLI へのログインが必要です。",
		emptyStepRunInTerminal: "ターミナルで次を実行: ",
		emptyStepThenLogin: "続けてログイン: ",
		emptyOpenSettings: "設定を開く",
		emptyRecheck: "再チェック",
		vaultPathUnavailable:
			"Vault のパスを解決できません（デスクトップ版のみ対応）。",
	},
	settings: {
		resolved: {
			labelResolved: "✓ 解決済み:",
			labelAutoDetected: "✓ 自動検出:",
			labelNotFoundConfigured: "✗ 指定されたパスに claude CLI が見つかりません",
			labelNotFoundAuto: "✗ 自動検出対象の場所に claude CLI が見つかりません",
		},
		claudePath: {
			name: "claude CLI のパス",
			desc:
				"任意。`claude` 実行ファイルへの絶対パスです。" +
				"空欄の場合は次の場所を順に自動検出します: PATH、~/.local/bin、~/.claude/local、/usr/local/bin、/opt/homebrew/bin。" +
				"既存の Claude Code サブスクリプションログインを利用するため、API キーは不要です。",
			placeholder: "/Users/you/.local/bin/claude",
		},
		disableMcp: {
			name: "MCP サーバーを無効化",
			desc:
				"オンにすると、起動した `claude` CLI は ~/.claude.json とプロジェクトの .mcp.json を無視し、" +
				"MCP サーバー無しで起動します。デフォルト: オフ（MCP 有効）。" +
				"Serena などのサーバーが開こうとするブラウザポップアップは、" +
				"PATH 上の `open`/`xdg-open` コマンドを上書きすることで別途ブロックされます。",
		},
		permissionMode: {
			name: "ツール実行の承認モード",
			desc:
				"Claude が Edit / Bash / MCP などのツールを呼び出す際の挙動。" +
				"『Ask before edits』ではチャット内に Approve / Deny ボタンが表示されます。" +
				"『Edit automatically』はファイル編集のみ自動で許可し、Bash や MCP は確認します。" +
				"『Bypass permissions』は確認なしで実行します（旧バージョンの動作）。" +
				"『Plan mode』はツール実行なしで計画のみ返します。",
		},
		model: {
			name: "モデル",
			desc:
				"新規メッセージで使う Claude モデル。チャットパネル下部のドロップダウンからも変更できます。",
		},
		effort: {
			name: "Effort（推論密度）",
			desc:
				"対応モデル（Sonnet 4.6 / Opus 4.6 など）の推論密度。`auto` は CLI/`~/.claude/settings.json` の既定値に委譲します。" +
				"Haiku は Effort 非対応のため、指定しても無視されます。",
		},
		language: {
			name: "表示言語",
			desc: "パネル UI の言語。`auto` は Obsidian 本体の言語設定に追従します。",
			option: {
				auto: "自動（Obsidian の設定に従う）",
				ja: "日本語",
				en: "English",
			},
			restartHint:
				"言語を変更しました。リボン・コマンドパレットの文言を完全に切り替えるには Obsidian を再読み込みしてください。",
		},
		fontSize: {
			name: "フォントサイズ",
			desc: (min: number, max: number) =>
				`チャットパネル全体の基準フォントサイズ (${min}–${max}px)。` +
				"変更は即座にパネルへ反映されます。",
		},
		composerPadding: {
			name: "下端の余白",
			desc: (min: number, max: number) =>
				`コンポーザーの下に追加で確保する余白 (${min}–${max}px)。` +
				"テーマによっては Obsidian のステータスバーが右サイドバーの下端に被って" +
				"送信ボタンやモデル選択が隠れることがあります。隠れて困るときだけ値を上げてください。",
		},
		resetToDefault: "デフォルトに戻す",
		hotkeys: {
			name: "ホットキー",
			desc:
				"パネルを開く / 入力欄にフォーカス / 送信 / キャンセル / 会話クリア / モデル切替 などのコマンドは" +
				"Obsidian 標準の『ホットキー』設定画面で自由にキーを割り当てられます。",
			openBtn: "ホットキー設定を開く",
		},
		about: {
			name: "このプラグインについて",
			desc: (version: string) => `バージョン ${version}`,
			repoLink: "GitHub リポジトリ",
		},
		notify: {
			completeName: "完了通知",
			completeDesc:
				"Claude の応答が完了したときの通知方式。" +
				"フラッシュはパネル枠を一瞬光らせます。音は内蔵チャイム、または下で指定した音声ファイルを再生します。" +
				"ユーザー自身がキャンセルしたランでは通知しません。",
			volumeName: "通知音の音量",
			volumeDesc: (min: number, max: number) =>
				`完了通知音の音量 (${min}–${max}%)。` +
				"テストボタンで現在の設定（音量・ファイル）の組み合わせを試聴できます。",
			testTooltip: "通知音をテスト再生",
			soundFileName: "通知音ファイル",
			soundFileDesc:
				"通知に使う音声ファイル（mp3 / wav / ogg / m4a など）。" +
				"Vault 内のファイルは相対パスとして保存され、Vault 同期で別環境に移っても追従します。" +
				"空欄の場合は内蔵の短いチャイムを使います。",
			soundPlaceholder: "（空欄 = 内蔵チャイム）",
			pickFromVault: "Vault 内のファイルから選択",
			pickFromOs: "OS のファイルダイアログから選択",
			clearSound: "クリア（内蔵チャイムに戻す）",
		},
		setup: {
			title: "セットアップ状況",
			checking: "確認中…",
			summaryOk: "✓ 利用可能です。",
			summaryWarn: "⚠ もう少しでセットアップ完了です。",
			summaryError: "✗ Claude CLI のセットアップが必要です。",
			stepInstalled: (version: string) =>
				`Claude CLI をインストール済み${version ? ` (v${version})` : ""}`,
			stepNotFound: "Claude CLI が見つかりません",
			stepLoggedIn: "ログイン済み",
			stepLoginNeeded: "ログインが必要です",
			stepLoginNeededDetail: "ターミナルで `claude /login` を実行してください。",
			recheck: "再チェック",
			installTitle: "インストール手順",
			installNote:
				"OS に合わせて以下のコマンドをターミナルで実行してください。" +
				"インストール後にこのタブの「再チェック」を押すと、自動検出されます。",
			installWinLabel: "Windows（管理者権限の PowerShell で実行）",
			installWinTooltip:
				"PowerShell 7 (pwsh) を入れてから新しいウィンドウで `claude /login` を実行してください。",
			installMacLabel: "macOS（Terminal で実行 / Homebrew 必須）",
			installNpmLabel: "npm が既に使える環境（Linux ほか共通）",
			installTip:
				"ヒント: 「npm: command not found」と出たら、Node.js が未インストールです。" +
				"上記の OS 別コマンドの 1 行目から順に実行してください。",
			installOfficialGuide: "公式インストールガイド",
			loginTitle: "ログイン手順",
			loginNote:
				"ターミナル（macOS は Terminal、Windows は PowerShell 7 / pwsh）で次のコマンドを実行し、" +
				"画面の指示に従ってブラウザでログインしてください。Claude Pro / Max のサブスクリプションでも API キーでも利用できます。",
			loginCmdLabel: "ログインコマンド",
			loginTroubleHeading: "うまくいかないとき:",
			loginTroubleAutoOpen:
				"ブラウザが自動で開かない場合は、表示された URL を選択コピーしてブラウザのアドレスバーに貼り付け、戻ってきた認証コードをターミナルに貼り戻してください。",
			loginTroublePaste:
				"Windows で認証コードの貼り付けが崩れる場合は、`winget install Microsoft.PowerShell` で PowerShell 7 (pwsh) を入れ、新しいウィンドウで `claude /login` をやり直してください。",
			copyBtn: "コピー",
			copyDone: "コピーしました",
			copyFail: "コピーに失敗しました",
		},
	},
	slash: {
		desc: {
			clear: "会話をクリア",
			continue: "前回セッションを再開（履歴も復元）",
			help: "コマンド一覧を表示",
			model: "モデルの表示 / 変更",
			think: "思考深度の表示 / 変更",
			mcp: "MCP サーバの状態を表示",
			usage: "アカウント・使用状況モーダル",
			cost: "/usage と同じ",
			account: "/usage と同じ",
			config: "プラグインの設定タブを開く",
			compact: "（自動圧縮の説明）",
			exit: "サイドバーパネルを閉じる",
			quit: "サイドバーパネルを閉じる",
			login: "Claude Code にログイン",
			logout: "ログアウト",
			agents: "サブエージェント設定",
			permissions: "ツール許可ルール",
			doctor: "ヘルスチェック",
			upgrade: "Claude Code を更新",
			migrateInstaller: "インストール方式を移行",
			releaseNotes: "リリースノート",
			bug: "バグ報告",
			terminalSetup: "ターミナル統合を設定",
			vim: "Vim 風キーバインドを切替",
			init: "CLAUDE.md を生成（CLI に転送）",
			review: "コードレビュー（CLI に転送）",
			prComments: "PR コメント取得（CLI に転送）",
		},
		category: {
			local: "ローカル",
			replOnly: "REPL",
			passthrough: "CLI",
			skill: "スキル",
			userCommand: "コマンド",
		},
		vaultPathUnresolved: "Vault のパスを解決できません。",
		configOpened:
			"プラグインの設定タブを開きました。モデル、Vault パス、CLI 引数などはこちらから変更できます。",
		purpose: {
			login: "Claude Code にログインする",
			logout: "Claude Code からログアウトする",
			agents: "サブエージェント設定を編集する",
			permissions: "ツール許可ルールを編集する",
			doctor: "Claude Code のヘルスチェック",
			upgrade: "Claude Code を更新する",
			migrateInstaller: "インストール方式を移行する",
			releaseNotes: "リリースノートを表示",
			bug: "Anthropic にバグ報告する",
			terminalSetup: "ターミナル統合を設定する",
			vim: "Vim 風キーバインドを切り替える",
		},
		terminalOnly: (command: string, purpose: string) =>
			[
				`**\`${command}\` はインタラクティブモード（REPL）専用です。**`,
				"",
				`${purpose}には、ターミナルを開いて以下を実行してください:`,
				"",
				"```",
				`claude ${command}`,
				"```",
			].join("\n"),
		compactExplain: [
			"**`/compact` はこのプラグインでは不要です。**",
			"",
			"このプラグインは `claude --print --resume` でセッションを継続しており、",
			"コンテキストウィンドウが埋まると Claude Code 側で自動的に圧縮されます。",
			"会話を完全にリセットしたい場合は `/clear` を使ってください。",
		].join("\n"),
		continue: {
			notFound: (cwd: string, encodedDir: string, exists: boolean, jsonlCount: number) =>
				[
					"再開できるセッションが見つかりません。",
					"",
					"**診断:**",
					`- Vault パス: \`${cwd}\``,
					`- 探索先: \`${encodedDir}\``,
					`- フォルダ存在: ${exists ? "はい" : "いいえ"}`,
					`- JSONL ファイル数: ${jsonlCount}`,
				].join("\n"),
			restored: (count: number) =>
				`前回セッションを復元しました（メッセージ ${count} 件）。次の送信で \`--continue\` 付きで再開します。`,
		},
		help: {
			localTitle: "ローカルコマンド（パネル内で完結）",
			replTitle: "ターミナル案内のみ（REPL 専用コマンド）",
			passthroughTitle: "パススルー（Claude Code CLI に転送）",
			passthroughNote:
				"上記以外の /コマンド（例: /init, /review, /pr-comments など）はそのまま CLI に --print モードで渡されます。" +
				".claude/commands/*.md で定義したユーザーコマンドも動作します。" +
				"注意: TTY を要求する REPL 専用コマンドは print モードでは動かない場合があります。",
			itemClear: "会話をクリア",
			itemContinue: "前回セッションを再開（UI 履歴も `~/.claude/projects/...jsonl` から復元）",
			itemHelp: "このヘルプを表示",
			itemModel: "モデルの表示 / 変更",
			itemThink: "思考深度の表示 / 変更",
			itemMcp: "設定済みの MCP サーバを表示",
			itemUsage: "アカウント情報とレート制限の使用状況を表示",
			itemCost: "/usage と同じ（セッションのコスト・トークンを表示）",
			itemConfig: "プラグインの設定タブを開く",
			itemCompact: "自動圧縮の説明（このプラグインでは手動操作不要）",
			itemExit: "サイドバーパネルを閉じる",
			itemLogin: "Claude Code の認証",
			itemAgents: "サブエージェント設定",
			itemPermissions: "ツール許可ルール",
			itemDoctor: "ヘルスチェック",
			itemUpgrade: "Claude Code 更新",
			itemMigrateInstaller: "インストール方式の移行",
			itemReleaseNotes: "リリースノート",
			itemBug: "Anthropic にバグ報告",
			itemTerminalSetup: "ターミナル統合設定",
			itemVim: "Vim 風キーバインド",
		},
		model: {
			set: (label: string) => `モデルを **${label}** に設定しました。`,
			current: (label: string) => `現在のモデル: ${label}`,
		},
		think: {
			set: (mode: string) => `思考モードを **${mode}** に設定しました。`,
			unknown: (arg: string, valid: string) =>
				`不明な思考モード \`${arg}\`。有効な値: ${valid}`,
			current: (mode: string) => `現在の思考モード: ${mode}`,
		},
		mcp: {
			title: "MCP サーバ（ライブ）",
			checking: "`claude mcp list` で接続確認中…",
			error: (msg: string) => `エラー: ${msg}`,
			emptyOutput: "(`claude mcp list` からの出力はありません)",
			connectedCount: (ok: number, total: number) => `${ok} / ${total} 接続中`,
			exitCode: (code: number) => `(終了コード ${code})`,
			scopeTooltipProject:
				"<vault>/.mcp.json から（この Vault を編集するすべての人と共有）",
			scopeTooltipLocal:
				"~/.claude.json の projects.<vault>.mcpServers から（Vault ごと・このマシン限定）",
			scopeTooltipUser:
				"~/.claude.json の mcpServers から（グローバル・このマシン限定）",
			scopeTooltipClaudeAi: "Claude.ai アカウントが管理（自動提供）",
			scopeTooltipUnknown: "ローカル設定ファイル内に出所が見つかりません",
		},
	},
	agent: {
		permissionUiUnavailable: "承認 UI が利用できないため拒否しました。",
		cliExitedWith: (detail: string) => `claude CLI exited with ${detail}`,
	},
	skill: {
		userCommandFallback: "(ユーザーコマンド)",
		skillFallback: "(スキル)",
	},
	audio: {
		emptyPlaceholder: "Vault 内に音声ファイルが見つかりません",
		searchPlaceholder: "Vault 内の音声ファイルを検索…",
	},
	contextMeter: {
		tooltip: (
			used: string,
			cap: string,
			pct: string,
			input: string,
			cache: string,
			output: string
		) =>
			`コンテキスト: ${used} / ${cap} (${pct}%)\n入力 ${input} · キャッシュ ${cache} · 出力 ${output}`,
		empty: "コンテキスト — 使用データはまだありません",
	},
};
