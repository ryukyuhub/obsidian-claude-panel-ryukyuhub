import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { NoteContextPayload, SentSelection } from "../note-context";

/** 何も渡さなかった理由。 */
export type NotAttachedReason = "excluded" | "noTarget" | "slash";

/**
 * 直前の発言の UserPromptSubmit hook に返したもの。`clipped` は additionalContext の
 * 上限で末尾を切ったとき true。
 */
export type LastPromptResult =
	| { at: Date; sent: NoteContextPayload; clipped: boolean }
	| { at: Date; sent: null; reason: NotAttachedReason };

/**
 * ノート欄の「直前の発言に何を添付したか」の表示。1 行に収め、ノート欄の高さは
 * 変えない（変わると端末がリサイズされ、claude が画面全体を描き直す）。
 *
 * この要素は live region なので、空のときも DOM から外さず（CSS で視覚的に隠す
 * だけ）、最初の表示から読み上げられるようにする。
 */
export class LastPromptStatus {
	private result: LastPromptResult | null = null;

	constructor(private readonly host: HTMLElement) {
		host.addClass("claude-panel-terminal-last");
		host.setAttr("role", "status");
		host.setAttr("aria-live", "polite");
		this.render();
	}

	show(result: LastPromptResult): void {
		this.result = result;
		this.render();
	}

	clear(): void {
		this.result = null;
		this.render();
	}

	render(): void {
		const { host, result } = this;
		host.empty();
		host.toggleClass("is-empty", result === null);
		host.removeAttribute("title");
		if (!result) return;
		host.toggleClass("is-attached", result.sent !== null);

		const icon = host.createSpan({ cls: "claude-panel-terminal-last-icon" });
		setIcon(icon, result.sent ? "paperclip" : "circle-slash");
		icon.setAttr("aria-hidden", "true");
		host.createSpan({
			cls: "claude-panel-terminal-last-time",
			text: formatTime(result.at, false),
		});
		host.createSpan({
			cls: "claude-panel-terminal-last-text",
			text: result.sent ? attachedText(result.sent) : t("terminal.lastNothing"),
		});
		// 何も渡さなかった理由は、見た目はツールチップだけにして、読み上げには入れる。
		if (!result.sent) {
			host.createSpan({
				cls: "claude-panel-terminal-last-reason",
				text: t("terminal.lastReasonSpoken", reasonText(result.reason)),
			});
		}
		host.title = tooltip(result);
	}
}

function attachedText(sent: NoteContextPayload): string {
	const { target, selection } = sent;
	const parts: string[] = [];
	if (target) {
		const name = baseName(target.path);
		parts.push(target.isFolder ? `${name}/` : name);
	}
	if (selection) {
		// 選択範囲の元のファイルが、添付したノートと違う（フォルダを添付した、
		// ノートを外した）ときは、どのファイルの選択かも出す。
		const fromOther =
			selection.filePath !== null &&
			(!target || target.isFolder || target.path !== selection.filePath);
		const where = [
			fromOther && selection.filePath ? baseName(selection.filePath) : "",
			lineRange(selection),
		]
			.filter((s) => s !== "")
			.join(" ");
		// 切り詰めたときは、末尾の「…」で一部だけを渡したと分かるようにする。
		const more = selection.omitted > 0 ? "…" : "";
		parts.push(t("terminal.lastSelection", where) + more);
	}
	return t("terminal.lastAttached", parts.join(" + "));
}

function tooltip(result: LastPromptResult): string {
	const time = formatTime(result.at, true);
	if (!result.sent) {
		const lines = [t("terminal.lastTooltipNothing", time), reasonText(result.reason)];
		if (result.reason !== "slash") lines.push(t("terminal.lastTooltipQueued"));
		return lines.join("\n");
	}
	const { target, selection } = result.sent;
	const lines = [t("terminal.lastTooltipAttached", time)];
	if (target) {
		lines.push(
			target.isFolder
				? t("terminal.lastTooltipFolder", `${target.path}/`)
				: t("terminal.lastTooltipNote", target.path)
		);
	}
	if (selection) {
		const where = [selection.filePath ?? "", lineRange(selection)]
			.filter((s) => s !== "")
			.join(" ");
		lines.push(
			selection.omitted > 0
				? t(
						"terminal.lastTooltipSelectionTruncated",
						where,
						selection.chars,
						selection.omitted
					)
				: t("terminal.lastTooltipSelection", where, selection.chars)
		);
	}
	if (result.clipped) lines.push(t("terminal.lastTooltipClipped"));
	lines.push(t("terminal.lastTooltipQueued"));
	return lines.join("\n");
}

function reasonText(reason: NotAttachedReason): string {
	switch (reason) {
		case "excluded":
			return t("terminal.lastReasonExcluded");
		case "noTarget":
			return t("terminal.lastReasonNoTarget");
		case "slash":
			return t("terminal.lastReasonSlash");
	}
}

/** 行の範囲。行が分からない（閲覧モードの選択）ときは空文字。 */
function lineRange(selection: SentSelection): string {
	if (selection.lineUnknown) return "";
	return selection.endLine > selection.startLine
		? `L${selection.startLine}–L${selection.endLine}`
		: `L${selection.startLine}`;
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function formatTime(at: Date, withSeconds: boolean): string {
	const parts = [at.getHours(), at.getMinutes()];
	if (withSeconds) parts.push(at.getSeconds());
	return parts.map((n) => String(n).padStart(2, "0")).join(":");
}
