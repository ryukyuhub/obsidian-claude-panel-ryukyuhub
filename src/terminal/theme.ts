import type { ITheme } from "@xterm/xterm";

/** `el` があるウィンドウの Obsidian がダークテーマか。 */
export function isDarkTheme(el: HTMLElement): boolean {
	return el.doc.body.hasClass("theme-dark");
}

/** Obsidian の CSS 変数から xterm の配色を作る。 */
export function resolveTheme(host: HTMLElement): ITheme {
	const dark = isDarkTheme(host);
	const probe = createProbe(host);
	const toHex = createColorConverter(host);
	const read = (name: string): string => {
		probe.setCssStyles({ color: `var(${name})` });
		return host.win.getComputedStyle(probe).color;
	};

	try {
		// 背景に透過色を使うテーマでも、xterm には不透明な色を渡す。
		const background = toHex(
			read("--background-primary"),
			dark ? "#000000" : "#ffffff"
		);
		const color = (name: string): string => toHex(read(name), background);

		const foreground = color("--text-normal");
		const red = color("--color-red");
		const green = color("--color-green");
		const yellow = color("--color-yellow");
		const blue = color("--color-blue");
		const magenta = color("--color-purple");
		const cyan = color("--color-cyan");
		return {
			background,
			foreground,
			cursor: foreground,
			cursorAccent: background,
			selectionBackground: toHex(read("--text-selection")),
			black: color(dark ? "--color-base-20" : "--color-base-100"),
			red,
			green,
			yellow,
			blue,
			magenta,
			cyan,
			white: color(dark ? "--color-base-70" : "--color-base-40"),
			brightBlack: color("--color-base-60"),
			brightRed: red,
			brightGreen: green,
			brightYellow: yellow,
			brightBlue: blue,
			brightMagenta: magenta,
			brightCyan: cyan,
			brightWhite: color(dark ? "--color-base-100" : "--color-base-00"),
		};
	} finally {
		probe.remove();
	}
}

/** Obsidian の等幅フォントを font-family の値として返す。 */
export function resolveFontFamily(host: HTMLElement): string {
	const probe = createProbe(host);
	probe.addClass("claude-panel-terminal-probe-mono");
	const family = host.win.getComputedStyle(probe).fontFamily;
	probe.remove();
	return family || "monospace";
}

function createProbe(host: HTMLElement): HTMLElement {
	return host.createDiv({ cls: "claude-panel-terminal-probe" });
}

/**
 * 任意の CSS 色（`hsl()` や `color-mix()` の計算結果を含む）を xterm が読める
 * `#rrggbb` にする。`under` を渡すと透過色をその上に重ね、渡さなければ透過度を残す。
 */
function createColorConverter(
	host: HTMLElement
): (css: string, under?: string) => string {
	const canvas = host.doc.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return (css) => css;

	const hex = (value: number): string => value.toString(16).padStart(2, "0");
	return (css, under) => {
		ctx.clearRect(0, 0, 1, 1);
		for (const fill of under ? [under, css] : [css]) {
			ctx.fillStyle = fill;
			ctx.fillRect(0, 0, 1, 1);
		}
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ""}`;
	};
}
