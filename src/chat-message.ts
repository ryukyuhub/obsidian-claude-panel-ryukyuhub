import {
	App,
	MarkdownRenderer,
	MarkdownView,
	Component,
	TFile,
} from "obsidian";

export type PermissionStatus = "pending" | "approved" | "denied";

export type Part =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; input: unknown }
	| {
			type: "permission";
			toolName: string;
			input: unknown;
			toolUseId: string;
			status: PermissionStatus;
			// CLI が提供する任意の理由文（例: Bash コマンドが拒否された
			// 経緯など）。承認カードに表示してユーザーが判断材料にできる。
			reason?: string;
	  };

/** 承認 UI からユーザーが返す判定の型。SDK の PermissionResult と同じ
 *  形状にしているため、agent 層がそのまま転送できる。 */
export type PermissionDecision =
	| { allow: true }
	| { allow: false; message?: string };

export interface RunResult {
	durationMs: number;
	costUsd?: number;
}

export interface SelectionRef {
	filePath: string | null;
	startLine: number;
	lineCount: number;
}

export interface MessageUsage {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	parts: Part[];
	streaming?: boolean;
	interactive?: (container: HTMLElement) => void;
	result?: RunResult;
	// 自動／手動で添付されたファイルがあるユーザーメッセージ向け。
	// メッセージ本文の先頭に "@path @path …" を並べる代わりに、
	// チップ（Mention chip）として描画する。
	mentions?: string[];
	// 選択テキストへの参照。本文をバブルに丸ごと貼らず、コンパクトな
	// pill として表示し、何を参照したかだけを示す。選択範囲の本文自体は
	// プロンプト内で claude に送られている。
	selectionRef?: SelectionRef;
	// ユーザーメッセージ専用: 入力された生テキスト。プロンプト履歴
	// ナビゲーション（textarea 内の Up/Down キー）で使う。
	inputText?: string;
	// アシスタントメッセージ専用: 当該ターンのトークン使用量。
	// メッセージ単位で保持することで、セッション累計メーターが
	// リロードを跨いでも復元できるようにしている。
	usage?: MessageUsage;
}

let _msgCounter = 0;
export function nextMsgId(): string {
	return `m${Date.now()}_${_msgCounter++}`;
}

/**
 * メッセージの parts にテキストチャンクを追記する。末尾が text part なら
 * そこに連結し、そうでなければ新しい text part を開く。
 */
export function appendText(parts: Part[], chunk: string): void {
	const last = parts[parts.length - 1];
	if (last && last.type === "text") {
		last.text += chunk;
	} else {
		parts.push({ type: "text", text: chunk });
	}
}

export function pushTool(parts: Part[], name: string, input: unknown): void {
	parts.push({ type: "tool", name, input });
}

export function pushPermission(
	parts: Part[],
	toolName: string,
	input: unknown,
	toolUseId: string,
	reason?: string
): void {
	parts.push({
		type: "permission",
		toolName,
		input,
		toolUseId,
		status: "pending",
		reason,
	});
}

/** pending 状態のパーミッション part を in-place で書き換える。見つかれば true を返す。 */
export function setPermissionStatus(
	parts: Part[],
	toolUseId: string,
	status: PermissionStatus
): boolean {
	for (const p of parts) {
		if (p.type === "permission" && p.toolUseId === toolUseId) {
			p.status = status;
			return true;
		}
	}
	return false;
}

/**
 * チャットメッセージを `host` に描画する。`host` は最初に空にされる。
 * `streaming` モードではテキストをプレーンテキストとして描画する（チャンク
 * がそのまま表示される）。確定後は各 text part を `MarkdownRenderer` に
 * 通してマークダウン HTML として描画する。
 */
export function renderMessage(
	host: HTMLElement,
	msg: ChatMessage,
	app: App,
	owner: Component,
	onPermissionDecision?: (
		toolUseId: string,
		decision: PermissionDecision
	) => void
): void {
	host.empty();
	host.addClass("claude-panel-msg");
	host.addClass(`claude-panel-msg-${msg.role}`);
	host.setAttr("data-msg-id", msg.id);

	host.createDiv({
		cls: "claude-panel-msg-role",
		text: msg.role === "user" ? "ユーザー" : msg.role === "assistant" ? "アシスタント" : msg.role,
	});

	const body = host.createDiv({ cls: "claude-panel-msg-text" });
	if (msg.mentions?.length || msg.selectionRef) {
		const refs = body.createDiv({ cls: "claude-panel-refs" });
		if (msg.mentions?.length) renderMentionChips(refs, msg.mentions);
		if (msg.selectionRef) renderSelectionChip(refs, msg.selectionRef);
	}
	if (msg.interactive) {
		msg.interactive(body);
	} else {
		for (const part of msg.parts) {
			renderPart(body, part, app, owner, !!msg.streaming, onPermissionDecision);
		}
	}

	if (msg.result) {
		renderResultFooter(host, msg.result);
	}
}

