import type { HookReply } from "./types";

/** hook の認証トークンを claude に渡す環境変数の名前。 */
export const HOOK_TOKEN_ENV = "CLAUDE_PANEL_HOOK_TOKEN";

// 旧版の claude は知らないイベント名があると警告の画面で止まるので、以前からあるものに絞る
const HOOK_EVENTS = ["UserPromptSubmit", "Stop"];
const HOOK_TIMEOUT_SEC = 2;

/** claude は 10,000 字を超える additionalContext をファイルに移し、先頭しか読まない。 */
const MAX_CONTEXT_CHARS = 9000;

/** `--settings` に渡す JSON。`hookUrl` が null なら hooks を含めない。 */
export function buildClaudeSettings(options: { hookUrl: string | null }): string {
	// auto は端末への問い合わせと COLORFGBG から明暗を決める
	const settings: Record<string, unknown> = { theme: "auto" };
	if (options.hookUrl !== null) {
		const hook = {
			type: "http",
			url: options.hookUrl,
			timeout: HOOK_TIMEOUT_SEC,
			// トークンそのものは引数（プロセス一覧から見える）に載せない
			headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV}` },
			allowedEnvVars: [HOOK_TOKEN_ENV],
		};
		settings.hooks = Object.fromEntries(
			HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]])
		);
	}
	return JSON.stringify(settings);
}

/** UserPromptSubmit への応答。`context` が null なら null。 */
export function userPromptReply(context: string | null): HookReply | null {
	if (context === null) return null;
	return {
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: truncate(context),
		},
	};
}

function truncate(text: string): string {
	if (text.length <= MAX_CONTEXT_CHARS) return text;
	// 末尾で割れたサロゲートペアは落とす
	return text.slice(0, MAX_CONTEXT_CHARS).replace(/[\uD800-\uDBFF]$/, "");
}
