import type { MessageUsage } from "./chat-message";

/** 暫定でハードコード。現行 Claude 4.x モデルはすべて 200k がデフォルト。 */
const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * チャットヘッダーに描画する小さな SVG ドーナツ + ツールチップ。
 * 直近の使用トークン量をウィンドウ容量に対する割合で表示する。
 *
 * 単純な「描画 + ホスト要素」の組み合わせなので、view から状態管理を
 * 切り離してここに閉じ込めている。host を受け取って update() を呼ぶ
 * だけのインターフェース。
 */
export class ContextMeter {
	constructor(private readonly host: HTMLElement) {}

	update(usage: MessageUsage | null): void {
		const cap = CONTEXT_WINDOW_TOKENS;
		const used = tokensUsed(usage);
		this.renderDonut(used / cap);

		const tooltip = usage
			? `コンテキスト: ${used.toLocaleString()} / ${cap.toLocaleString()} (${((used / cap) * 100).toFixed(0)}%)\n入力 ${usage.inputTokens.toLocaleString()} · キャッシュ ${(usage.cacheCreationTokens + usage.cacheReadTokens).toLocaleString()} · 出力 ${usage.outputTokens.toLocaleString()}`
			: "コンテキスト — 使用データはまだありません";
		// aria-label のみを使う（Obsidian がツールチップとしてレンダリングする）。
		// 同時に `title` も設定すると、Obsidian のツールチップとブラウザ標準の
		// title 吹き出しが二重に表示されてしまう。
		this.host.setAttr("aria-label", tooltip);
	}

	private renderDonut(fraction: number): void {
		this.host.empty();
		const f = Math.max(0, Math.min(1, fraction));
		const percent = f * 100;

		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 36 36");
		svg.classList.add("claude-panel-meter-svg");

		const bg = document.createElementNS(ns, "circle");
		bg.setAttribute("cx", "18");
		bg.setAttribute("cy", "18");
		bg.setAttribute("r", "15.9155");
		bg.setAttribute("fill", "none");
		bg.setAttribute("stroke-width", "3.5");
		bg.classList.add("claude-panel-meter-bg");
		svg.appendChild(bg);

		const fg = document.createElementNS(ns, "circle");
		fg.setAttribute("cx", "18");
		fg.setAttribute("cy", "18");
		fg.setAttribute("r", "15.9155");
		fg.setAttribute("fill", "none");
		fg.setAttribute("stroke-width", "3.5");
		fg.setAttribute("stroke-linecap", "round");
		// 円周は 2π·15.9155 ≈ 100 になるので、dasharray はそのまま % にマッピングできる。
		fg.setAttribute("stroke-dasharray", `${percent.toFixed(2)} 100`);
		fg.setAttribute("transform", "rotate(-90 18 18)");
		fg.classList.add("claude-panel-meter-fg");
		if (f >= 0.85) fg.classList.add("is-danger");
		else if (f >= 0.6) fg.classList.add("is-warn");
		svg.appendChild(fg);

		this.host.appendChild(svg);
	}
}

/**
 * モデルの入力ウィンドウを占めるトークン量。今ターン生成された出力
 * トークンは入力には含まれないが、次ターンの入力には乗るので、
 * 「会話を続けた場合にコンテキストへ入る量」を近似するために出力
 * トークンも含めている。
 */
function tokensUsed(usage: MessageUsage | null): number {
	if (!usage) return 0;
	return (
		usage.inputTokens +
		usage.cacheCreationTokens +
		usage.cacheReadTokens +
		usage.outputTokens
	);
}
