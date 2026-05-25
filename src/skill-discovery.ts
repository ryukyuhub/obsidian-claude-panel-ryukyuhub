import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SlashCategory, SlashCommandSpec } from "./slash-commands";
import { t } from "./i18n";

/**
 * `/` 入力時のサジェスト候補に混ぜる、動的に発見されるコマンド群を返す。
 *
 * 走査対象（優先度順、先勝ちで重複名はスキップ）:
 *   1. `<vault>/.claude/skills/` 配下のスキル                 → category: skill
 *   2. `<vault>/.claude/commands/<name>.md`                   → category: user-command
 *   3. `~/.claude/skills/` 配下のスキル                        → category: skill
 *   4. `~/.claude/commands/<name>.md`                          → category: user-command
 *   5. enabledPlugins で有効になっているマーケットプレース   → category: skill / user-command
 *      の `<plugin-root>/skills/` と `<plugin-root>/commands/`
 *
 * スキルの配置形式は 3 通りに対応する（Claude Code の実装が複数の形を
 * 受け付けるため）:
 *   a) `<dir>/<name>/SKILL.md`
 *   b) `<dir>/<group>/<name>/SKILL.md`     — learned/ などのグルーピング
 *   c) `<dir>/<name>.md`                   — フラット配置（vault でよく使われる）
 *
 * SKILL.md / `.md` の YAML フロントマターから `name` と `description` を
 * 読み、未指定時はディレクトリ名 / ファイル名にフォールバックする。
 */
export function discoverDynamicCommands(cwd: string | null): SlashCommandSpec[] {
	// プラグイン解決が想定外のスキーマに遭遇しても composer の描画を
	// 道連れにしないよう、全体を try/catch で覆って空配列にフォールバックする。
	try {
		const out: SlashCommandSpec[] = [];
		const seen = new Set<string>();
		const push = (spec: SlashCommandSpec) => {
			if (seen.has(spec.name)) return;
			seen.add(spec.name);
			out.push(spec);
		};

		if (cwd) {
			for (const s of scanSkillRoot(
				path.join(cwd, ".claude", "skills"),
				"skill"
			))
				push(s);
			for (const s of scanCommandDir(
				path.join(cwd, ".claude", "commands"),
				"user-command"
			))
				push(s);
		}

		const home = os.homedir();
		for (const s of scanSkillRoot(
			path.join(home, ".claude", "skills"),
			"skill"
		))
			push(s);
		for (const s of scanCommandDir(
			path.join(home, ".claude", "commands"),
			"user-command"
		))
			push(s);

		// 有効化されたプラグイン / マーケットプレースを走査。
		// settings.json の enabledPlugins は `<plugin>@<marketplace>` 形式。
		for (const root of resolveEnabledPluginRoots(home, cwd)) {
			for (const s of scanSkillRoot(path.join(root, "skills"), "skill"))
				push(s);
			for (const s of scanCommandDir(
				path.join(root, "commands"),
				"user-command"
			))
				push(s);
		}

		return out;
	} catch {
		return [];
	}
}

/**
 * スキルルート 1 つを走査して仕様を返す。3 形態に対応:
 *   - `<dir>/<name>/SKILL.md`
 *   - `<dir>/<group>/<name>/SKILL.md`（learned/ 等の 1 階層深い形）
 *   - `<dir>/<name>.md`（vault で多用されるフラット形式）
 */
