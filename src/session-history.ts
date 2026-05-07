import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	type ChatMessage,
	nextMsgId,
	appendText,
	pushTool,
} from "./chat-message";

/**
 * Claude Code CLI が `~/.claude/projects/<encoded-cwd>/<session>.jsonl` に
 * 残す会話ログを読み出して、UI 用の `ChatMessage[]` に再構築するモジュール。
 *
 * `/continue` から呼ばれ、Obsidian 再起動後にサイドバーの履歴を復元する
 * 用途で使う。Vault のパスは `<encoded-cwd>` のキーになるため、別 Vault
 * のセッションは別フォルダに分かれており混入しない。
 */

interface JsonlRecord {
	type?: string;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/**
 * cwd を Claude CLI と同じ規則でエンコードする。CLI 側のソースに合わせて、
 * `[a-zA-Z0-9-]` 以外の文字（スラッシュ、ドット、`@`、`_`、非 ASCII 文字
 * を含む）はすべて 1 文字 1 ハイフンに置き換える。先頭スラッシュも 1 個
 * のハイフンになるため、絶対パスはハイフンで始まる文字列にエンコードされる。
 *
 * クロスプラットフォーム性: Windows のパス（`C:\Users\foo\vault`）でも
 * 同じ regex でエンコードできる。`:`, `\`, `/` のいずれもハイフンに置換
 * されるため、Obsidian が basePath を `/` で返しても `\` で返しても同じ
 * 結果になり、Claude CLI が Windows 側で生成するフォルダ名と一致する。
 *
 * 末尾スラッシュ: 環境によって basePath が `/foo` だったり `/foo/` だったり
 * ぶれるため、最後の `/` `\` を除去してから処理する。残してしまうと
 * `-foo-` のような末尾ハイフンがついて Claude CLI のフォルダ名（末尾なし）
 * とずれる。
 *
 * NFC 正規化: macOS のファイルシステム経由（特に Google Drive 等の
 * CloudStorage）で得たパスはしばしば NFD（`ド` = `タ` + 濁点 の
 * 2 codepoint）になっており、Claude CLI が NFC 前提で作ったフォルダ名と
 * ハイフン数が合わなくなる（例: `マイドライブ` が NFC では 6 ハイフン、
 * NFD では 8 ハイフンになる）。Windows / Linux では既に NFC なので
 * `normalize("NFC")` は実質 no-op で副作用なし。
 */
function encodeCwd(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	return trimmed.normalize("NFC").replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * 指定 cwd に対応するプロジェクトフォルダから、最新（mtime 最大）の
 * `.jsonl` セッションファイルを返す。見つからなければ null。
 */
export function findLatestSessionFile(cwd: string): string | null {
	const dir = path.join(os.homedir(), ".claude", "projects", encodeCwd(cwd));
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	let bestPath: string | null = null;
	let bestMtime = -1;
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const full = path.join(dir, name);
		try {
			const st = fs.statSync(full);
			if (!st.isFile()) continue;
			if (st.mtimeMs > bestMtime) {
				bestMtime = st.mtimeMs;
				bestPath = full;
			}
		} catch {
			/* noop — レース等で消えたファイルは無視 */
		}
	}
	return bestPath;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	input?: unknown;
}

/** ユーザーメッセージから表示用テキストを抽出する。`tool_result` ブロックは
 *  捨てる（プラグインの UI ではアシスタント側のツール pill にひもづけて
 *  表現しないため）。 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** ユーザーが実際に入力したものではない、CLI またはハーネスが合成した
 *  ユーザーメッセージを判定する。
 *
 *  - `<ide_opened_file>...</ide_opened_file>` 系の IDE 統合メタタグ
 *  - `<system-reminder>...` などのハーネス注入タグ
 *  - `[Request interrupted by user for tool use]` のように CLI が permission
 *    deny / cancel の置き換えとして差し込む文言
 *
 *  これらを履歴から除外することで、復元した UI が「自分が入力した発言だけ」
 *  を見せられるようにする。 */
function isInjectedMeta(text: string): boolean {
	const t = text.trimStart();
	if (/^<[a-zA-Z][\w-]*>/.test(t)) return true;
	if (/^\[Request interrupted/i.test(t)) return true;
	return false;
}

/**
 * JSONL ファイルを読み、UI に並べる `ChatMessage[]` に再構築する。
 *
 * 復元する情報:
 *   - ユーザーの入力テキスト（`<ide_opened_file>` 等の自動注入は除外）
 *   - アシスタントのテキスト出力とツール使用 pill
 *
 * 復元しない情報:
 *   - thinking ブロック（パネルでは元々非表示）
 *   - tool_result（アシスタント pill に統合せず捨てる）
 *   - パーミッション承認カード（リロード後に承認しても CLI 側のラン
 *     は既に終了している。`status: "denied"` 相当の情報も再現しない）
 *   - usage / コスト（メーターは新ターン到来時に更新される）
 */
export function loadSessionMessages(jsonlPath: string): ChatMessage[] {
	let raw: string;
	try {
		raw = fs.readFileSync(jsonlPath, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n");
	const messages: ChatMessage[] = [];
	let currentAssistant: ChatMessage | null = null;

	const flushAssistant = (): void => {
		if (currentAssistant && currentAssistant.parts.length > 0) {
			messages.push(currentAssistant);
		}
		currentAssistant = null;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let rec: JsonlRecord;
		try {
			rec = JSON.parse(trimmed) as JsonlRecord;
		} catch {
			continue;
		}

		if (rec.isMeta || rec.isCompactSummary) continue;

		if (rec.type === "user" && rec.message?.content !== undefined) {
			const text = extractUserText(rec.message.content).trim();
			if (!text) continue;
			if (isInjectedMeta(text)) continue;
			flushAssistant();
			messages.push({
				id: nextMsgId(),
				role: "user",
				parts: [{ type: "text", text }],
				inputText: text,
			});
		} else if (
			rec.type === "assistant" &&
			Array.isArray(rec.message?.content)
		) {
			if (!currentAssistant) {
				currentAssistant = {
					id: nextMsgId(),
					role: "assistant",
					parts: [],
				};
			}
			for (const block of rec.message.content as ContentBlock[]) {
				if (block?.type === "text" && typeof block.text === "string") {
					appendText(currentAssistant.parts, block.text);
				} else if (
					block?.type === "tool_use" &&
					typeof block.name === "string"
				) {
					pushTool(currentAssistant.parts, block.name, block.input);
				}
				// thinking はスキップ
			}
		}
		// queue-operation / attachment / file-history-snapshot / ai-title /
		// last-prompt / system はすべて UI 表示しないので無視。
	}
	flushAssistant();

	// 末尾に残ったアシスタントが空 parts のままなら除外。Part 走査で必要に
	// 応じて非表示エントリも畳む。
	return messages.filter((m) => m.parts.length > 0);
}

/** ChatRuntime から呼ぶエントリポイント。指定 cwd の直近セッションを
 *  読み出し、復元したメッセージ配列を返す。セッションファイルが無い、
 *  または有効なメッセージがゼロ件のときは null を返す。 */
export function loadLatestSessionMessages(cwd: string): ChatMessage[] | null {
	const file = findLatestSessionFile(cwd);
	if (!file) return null;
	const msgs = loadSessionMessages(file);
	return msgs.length > 0 ? msgs : null;
}

/** `/continue` で「見つからない」を出したときの診断用に、エンコード済みの
 *  プロジェクトディレクトリと、その存在ステータスを返す。 */
export interface SessionLookupDiagnostics {
	cwd: string;
	encodedDir: string;
	exists: boolean;
	jsonlCount: number;
}

export function diagnoseSessionLookup(cwd: string): SessionLookupDiagnostics {
	const encodedDir = path.join(
		os.homedir(),
		".claude",
		"projects",
		encodeCwd(cwd)
	);
	let exists = false;
	let jsonlCount = 0;
	try {
		const entries = fs.readdirSync(encodedDir);
		exists = true;
		jsonlCount = entries.filter((e) => e.endsWith(".jsonl")).length;
	} catch {
		exists = false;
	}
	return { cwd, encodedDir, exists, jsonlCount };
}