export function renderPart(
	body: HTMLElement,
	part: Part,
	app: App,
	owner: Component,
	streaming: boolean,
	onPermissionDecision?: (toolUseId: string, decision: PermissionDecision) => void
): void {
	if (part.type === "text") {
		const span = body.createDiv({
			cls: "claude-panel-msg-text-part",
		});
		if (streaming) {
			span.textContent = part.text;
		} else {
			span.addClass("claude-panel-md");
			void MarkdownRenderer.render(app, part.text, span, "", owner)
				.then(() => linkifyPaths(span, app));
		}
	} else if (part.type === "tool") {
		renderToolPill(body, part.name, part.input);
	} else {
		renderPermissionCard(body, part, onPermissionDecision);
	}
}

export function renderPermissionCard(
	parent: HTMLElement,
	part: Extract<Part, { type: "permission" }>,
	onDecision?: (toolUseId: string, decision: PermissionDecision) => void
): void {
	const card = parent.createDiv({
		cls: `claude-panel-perm is-${part.status}`,
	});
	const header = card.createDiv({ cls: "claude-panel-perm-header" });
	header.createSpan({
		cls: "claude-panel-perm-icon",
		text: part.status === "pending" ? "?" : part.status === "approved" ? "✓" : "✕",
	});
	header.createSpan({
		cls: "claude-panel-perm-title",
		text:
			part.status === "pending"
				? "ツール実行の承認"
				: part.status === "approved"
					? "承認済み"
					: "拒否しました",
	});
	header.createSpan({
		cls: "claude-panel-perm-tool",
		text: part.toolName,
	});

	const arg = formatToolArg(part.toolName, part.input);
	if (arg) {
		card.createDiv({
			cls: "claude-panel-perm-arg",
			text: arg,
			attr: { title: arg },
		});
	}
	renderToolDetails(card, part.toolName, part.input);
	if (part.reason) {
		card.createDiv({
			cls: "claude-panel-perm-reason",
			text: part.reason,
		});
	}
	if (part.status === "pending" && onDecision) {
		const actions = card.createDiv({ cls: "claude-panel-perm-actions" });
		const allow = actions.createEl("button", {
			cls: "claude-panel-perm-allow mod-cta",
			text: "許可",
		});
		allow.onclick = () => onDecision(part.toolUseId, { allow: true });
		const deny = actions.createEl("button", {
			cls: "claude-panel-perm-deny",
			text: "拒否",
		});
		deny.onclick = () =>
			onDecision(part.toolUseId, { allow: false, message: "ユーザーが拒否しました。" });
	}
}

/**
 * レンダリング直後のマークダウン内をスキャンし、テキストが Vault 相対パス
 * （オプションで `:line` や `:start-end`）になっているインラインの
 * `<code>` を探す。実在ファイルに解決できる場合、その code spann をクリック
 * 可能な内部リンクに置き換える（行番号指定があればその行までスクロール）。
 */
function linkifyPaths(host: HTMLElement, app: App): void {
	const PATH_RE =
		/^([^\s:]+\.[a-zA-Z0-9]+)(?::(\d+)(?:-(\d+))?)?$/;
	const codes = Array.from(host.querySelectorAll("code"));
	for (const code of codes) {
		// <pre> 内の code（複数行のコードブロック）はスキップ。インライン code のみを対象にする。
		if (code.parentElement?.tagName === "PRE") continue;
		const raw = code.textContent?.trim();
		if (!raw) continue;
		const match = raw.match(PATH_RE);
		if (!match) continue;
		const [, path, startLineStr] = match;
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;

		const link = document.createElement("a");
		link.className = "internal-link claude-panel-path-link";
		link.textContent = code.textContent ?? raw;
		link.setAttr("href", path);
		link.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();
			await app.workspace.openLinkText(path, "");
			if (startLineStr) {
				const startLine = parseInt(startLineStr, 10);
				const view =
					app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.editor) {
					const pos = { line: startLine - 1, ch: 0 };
					view.editor.setCursor(pos);
					view.editor.scrollIntoView(
						{ from: pos, to: pos },
						true
					);
				}
			}
		};
		code.replaceWith(link);
	}
}

export function renderToolPill(
	parent: HTMLElement,
	name: string,
	input: unknown
): void {
	const pill = parent.createDiv({ cls: "claude-panel-tool" });
	pill.createSpan({
		cls: "claude-panel-tool-name",
		text: name,
	});
	const arg = formatToolArg(name, input);
	if (arg) {
		pill.createSpan({
			cls: "claude-panel-tool-arg",
			text: arg,
			attr: { title: arg },
		});
	}
}

