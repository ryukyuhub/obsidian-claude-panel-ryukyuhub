import {
	App,
	MarkdownRenderer,
	MarkdownView,
	Component,
	TFile,
} from "obsidian";
import type {
	ChatMessage,
	MessageUsage,
	Part,
	PermissionDecision,
	RunResult,
	SelectionRef,
} from "./chat-message";
import { formatTokens } from "./usage-history";
import { t } from "./i18n";
import { formatModelLabel } from "./settings/labels";

/**
 * チャットメッセージの DOM 描画レイヤー。`chat-message.ts` のデータモデルを
 * 受け取り、ホスト要素に描画する責務だけを持つ。obsidian の MarkdownRenderer
 * など UI 依存はここに閉じる。
 */

// 設定でカスタムされたロール名。空文字なら i18n の既定ラベルにフォール
// バックする。i18n の言語 override と同様、モジュールレベルに保持して
// renderMessage の引数を増やさずに参照できるようにしている。設定の読み込み
// 時（main.ts）と設定変更時（settings/tab.ts）に setRoleNames で更新する。
let customUserName = "";
let customAssistantName = "";

/** 設定で指定されたロール名を反映する。空文字なら既定ラベルに戻す。 */
export function setRoleNames(userName: string, assistantName: string): void {
	customUserName = userName.trim();
	customAssistantName = assistantName.trim();
}

