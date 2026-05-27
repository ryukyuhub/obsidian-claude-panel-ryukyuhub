import type { Messages } from "./types";

export const en: Messages = {
	ribbon: {
		openPanel: "Open Claude Panel",
	},
	command: {
		openPanel: "Open Claude Panel",
		focusInput: "Focus Claude Panel input",
		sendPrompt: "Send prompt",
		cancelAgent: "Cancel running agent",
		clearChat: "Clear conversation",
		cycleModel: "Cycle model",
		toggleActiveFile: "Toggle include active file/folder",
	},
	notify: {
		none: "None",
		sound: "Sound only",
		flash: "Flash only",
		both: "Sound and flash",
	},
	permission: {
		default: "Ask before edits",
		acceptEdits: "Auto-approve edits",
		bypassPermissions: "Skip all confirmations",
		plan: "Plan mode",
		tooltip: {
			default: "Ask for approval on every tool call (edit, Bash, MCP, etc.).",
			acceptEdits: "File edits are auto-approved. Bash, MCP, and others still require confirmation.",
			bypassPermissions: "Run every tool without confirmation. Only when you trust the agent.",
			plan: "Planning only. No tools are executed; the agent returns proposals.",
		},
	},
	composer: {
		unresolvedPaths: (n: number) =>
			`Could not resolve paths for ${n} file(s) (Electron sandbox limitation).`,
		alreadyAttached: "The selected file is already attached.",
		pasted: (path: string) => `Pasted: ${path}`,
		pasteFailed: (msg: string) => `Failed to save pasted image: ${msg}`,
		pendingPaste: (name: string) =>
			`${name} (will be saved on send)`,
		activeLabel: "Active:",
		activeFolderTooltip:
			"Sends the folder path as an @-mention. Claude reads files inside on demand.",
		activeFileTooltip:
			"Sent as an @-mention to Claude on every message.",
		folderFileCount: (path: string, n: number) =>
			`${path} (${n} file${n === 1 ? "" : "s"})`,
		toggleIncluded: "✓ Include",
		toggleExcluded: "○ Exclude",
		noActiveFile: "No active file",
		selectionLabel: "Selection:",
		selectionMeta: (lines: number, chars: number, startLine: number) =>
			`${lines} line${lines === 1 ? "" : "s"} · ${chars} chars · L${startLine}`,
		selectionMoreLines: (n: number) =>
			` ⋯ +${n} more line${n === 1 ? "" : "s"}`,
		fileCount: (n: number) => `${n} file${n === 1 ? "" : "s"}`,
		savedToVault: (n: number) =>
			`Saved ${n} file${n === 1 ? "" : "s"} inside the vault.`,
		copyFailed: (n: number) =>
			`Could not copy ${n} file${n === 1 ? "" : "s"} to the vault.`,
	},
	account: {
		modalTitle: "Account & Usage",
		loading: "Loading…",
		sectionAccount: "Account",
		sectionUsage: "Usage",
		sectionLocalTotal: "Local totals (recorded by this plugin)",
		authFetchFailed: (msg: string) =>
			`Could not fetch auth status: ${msg}`,
		notLoggedIn: "Not signed in. Run `claude /login` in your terminal.",
		cacheNote: (age: string) => `Showing cached data from ${age}.`,
		rateLimitedNote:
			"Rate-limited; could not fetch the latest usage. Try again later by clicking Refresh.",
		usageFetchFailed: (msg: string) => `Could not fetch usage: ${msg}`,
		manageOnClaudeAi: "Manage usage on claude.ai",
		refresh: "Refresh",
		refreshDisabledRateLimited: "Disabled while rate-limited",
		openModalFailed: (msg: string) =>
			`Could not open Account & Usage: ${msg}`,
		rowAuthMethod: "Auth method",
		rowEmail: "Email",
		rowOrg: "Organization",
		rowPlan: "Plan",
		historyToday: "Today",
		historyThisMonth: "This month",
		historyTooltip: (count: number, inT: string, outT: string, cc: string, cr: string) =>
			`${count} turn${count === 1 ? "" : "s"}\nInput: ${inT}\nOutput: ${outT}\nCache create: ${cc}\nCache read: ${cr}`,
		historyResolving:
			"Resolving account… totals may include data from other accounts.",
		historyFootnote:
			"Only counts prompts sent via this plugin. Claude.ai web and other CLI sessions are not included. For the accurate 7-day figure, see “Weekly (7 days)” above.",
		windowFiveHour: "Session (5 hours)",
		windowSevenDay: "Weekly (7 days)",
		windowSevenDayOpus: "Weekly Opus",
		windowSevenDaySonnet: "Weekly Sonnet",
		noUsageData: "No usage data.",
		utilizationRateLimited: (min: number) =>
			`Utilization (%) is unavailable while the Anthropic API is rate-limited. Try Refresh in ${min} minute${min === 1 ? "" : "s"}.`,
		utilizationFetchHint:
			"Utilization (%) is fetched from the API. Click Refresh to retrieve the latest value.",
		utilizationPending: "Awaiting API value (updates after the next chat turn).",
		resetSoon: "Resets shortly",
		resetInMinutes: (n: number) => `Resets in ${n} minute${n === 1 ? "" : "s"}`,
		resetInHours: (n: number) => `Resets in ${n} hour${n === 1 ? "" : "s"}`,
		resetInDays: (n: number) => `Resets in ${n} day${n === 1 ? "" : "s"}`,
		cacheAgeLessThanMinute: "less than 1 minute ago",
		cacheAgeMinutes: (n: number) => `${n} minute${n === 1 ? "" : "s"} ago`,
		cacheAgeHours: (n: number) => `${n} hour${n === 1 ? "" : "s"} ago`,
		errClaudeCliNotFound:
			"`claude` CLI not found. Set its absolute path in the plugin settings.",
		errAuthJsonParse: (msg: string) =>
			`Could not parse auth status JSON: ${msg}`,
		errNotLoggedInForUsage:
			"Not signed in to Claude Code. Run `claude /login` in your terminal.",
		errUsageAuthHttp: (status: number) =>
			`Anthropic API returned HTTP ${status}. Your OAuth token may have expired — run \`claude /login\` in your terminal to refresh it.`,
		errUsageRateLimited: (suffix: string) =>
			`Anthropic API rate limit reached (HTTP 429).${suffix}`,
		errUsageRateLimitedHintDefault: " Wait a moment and click Refresh.",
		errUsageServer: (status: number) =>
			`Anthropic API server error (HTTP ${status}). Please retry later.`,
		errUsageGeneric: (status: number) =>
			`Anthropic API returned HTTP ${status}.`,
	},
	chat: {
		roleUser: "User",
		roleAssistant: "Assistant",
		permPendingTitle: "Tool execution approval",
		permApprovedTitle: "Approved",
		permDeniedTitle: "Denied",
		permAllow: "Allow",
		permDeny: "Deny",
		permUserDenied: "User denied the request.",
		footerComplete: (duration: string, tokensText: string, cost: string) =>
			`Done · ${duration}${tokensText}${cost}`,
		footerDurationSec: (sec: string) => `${sec}s`,
		footerDurationMs: (ms: number) => `${ms}ms`,
		footerUsageTooltip: (inT: string, outT: string, cc: string, cr: string) =>
			`Input: ${inT}\nOutput: ${outT}\nCache create: ${cc}\nCache read: ${cr}`,
		selRefRangeMulti: (start: number, lines: number) =>
			`L${start} · ${lines} lines`,
		selRefRangeSingle: (start: number) => `L${start}`,
		askOtherButton: "Other…",
		askOtherPlaceholder: "Type your answer…",
		askOtherSubmit: "Send",
		askOtherCancel: "Back",
		askMultiSubmit: (n: number) =>
			n > 0 ? `Send (${n})` : "Send",
		interruptedBadge: "Interrupted",
	},
	chatTool: {
		changeOfN: (i: number, n: number) => `Change ${i} / ${n}`,
		writeContent: "Content to write",
		bashCommand: "Command",
		notebookCell: (id: string) => `Cell: ${id}`,
		moreLines: (n: number) => `… +${n} more line${n === 1 ? "" : "s"}`,
	},
	chatRuntime: {
		conversationRestored: "Conversation restored.",
		runInterrupted: "User interrupted the run.",
		runFinished: "Run finished.",
		conversationCleared: "Conversation cleared.",
		interruptedDefault: "Run interrupted.",
		errorPrefix: (msg: string) => `\n\n**Error:** ${msg}`,
		userInterruptedInline: "\n\n_**[User interrupted]**_",
		noActiveMessage: "No active chat message.",
	},
	view: {
		displayText: "Claude Panel",
		headerTitle: "Claude Panel",
		meterLabelContext: "Context",
		accountBtnAria: "Account & Usage",
		clearBtn: "Clear",
		attachBtn: "Attach",
		saveToVaultToggle: "Save to vault",
		saveToVaultTooltip:
			"When on, attached and pasted files are saved inside the vault (at the destination set in settings). " +
			"When off, pasted images go to a temporary folder and attached files keep their original absolute path. " +
			"The default state can be changed in the plugin settings.",
		sendBtn: "Send",
		stopBtn: "Stop (Esc)",
		interruptBtn: "Interrupt",
		interruptedNotice: "Interrupt sent",
		slashBlockedBusy:
			"Slash commands aren't available during a running turn. Press Esc to stop first.",
		controlLabelModel: "Model",
		controlLabelThinking: "Thinking",
		controlLabelEffort: "Effort",
		controlLabelPermission: "Approval",
		effortTooltip:
			"Reasoning depth for supported models (Sonnet 4.6 / Opus 4.7, etc.). 'auto' defers to the CLI / ~/.claude/settings.json default. Haiku does not support effort and the value is ignored.",
		modelChangedNotice: (label: string) => `Model: ${label}`,
		includeStateIncluded: "include",
		includeStateExcluded: "exclude",
		toggleActiveNoticeWithTarget: (target: string, state: string) =>
			`Set "${target}" to ${state}`,
		toggleActiveNoticeDefault: (state: string) => `Set active to ${state}`,
		emptyTitle: "Welcome to Claude Panel",
		emptyCheckingSetup: "Checking setup…",
		emptyReady:
			"Send a message from the input below. Type `/help` to see local commands.",
		emptyCliMissing: "Claude CLI not found.",
		emptyLoginRequired: "Claude CLI login required.",
		emptyStepRunInTerminal: "Run in your terminal: ",
		emptyStepThenLogin: "Then sign in: ",
		emptyOpenSettings: "Open settings",
		emptyRecheck: "Re-check",
		vaultPathUnavailable:
			"Could not resolve the vault path (desktop only).",
		summarizeBadgeLabel: "💬 Summarize & start fresh",
		summarizeBadgeBusyLabel: "Summarizing…",
		summarizeBadgeAria: (percent: number) =>
			`Context at ${percent}%. Click to summarize and start a fresh conversation.`,
		summarizeModalTitle: "Summarize and start a fresh conversation",
		summarizeModalBody: (percent: number) =>
			`Your current conversation is using ${percent}% of the context window. Claude will summarize everything so far, and the summary alone will be carried into a fresh conversation. The displayed messages will be cleared from the chat (the CLI-side log is preserved).`,
		summarizeModalConfirm: "Summarize & start fresh",
		summarizeModalCancel: "Cancel",
		summarizingInProgress: "Summarizing — please wait until it completes.",
		summaryFailedNotice: "Summarization failed. Continuing with the existing conversation.",
		summarySystemPrefix: "Previous conversation summary:",
	},
	settings: {
		resolved: {
			labelResolved: "✓ Resolved:",
			labelAutoDetected: "✓ Auto-detected:",
			labelNotFoundConfigured: "✗ The claude CLI was not found at the specified path",
			labelNotFoundAuto: "✗ The claude CLI was not found in any auto-detection location",
		},
		claudePath: {
			name: "Claude CLI path",
			desc:
				"Optional. Absolute path to the `claude` executable. " +
				"If left blank, the following locations are tried in order: PATH, ~/.local/bin, ~/.claude/local, /usr/local/bin, /opt/homebrew/bin. " +
				"Your existing Claude Code subscription login is used, so no API key is required.",
			placeholder: "/Users/you/.local/bin/claude",
		},
		disableMcp: {
			name: "Disable MCP servers",
			desc:
				"When on, the spawned `claude` CLI ignores ~/.claude.json and the project's .mcp.json " +
				"and starts without any MCP servers. Default: off (MCP enabled). " +
				"Browser pop-ups that servers like Serena try to open are blocked separately " +
				"by overriding the `open`/`xdg-open` commands on PATH.",
		},
		permissionMode: {
			name: "Tool approval mode",
			desc:
				"How Claude behaves when invoking tools such as Edit / Bash / MCP. " +
				"'Ask before edits' shows Approve / Deny buttons in the chat. " +
				"'Edit automatically' auto-approves file edits only; Bash and MCP still ask. " +
				"'Bypass permissions' runs everything without confirmation (legacy behavior). " +
				"'Plan mode' returns a plan only, with no tool execution.",
		},
		model: {
			name: "Model",
			desc:
				"Claude model used for new messages. Can also be changed from the dropdown at the bottom of the chat panel.",
		},
		effort: {
			name: "Effort (reasoning depth)",
			desc:
				"Reasoning depth for supported models (Sonnet 4.6 / Opus 4.6, etc.). `auto` defers to the CLI / `~/.claude/settings.json` default. " +
				"Haiku does not support effort, so the value is ignored.",
		},
		includeActiveDefault: {
			name: "Include the active file / folder by default",
			desc:
				"When on, the active file (or folder) is included in the prompt " +
				"when the chat panel opens. " +
				"When off, it starts excluded. " +
				"Either way you can flip it per turn with the \"Include / Exclude\" toggle in the panel.",
		},
		saveAttachments: {
			name: "Save attachments inside the vault",
			desc:
				"When on, attached and pasted files are saved inside the vault. " +
				"When off, pasted images go to the plugin's temporary folder (removed when Obsidian quits), " +
				"and attached files are referenced by their original absolute path. " +
				"This value becomes the initial state of the \"Save to vault\" checkbox in the chat panel.",
		},
		attachmentLocation: {
			name: "Attachment save location",
			desc:
				"Where attachments go when \"Save attachments inside the vault\" is enabled. " +
				"For active-file-relative modes, files fall back to the vault root when there is no active file.",
			option: {
				activeFileFolder: "Same folder as the active file",
				vaultPath: "A specified path inside the vault",
				activeFileSubfolder: "A named folder next to the active file",
			},
		},
		attachmentVaultPath: {
			name: "Save path (inside the vault)",
			desc:
				"Destination folder (vault-relative) used when the location is set to \"A specified path inside the vault\". " +
				"Leave blank to save to the vault root.",
			placeholder: "attachments",
		},
		attachmentSubfolder: {
			name: "Subfolder name",
			desc:
				"Name of the subfolder created next to the active file when the location is set to " +
				"\"A named folder next to the active file\". Defaults to \"attachments\" when blank.",
			placeholder: "attachments",
		},
		language: {
			name: "Display language",
			desc: "Panel UI language. `auto` follows Obsidian's own language setting.",
			option: {
				auto: "Auto (follow Obsidian)",
				ja: "日本語",
				en: "English",
			},
			restartHint:
				"Language changed. Reload Obsidian to fully update ribbon and command-palette labels.",
		},
		fontSize: {
			name: "Font size",
			desc: (min: number, max: number) =>
				`Base font size for the entire chat panel (${min}–${max}px). ` +
				"Changes apply to the panel immediately.",
		},
		composerPadding: {
			name: "Bottom padding",
			desc: (min: number, max: number) =>
				`Extra padding reserved below the composer (${min}–${max}px). ` +
				"With some themes the Obsidian status bar overlaps the bottom of the right sidebar " +
				"and hides the Send button or model selector. Only raise this if that happens.",
		},
		resetToDefault: "Reset to default",
		submitWithModEnter: {
			name: "Don't submit on Enter",
			desc:
				"When ON, plain Enter only inserts a newline. You submit via the key bound to " +
				"the \"Claude Panel: Send prompt\" command in Obsidian's Hotkeys settings " +
				"(default: Shift+Enter, customizable). When OFF (default), Enter submits.",
		},
		hotkeys: {
			name: "Hotkeys",
			desc:
				"Commands such as Open Panel / Focus Input / Send / Cancel / Clear conversation / Cycle model " +
				"can be assigned freely from Obsidian's built-in Hotkeys settings.",
			openBtn: "Open Hotkey settings",
		},
		about: {
			name: "About this plugin",
			desc: (version: string) => `Version ${version}`,
			repoLink: "GitHub repository",
		},
		notify: {
			completeName: "Completion notification",
			completeDesc:
				"How to notify when Claude finishes responding. " +
				"Flash briefly highlights the panel border. Sound plays the built-in chime, or the audio file you specify below. " +
				"Runs that you cancelled yourself are not notified.",
			volumeName: "Notification volume",
			volumeDesc: (min: number, max: number) =>
				`Completion-notification volume (${min}–${max}%). ` +
				"Use the test button to preview the current setting (volume and file together).",
			testTooltip: "Play test notification",
			soundFileName: "Notification sound file",
			soundFileDesc:
				"Audio file used for the notification (mp3 / wav / ogg / m4a, etc.). " +
				"Files inside the vault are saved as relative paths so they follow you to other devices via vault sync. " +
				"Leave blank to use the built-in short chime.",
			soundPlaceholder: "(blank = built-in chime)",
			pickFromVault: "Pick from inside the vault",
			pickFromOs: "Pick via OS file dialog",
			clearSound: "Clear (revert to built-in chime)",
		},
		setup: {
			title: "Setup status",
			checking: "Checking…",
			summaryOk: "✓ Ready to use.",
			summaryWarn: "⚠ Almost ready — one more step.",
			summaryError: "✗ Claude CLI setup required.",
			stepInstalled: (version: string) =>
				`Claude CLI installed${version ? ` (v${version})` : ""}`,
			stepNotFound: "Claude CLI not found",
			stepLoggedIn: "Signed in",
			stepLoginNeeded: "Sign-in required",
			stepLoginNeededDetail: "Run `claude /login` in your terminal.",
			recheck: "Re-check",
			installTitle: "Install instructions",
			installNote:
				"Run the commands below in a terminal for your OS. " +
				"After installing, press Re-check on this tab and the plugin will pick it up automatically.",
			installWinLabel: "Windows (run in an Administrator PowerShell)",
			installWinTooltip:
				"Install PowerShell 7 (pwsh) first, then run `claude /login` in a new window.",
			installMacLabel: "macOS (run in Terminal, Homebrew required)",
			installNpmLabel: "Environments with npm already available (Linux and others)",
			installTip:
				"Tip: if you see 'npm: command not found', Node.js is not installed. " +
				"Run the commands above for your OS from the first line.",
			installOfficialGuide: "Official install guide",
			loginTitle: "Login instructions",
			loginNote:
				"In a terminal (Terminal on macOS, PowerShell 7 / pwsh on Windows), run the command below " +
				"and follow the on-screen prompts to sign in via your browser. Both Claude Pro / Max subscriptions and API keys are supported.",
			loginCmdLabel: "Login command",
			loginTroubleHeading: "If it doesn't work:",
			loginTroubleAutoOpen:
				"If the browser does not open automatically, select and copy the URL shown, paste it into your browser's address bar, then paste the returned auth code back into the terminal.",
			loginTroublePaste:
				"If pasting the auth code is garbled on Windows, install PowerShell 7 (pwsh) with `winget install Microsoft.PowerShell` and retry `claude /login` in a new window.",
			copyBtn: "Copy",
			copyDone: "Copied",
			copyFail: "Failed to copy",
		},
	},
	slash: {
		desc: {
			clear: "Clear the conversation",
			continue: "Resume the last session (restores history)",
			help: "Show the command list",
			model: "Show / change the model",
			think: "Show / change the thinking depth",
			mcp: "Show MCP server status",
			plugin: "List / install / uninstall plugins (forwarded to claude plugin)",
			usage: "Account & usage modal",
			cost: "Same as /usage",
			account: "Same as /usage",
			config: "Open the plugin settings tab",
			compact: "(Auto-compaction explanation)",
			exit: "Close the sidebar panel",
			quit: "Close the sidebar panel",
			login: "Sign in to Claude Code",
			logout: "Sign out",
			agents: "Sub-agent settings",
			permissions: "Tool permission rules",
			doctor: "Health check",
			upgrade: "Update Claude Code",
			migrateInstaller: "Migrate the installer",
			releaseNotes: "Release notes",
			bug: "Report a bug",
			terminalSetup: "Configure terminal integration",
			vim: "Toggle Vim-style key bindings",
			init: "Generate CLAUDE.md (forwarded to CLI)",
			review: "Code review (forwarded to CLI)",
			prComments: "Fetch PR comments (forwarded to CLI)",
		},
		category: {
			local: "Local",
			replOnly: "REPL",
			passthrough: "CLI",
			skill: "Skill",
			userCommand: "Command",
		},
		vaultPathUnresolved: "Could not resolve the vault path.",
		configOpened:
			"Opened the plugin settings tab. You can change the model, vault path, CLI arguments, etc. from there.",
		purpose: {
			login: "to sign in to Claude Code",
			logout: "to sign out of Claude Code",
			agents: "to edit sub-agent settings",
			permissions: "to edit tool permission rules",
			doctor: "for the Claude Code health check",
			upgrade: "to update Claude Code",
			migrateInstaller: "to migrate the installer",
			releaseNotes: "to view the release notes",
			bug: "to report a bug to Anthropic",
			terminalSetup: "to configure terminal integration",
			vim: "to toggle Vim-style key bindings",
		},
		terminalOnly: (command: string, purpose: string) =>
			[
				`**\`${command}\` is only available in interactive (REPL) mode.**`,
				"",
				`Open a terminal and run the following ${purpose}:`,
				"",
				"```",
				`claude ${command}`,
				"```",
			].join("\n"),
		compactExplain: [
			"**`/compact` is not needed in this plugin.**",
			"",
			"This plugin uses `claude --print --resume` to continue sessions, and",
			"Claude Code automatically compacts the conversation when the context window fills up.",
			"To reset the conversation entirely, use `/clear`.",
		].join("\n"),
		continue: {
			notFound: (cwd: string, encodedDir: string, exists: boolean, jsonlCount: number) =>
				[
					"No resumable session was found.",
					"",
					"**Diagnostics:**",
					`- Vault path: \`${cwd}\``,
					`- Looked in: \`${encodedDir}\``,
					`- Folder exists: ${exists ? "yes" : "no"}`,
					`- JSONL file count: ${jsonlCount}`,
				].join("\n"),
			restored: (count: number) =>
				`Restored the previous session (${count} message${count === 1 ? "" : "s"}). The next send will resume with \`--continue\`.`,
		},
		help: {
			localTitle: "Local commands (handled inside the panel)",
			replTitle: "Terminal guidance only (REPL-only commands)",
			passthroughTitle: "Passthrough (forwarded to the Claude Code CLI)",
			passthroughNote:
				"Other /commands (e.g. /init, /review, /pr-comments) are forwarded to the CLI in --print mode as-is. " +
				"User commands defined in .claude/commands/*.md also work. " +
				"Note: REPL-only commands that require a TTY may not work in print mode.",
			itemClear: "Clear the conversation",
			itemContinue: "Resume the previous session (also restores UI history from `~/.claude/projects/...jsonl`)",
			itemHelp: "Show this help",
			itemModel: "Show / change the model",
			itemThink: "Show / change the thinking depth",
			itemMcp: "Show configured MCP servers",
			itemPlugin: "Plugin actions (list / install / uninstall / enable / disable / update / details)",
			itemUsage: "Show account info and rate-limit usage",
			itemCost: "Same as /usage (show session cost & tokens)",
			itemConfig: "Open the plugin settings tab",
			itemCompact: "Auto-compaction explanation (no manual action needed)",
			itemExit: "Close the sidebar panel",
			itemLogin: "Claude Code authentication",
			itemAgents: "Sub-agent settings",
			itemPermissions: "Tool permission rules",
			itemDoctor: "Health check",
			itemUpgrade: "Update Claude Code",
			itemMigrateInstaller: "Migrate the installer",
			itemReleaseNotes: "Release notes",
			itemBug: "Report a bug to Anthropic",
			itemTerminalSetup: "Terminal integration settings",
			itemVim: "Vim-style key bindings",
		},
		model: {
			set: (label: string) => `Set the model to **${label}**.`,
			current: (label: string) => `Current model: ${label}`,
		},
		think: {
			set: (mode: string) => `Set the thinking mode to **${mode}**.`,
			unknown: (arg: string, valid: string) =>
				`Unknown thinking mode \`${arg}\`. Valid values: ${valid}`,
			current: (mode: string) => `Current thinking mode: ${mode}`,
		},
		plugin: {
			title: (cmd: string) => `Plugin: \`claude plugin ${cmd}\``,
			running: (cmd: string) => `Running \`claude plugin ${cmd}\`…`,
			error: (msg: string) => `Error: ${msg}`,
			emptyOutput: "(No output)",
			exitCode: (code: number) => `(exit code ${code})`,
			usage: [
				"**Usage:**",
				"- `/plugin` or `/plugin list` — list installed plugins",
				"- `/plugin install <name>@<marketplace>` — install",
				"- `/plugin uninstall <name>@<marketplace>` — uninstall",
				"- `/plugin enable <name>@<marketplace>` — enable",
				"- `/plugin disable [<name>@<marketplace>]` — disable",
				"- `/plugin update <name>@<marketplace>` — update",
				"- `/plugin details <name>` — show details",
				"",
				"Other subcommands (`marketplace`, `validate`, `tag`, `prune` …) are forwarded the same way as `claude plugin ...`.",
			].join("\n"),
		},
		mcp: {
			title: "MCP servers (live)",
			checking: "Checking connections with `claude mcp list`…",
			error: (msg: string) => `Error: ${msg}`,
			emptyOutput: "(No output from `claude mcp list`)",
			connectedCount: (ok: number, total: number) => `${ok} / ${total} connected`,
			exitCode: (code: number) => `(exit code ${code})`,
			scopeTooltipProject:
				"From <vault>/.mcp.json (shared with everyone who edits this vault)",
			scopeTooltipLocal:
				"From ~/.claude.json projects.<vault>.mcpServers (per-vault, this machine only)",
			scopeTooltipUser:
				"From ~/.claude.json mcpServers (global, this machine only)",
			scopeTooltipClaudeAi: "Managed by your Claude.ai account (provided automatically)",
			scopeTooltipUnknown: "Source not found in local configuration files",
		},
	},
	agent: {
		permissionUiUnavailable: "Denied because no approval UI is available.",
		cliExitedWith: (detail: string) => `claude CLI exited with ${detail}`,
	},
	skill: {
		userCommandFallback: "(user command)",
		skillFallback: "(skill)",
	},
	audio: {
		emptyPlaceholder: "No audio files found in this vault",
		searchPlaceholder: "Search audio files in this vault…",
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
			`Context: ${used} / ${cap} (${pct}%)\nInput ${input} · Cache ${cache} · Output ${output}`,
		empty: "Context — no usage data yet",
	},
};
