# Claude Panel

> **Provided by [Ryukyu HUB Inc. (琉球HUB株式会社)](https://ryukyuhub.co.jp).**

Claude Panel adds a right-sidebar chat panel powered by [Claude Code](https://docs.claude.com/claude-code) to Obsidian. It spawns the `claude` CLI as a subprocess with the active vault as its working directory, so reading, writing, searching, and running commands against your notes all happen inside Obsidian.

> Desktop only. Requires the `claude` CLI to be installed and signed in (Claude Pro / Max subscription, or an Anthropic API key).

日本語の解説は [README.ja.md](README.ja.md) を参照してください。

## Features

- Streaming chat panel in the right sidebar, with tool-use pills and per-turn cost / duration
- Active note is auto-mentioned as `@filename` on every turn (toggleable)
- File picker for additional mentions; paste clipboard images directly into the composer
- Editor / preview selection is captured automatically so you can ask "explain this" without copy/paste
- Sessions are resumed via `claude --resume <session>` (Claude Code's auto-compaction stays active)
- Account & usage panel — Claude plan, organization, and rate-limit consumption (5h / 7d / Sonnet) in real time
- Slash commands: `/clear`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/login`
- Project-level MCP servers: drop a `.mcp.json` at the vault root and it is loaded automatically
- UI follows Obsidian's language setting (English / 日本語)

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

### 4. Install the Obsidian plugin

1. In Obsidian, open Settings → Community plugins → **Browse**, search for **Claude Panel**, and click **Install**.
2. Enable **Claude Panel** in the Community plugins list.
3. Open the plugin's setting tab. The top "Setup status" block shows whether the `claude` CLI was auto-detected. If not, paste the absolute path to the binary (for example `/usr/local/bin/claude` on macOS, or `C:\Users\<you>\AppData\Roaming\npm\claude.cmd` on Windows).

> For sideloading or pre-release builds, [BRAT](https://github.com/TfTHacker/obsidian42-brat) can install the plugin straight from this repository.

## Troubleshooting

### `claude: command not found` / `'claude.exe' is not recognized`
Right after `npm install -g @anthropic-ai/claude-code`, your terminal has not picked up the new PATH. **Closing and re-opening the terminal** usually fixes it. If detection still fails, fill in the absolute path to the binary in the plugin's "claude CLI path" setting:

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
Check that the "Setup status" block in the plugin's setting tab reads **✓ Available**. If it shows ✗ or ⚠, follow the install / login steps shown directly below it. The "Re-check" button refreshes the status.

## Usage

- Click the ribbon icon or run **Open Claude Panel** from the command palette to open the panel.
- Type a prompt and press `Enter` (or click Send). `Esc` cancels the running turn; `Shift+Enter` inserts a newline.
- Use the **Attach** button to mention additional notes, or paste a clipboard image straight into the composer.
- Click the user icon in the panel header to see your Claude account info and current rate-limit consumption.

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

There is no test suite or lint config. For strict type checking, run `npx tsc --noEmit`.

## Architecture

Files under `src/`:

- `main.ts` — `Plugin` entry point. Registers the view, ribbon icon, commands, and setting tab.
- `view.ts` — `ItemView` for the sidebar. Owns chat history, the composer, attachments, paste handling, prompt assembly, and the streaming render loop.
- `agent.ts` — Subprocess layer. `runAgent()` spawns `claude` with stream-json I/O and dispatches each JSON line to text / tool-use / result / error / usage events.
- `chat-message.ts` — Message and part types plus the renderer. Tool invocations are shown as styled pills rather than raw JSON.
- `selection-capture.ts` — 250 ms polling loop that reads the active markdown view's selection (editor or preview). A 1.5 s "handoff grace" keeps the captured selection alive when the user clicks the panel.
- `slash-commands.ts` — Local handlers for `/clear`, `/help`, `/model`, `/think`, `/mcp`, `/usage`, `/login`. Unmatched slash input is forwarded to the CLI.
- `account-usage.ts` — Account & usage modal. Reads `claude auth status --json` and the OAuth token (macOS Keychain; `~/.claude/.credentials.json` on Linux / Windows), then queries the Anthropic OAuth usage endpoint.
- `file-picker.ts` — Fuzzy file picker for the Attach button.
- `settings.ts` — Settings type, defaults, and the setting tab.

The subprocess strips `ANTHROPIC_API_KEY` from the child environment so the CLI reuses the existing Claude Code login (subscription auth). On macOS / Linux, no-op `open` / `xdg-open` shell scripts are placed in a temporary directory and prepended to `PATH` to suppress MCP servers that try to open a browser window on startup (e.g. Serena's auto-dashboard). On Windows the equivalent is achieved by setting `BROWSER=true`.

## Release

Pushing a semver tag triggers a release. [.github/workflows/release.yml](.github/workflows/release.yml) builds the plugin, attaches a zip, and emits GitHub artifact attestations for the release assets.

```bash
npm version 0.1.8 -m "Release %s"
git push --follow-tags
```

`npm version` runs `version-bump.mjs`, which syncs the bumped version into `manifest.json` and `versions.json`.

## License

MIT — © 2026 [Ryukyu HUB Inc. (琉球HUB株式会社)](https://ryukyuhub.co.jp). See [LICENSE](LICENSE) for details.