function renderMentionChips(parent: HTMLElement, mentions: string[]): void {
	for (const m of mentions) {
		const chip = parent.createDiv({ cls: "claude-panel-mention" });
		chip.createSpan({
			cls: "claude-panel-mention-symbol",
			text: "@",
		});
		chip.createSpan({
			cls: "claude-panel-mention-path",
			text: m,
			attr: { title: m },
		});
	}
}

function renderSelectionChip(parent: HTMLElement, sel: SelectionRef): void {
	const chip = parent.createDiv({ cls: "claude-panel-selref" });
	chip.createSpan({
		cls: "claude-panel-selref-symbol",
		text: "≡",
	});
	if (sel.filePath) {
		chip.createSpan({
			cls: "claude-panel-selref-path",
			text: basename(sel.filePath),
			attr: { title: sel.filePath },
		});
	}
	const range =
		sel.lineCount > 1
			? `L${sel.startLine} · ${sel.lineCount}行`
			: `L${sel.startLine}`;
	chip.createSpan({
		cls: "claude-panel-selref-range",
		text: range,
	});
}

function renderResultFooter(host: HTMLElement, r: RunResult): void {
	const footer = host.createDiv({ cls: "claude-panel-msg-footer" });
	const duration =
		r.durationMs >= 1000
			? `${(r.durationMs / 1000).toFixed(1)}秒`
			: `${r.durationMs}ms`;
	const cost = r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : "";
	footer.setText(`完了 · ${duration}${cost}`);
}

/**
 * ツール入力から最も有用な識別子を取り出す。チャット上に JSON 全体を
 * 貼り付けたくないので、何が操作対象かが分かる程度の短い表記にする。
 */
function formatToolArg(name: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const i = input as Record<string, unknown>;

	if (typeof i.file_path === "string") return basename(i.file_path);
	if (typeof i.path === "string") return basename(i.path);
	if (typeof i.notebook_path === "string") return basename(i.notebook_path);
	if (typeof i.command === "string") return truncate(i.command, 70);
	if (typeof i.pattern === "string") return truncate(i.pattern, 50);
	if (typeof i.query === "string") return truncate(i.query, 50);
	if (typeof i.url === "string") return truncate(i.url, 70);
	if (typeof i.description === "string")
		return truncate(i.description, 70);
	if (typeof i.prompt === "string") return truncate(i.prompt, 70);
	// TodoWrite 等の場合は件数表示にフォールバック。
	if (Array.isArray(i.todos)) {
		const n = i.todos.length;
		return `${n} todo${n === 1 ? "" : "s"}`;
	}

	return "";
}

/**
 * 承認カード内に「実際に何が変わるのか」を表示する。Edit は行単位の
 * unified diff（- 行赤、+ 行緑、共通行は薄色）を出す。Write は新規内容、
 * Bash はコマンド全文。
 */
function renderToolDetails(parent: HTMLElement, toolName: string, input: unknown): void {
	if (typeof input !== "object" || input === null) return;
	const i = input as Record<string, unknown>;

	if (toolName === "Edit" || toolName === "MultiEdit") {
		const edits = Array.isArray(i.edits)
			? (i.edits as Record<string, unknown>[])
			: [i];
		edits.forEach((e, idx) => {
			const oldStr = typeof e.old_string === "string" ? e.old_string : "";
			const newStr = typeof e.new_string === "string" ? e.new_string : "";
			renderDiffBlock(
				parent,
				edits.length > 1 ? `変更 ${idx + 1} / ${edits.length}` : "変更内容",
				oldStr,
				newStr
			);
		});
		return;
	}
	if (toolName === "Write" && typeof i.content === "string") {
		renderPlainBlock(parent, "書き込む内容", i.content, "new");
		return;
	}
	if (toolName === "Bash" && typeof i.command === "string") {
		renderPlainBlock(parent, "コマンド", i.command);
		if (typeof i.description === "string" && i.description.length > 0) {
			parent.createDiv({
				cls: "claude-panel-perm-reason",
				text: i.description,
			});
		}
		return;
	}
	if (toolName === "NotebookEdit" && typeof i.new_source === "string") {
		if (typeof i.cell_id === "string") {
			parent.createDiv({
				cls: "claude-panel-perm-reason",
				text: `セル: ${i.cell_id}`,
			});
		}
		const oldSrc = typeof i.old_source === "string" ? i.old_source : "";
		if (oldSrc) renderDiffBlock(parent, "変更内容", oldSrc, i.new_source);
		else renderPlainBlock(parent, "書き込む内容", i.new_source, "new");
		return;
	}
}