/** ロールに対応する表示名。カスタム名が未設定なら i18n の既定を使う。 */
function roleLabel(role: ChatMessage["role"]): string {
	if (role === "user") return customUserName || t("chat.roleUser");
	if (role === "assistant") return customAssistantName || t("chat.roleAssistant");
	return role;
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
	) => void,
	onAskAnswer?: (answer: string) => void,
	// ユーザプロンプトの省略トグルで本文の高さが変わったとき、view 側に
	// 上端固定スペーサーの再計算を促すためのコールバック。
	onUserContentResize?: () => void
): void {
	host.empty();
	host.addClass("claude-panel-msg");
	host.addClass(`claude-panel-msg-${msg.role}`);
	host.setAttr("data-msg-id", msg.id);
	host.toggleClass("is-interrupted", !!msg.interrupted);

	const roleRow = host.createDiv({ cls: "claude-panel-msg-role" });
	roleRow.createSpan({
		cls: "claude-panel-msg-role-label",
		text: roleLabel(msg.role),
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
	if (msg.role === "assistant" && msg.interrupted) {
		roleRow.createSpan({
			cls: "claude-panel-interrupted-badge",
			text: t("chat.interruptedBadge"),
			attr: { title: t("chat.interruptedBadge") },
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
	} else if (msg.role === "user") {
		// ユーザプロンプトは本文だけを専用ラッパに包み、長文を 6 行に省略する。
		// チップ（refs）はラッパの外＝常時表示のまま残す。
		const clamp = body.createDiv({ cls: "claude-panel-user-clamp" });
		const renders = msg.parts.map((part) =>
			renderPart(
				clamp,
				part,
				app,
				owner,
				!!msg.streaming,
				onPermissionDecision,
				onAskAnswer
			)
		);
		// マークダウンが実 DOM に入った後に高さを測る。
		void Promise.all(renders).then(() =>
			applyUserClamp(clamp, onUserContentResize)
		);
	} else {
		// 散文中の yes/no 質問の自動 GUI フォールバックは「メッセージ最終の
		// テキスト part」にだけ載せたい（途中の text → tool → text のような
		// パターンで、ツール前の text 末尾を質問と誤認しないため）。
		let lastTextIdx = -1;
		for (let i = msg.parts.length - 1; i >= 0; i--) {
			if (msg.parts[i].type === "text") {
				lastTextIdx = i;
				break;
			}
		}
		msg.parts.forEach((part, idx) => {
			renderPart(
				body,
				part,
				app,
				owner,
				!!msg.streaming,
				onPermissionDecision,
				onAskAnswer,
				idx === lastTextIdx && msg.role === "assistant" && !msg.streaming
			);
		});
	}

	if (msg.result) {
		renderResultFooter(host, msg.result, msg.usage);
	}
}

export function renderPart(
	body: HTMLElement,
	part: Part,
	app: App,
	owner: Component,
	streaming: boolean,
	onPermissionDecision?: (toolUseId: string, decision: PermissionDecision) => void,
	onAskAnswer?: (answer: string) => void,
	yesNoFallbackEligible = false
): Promise<void> {
	if (part.type === "text") {
		const span = body.createDiv({
			cls: "claude-panel-msg-text-part",
		});
		if (streaming) {
			span.textContent = part.text;
			return Promise.resolve();
		}
		span.addClass("claude-panel-md");
		const partText = part.text;
		return MarkdownRenderer.render(app, partText, span, "", owner).then(() => {
			linkifyPaths(span, app);
			highlightQuestions(span);
			renderAskBlocks(span, onAskAnswer);
			if (yesNoFallbackEligible) {
				maybeRenderYesNoFallback(span, partText, onAskAnswer);
			}
		});
	} else if (part.type === "tool") {
		renderToolPill(body, part.name, part.input);
		return Promise.resolve();
	} else {
		renderPermissionCard(body, part, onPermissionDecision);
		return Promise.resolve();
	}
}

/** ユーザプロンプトを折りたたむ既定行数。これを超えた本文だけクランプする。 */
const MAX_USER_LINES = 6;

/**
 * ユーザメッセージ本文 `wrap` が 6 行ぶんを超えていたらクランプし、`body`
 * 直下に展開/折りたたみトグルを足す。マークダウン確定後に呼ぶこと（高さ計測
 * のため）。クランプ状態は CSS クラス `is-clamped` ＋ インライン max-height の
 * 付け外しのみで表現し、データモデルは変更しない。`onResize` はトグルで高さが
 * 変わったとき view 側のスペーサー再計算を促すためのコールバック。
 */
function applyUserClamp(
	wrap: HTMLElement,
	onResize?: () => void
): void {
	const cs = getComputedStyle(wrap);
	let lineHeight = parseFloat(cs.lineHeight);
	if (!isFinite(lineHeight) || lineHeight <= 0) {
		// line-height が "normal" 等で数値化できないときのフォールバック。
		const fontSize = parseFloat(cs.fontSize) || 16;
		lineHeight = fontSize * 1.5;
	}
	const maxHeight = Math.round(lineHeight * MAX_USER_LINES);

	const full = wrap.scrollHeight;
	// scrollHeight が 0 = パネル非表示/幅 0。計測不能なのでクランプしない。
	if (full <= 0) return;
	// 6 行以内なら省略不要（トグルも出さない）。+4px は小数 px の切り上げで
	// ぴったり 6 行のときに偽陽性でクランプされるのを防ぐ許容誤差。
	if (full <= maxHeight + 4) return;

	// 隠れている行数（おおよそ）。トグルに「あと N 行」と添えて省略量を示す。
	const hiddenLines = Math.max(1, Math.round((full - maxHeight) / lineHeight));

	const collapse = () => {
		wrap.addClass("is-clamped");
		wrap.style.maxHeight = `${maxHeight}px`;
	};
	const expand = () => {
		wrap.removeClass("is-clamped");
		wrap.style.maxHeight = "";
	};

	let collapsed = true;
	collapse();

	// トグルはラッパ内に絶対配置でフェードへ重ねる（下記 CSS）。本文末尾に
	// 重なっても overflow:hidden の下端に収まるのでクリップされない。
	const toggle = wrap.createEl("button", {
		cls: "claude-panel-user-clamp-toggle",
		text: t("chat.userClampExpand", hiddenLines),
	});
	toggle.onclick = () => {
		collapsed = !collapsed;
		if (collapsed) collapse();
		else expand();
		toggle.setText(
			collapsed
				? t("chat.userClampExpand", hiddenLines)
				: t("chat.userClampCollapse")
		);
		onResize?.();
	};
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
				? t("chat.permPendingTitle")
				: part.status === "approved"
					? t("chat.permApprovedTitle")
					: t("chat.permDeniedTitle"),
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
			text: t("chat.permAllow"),
		});
		allow.onclick = () => onDecision(part.toolUseId, { allow: true });
		const deny = actions.createEl("button", {
			cls: "claude-panel-perm-deny",
			text: t("chat.permDeny"),
		});
		deny.onclick = () =>
			onDecision(part.toolUseId, { allow: false, message: t("chat.permUserDenied") });
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

/**
 * ストリーミング中の生テキストから `\`\`\`ask` フェンスを含む区間を取り除く。
 * 確定後のマークダウン描画では `renderAskBlocks` が JSON を質問カードに
 * 置き換えてくれるが、ストリーミング途中は文字列がプレーンテキストとして
 * そのまま描画されるため、JSON が一瞬覗いてしまう。これを避けるため、
 * 完成・未完成（閉じ \`\`\` 未到達）どちらの場合もブロックを丸ごと
 * 表示から外す。マークダウン構造としての本来のテキストは parts に
 * 保持されたまま、確定時の再描画でカードへ復元される。
 */
export function stripAskBlocksForStream(text: string): string {
	let out = "";
	let pos = 0;
	while (pos < text.length) {
		const startIdx = findAskFenceStart(text, pos);
		if (startIdx === -1) {
			out += text.slice(pos);
			break;
		}
		// ブロック直前の余分な空白行は除く（ブロックが消える分の見た目を詰める）。
		out += text.slice(pos, startIdx).replace(/\n+$/, "");
		// 開始フェンス末尾の改行を探す。まだ到達していなければ未完のフェンス
		// なので、そこから先は丸ごと隠してリターン。
		const lineEnd = text.indexOf("\n", startIdx);
		if (lineEnd === -1) break;
		// 閉じ \`\`\` を探す。未到達ならブロック途中なので隠してリターン。
		const closeIdx = text.indexOf("\n```", lineEnd);
		if (closeIdx === -1) break;
		pos = closeIdx + 4;
		if (text[pos] === "\n") pos++;
	}
	return out;
}

function findAskFenceStart(text: string, fromIdx: number): number {
	let i = fromIdx;
	while (i < text.length) {
		const idx = text.indexOf("```ask", i);
		if (idx === -1) return -1;
		// 行頭であること（テキスト先頭 or 直前が改行）。
		if (idx !== 0 && text[idx - 1] !== "\n") {
			i = idx + 1;
			continue;
		}
		// `\`\`\`asking` のような語の途中マッチを弾く。
		const after = text[idx + 6];
		if (after === undefined || after === "\n" || after === " " || after === "\r" || after === "\t") {
			return idx;
		}
		i = idx + 1;
	}
	return -1;
}

/**
 * `\`\`\`ask` フェンスドコードブロックを検出し、クリック可能な質問 GUI に
 * 差し替える。Claude にはシステムプロンプト付加文で「離散的な選択肢で
 * 答えられる質問は `ask` 言語タグの JSON で出せ」と指示している
 * （[src/agent.ts](src/agent.ts) を参照）。MarkdownRenderer を通った後は
 * `<pre><code class="language-ask">...</code></pre>` の形になっているので、
 * pre 要素ごと差し替える。`onAnswer` が未指定なら(履歴ロード時など)
 * クリック不可のままパースだけして表示する。
 * 置き換え後、`.claude-panel-messages` を最下部までスクロールし、サイド
 * バーの隅で見ているユーザーが質問の存在を見落とさないようにする。
 */
function renderAskBlocks(
	host: HTMLElement,
	onAnswer?: (answer: string) => void
): void {
	const codes = Array.from(
		host.querySelectorAll("pre > code.language-ask")
	) as HTMLElement[];
	let replaced = false;
	let lastCard: HTMLElement | null = null;
	for (const code of codes) {
		const pre = code.parentElement;
		if (!pre || pre.tagName !== "PRE") continue;
		const raw = code.textContent ?? "";
		const parsed = parseAskPayload(raw);
		if (!parsed) continue;

		const card = document.createElement("div");
		card.className = "claude-panel-ask";

		const q = document.createElement("div");
		q.className = "claude-panel-ask-question";
		q.textContent = parsed.question;
		card.appendChild(q);

		const slot = document.createElement("div");
		slot.className = "claude-panel-ask-slot";
		card.appendChild(slot);
		renderAskOptions(slot, parsed, onAnswer);

		pre.replaceWith(card);
		lastCard = card;
		replaced = true;
	}
	if (replaced && lastCard && isLastMessageHost(host)) {
		// MarkdownRenderer.render は非同期で、確定再描画側の同期的なスクロール
		// 調整はカード追加前に走り終わっている。質問が画面外に置いていかれない
		// よう、カード自身を最小スクロールで可視化する。block:"nearest" なので、
		// 既に見えている（＝上端固定したプロンプトと同画面に収まる）場合は
		// スクロールせず、固定を崩さない。下端のスペーサーへ吸い込まれることも
		// ない（カードを対象にスクロールするため）。
		scrollCardIntoView(lastCard);
	}
}

/** 質問カードを最小スクロールで可視化する。既に見えていれば動かさない。 */
function scrollCardIntoView(card: HTMLElement): void {
	card.scrollIntoView({ block: "nearest" });
}

/** host が会話の「最後のメッセージ」に属するか。新しいプロンプト送信時には
 *  会話全体が再描画され、過去ターンの ask カードも再描画される。そのとき
 *  カードを可視化するスクロールを走らせると、上端に固定したばかりの新しい
 *  プロンプトを過去カードの位置へ引き戻してしまう。最後のメッセージ（＝
 *  今まさに出た応答）のカードだけを可視化対象にすることでこれを防ぐ。 */
function isLastMessageHost(host: HTMLElement): boolean {
	const msg = host.closest(".claude-panel-msg");
	const container = host.closest(".claude-panel-messages");
	if (!msg || !container) return false;
	const msgs = container.querySelectorAll(".claude-panel-msg");
	return msgs.length > 0 && msgs[msgs.length - 1] === msg;
}

/**
 * 質問カード内の選択肢ボタン群を `slot` に描画する。`type` で分岐:
 * - single: クリック即送信（従来挙動）。`allowOther` 時は「その他…」で
 *   記述入力 UI に置き換える。
 * - multi: クリックはチェック ON/OFF のトグル。下部に「送信」ボタンを
 *   置き、押下で選択された複数項目をカンマ区切りで送信する。`allowOther`
 *   時は「その他…」が追加入力行を開き、自由記述もチェック済み項目と
 *   一緒に送信される（multi では選択肢を消さず、チェックと併存させる）。
 */
function renderAskOptions(
	slot: HTMLElement,
	parsed: AskPayload,
	onAnswer?: (answer: string) => void
): void {
	if (parsed.type === "multi") {
		renderAskMulti(slot, parsed, onAnswer);
		return;
	}
	slot.empty();
	slot.className = "claude-panel-ask-slot claude-panel-ask-options";

	for (const option of parsed.options) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "claude-panel-ask-option";
		btn.textContent = option;
		if (onAnswer) {
			btn.onclick = (e) => {
				e.preventDefault();
				// 連打で複数回送信されないよう、選択直後にカード内の
				// ボタンを全部無効化し、選択された方には is-selected を立てる。
				const buttons = slot.querySelectorAll<HTMLButtonElement>(
					".claude-panel-ask-option"
				);
				buttons.forEach((b) => (b.disabled = true));
				btn.addClass("is-selected");
				onAnswer(option);
			};
		} else {
			btn.disabled = true;
		}
		slot.appendChild(btn);
	}

	if (parsed.allowOther && onAnswer) {
		const otherBtn = document.createElement("button");
		otherBtn.type = "button";
		otherBtn.className =
			"claude-panel-ask-option claude-panel-ask-option-other";
		otherBtn.textContent = t("chat.askOtherButton");
		otherBtn.onclick = (e) => {
			e.preventDefault();
			renderAskFreeText(slot, parsed, onAnswer);
		};
		slot.appendChild(otherBtn);
	}
}

/**
 * 複数選択モードの描画。トグル可能なボタン群 + 「送信 (N)」ボタンの構成。
 * `allowOther` 時の「その他…」は別行のインライン textarea を開閉する形にし、
 * チェック済み項目と入力中の自由記述が両立できるようにする。
 */
function renderAskMulti(
	slot: HTMLElement,
	parsed: AskPayload,
	onAnswer?: (answer: string) => void
): void {
	slot.empty();
	slot.className =
		"claude-panel-ask-slot claude-panel-ask-options claude-panel-ask-multi";

	const selected = new Set<string>();
	const optionButtons: HTMLButtonElement[] = [];

	for (const option of parsed.options) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "claude-panel-ask-option";
		btn.textContent = option;
		if (onAnswer) {
			btn.onclick = (e) => {
				e.preventDefault();
				if (selected.has(option)) {
					selected.delete(option);
					btn.removeClass("is-selected");
				} else {
					selected.add(option);
					btn.addClass("is-selected");
				}
				updateSendLabel();
			};
		} else {
			btn.disabled = true;
		}
		optionButtons.push(btn);
		slot.appendChild(btn);
	}

	// 「その他…」用のインライン入力行。閉じている間は textarea を DOM から
	// 外し、押下で開閉する。値はクローズしても次回オープン時まで保持される
	// よう、関数スコープの変数に持つ。
	let otherText = "";
	let otherOpen = false;
	let otherInput: HTMLTextAreaElement | null = null;
	let otherRow: HTMLDivElement | null = null;

	const openOther = (): void => {
		if (otherOpen) return;
		otherOpen = true;
		otherRow = document.createElement("div");
		otherRow.className = "claude-panel-ask-multi-other-row";
		const ta = document.createElement("textarea");
		ta.className = "claude-panel-ask-freeform-input";
		ta.rows = 2;
		ta.placeholder = t("chat.askOtherPlaceholder");
		ta.value = otherText;
		ta.addEventListener("input", () => {
			otherText = ta.value;
			updateSendLabel();
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		otherInput = ta;
		otherRow.appendChild(ta);
		// 「その他…」行はオプション群の後・送信ボタンの前に挿入する。
		slot.insertBefore(otherRow, sendRow);
		ta.focus();
	};

	if (parsed.allowOther && onAnswer) {
		const otherBtn = document.createElement("button");
		otherBtn.type = "button";
		otherBtn.className =
			"claude-panel-ask-option claude-panel-ask-option-other";
		otherBtn.textContent = t("chat.askOtherButton");
		otherBtn.onclick = (e) => {
			e.preventDefault();
			openOther();
			otherBtn.disabled = true;
		};
		slot.appendChild(otherBtn);
	}

	const sendRow = document.createElement("div");
	sendRow.className = "claude-panel-ask-multi-actions";
	slot.appendChild(sendRow);

	const sendBtn = document.createElement("button");
	sendBtn.type = "button";
	sendBtn.className = "claude-panel-ask-multi-submit mod-cta";
	sendRow.appendChild(sendBtn);

	const countOf = (): number =>
		selected.size + (otherText.trim() ? 1 : 0);

	const updateSendLabel = (): void => {
		const n = countOf();
		sendBtn.textContent = t("chat.askMultiSubmit", n);
		sendBtn.disabled = !onAnswer || n === 0;
	};

	const submit = (): void => {
		if (!onAnswer) return;
		const parts: string[] = [];
		// 元の options の出現順を維持する。Claude にとっても会話履歴の
		// 可読性上もこの方が読みやすい。
		for (const option of parsed.options) {
			if (selected.has(option)) parts.push(option);
		}
		const other = otherText.trim();
		if (other) parts.push(other);
		if (parts.length === 0) return;

		// 送信後の確定表示: 全コントロールを disabled にし、選択された
		// 項目だけ is-selected ピルとして残す。「その他…」入力欄は確定
		// 文字列を表すピルに置き換える。送信ボタンと未選択項目は外す。
		slot.empty();
		slot.className = "claude-panel-ask-slot claude-panel-ask-options";
		for (const value of parts) {
			const pill = document.createElement("button");
			pill.type = "button";
			pill.className = "claude-panel-ask-option is-selected";
			pill.textContent = value;
			pill.disabled = true;
			slot.appendChild(pill);
		}
		onAnswer(parts.join(", "));
	};

	sendBtn.onclick = (e) => {
		e.preventDefault();
		submit();
	};
	updateSendLabel();
}

/**
 * 「その他…」を押された後の記述入力 UI（単一選択モード）。Enter（IME
 * 確定中は除く）で送信、Shift+Enter で改行、Esc / 戻るボタンで選択肢一覧に
 * 戻る。送信したら自身を「ユーザーが入力した文字列」の is-selected ピルに
 * 置き換え、押下不可にする。
 */
function renderAskFreeText(
	slot: HTMLElement,
	parsed: AskPayload,
	onAnswer: (answer: string) => void
): void {
	slot.empty();
	slot.className = "claude-panel-ask-slot claude-panel-ask-freeform";

	const ta = document.createElement("textarea");
	ta.className = "claude-panel-ask-freeform-input";
	ta.rows = 2;
	ta.placeholder = t("chat.askOtherPlaceholder");
	slot.appendChild(ta);

	const actions = document.createElement("div");
	actions.className = "claude-panel-ask-freeform-actions";
	slot.appendChild(actions);

	const backBtn = document.createElement("button");
	backBtn.type = "button";
	backBtn.className = "claude-panel-ask-freeform-cancel";
	backBtn.textContent = t("chat.askOtherCancel");
	backBtn.onclick = (e) => {
		e.preventDefault();
		renderAskOptions(slot, parsed, onAnswer);
	};
	actions.appendChild(backBtn);

	const sendBtn = document.createElement("button");
	sendBtn.type = "button";
	sendBtn.className = "claude-panel-ask-freeform-submit mod-cta";
	sendBtn.textContent = t("chat.askOtherSubmit");
	actions.appendChild(sendBtn);

	const submit = (): void => {
		const value = ta.value.trim();
		if (!value) {
			ta.focus();
			return;
		}
		slot.empty();
		slot.className = "claude-panel-ask-slot claude-panel-ask-options";
		const pill = document.createElement("button");
		pill.type = "button";
		pill.className = "claude-panel-ask-option is-selected";
		pill.textContent = value;
		pill.disabled = true;
		slot.appendChild(pill);
		onAnswer(value);
	};

	sendBtn.onclick = (e) => {
		e.preventDefault();
		submit();
	};
	ta.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			renderAskOptions(slot, parsed, onAnswer);
		}
	});

	// 入力可能になった瞬間にフォーカスする。renderAskBlocks 全体は
	// MarkdownRenderer の非同期 then チェインの中で走るので、要素は既に
	// DOM へ挿入済み。focus は即時で問題ない。
	ta.focus();
}

