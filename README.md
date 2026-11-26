# Claude Panel

> **Provided by [Ryukyu HUB Inc. (琉球HUB株式会社)](https://ryukyuhub.co.jp).**

Claude Panel adds a right-sidebar panel powered by [Claude Code](https://docs.claude.com/claude-code) to Obsidian. It runs the `claude` CLI with the active vault as its working directory, so reading, writing, searching, and running commands against your notes all happen inside Obsidian.

The panel offers two interfaces:

- **Terminal UI (default)** — Claude Code's own interactive screen. The plugin runs `claude` in interactive mode inside a terminal built with [xterm.js](https://xtermjs.org/).
- **Chat UI** — this plugin's own chat screen. It runs `claude` as a subprocess with stream-json I/O.

Switch between them with **Interface** in the plugin settings. If you already used the plugin, the panel switches to the terminal UI once you update, and a notice tells you how to switch back.

> Desktop only. Requires the `claude` CLI to be installed and signed in (Claude Pro / Max subscription, or an Anthropic API key).

日本語の解説は [README.ja.md](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/README.ja.md) を参照してください。

## Features

### Terminal UI (default)

- Claude Code's own screen inside the sidebar. Model, effort, thinking, and approval mode follow Claude Code's own settings and its UI (`/model`, `Shift+Tab`, and so on), not this plugin's settings
- The active note or folder and the editor / preview selection are passed to Claude Code each time you submit a prompt (toggleable; see [Limitations](#limitations))
- `[[wikilinks]]`, vault file paths, and URLs in the output are clickable
- Attach files with the paperclip button or by drag & drop (from your OS or from Obsidian's file explorer); paste clipboard images directly
- Header buttons for a new session, continuing the last session, attaching files, account & usage, and settings. After Claude Code exits, you can resume the same session or start a new one
- Turn completion is signaled by a sound chime and a brief panel flash (configurable in settings)
- Terminal colors and the monospace font follow your Obsidian theme
- The current model and effort are always shown in Claude Code's status line at the bottom of the screen, like `Sonnet 5.5 · effort: high`. Changing them with `/model` or `/effort` is reflected right away (toggleable; see [Limitations](#limitations))

### Chat UI

- Streaming chat panel with tool-use pills and per-turn cost / duration / token usage
- Active note or active folder is auto-mentioned as `@filename` on every turn (toggleable)
- File picker for additional mentions; paste clipboard images directly into the composer
- Editor / preview selection is captured automatically so you can ask "explain this" without copy/paste
- Discrete-choice questions render as clickable buttons; yes/no questions in prose are auto-detected and rendered as a Yes/No picker too
- Turn completion is signaled by a sound chime and a brief panel flash (configurable in settings)
- Sessions are resumed via `claude --resume <session>` (Claude Code's auto-compaction stays active)
- Slash commands handled in the panel, such as `/clear`, `/continue`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/compact`
- Five tool approval modes: Ask before edits / Auto-approve edits / Auto mode / Skip all confirmations / Plan mode. Auto mode lets Claude Code's classifier run low-risk actions automatically and block risky ones; it needs a supported model and plan (Haiku is not supported) and falls back to "Ask before edits" when unavailable. The classifier's risk-check requests are sent from Claude Code to Anthropic and may count toward your usage

### Both interfaces

- Account & usage panel — Claude plan, organization, and rate-limit consumption (5h / 7d / Sonnet)
- Project-level MCP servers: drop a `.mcp.json` at the vault root and Claude Code loads it. A setting can start Claude Code without any MCP servers
- The plugin's UI follows Obsidian's language setting (English / 日本語)

## Requirements

- Obsidian desktop, with the `claude` CLI installed and signed in (see [Installation](#installation))
- For the terminal UI:
  - **Windows**: Windows 10 version 1809 or later (the terminal uses the Windows pseudo console, ConPTY), and the built-in Windows PowerShell 5.1
  - **macOS / Linux**: Python 3.8 or later (`python3`), or the `script` command
- The terminal UI has not been tested on macOS yet. If it does not work for you, switch to the chat UI with **Interface** in the plugin settings

## External programs, network, and files

This section explains what the plugin runs, which network connections it makes, and which files it writes outside the vault, and why. The plugin does not bundle or download any native binaries.

### Programs it runs

- **`claude` CLI** — the Claude Code CLI you installed. This is what talks to Anthropic. The plugin also runs `claude auth status --json` to show account info.
- **Windows (terminal UI): Windows PowerShell 5.1.** To give `claude` a real terminal without a native module, the plugin runs a PowerShell script bundled in `main.js`:
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>` (with no console window).
  - `-ExecutionPolicy Bypass` applies only to that PowerShell process. It does not change your system's execution policy.
  - The script compiles C# source embedded in it at runtime with `Add-Type`, and uses it to call the Windows ConPTY API.
  - The script is written to `%TEMP%\claude-panel-pty-bridge-<hash>.ps1` (see [Files it writes](#files-it-writes)).
- **Status line (terminal UI): Python on macOS / Linux, Windows PowerShell 5.1 on Windows.** To show the model and effort in the status line, the plugin gives Claude Code a `statusLine` command, and Claude Code runs it each time it updates the display. It only reads the JSON Claude Code passes on standard input and prints one line. It is not used when "Show model and effort in the status line" is off.
  - macOS / Linux: the same Python found for the terminal (see above), run as `python3 -I -S -X utf8 -c <source>`. If no Python is found, nothing is shown.
  - Windows: the same PowerShell 5.1 as above, run as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>`, with the script written to `%TEMP%\claude-panel-statusline-<hash>.ps1`.
- **macOS / Linux (terminal UI): `python3`, or `script` if no suitable Python is found.** The plugin passes a bundled Python script on the command line (`python3 -I -S -u -X utf8 -c <source>`) to create the terminal.
  - Python is searched in this order. macOS: `/Library/Developer/CommandLineTools/usr/bin/python3`, `/Applications/Xcode.app/Contents/Developer/usr/bin/python3`, `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/Library/Frameworks/Python.framework/Versions/Current/bin/python3`, and `/usr/bin/python3` only when `xcode-select -p` succeeds (otherwise it would prompt you to install developer tools). Linux: `python3` in each absolute directory on `PATH`, then `/usr/bin` and `/usr/local/bin`.
  - Each candidate is checked by running it once with a short check (Python 3.8 or later with `os.forkpty`).
  - If none is usable, the plugin runs a bundled shell script with `/bin/sh` that uses the `script` command found on `PATH` (and `stty` for resizing).
- **macOS: `security`** — to read Claude Code's OAuth token from the Keychain for the account & usage panel.

### Network

- **Local hook server (terminal UI).** The plugin opens an HTTP server on `127.0.0.1` on a random port. It is not reachable from other machines. Claude Code calls it through its HTTP hooks (`UserPromptSubmit` and `Stop`). On a prompt, the plugin replies with the path of the active note or folder and the current selection, which Claude Code adds as context. On `Stop`, the plugin plays the completion notification.
  - Each panel gets its own random URL path and a random token. The token is passed to `claude` in an environment variable, not on the command line, and every request must carry it.
  - Requests that come from a browser (with an `Origin` header or another `Host`) are rejected.
  - `127.0.0.1` and `localhost` are added to `NO_PROXY` for `claude` so the hook calls do not go through a proxy.
- **Anthropic usage endpoint.** The account & usage panel sends your OAuth token to `https://api.anthropic.com/api/oauth/usage` to read rate-limit consumption.
- Everything else (chat, tools, MCP servers) is done by the `claude` CLI itself.

### Files it writes

Temporary files in the OS temp directory (`os.tmpdir()`, `%TEMP%` on Windows):

| File | When | Purpose |
|---|---|---|
| `claude-panel-pty-bridge-<hash>.ps1` | Windows, terminal UI | The PowerShell script above. Reused while its contents are the same; a new file is written when the plugin updates it. A short-lived `.tmp` file is used while writing |
| `claude-panel-statusline-<hash>.ps1` | Windows, terminal UI, when the status line setting is on | The PowerShell script for the status line. Reused and updated the same way as the one above |
| `ptyb.XXXXXX/` (under `$TMPDIR` or `/tmp`) | macOS / Linux, terminal UI, `script` fallback only | Small files for process IDs. Removed when the session ends |
| `claude-panel-empty-mcp.json` | When "Disable MCP servers" is on | An empty MCP configuration passed to `claude` |
| `claude-panel-thinking-on.json` / `claude-panel-thinking-off.json` | Chat UI | Settings passed to `claude` to turn thinking on or off |
| `claude-panel-shadow-bin/open`, `claude-panel-shadow-bin/xdg-open` | Chat UI, macOS / Linux | No-op scripts that stop MCP servers from opening a browser (see [Architecture](#architecture)) |

Other files:

- Pasted images are saved to `<vault>/.obsidian/plugins/claude-panel-ryukyuhub/attachments/` (`.obsidian` is your vault's config folder) and deleted when the plugin unloads. If "Save attachments inside the vault" is on, they are saved in the vault instead and kept.
- `~/.claude-panel/usage-history.json` and `~/.claude-panel/usage-cache.json` hold the local token totals and the last rate-limit values for the account & usage panel.

## Installation

> **New to the Claude CLI?** Parts of this guide use a terminal. On Windows, open **PowerShell**; on macOS, open **Terminal**. Copy and paste each command block one line at a time. If a command says "not found," see [Troubleshooting](#troubleshooting) at the bottom.

### 1. Install prerequisites

The `claude` CLI runs on Node.js. Install Node.js (and Git, plus PowerShell 7 on Windows) first.

#### Windows — install with `winget` (recommended)

Open PowerShell **as Administrator** and run these three commands in order:

```powershell
winget install --id OpenJS.NodeJS.LTS         # Node.js + npm
winget install --id Git.Git                   # Git
winget install --id Microsoft.PowerShell      # PowerShell 7 (the older 5.1 mangles pasted auth codes)
```

After installation, **close PowerShell and re-open a fresh PowerShell 7 (`pwsh`) window** before continuing — the PATH needs to be reloaded.

> PowerShell 7 is for your own terminal work. The plugin's terminal UI uses the built-in Windows PowerShell 5.1, which stays installed alongside it.

> If `winget` is unavailable on older Windows, you can install each tool directly from its official site: [Node.js LTS](https://nodejs.org/) / [Git for Windows](https://git-scm.com/download/win) / [PowerShell 7](https://aka.ms/PSWindows).

#### macOS — install with `brew` (recommended)

In Terminal:

```bash
# Only run this line if Homebrew is not already installed:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js (npm included) and Git
brew install node git
```

### 2. Install the Claude Code CLI

One command on every OS:

```bash
npm install -g @anthropic-ai/claude-code
```

Run `claude --version` afterwards. If it prints a version, you are good.

> On macOS you can also install via Homebrew Cask: `brew install --cask claude-code`.

### 3. Sign in to Claude

```bash
claude /login
```

A browser opens to Anthropic's login screen. Sign in with your Claude Pro / Max subscription or your Anthropic API key.

> **If the browser does not open automatically:** copy the `https://claude.ai/...` URL printed in the terminal and paste it into your browser's address bar. After signing in, copy the **auth code** shown on the page and paste it back into the terminal.
>
> **If pasting the auth code is mangled on Windows:** Windows' built-in PowerShell 5.1 has a known clipboard bug. Install PowerShell 7 with `winget install Microsoft.PowerShell` (see above) and retry in a fresh `pwsh` window.
>
> With the terminal UI, you can also run `/login` inside the panel.

### 4. Install the Obsidian plugin

1. In Obsidian, open Settings → Community plugins → **Browse**, search for **Claude Panel**, and click **Install**.
2. Enable **Claude Panel** in the Community plugins list.
3. Open the plugin's setting tab. The top "Setup status" block shows whether the `claude` CLI was auto-detected. If not, paste the absolute path to the binary (for example `/usr/local/bin/claude` on macOS, or `C:\Users\<you>\AppData\Roaming\npm\claude.cmd` on Windows).

> For sideloading or pre-release builds, [BRAT](https://github.com/TfTHacker/obsidian42-brat) can install the plugin straight from this repository.

## Troubleshooting

### `claude: command not found` / `'claude.exe' is not recognized`
Right after `npm install -g @anthropic-ai/claude-code`, your terminal has not picked up the new PATH. **Closing and re-opening the terminal** usually fixes it. If detection still fails, fill in the absolute path to the binary in the plugin's "Claude CLI path" setting:

- macOS (Intel): `/usr/local/bin/claude`
- macOS (Apple Silicon, Homebrew): `/opt/homebrew/bin/claude`
- macOS (npm global): something like `~/.nvm/versions/node/<ver>/bin/claude`
- Windows (npm global): `C:\Users\<you>\AppData\Roaming\npm\claude.cmd`

### Auth code paste is broken / input shows up blank on Windows
The bundled PowerShell 5.1 has a clipboard bug. Install PowerShell 7 with `winget install Microsoft.PowerShell` and re-run `claude /login` in a fresh `pwsh` window.

### The browser does not open (Windows / WSL / Remote Desktop / SSH)
Copy the URL the terminal prints, paste it into a browser address bar manually, and paste the auth code that appears after sign-in back into the terminal.

### `npm: command not found`
Node.js is not installed. Go back to [Install prerequisites](#1-install-prerequisites) and run `winget install OpenJS.NodeJS.LTS` (Windows) or `brew install node` (macOS).

### The plugin does not start, or chat fails to send
Check that the "Setup status" block in the plugin's setting tab reads **✓ Ready to use.** If it shows ✗ or ⚠, follow the install / login steps shown directly below it. The "Re-check" button refreshes the status.

### "A terminal can't be opened in this environment." (macOS / Linux)
The terminal UI found neither a usable Python (3.8 or later) nor the `script` command. Install Python 3 (on macOS, for example, the Command Line Tools with `xcode-select --install`, or `brew install python`; on Linux, your distribution's `python3` package), then press **Retry** in the panel. You can also press **Switch to chat UI**.

### "Could not open a terminal." / PowerShell is blocked (Windows)
The PowerShell process the terminal UI uses could not run. The text below the message shows the reason reported by PowerShell. Common causes:

- An execution policy set by Group Policy. `-ExecutionPolicy Bypass` on the command line does not override a policy set by Group Policy.
- Application control (AppLocker, WDAC) or security software blocking `powershell.exe`, scripts in `%TEMP%`, or C# compilation with `Add-Type`. PowerShell's Constrained Language Mode also blocks `Add-Type`.
- `%TEMP%` is not writable.

These are usually set by an administrator. Ask them, or press **Switch to chat UI**, which does not use PowerShell.

### "Could not start Claude Code."
The terminal was opened but `claude` could not be started. Check the "Claude CLI path" setting (the **Open settings** button takes you there).

### Japanese (IME) input in the terminal UI
Text being composed is shown at the cursor in the terminal. `Enter` while composing only confirms the conversion; it does not submit the prompt. In a narrow panel, long composition text is shifted left so that its end stays visible. If your input method still does not work well in the terminal, switch to the chat UI, which uses a normal text box.

### Notes are not passed, no completion chime, or no "Resume" button (terminal UI)
These rely on Claude Code's hooks. See [Limitations](#limitations).

## Usage

- Click the ribbon icon or run **Open Claude Panel** from the command palette to open the panel.
- To switch interfaces, change **Interface** in the plugin settings. The panel is reopened, and anything running in it ends.

### Terminal UI

- Claude Code starts in a new session the first time the panel becomes visible. Use it as you would in any terminal. `/login`, `/model`, `Shift+Tab`, and other Claude Code features work as usual.
- Keys:
  - `Shift+Enter` inserts a newline.
  - Windows / Linux: `Ctrl+C` copies when text is selected; otherwise it goes to Claude Code. `Ctrl+Shift+C` copies. `Ctrl+V` / `Ctrl+Shift+V` paste.
  - macOS: `Cmd+C` / `Cmd+V` copy and paste.
  - When Claude Code is using the mouse, hold `Shift` (Windows / Linux) or `Option` (macOS) while dragging to select text.
  - While the terminal has focus, keys go to the terminal, so Obsidian hotkeys do not work (on macOS, `Cmd` shortcuts still do). Click another pane to use Obsidian hotkeys.
- Links: URLs open in your browser. `[[wikilinks]]` to existing notes and paths of files in the vault (vault-relative, or absolute paths inside the vault) open in Obsidian; hold `Ctrl` / `Cmd` while clicking to open them in a new tab.
- The bar at the bottom shows the active note (or the folder last clicked in the file explorer) and the current selection, each with an "Attach" checkbox (the chat UI keeps its Include / Exclude buttons). When you submit a prompt that does not start with `/`, the path of the checked note or folder and the selected text are passed to Claude Code. Note contents are not sent; Claude Code reads them when needed. A selection longer than 7,500 characters is cut, with a note telling Claude Code where to read the rest.
  - After you send a prompt, the right end of the bar shows what was actually passed with it: "HH:MM Attached: <name>" (the note or folder, and the selection's lines if any), or "HH:MM Nothing attached". Hover over it for details: the full path, the selection's lines, how many characters were left out, and why nothing was attached.
  - The display is cleared when a new session starts, for example after **Clear conversation**.
  - Claude Code does not call the hooks for built-in slash commands such as `/help`, so the display does not change for them. The time shows that it still refers to an earlier prompt.
  - For a prompt you send (queue) while Claude is responding, what is passed is the active note and selection at the time Claude Code picks the prompt up, not when you pressed Enter, and the time shown is that time too.
  - If the plugin does not answer the hook within 2 seconds, Claude Code goes on without the note. The plugin cannot detect this, so the display still says "Attached".
- Attach files with the paperclip button, or drag & drop files and folders from your OS or from Obsidian's file explorer. They are inserted as `@path` references. Files outside the vault are copied into the vault when "Save attachments inside the vault" is on. Folders are referenced where they are. Claude Code's `@` reference cannot attach a file whose path contains `#`, or a path that contains both `"` and a space. For these the plugin inserts the bare path without `@`, so Claude receives the path rather than the contents; ask Claude to read it if needed.
- So that the bottom of the panel is not hidden by Obsidian's status bar, the terminal UI automatically adds as much bottom margin as the status bar overlaps. The **Bottom padding** setting only has an effect when it is larger than that.
- Paste a clipboard image to save it and insert its absolute path; Claude Code picks it up as an image. When the clipboard has both text and an image, the text is pasted.
- Header buttons: **New session**, **Continue last session** (`claude --continue`), **Attach files**, **Account & Usage**, and **Open settings**.
- After Claude Code exits (for example with `/exit`), choose **Resume** (the same session; shown once the session is known, after you have submitted a prompt) or **New session**.
- Commands: **Cancel running agent** sends `Esc` to Claude Code, **Clear conversation** starts a new session, and **Toggle include active file/folder** works as in the chat UI. **Send prompt** and **Cycle model** are for the chat UI only.
- The settings for approval mode, model, thinking, effort, display names, and the submit key apply to the chat UI only, and are hidden while the terminal UI is selected.

### Chat UI

- Type a prompt and press `Enter` (or click Send). `Esc` cancels the running turn; `Shift+Enter` inserts a newline.
- Use the **Attach** button to mention additional notes, or paste a clipboard image straight into the composer.
- Click the user icon in the panel header to see your Claude account info and current rate-limit consumption.

## Limitations

- **Terminal UI note integration needs Claude Code's hooks.** Passing the active note and selection, the completion notification, and the **Resume** button after exit all depend on Claude Code calling the plugin's local hook server. They do not work when hooks are turned off or restricted, for example with `disableAllHooks`, or when an organization's managed settings limit HTTP hooks with `allowedHttpHookUrls`. The terminal itself still works.
- **Status line in the terminal UI.** The "Show model and effort in the status line" setting is on by default. Inside the panel, this display is used instead of the `statusLine` in your `settings.json`; your usual terminal is not affected. When the setting is off, your own `statusLine` setting is used. Changes apply from the next session you start. On macOS / Linux, nothing is shown without Python 3.8 or later (when the terminal runs through `script`). Nothing is shown either when `disableAllHooks` is on.
- **The UI language setting covers only the plugin's own UI.** It does not change Claude Code's screen in the terminal UI.
- **Theme in the terminal UI.** The plugin starts Claude Code with `theme: auto` so it follows Obsidian's light / dark mode. If you pick a theme with `/theme` in the panel, it goes back to `auto` the next time Claude Code starts in the panel.
- **Switching light / dark on Windows while Claude Code is running.** Claude Code's text colors do not change until its next start. The terminal background does follow, and the light / dark state at startup is detected correctly. This is because the Windows pseudo console (ConPTY) does not relay Claude Code's background-color query. On macOS / Linux the colors follow while Claude Code is running.
- **"Local totals" in the account & usage panel count the chat UI only.** Usage in the terminal UI is not recorded there. The rate-limit consumption (5h / 7d) is read from Anthropic, so it is not limited to the chat UI.
- **Obsidian hotkeys while the terminal has focus.** See [Usage](#terminal-ui).
- The **Interface** setting is stored in the plugin's `data.json`, so it is shared by devices that sync the vault's `.obsidian` folder.

## Development

```bash
git clone https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub.git
cd obsidian-claude-panel-ryukyuhub
npm install
cp esbuild.config.local.example.mjs esbuild.config.local.mjs
# Edit esbuild.config.local.mjs and point VAULT_OUT_DIRS at your vault's plugin folder.
npm run dev      # esbuild watch — writes main.js and assets straight into the vault
```

The build writes `main.js` / `manifest.json` / `styles.css` directly into your configured vault plugin folder, so toggling the plugin off/on (or using [Hot Reload](https://github.com/pjeby/hot-reload)) picks up changes instantly.

`esbuild.config.local.mjs` is gitignored, so each developer keeps their own path. You can also skip the file and set `OUT_DIR=...` per invocation:

```bash
OUT_DIR=/path/to/vault/.obsidian/plugins/claude-panel-ryukyuhub npm run dev
```

When neither is set, the build falls back to `./build/` (used by the CI release packaging).

There is no test suite. Run `npm run lint` (ESLint, configured in `eslint.config.mjs`) and `npx tsc --noEmit` (type check) before sending changes. `npm run build` makes a production build.

## Architecture

Files under `src/`:

- `main.ts` — `Plugin` entry point. Registers the view (a chat or terminal view, depending on **Interface**), ribbon icon, commands, and setting tab; migrates settings; owns the hook server; ends terminal processes on quit, reload, and unload.
- `panel-view.ts` — The view type shared by both interfaces and the `PanelView` interface that `main.ts` and the setting tab call.
- `view.ts` — Chat UI `ItemView`. Owns the chat history, header controls, composer, and rendering.
- `chat-runtime.ts` — One chat turn: sending, streaming, and tool approval.
- `agent.ts` — Chat UI subprocess layer. `runAgent()` spawns `claude` with stream-json I/O and dispatches each JSON line to text / tool-use / result / error / usage events. Also holds the vault system prompt and the empty MCP config used by both interfaces.
- `chat-message.ts` / `chat-message-render.ts` — Message data model, and the renderer (tool pills, approval cards, question buttons).
- `composer.ts` — Chat UI input: attachments and prompt assembly.
- `note-context.ts` — Active note / folder and selection state shared by both interfaces, and the context text passed to the terminal UI.
- `selection-capture.ts` — Reads the active markdown view's selection (editor or preview) every 250 ms. A 1.5 s "handoff grace" keeps the captured selection alive when the user clicks the panel.
- `attachments.ts` — OS file dialog, copying files into the vault, and saving pasted images.
- `slash-commands.ts` / `slash-suggest.ts` / `skill-discovery.ts` — Chat UI slash commands, the `/` suggestion list, and discovery of skills and custom commands.
- `session-history.ts` — Reads Claude Code's session logs for `/continue` in the chat UI.
- `prompt-history.ts`, `context-meter.ts`, `summary-badge.ts`, `summary-confirm-modal.ts` — Chat UI input history, context meter, and "Summarize & start fresh".
- `completion-notifier.ts` / `notify-sound-source.ts` — Completion chime and flash, and loading the sound file.
- `account-api.ts` / `account-modal.ts` — Account & usage. Reads `claude auth status --json` and the OAuth token (macOS Keychain; `~/.claude/.credentials.json` on Linux / Windows), then queries the Anthropic OAuth usage endpoint.
- `usage-history.ts` — Local token totals (chat UI).
- `cli-resolver.ts` — Finds the `claude` binary and builds its environment.
- `obsidian-internals.ts` — Typed access to the private Obsidian APIs used (`app.setting`, `app.dragManager`).
- `assets.d.ts` — Types for the bridge scripts that esbuild bundles as text.
- `i18n/` — `en.ts` / `ja.ts` dictionaries, their shared type, and `t()`.
- `settings/` — Settings type and defaults (`types.ts`), labels, the setting tab (`tab.ts`), and the vault sound-file picker.
- `terminal/` — The terminal UI:
  - `terminal-view.ts` — Terminal UI `ItemView`: header, starting / exit / error states, note bar, hook handling, attachments.
  - `xterm-pane.ts` — xterm.js wrapper: sizing, keys, paste, drag & drop, flow control, copy via OSC 52.
  - `links.ts` — Link detection for wikilinks, vault paths, and URLs.
  - `theme.ts` — Builds the terminal colors and font from Obsidian's CSS variables.
  - `launch.ts` — `claude` arguments and environment.
  - `hook-server.ts` / `hook-settings.ts` — The loopback HTTP server, and the `--settings` JSON and hook replies.
  - `status-line.ts` — The `statusLine` command that shows the model and effort (Python on macOS / Linux, `bridge/status-line.ps1` on Windows).
  - `pty.ts`, `pty-process.ts`, `pty-windows.ts`, `pty-posix.ts`, `types.ts` — Starting and stopping the terminal process on each OS.
  - `bridge/` — `bridge.ps1` (Windows ConPTY), `bridge.py` (Python), `script-pty.sh` (`script` fallback).

Both interfaces remove `ANTHROPIC_API_KEY` from the child environment so the CLI reuses the existing Claude Code login (subscription auth), and put the `claude` binary's folder and common install folders on `PATH`.

The chat UI also suppresses MCP servers that try to open a browser window on startup (e.g. Serena's auto-dashboard): on macOS / Linux, no-op `open` / `xdg-open` shell scripts are placed in a temporary directory and prepended to `PATH`, and `BROWSER=true` is set. The terminal UI does not do this, so `/login` can open your browser.

The terminal UI starts `claude` with `--append-system-prompt` (the same vault description the chat UI uses), `--settings` (the theme, the two HTTP hooks, and the status line), and `--continue` / `--resume` / `--strict-mcp-config --mcp-config` when needed. It also removes environment variables left over from a terminal or Claude Code session that started Obsidian, and sets `TERM=xterm-256color` and `COLORTERM=truecolor`.

The terminal uses [xterm.js](https://github.com/xtermjs/xterm.js) and its fit, web-links, and unicode11 add-ons (MIT License). `styles.css` includes xterm.js's CSS with its license notice, scoped to the panel.

## Release

Pushing a semver tag triggers a release. [.github/workflows/release.yml](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/.github/workflows/release.yml) builds the plugin, attaches a zip, and emits GitHub artifact attestations for the release assets.

```bash
npm version 0.1.8 -m "Release %s"
git push --follow-tags
```

`npm version` runs `version-bump.mjs`, which syncs the bumped version into `manifest.json` and `versions.json`.

## License

MIT — © 2026 [Ryukyu HUB Inc. (琉球HUB株式会社)](https://ryukyuhub.co.jp). See [LICENSE](https://github.com/ryukyuhub/obsidian-claude-panel-ryukyuhub/blob/main/LICENSE) for details.

This plugin bundles [xterm.js](https://github.com/xtermjs/xterm.js) and its add-ons, licensed under the MIT License.
