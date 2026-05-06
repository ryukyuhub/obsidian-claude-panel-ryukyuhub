import {
	App,
	MarkdownRenderer,
	MarkdownView,
	Component,
	TFile,
} from "obsidian";
import type {
	ChatMessage,
	Part,
	PermissionDecision,
	RunResult,
	SelectionRef,
} from "./chat-message";

/**
 * チャットメッセージの DOM 描画レイヤー。`chat-message.ts` のデータモデルを
 * 受け取り、ホスト要素に描画する責務だけを持つ。obsidian の MarkdownRenderer
 * など UI 依存はここに閉じる。
 */

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

	const roleRow = host.createDiv({ cls: "claude-panel-msg-role" });
	roleRow.createSpan({
		cls: "claude-panel-msg-role-label",
		text: msg.role === "user" ? "ユーザー" : msg.role === "assistant" ? "アシスタント" : msg.role,
	});
	if (msg.role === "user" && msg.thinkingMode && msg.thinkingMode !== "off") {
		roleRow.createSpan({
			cls: "claude-panel-think-badge",
			text: msg.thinkingMode,
			attr: { title: `Thinking mode: ${msg.thinkingMode}` },
		});
	}
	if (msg.role === "user" && msg.effortLevel && msg.effortLevel !== "auto") {
		roleRow.createSpan({
			cls: "claude-panel-effort-badge",
			text: msg.effortLevel,
			attr: { title: `Effort: ${msg.effortLevel}` },
		});
	}

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
				.then(() => {
					linkifyPaths(span, app);
					highlightQuestions(span);
				});
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

/**
 * アシスタントメッセージ内で `?` / `？` で終わる文を見つけ、強調用の
 * `<span>` で包む。サイドバーの隅で見ているとモデルからの問いかけを
 * 見落としやすいので、応答待ちであることに気付けるよう色と太字で
 * 浮かせる。ユーザー側のメッセージは Claude に向けた質問でしかない
 * ので対象外。コードブロック内のテキストも対象外（誤検出が多いうえ
 * モノスペースの装飾を壊すため）。
 */
function highlightQuestions(host: HTMLElement): void {
	if (!host.closest(".claude-panel-msg-assistant")) return;

	const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
	const targets: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const t = node as Text;
		const parent = t.parentElement;
		if (!parent) continue;
		if (parent.closest("pre, code, .claude-panel-question")) continue;
		if (!/[?？]/.test(t.data)) continue;
		targets.push(t);
	}

	// 文の開始は前の文末記号（。！？.!?）または改行の直後。`?` / `？` で
	// 終わるところまでを 1 つのマッチにする。lookbehind を使わずに非貪欲
	// マッチで十分カバーできる。
	const SENT = /[^。！？.!?\n]*[?？]/g;

	for (const text of targets) {
		const content = text.data;
		const fragment = document.createDocumentFragment();
		let lastIdx = 0;
		let m: RegExpExecArray | null;
		SENT.lastIndex = 0;
		while ((m = SENT.exec(content))) {
			const matchStart = m.index;
			const matchEnd = matchStart + m[0].length;
			let trimStart = matchStart;
			while (trimStart < matchEnd && /\s/.test(content[trimStart])) trimStart++;
			if (trimStart > lastIdx) {
				fragment.appendChild(
					document.createTextNode(content.slice(lastIdx, trimStart))
				);
			}
			const span = document.createElement("span");
			span.className = "claude-panel-question";
			span.textContent = content.slice(trimStart, matchEnd);
			fragment.appendChild(span);
			lastIdx = matchEnd;
		}
		if (lastIdx === 0) continue;
		if (lastIdx < content.length) {
			fragment.appendChild(document.createTextNode(content.slice(lastIdx)));
		}
		text.replaceWith(fragment);
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
			text: line.text.length === 0 ? " " : line.text,
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