/**
 * 散文中に yes/no で答えられる質問が紛れていたら、本文末尾に Yes/No ボタン
 * の小カードを追加するフォールバック。Claude には ask ブロックで出すよう
 * システムプロンプトで指示しているが、長い会話のなかでルールを忘れて散文
 * のまま「…ますか?」と聞いてくるケースが頻発するため、クライアント側で
 * 救済する。明示的な ask ブロックが含まれるテキストは素通り（カードと
 * 二重に出さない）。
 */
function maybeRenderYesNoFallback(
	container: HTMLElement,
	partText: string,
	onAnswer?: (answer: string) => void
): void {
	if (!onAnswer) return;
	if (/```ask\b/.test(partText)) return;
	const labels = detectYesNoQuestion(partText);
	if (!labels) return;
	renderYesNoCard(container, labels, onAnswer);
	// 質問カードと同様、生成タイミングがスクロール調整の後になるので、カード
	// 自身を最小スクロールで可視化する（既に見えていれば動かさない）。最後の
	// メッセージのときだけ（過去ターンの再描画では固定を崩さない）。
	const card = container.querySelector<HTMLElement>(".claude-panel-ask");
	if (card && isLastMessageHost(container)) scrollCardIntoView(card);
}

interface YesNoLabels {
	yes: string;
	no: string;
}

/**
 * 散文の末尾文が yes/no で答えられる質問かを判定する。曖昧な疑問詞
 * （何 / どう / なぜ など）を含む場合は open-ended なので除外する。
 */
function detectYesNoQuestion(text: string): YesNoLabels | null {
	const trimmed = text.replace(/\s+$/, "");
	if (!trimmed) return null;
	const last = trimmed[trimmed.length - 1];
	if (last !== "?" && last !== "？") return null;

	// 末尾文だけを抽出する: 改行・句点・ピリオド・感嘆符のいずれかの直後を文頭とみなす。
	const breakers = ["\n", "。", "！", "!", ".", "．"];
	let sentStart = 0;
	for (const ch of breakers) {
		const idx = trimmed.lastIndexOf(ch);
		if (idx > sentStart) sentStart = idx + 1;
	}
	let sentence = trimmed.slice(sentStart).trim();
	// 箇条書きの行頭マーカーや markdown の強調を剥がしておく。
	sentence = sentence
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^\*+/, "")
		.replace(/\*+$/, "");
	if (!sentence) return null;
	if (sentence.length > 140) return null;

	// 日本語: 末尾が「か?」「か？」
	if (/か[?？]$/.test(sentence)) {
		// 文中に疑問詞があるなら open-ended（「次は何をしますか?」など）として除外。
		if (
			/(何|なに|どう|どこ|いつ|誰|だれ|どの|なぜ|どれ|どんな|いくつ|いくら|どっち|どちら|いかが|なんで|どちら様)/.test(
				sentence
			)
		) {
			return null;
		}
		return { yes: "はい", no: "いいえ" };
	}

	// 英語: yes/no 助動詞で始まる疑問文。先頭が疑問詞（what など）の場合は弾く。
	if (/^(what|where|when|who|whom|whose|which|why|how)\b/i.test(sentence)) {
		return null;
	}
	const enLead =
		/^(should|shall|do|does|did|can|could|will|would|may|might|must|is|are|was|were|have|has|had|am|want|need|ok|okay|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|shouldn't|couldn't|haven't|hasn't|hadn't|can't|mustn't)\b/i;
	if (enLead.test(sentence)) {
		return { yes: "Yes", no: "No" };
	}
	return null;
}

function renderYesNoCard(
	container: HTMLElement,
	labels: YesNoLabels,
	onAnswer: (answer: string) => void
): void {
	const card = document.createElement("div");
	card.className = "claude-panel-ask claude-panel-ask-yesno";

	const slot = document.createElement("div");
	slot.className = "claude-panel-ask-slot claude-panel-ask-options";
	card.appendChild(slot);

	const makeBtn = (text: string): HTMLButtonElement => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "claude-panel-ask-option";
		b.textContent = text;
		b.onclick = (e) => {
			e.preventDefault();
			const buttons = slot.querySelectorAll<HTMLButtonElement>(
				".claude-panel-ask-option"
			);
			buttons.forEach((x) => (x.disabled = true));
			b.addClass("is-selected");
			onAnswer(text);
		};
		return b;
	};

	slot.appendChild(makeBtn(labels.yes));
	slot.appendChild(makeBtn(labels.no));

	container.appendChild(card);
}

interface AskPayload {
	question: string;
	options: string[];
	allowOther: boolean;
	type: "single" | "multi";
}

function parseAskPayload(raw: string): AskPayload | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;
	const o = obj as Record<string, unknown>;
	const question = typeof o.question === "string" ? o.question.trim() : "";
	if (!question) return null;
	if (!Array.isArray(o.options)) return null;
	const options: string[] = [];
	for (const v of o.options) {
		if (typeof v !== "string") continue;
		const s = v.trim();
		if (s) options.push(s);
	}
	if (options.length === 0) return null;
	const allowOther = o.allowOther === true;
	// `type` 未指定または不明値は "single"（後方互換）。
	const type: "single" | "multi" = o.type === "multi" ? "multi" : "single";
	return { question, options, allowOther, type };
}

export function renderToolPill(
	parent: HTMLElement,
	name: string,
	input: unknown
): void {
	// ピル本体だけだと「何のファイルを触ったか」しか分からないので、
	// 編集系ツール（Edit/MultiEdit/Write/NotebookEdit）はピルの下に
	// 差分プレビューを並べる。ピルとプレビューを 1 つのブロックに
	// まとめるためのラッパーを作る。
	const block = parent.createDiv({ cls: "claude-panel-tool-block" });
	const pill = block.createDiv({ cls: "claude-panel-tool" });
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
	if (shouldShowInlineDiff(name)) {
		renderToolDetails(block, name, input);
	}
}

function shouldShowInlineDiff(toolName: string): boolean {
	return (
		toolName === "Edit" ||
		toolName === "MultiEdit" ||
		toolName === "Write" ||
		toolName === "NotebookEdit"
	);
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
			? t("chat.selRefRangeMulti", sel.startLine, sel.lineCount)
			: t("chat.selRefRangeSingle", sel.startLine);
	chip.createSpan({
		cls: "claude-panel-selref-range",
		text: range,
	});
}

function renderResultFooter(
	host: HTMLElement,
	r: RunResult,
	usage: MessageUsage | undefined
): void {
	const footer = host.createDiv({ cls: "claude-panel-msg-footer" });
	const duration =
		r.durationMs >= 1000
			? t("chat.footerDurationSec", (r.durationMs / 1000).toFixed(1))
			: t("chat.footerDurationMs", r.durationMs);
	const tokens = usage ? formatTokens(sumUsage(usage)) : null;
	const tokensText = tokens ? ` · ${tokens} tokens` : "";
	const cost = r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : "";
	const modelText = r.model ? `${formatModelLabel(r.model)} · ` : "";
	footer.setText(t("chat.footerComplete", modelText, duration, tokensText, cost));
	if (usage) {
		// 内訳をホバーで見られるようにする。フッター行は混雑するので
		// 4 種別の数値はツールチップに退避。
		footer.setAttr(
			"title",
			t(
				"chat.footerUsageTooltip",
				usage.inputTokens.toLocaleString(),
				usage.outputTokens.toLocaleString(),
				usage.cacheCreationTokens.toLocaleString(),
				usage.cacheReadTokens.toLocaleString()
			)
		);
	}
}

function sumUsage(u: MessageUsage): number {
	return (
		(u.inputTokens || 0) +
		(u.outputTokens || 0) +
		(u.cacheCreationTokens || 0) +
		(u.cacheReadTokens || 0)
	);
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
			// 単一編集ではラベルを省略する（赤緑の diff 自体が「変更」を
			// 自明に示すので "変更内容" の見出しは情報冗長）。複数編集の
			// 場合だけ「変更 N / M」を残し、どの hunk か識別できるように。
			renderDiffBlock(
				parent,
				edits.length > 1 ? t("chatTool.changeOfN", idx + 1, edits.length) : null,
				oldStr,
				newStr
			);
		});
		return;
	}
	if (toolName === "Write" && typeof i.content === "string") {
		renderPlainBlock(parent, t("chatTool.writeContent"), i.content, "new");
		return;
	}
	if (toolName === "Bash" && typeof i.command === "string") {
		renderPlainBlock(parent, t("chatTool.bashCommand"), i.command);
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
				text: t("chatTool.notebookCell", i.cell_id),
			});
		}
		const oldSrc = typeof i.old_source === "string" ? i.old_source : "";
		if (oldSrc) renderDiffBlock(parent, null, oldSrc, i.new_source);
		else renderPlainBlock(parent, t("chatTool.writeContent"), i.new_source, "new");
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
	label: string | null,
	oldStr: string,
	newStr: string
): void {
	const wrap = parent.createDiv({ cls: "claude-panel-perm-detail" });
	if (label) {
		wrap.createDiv({ cls: "claude-panel-perm-detail-label", text: label });
	}
	const diff = wrap.createDiv({ cls: "claude-panel-perm-diff" });

	// DOM は常に「左右ペア」として描き、ナローでは縦積み（unified ライク）、
	// ワイドでは左右並び（split）をコンテナクエリで切り替える。
	// ペアリングは「直前から積んだ del 群と add 群を ctx か末尾で flush」する
	// 単純なロジック。差分は隣接する add/del 群が同じ hunk になりやすいので、
	// この単純なペアリングで実用上は十分整列する。
	const lines = clipDiff(diffLines(oldStr, newStr), 40);
	const rows = pairForSplit(lines);
	for (const row of rows) {
		if (row.kind === "ellipsis") {
			const r = diff.createDiv({
				cls: "claude-panel-perm-diff-row is-ellipsis",
			});
			r.setText(row.text || "⋯");
			continue;
		}
		const r = diff.createDiv({
			cls: `claude-panel-perm-diff-row is-${row.kind}`,
		});
		appendDiffCell(r, "left", row.left);
		appendDiffCell(r, "right", row.right);
	}
}

interface DiffCell {
	kind: "del" | "add" | "ctx" | "empty";
	text: string;
}

type SplitRow =
	| { kind: "ctx" | "pair"; left: DiffCell; right: DiffCell }
	| { kind: "ellipsis"; text: string };

function appendDiffCell(
	row: HTMLElement,
	side: "left" | "right",
	cell: DiffCell
): void {
	const el = row.createDiv({
		cls: `claude-panel-perm-diff-cell is-${side} is-${cell.kind}`,
	});
	if (cell.kind === "empty") return;
	const marker =
		cell.kind === "add" ? "+" : cell.kind === "del" ? "−" : " ";
	el.createSpan({
		cls: "claude-panel-perm-diff-marker",
		text: marker,
	});
	el.createSpan({
		cls: "claude-panel-perm-diff-text",
		// 空行も視覚的に 1 行分の高さを確保するため non-breaking space に置換。
		text: cell.text.length === 0 ? " " : cell.text,
	});
}

function pairForSplit(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let dels: string[] = [];
	let adds: string[] = [];

	const flush = (): void => {
		const n = Math.max(dels.length, adds.length);
		for (let i = 0; i < n; i++) {
			rows.push({
				kind: "pair",
				left:
					i < dels.length
						? { kind: "del", text: dels[i] }
						: { kind: "empty", text: "" },
				right:
					i < adds.length
						? { kind: "add", text: adds[i] }
						: { kind: "empty", text: "" },
			});
		}
		dels = [];
		adds = [];
	};

	for (const line of lines) {
		if (line.kind === "ctx") {
			flush();
			rows.push({
				kind: "ctx",
				left: { kind: "ctx", text: line.text },
				right: { kind: "ctx", text: line.text },
			});
		} else if (line.kind === "ellipsis") {
			flush();
			rows.push({ kind: "ellipsis", text: line.text });
		} else if (line.kind === "del") {
			dels.push(line.text);
		} else {
			adds.push(line.text);
		}
	}
	flush();
	return rows;
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
		{ kind: "ellipsis", text: t("chatTool.moreLines", lines.length - max) },
	];
}

/** 行数で切り詰める（バイト数だと CJK で過剰に切られるため）。 */
function clip(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n") + "\n" + t("chatTool.moreLines", lines.length - maxLines);
}

function basename(p: string): string {
	const trimmed = p.replace(/[\\/]+$/, "");
	const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