function scanSkillRoot(
	dir: string,
	category: SlashCategory
): SlashCommandSpec[] {
	const out: SlashCommandSpec[] = [];
	if (!safeIsDir(dir)) return out;
	for (const entry of safeReaddir(dir)) {
		const full = path.join(dir, entry);

		// (c) フラット形式: `<name>.md`
		if (
			entry.endsWith(".md") &&
			entry !== "SKILL.md" &&
			safeIsFile(full)
		) {
			const fallbackName = entry.slice(0, -3);
			out.push(skillSpec(full, fallbackName, category));
			continue;
		}

		if (!safeIsDir(full)) continue;

		// (a) 直下に SKILL.md
		const direct = path.join(full, "SKILL.md");
		if (safeIsFile(direct)) {
			out.push(skillSpec(direct, entry, category));
			continue;
		}

		// (b) もう 1 階層下を覗く（無限再帰は避ける）
		for (const inner of safeReaddir(full)) {
			const innerFull = path.join(full, inner);
			if (!safeIsDir(innerFull)) continue;
			const innerSkill = path.join(innerFull, "SKILL.md");
			if (safeIsFile(innerSkill)) {
				out.push(skillSpec(innerSkill, inner, category));
			}
		}
	}
	return out;
}

function scanCommandDir(
	dir: string,
	category: SlashCategory
): SlashCommandSpec[] {
	const out: SlashCommandSpec[] = [];
	if (!safeIsDir(dir)) return out;
	for (const entry of safeReaddir(dir)) {
		if (!entry.endsWith(".md")) continue;
		const full = path.join(dir, entry);
		if (!safeIsFile(full)) continue;
		const fallbackName = entry.slice(0, -3);
		const meta = parseFrontmatter(full);
		const name = (meta.name || fallbackName).trim();
		out.push({
			name: "/" + name,
			desc: meta.description || t("skill.userCommandFallback"),
			category,
		});
	}
	return out;
}

function skillSpec(
	skillFile: string,
	fallbackName: string,
	category: SlashCategory
): SlashCommandSpec {
	const meta = parseFrontmatter(skillFile);
	const name = (meta.name || fallbackName).trim();
	return {
		name: "/" + name,
		desc: meta.description || t("skill.skillFallback"),
		category,
	};
}

/**
 * 有効化されたプラグインのルートディレクトリ一覧を返す。
 *
 * `~/.claude/settings.json` と `<vault>/.claude/settings.json` の双方の
 * `enabledPlugins`（`<plugin>@<marketplace>: true`）を読み、各キーを
 * 以下の順で絶対パスに解決する:
 *
 *   1. `~/.claude/plugins/installed_plugins.json` の `installPath`
 *      （Claude Code がインストール時に書き込むキャノニカルな所在。
 *        marketplace.json の `source` がオブジェクト形式 — リモート git
 *        プラグイン、例: `{source:"url", url, sha}` — のときは、コードは
 *        marketplace ディレクトリ配下ではなく cache 配下に clone される
 *        ため、ここでしか正しく解決できない）
 *   2. フォールバックとして marketplace.json の `source` を相対パス解決
 *      （ローカル marketplace の `source: "./"` などの旧来形式向け）
 *
 * marketplace.json は `<marketplace>/.claude-plugin/marketplace.json` に
 * 置かれる新形式と、ルート直下に置かれる旧形式の両方を試す。
 */
function resolveEnabledPluginRoots(
	home: string,
	cwd: string | null
): string[] {
	const enabled = collectEnabledPluginKeys(home, cwd);
	if (enabled.size === 0) return [];

	const marketplacesBase = path.join(home, ".claude", "plugins", "marketplaces");
	const installed = readInstalledPlugins(home);
	const out: string[] = [];

	for (const key of enabled) {
		// (1) installed_plugins.json の installPath を最優先。
		const installPath = pickInstallPath(installed, key);
		if (installPath && safeIsDir(installPath)) {
			out.push(installPath);
			continue;
		}

		// (2) marketplace.json の source を解決するフォールバック経路。
		const at = key.lastIndexOf("@");
		if (at < 0) continue;
		const pluginName = key.slice(0, at);
		const marketplace = key.slice(at + 1);
		const marketplaceRoot = path.join(marketplacesBase, marketplace);
		if (!safeIsDir(marketplaceRoot)) continue;

		const def = readMarketplaceJson(marketplaceRoot);
		const plugins: Array<Record<string, unknown>> =
			(def?.plugins as Array<Record<string, unknown>>) || [];
		const match = plugins.find((p) => p?.name === pluginName);
		const rawSource = match?.source;
		// source がオブジェクト形式（リモート git プラグイン）の場合は
		// (1) で解決済みのはず。(1) で解決できなかったまま落ちてきたら
		// 静かにスキップする — path.resolve に object を渡すと TypeError。
		if (typeof rawSource !== "string" && rawSource !== undefined) continue;
		const source = rawSource ?? "./";
		const pluginRoot = path.resolve(marketplaceRoot, source);
		if (safeIsDir(pluginRoot)) out.push(pluginRoot);
	}

	return out;
}