function renderPlainBlock(
	parent: HTMLElement,
	label: string,
	body: string,
	variant?: "old" | "new"
): void {
	const wrap = parent.createDiv({ cls: "claude-panel-perm-detail" });
	wrap.createDiv({ cls: "claude-panel-perm-detail-label", text: label });
	const pre = wrap.createEl("pre", {
		cls:
			"claude-panel-perm-detail-body" +
			(variant ? ` is-${variant}` : ""),
	});
	pre.createEl("code", { text: clip(body, 24) });
}

function renderDiffBlock(
	parent: HTMLElement,
	label: string,
	oldStr: string,
	newStr: string
): void {
	const wrap = parent.createDiv({ cls: "claude-panel-perm-detail" });
	wrap.createDiv({ cls: "claude-panel-perm-detail-label", text: label });
	const diff = wrap.createDiv({ cls: "claude-panel-perm-diff" });

	const lines = clipDiff(diffLines(oldStr, newStr), 40);
	for (const line of lines) {
		const row = diff.createDiv({
			cls: `claude-panel-perm-diff-line is-${line.kind}`,
		});
		if (line.kind === "ellipsis") {
			row.setText(line.text || "⋯");
			continue;
		}
		row.createSpan({
			cls: "claude-panel-perm-diff-marker",
			text: line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ",
		});
		row.createSpan({
			cls: "claude-panel-perm-diff-text",
			// 空行も視覚的に1行分の高さを確保するため non-breaking space に置換。
			text: line.text.length === 0 ? " " : line.text,
		});
	}
}

interface DiffLine {
	kind: "add" | "del" | "ctx" | "ellipsis";
	text: string;
}

/**
 * 行単位の LCS で unified diff を作る。差分行と前後 2 行のコンテキスト
 * だけを残し、長い共通ブロックは "…" 省略行に畳む。Edit ツールの old/new
 * は通常数十行以内なので、O(n·m) DP で十分。
 */
function diffLines(oldStr: string, newStr: string): DiffLine[] {
	const a = oldStr.split("\n");
	const b = newStr.split("\n");
	const n = a.length;
	const m = b.length;

	// LCS テーブル
	const dp: number[][] = Array.from({ length: n + 1 }, () =>
		new Array(m + 1).fill(0)
	);
	for (let x = n - 1; x >= 0; x--) {
		for (let y = m - 1; y >= 0; y--) {
			dp[x][y] = a[x] === b[y]
				? dp[x + 1][y + 1] + 1
				: Math.max(dp[x + 1][y], dp[x][y + 1]);
		}
	}
	const raw: DiffLine[] = [];
	let x = 0, y = 0;
	while (x < n && y < m) {
		if (a[x] === b[y]) {
			raw.push({ kind: "ctx", text: a[x] });
			x++; y++;
		} else if (dp[x + 1][y] >= dp[x][y + 1]) {
			raw.push({ kind: "del", text: a[x] });
			x++;
		} else {
			raw.push({ kind: "add", text: b[y] });
			y++;
		}
	}
	while (x < n) raw.push({ kind: "del", text: a[x++] });
	while (y < m) raw.push({ kind: "add", text: b[y++] });

	// 前後 2 行のコンテキストだけ残し、それ以上連続する ctx は省略する。
	const CONTEXT = 2;
	const keep: boolean[] = raw.map((l) => l.kind !== "ctx");
	for (let k = 0; k < raw.length; k++) {
		if (raw[k].kind === "ctx") continue;
		for (let d = 1; d <= CONTEXT; d++) {
			if (k - d >= 0) keep[k - d] = true;
			if (k + d < raw.length) keep[k + d] = true;
		}
	}
	const out: DiffLine[] = [];
	let ellipsis = false;
	for (let k = 0; k < raw.length; k++) {
		if (keep[k]) {
			out.push(raw[k]);
			ellipsis = false;
		} else if (!ellipsis) {
			out.push({ kind: "ellipsis", text: "" });
			ellipsis = true;
		}
	}
	return out;
}

function clipDiff(lines: DiffLine[], max: number): DiffLine[] {
	if (lines.length <= max) return lines;
	return [
		...lines.slice(0, max),
		{ kind: "ellipsis", text: `… 他 ${lines.length - max} 行` },
	];
}

/** 行数で切り詰める（バイト数だと CJK で過剰に切られるため）。 */
function clip(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n") + `\n… 他 ${lines.length - maxLines} 行`;
}

function basename(p: string): string {
	const trimmed = p.replace(/[\\/]+$/, "");
	const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
