import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import comments from "@eslint-community/eslint-plugin-eslint-comments";

// Mirrors the automated checks Obsidian runs on community-plugin releases
// (eslint-plugin-obsidianmd "recommended"). Run before every release:
//
//     npx eslint src
//
// Obsidian's release dashboard only treats a *subset* of these rules as
// blocking "errors" (e.g. no-static-styles-assignment,
// settings-tab/no-manual-html-headings); the rest are shown as non-blocking
// "warnings". We mirror that below so a non-zero exit means a genuinely
// blocking problem was reintroduced, while advisory findings stay visible
// as warnings.
export default tseslint.config(
	...obsidianmd.configs.recommended,
	{
		// Obsidian の release dashboard はブロッカー扱い: eslint-disable には必ず
		// `-- 理由` を付ける（コメントが必要な理由を説明する）。ローカルでも error
		// にして再現し、リリース後の Fail を防ぐ。
		plugins: { "@eslint-community/eslint-comments": comments },
		rules: {
			"@eslint-community/eslint-comments/require-description": "error",
		},
	},
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		rules: {
			// --- advisory obsidianmd rules we intentionally don't apply ---
			// getLanguage() isn't available on minAppVersion 1.4.5, so we keep
			// reading localStorage("language") instead.
			"obsidianmd/prefer-get-language": "warn",
			// Fires on CLI/command strings (`npm install -g @anthropic-ai/...`,
			// `claude /login`) where forcing sentence case would break them.
			"obsidianmd/ui/sentence-case": "warn",
			// --- typescript-eslint type-safety: advisory, non-blocking ---
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-floating-promises": "warn",
			"@typescript-eslint/no-misused-promises": "warn",
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",
			"@typescript-eslint/no-redundant-type-constituents": "warn",
			"@typescript-eslint/prefer-promise-reject-errors": "warn",
			"@typescript-eslint/no-unused-vars": "warn",
		},
	},
	{
		ignores: ["main.js", "build/", "node_modules/"],
	},
);