/**
 * `~/.claude/plugins/installed_plugins.json` の `plugins` マップを返す。
 * スキーマ:
 *   { version: 2, plugins: { "<name>@<marketplace>": Array<{ installPath, scope, ... }> } }
 * 同一キーに複数エントリがあるのは scope 違い（user / project / local）。
 */
function readInstalledPlugins(
	home: string
): Record<string, Array<{ installPath?: string }>> {
	const data = safeReadJson(
		path.join(home, ".claude", "plugins", "installed_plugins.json")
	);
	const plugins = (data as { plugins?: unknown } | null)?.plugins;
	if (!plugins || typeof plugins !== "object") return {};
	return plugins as Record<string, Array<{ installPath?: string }>>;
}

function pickInstallPath(
	installed: Record<string, Array<{ installPath?: string }>>,
	key: string
): string | null {
	const entries = installed[key];
	if (!Array.isArray(entries)) return null;
	for (const e of entries) {
		const p = e?.installPath;
		if (typeof p === "string" && p) return p;
	}
	return null;
}

function collectEnabledPluginKeys(
	home: string,
	cwd: string | null
): Set<string> {
	const out = new Set<string>();
	const candidates = [path.join(home, ".claude", "settings.json")];
	if (cwd) candidates.push(path.join(cwd, ".claude", "settings.json"));
	for (const file of candidates) {
		const data = safeReadJson(file);
		const ep = (data as { enabledPlugins?: Record<string, boolean> })
			?.enabledPlugins;
		if (!ep) continue;
		for (const [key, value] of Object.entries(ep)) {
			if (value) out.add(key);
		}
	}
	return out;
}

function readMarketplaceJson(marketplaceRoot: string): Record<string, unknown> | null {
	// 新形式: `<root>/.claude-plugin/marketplace.json`
	const newPath = path.join(
		marketplaceRoot,
		".claude-plugin",
		"marketplace.json"
	);
	const fromNew = safeReadJson(newPath);
	if (fromNew) return fromNew;
	// 旧形式: `<root>/marketplace.json`
	return safeReadJson(path.join(marketplaceRoot, "marketplace.json"));
}

/**
 * 簡易 YAML フロントマターパーサ。`---` ... `---` で囲まれた最初のブロック
 * から `key: value` を抽出する。値の引用符は剥がす。複数行値は未対応
 * （SKILL.md の description は実際には 1 行で書かれている）。
 */
function parseFrontmatter(filePath: string): {
	name?: string;
	description?: string;
} {
	const content = safeRead(filePath);
	if (!content) return {};
	if (!content.startsWith("---")) return {};
	const rest = content.slice(3);
	const endRel = rest.search(/\n---\s*(?:\n|$)/);
	if (endRel < 0) return {};
	const block = rest.slice(0, endRel);
	const meta: Record<string, string> = {};
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!m) continue;
		let value = m[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		meta[m[1]] = value;
	}
	return meta;
}

function safeIsDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
function safeIsFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}
function safeReaddir(p: string): string[] {
	try {
		return fs.readdirSync(p);
	} catch {
		return [];
	}
}
function safeRead(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}
function safeReadJson(p: string): Record<string, unknown> | null {
	const raw = safeRead(p);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}
