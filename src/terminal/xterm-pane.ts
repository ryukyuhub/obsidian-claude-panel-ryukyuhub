import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Platform, type App, type ItemView } from "obsidian";
import * as os from "os";
import { extractPastedImages, getFilePath } from "../attachments";
import { getDragged } from "../obsidian-internals";
import {
	createVaultLinkProvider,
	isLinkClick,
	openFileUri,
	URL_REGEX,
} from "./links";
import { resolveFontFamily, resolveTheme } from "./theme";

/** これより小さいときは、非表示か開閉アニメーションの途中とみなす。 */
const MIN_HOST_WIDTH = 50;
const MIN_HOST_HEIGHT = 30;
const MIN_COLS = 20;
const MIN_ROWS = 5;
const LAYOUT_DELAY_MS = 80;
/** 未処理の出力がこれを超えたら止め、下の値を切ったら再開する。 */
const FLOW_HIGH_BYTES = 1024 * 1024;
const FLOW_LOW_BYTES = 256 * 1024;
/** OSC 52 でコピーを受け付ける最大サイズ（復号後）。 */
const MAX_OSC52_BYTES = 1024 * 1024;
/** 明暗の変化を通知するモード（DECSET ?2031）。 */
const COLOR_SCHEME_MODE = 2031;

export interface XtermPaneOptions {
	app: App;
	view: ItemView;
	/** xterm の親要素。padding を付けないこと（FitAddon が高さに含めてしまう）。 */
	host: HTMLElement;
	getFontSize(): number;
	onInput(data: string | Uint8Array): void;
	/** デバウンス後、桁・行が変わったときだけ呼ぶ。 */
	onResize(cols: number, rows: number): void;
	/** 初めて寸法が取れたとき 1 回だけ呼ぶ。 */
	onVisible(): void;
	onPasteImages(files: File[]): void;
	onDropItems(items: {
		osPaths: string[];
		vaultPaths: string[];
		unresolved: number;
	}): void;
}

/** xterm のラッパー（サイズ・キー・貼り付け・ドロップ・流量制御）。 */
export class XtermPane {
	private readonly term: Terminal;
	private readonly fit = new FitAddon();
	private readonly cleanups: (() => void)[] = [];
	private observer: ResizeObserver | null = null;
	private layoutTimer: number | null = null;
	private lastSize: { cols: number; rows: number } | null = null;
	/** 前回の layout で寸法が取れたか。 */
	private shown = false;
	private focusPending = false;
	private inputEnabled = true;
	private disposed = false;
	private dark: boolean;
	/** 端末内のプログラムが明暗の変化の通知を求めているか。 */
	private notifiesColorScheme = false;

	private flow: { pause(): void; resume(): void } | null = null;
	private flowPaused = false;
	private pendingBytes = 0;

	constructor(private readonly options: XtermPaneOptions) {
		this.dark = this.isDark();
		this.term = this.createTerminal();
		this.registerSequences();
		this.bindHost();
		this.observeSize();
		this.scheduleLayout();
	}

	/** 現在の寸法に合わせる。非表示などで寸法が取れなければ null。 */
	layout(): { cols: number; rows: number } | null {
		if (this.disposed) return null;
		const { host } = this.options;
		if (
			host.clientWidth < MIN_HOST_WIDTH ||
			host.clientHeight < MIN_HOST_HEIGHT
		) {
			this.shown = false;
			return null;
		}
		// 非表示のまま開くと文字幅を測れないので、見えるまで遅らせる。
		if (!this.term.element) {
			this.term.open(host);
			this.alignComposition();
		}
		if (!this.shown) {
			this.shown = true;
			this.syncOptions();
		}

		const proposed = this.fit.proposeDimensions();
		if (!proposed || isNaN(proposed.cols) || isNaN(proposed.rows)) return null;
		const size = {
			cols: Math.max(MIN_COLS, proposed.cols),
			rows: Math.max(MIN_ROWS, proposed.rows),
		};
		const last = this.lastSize;
		this.lastSize = size;
		if (!last || last.cols !== size.cols || last.rows !== size.rows) {
			this.term.resize(size.cols, size.rows);
			if (last) this.options.onResize(size.cols, size.rows);
		}
		if (!last) {
			if (this.focusPending) this.term.focus();
			this.options.onVisible();
		}
		return size;
	}

	scheduleLayout(): void {
		if (this.disposed) return;
		if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
		this.layoutTimer = window.setTimeout(() => {
			this.layoutTimer = null;
			this.layout();
		}, LAYOUT_DELAY_MS);
	}

	write(chunk: Uint8Array): void {
		if (this.disposed) return;
		this.pendingBytes += chunk.length;
		if (!this.flowPaused && this.pendingBytes > FLOW_HIGH_BYTES) {
			this.flowPaused = true;
			this.flow?.pause();
		}
		this.term.write(chunk, () => {
			this.pendingBytes -= chunk.length;
			if (
				this.flowPaused &&
				!this.disposed &&
				this.pendingBytes < FLOW_LOW_BYTES
			) {
				this.flowPaused = false;
				this.flow?.resume();
			}
		});
	}

	/** 出力が溜まったときに止める相手。null で解除。 */
	setFlow(target: { pause(): void; resume(): void } | null): void {
		if (this.flowPaused) this.flow?.resume();
		this.flow = target;
		// 前の相手の出力がまだ残っていれば、新しい相手も待たせる。
		if (this.flowPaused) target?.pause();
	}

	clear(): void {
		if (this.disposed) return;
		// RIS（ESC c）。reset() と違い、書き込み済みの出力を処理した後に効く。
		// バイト列で渡すのは、途中で切れた UTF-8 の残りも捨てさせるため。
		this.term.write(new Uint8Array([0x1b, 0x63]));
	}

	paste(text: string): void {
		// open() 前の term.paste() は例外になる。
		if (this.disposed || !this.inputEnabled || !this.term.textarea) return;
		this.term.paste(text);
	}

	focus(): void {
		if (this.disposed) return;
		if (this.term.element) {
			this.term.focus();
		} else {
			this.focusPending = true;
			this.scheduleLayout();
		}
	}

	hasFocus(): boolean {
		const { textarea } = this.term;
		return !!textarea && textarea.doc.activeElement === textarea;
	}

	setInputEnabled(on: boolean): void {
		if (this.disposed) return;
		this.inputEnabled = on;
		if (this.shown) this.term.options.disableStdin = !on;
	}

	/** 配色・フォントを設定し直す。 */
	applyAppearance(): void {
		if (this.disposed) return;
		if (this.shown) this.syncOptions();
		this.scheduleLayout();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
		this.observer?.disconnect();
		for (const cleanup of this.cleanups) cleanup();
		this.setFlow(null);
		this.term.dispose();
	}

	private createTerminal(): Terminal {
		const { app, host } = this.options;
		const openUrl = (event: MouseEvent, uri: string): void => {
			if (!isLinkClick(event, term)) return;
			if (/^https?:/i.test(uri)) window.open(uri);
			else openFileUri(app, uri, event);
		};
		const term = new Terminal({
			// unicode11 の有効化に必要
			allowProposedApi: true,
			scrollback: 5000,
			cursorBlink: false,
			// 動作中にテーマを切り替えて claude 側の配色とずれても読めるようにする。
			minimumContrastRatio: 4.5,
			// マウスを捕捉されている間も、Option+ドラッグで選択できるようにする
			// （Windows / Linux は Shift+ドラッグで、設定は要らない）。
			macOptionClickForcesSelection: true,
			fontSize: this.options.getFontSize(),
			fontFamily: resolveFontFamily(host),
			theme: resolveTheme(host),
			// 設定しないと、OSC 8 のリンクで xterm が confirm() を出す。
			linkHandler: { activate: openUrl, allowNonHttpProtocols: true },
			...(Platform.isWin
				? {
						windowsPty: {
							backend: "conpty" as const,
							buildNumber: Number(os.release().split(".")[2]),
						},
					}
				: {}),
		});
		term.loadAddon(this.fit);
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		// 先に登録した方が優先される（URL の一部を Vault のパスとみなさない）。
		term.loadAddon(new WebLinksAddon(openUrl, { urlRegex: URL_REGEX }));
		term.registerLinkProvider(createVaultLinkProvider(app, term));
		term.attachCustomKeyEventHandler((event) => this.handleKey(event));
		term.onData((data) => {
			if (this.inputEnabled) this.options.onInput(data);
		});
		term.onBinary((data) => {
			if (this.inputEnabled) {
				this.options.onInput(Buffer.from(data, "latin1"));
			}
		});
		return term;
	}

	private bindHost(): void {
		const { app, view, host } = this.options;
		const listen = <K extends keyof HTMLElementEventMap>(
			type: K,
			listener: (event: HTMLElementEventMap[K]) => void,
			capture = false
		): void => {
			host.addEventListener(type, listener, capture);
			this.cleanups.push(() =>
				host.removeEventListener(type, listener, capture)
			);
		};
		listen("paste", (event) => this.handlePaste(event), true);
		listen("dragover", (event) => this.handleDragOver(event));
		listen("drop", (event) => this.handleDrop(event));

		const cssChange = app.workspace.on("css-change", () =>
			this.applyAppearance()
		);
		this.cleanups.push(() => app.workspace.offref(cssChange));
		this.cleanups.push(
			view.containerEl.onWindowMigrated(() => this.handleWindowMigrated())
		);
	}

	private observeSize(): void {
		const { host } = this.options;
		this.observer?.disconnect();
		const win = host.win as Window & {
			ResizeObserver: typeof ResizeObserver;
		};
		this.observer = new win.ResizeObserver(() => this.scheduleLayout());
		this.observer.observe(host);
	}

	private handleWindowMigrated(): void {
		if (this.disposed) return;
		const { host } = this.options;
		if (this.term.element) {
			// 開き直すと、内部の window の参照だけが移動先に変わる。document は変わらず、
			// マウスのドラッグや離した操作を拾えなくなるので合わせて差し替える。
			this.term.open(host);
			const { _core: core } = this.term as unknown as {
				_core?: { _document?: Document };
			};
			if (core?._document) core._document = host.doc;
		}
		this.observeSize();
		this.applyAppearance();
	}

	/**
	 * 設定を xterm へ反映する。非表示の間は呼ばない。xterm はオプションが変わると
	 * 文字幅を測り直すが、非表示だと 0 になり字間が崩れるため、表示されたときに
	 * まとめて反映する（theme は毎回新しい値なので、必ず測り直される）。
	 */
	private syncOptions(): void {
		const { host } = this.options;
		this.term.options.disableStdin = !this.inputEnabled;
		this.term.options.fontSize = this.options.getFontSize();
		this.term.options.fontFamily = resolveFontFamily(host);
		this.term.options.theme = resolveTheme(host);
		this.notifyColorScheme();
	}

	// ---------- 制御シーケンス ----------

	/** xterm が処理しないシーケンスを補う。false を返すと既定の処理も続く。 */
	private registerSequences(): void {
		const { parser } = this.term;
		const watchMode = (final: "h" | "l"): void => {
			parser.registerCsiHandler({ prefix: "?", final }, (params) => {
				if (params.includes(COLOR_SCHEME_MODE)) {
					this.notifiesColorScheme = final === "h";
				}
				return false;
			});
		};
		watchMode("h");
		watchMode("l");
		parser.registerEscHandler({ final: "c" }, () => {
			this.notifiesColorScheme = false;
			return false;
		});
		parser.registerOscHandler(52, (data) => {
			this.copyFromOsc52(data);
			return true;
		});
	}

	private isDark(): boolean {
		return this.options.host.doc.body.hasClass("theme-dark");
	}

	/** 明暗が変わったことを知らせる。受け手が背景色を問い合わせるので、配色の更新後に呼ぶ。 */
	private notifyColorScheme(): void {
		const dark = this.isDark();
		if (dark === this.dark) return;
		this.dark = dark;
		if (this.notifiesColorScheme) {
			this.term.input(dark ? "\x1b[?997;1n" : "\x1b[?997;2n", false);
		}
	}

	/** `<選択先>;<base64>`。書き込みだけ受け付け、読み取り（`?`）には応答しない。 */
	private copyFromOsc52(data: string): void {
		const match = /^[cp]*;([A-Za-z0-9+/]+={0,2})$/.exec(data);
		if (!match || match[1].length > Math.ceil(MAX_OSC52_BYTES / 3) * 4) return;
		const bytes = Buffer.from(match[1], "base64");
		if (bytes.length > MAX_OSC52_BYTES) return;
		this.writeClipboard(bytes.toString("utf8"));
	}

	private writeClipboard(text: string): void {
		this.options.host.win.navigator.clipboard.writeText(text).catch((e) => {
			console.warn("[claude-panel] copy from terminal failed", e);
		});
	}

	// ---------- キー ----------

	/** false を返すと xterm はそのキーを処理しない。keypress / keyup でも呼ばれる。 */
	private handleKey(event: KeyboardEvent): boolean {
		// 変換中のキーは xterm に任せる。
		if (event.isComposing || event.key === "Process") return true;
		const { ctrlKey, shiftKey, altKey, metaKey } = event;

		if (event.key === "Enter" && shiftKey && !ctrlKey && !altKey && !metaKey) {
			if (event.type === "keydown") {
				event.preventDefault();
				this.term.input("\n");
			}
			return false;
		}

		if (Platform.isMacOS || !ctrlKey || altKey || metaKey) return true;
		const letter = keyLetter(event);
		if (letter === "c" && (shiftKey || this.term.hasSelection())) {
			if (event.type === "keydown") {
				event.preventDefault();
				this.copySelection();
			}
			return false;
		}
		// preventDefault せず、標準の paste イベントで貼り付ける。
		if (letter === "v") return false;
		return true;
	}

	private copySelection(): void {
		const text = this.term.getSelection();
		if (!text) return;
		this.term.clearSelection();
		this.writeClipboard(text);
	}

	/**
	 * 変換中の文字列は入力位置から 1 行で右へ伸び、狭いパネルでは見切れる。
	 * はみ出す分だけ左へずらし、入力中の末尾が見えるようにする。
	 * 位置を決める xterm の処理より後に動くよう、open() の後に呼ぶこと。
	 */
	private alignComposition(): void {
		const { host } = this.options;
		const { element, textarea } = this.term;
		const preview = element?.querySelector<HTMLElement>(".composition-view");
		if (!preview || !textarea) return;

		let composing = false;
		const align = (): void => {
			const right = preview.offsetLeft + preview.offsetWidth;
			const overflow = composing ? right - host.clientWidth : 0;
			const transform = overflow > 0 ? `translateX(${-overflow}px)` : "";
			preview.setCssStyles({ transform });
			textarea.setCssStyles({ transform });
		};
		textarea.addEventListener("compositionstart", () => {
			composing = true;
		});
		textarea.addEventListener("compositionupdate", align);
		textarea.addEventListener("compositionend", () => {
			composing = false;
			align();
		});
		this.term.onRender(() => {
			if (composing) align();
		});
	}

	// ---------- 貼り付け / ドロップ ----------

	private handlePaste(event: ClipboardEvent): void {
		// 表計算などはテキストと画像の両方を入れるので、テキストを優先する。
		if (event.clipboardData?.getData("text/plain")) return;
		const images = extractPastedImages(event);
		if (images.length === 0) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (this.inputEnabled) this.options.onPasteImages(images);
	}

	private handleDragOver(event: DragEvent): void {
		const { dataTransfer } = event;
		if (!dataTransfer || !this.inputEnabled) return;
		const accepts =
			dataTransfer.types.includes("Files") ||
			getDragged(this.options.app).length > 0;
		if (!accepts) return;
		// Obsidian 側の処理は defaultPrevented を見て何もしない。伝播は止めない
		// （止めるとドラッグ中のファイル名の表示が追従しなくなる）。
		event.preventDefault();
		dataTransfer.dropEffect = "copy";
	}

	private handleDrop(event: DragEvent): void {
		if (!this.inputEnabled) return;
		const vaultPaths = getDragged(this.options.app).map((item) => item.path);
		const osPaths: string[] = [];
		let unresolved = 0;
		if (vaultPaths.length === 0) {
			for (const file of Array.from(event.dataTransfer?.files ?? [])) {
				const path = getFilePath(file);
				if (path) osPaths.push(path);
				else unresolved++;
			}
		}
		if (vaultPaths.length + osPaths.length + unresolved === 0) return;
		event.preventDefault();
		this.options.onDropItems({ osPaths, vaultPaths, unresolved });
	}
}

/** 押されたキーの英字。キリル文字などの配列では物理キーから求める。 */
function keyLetter(event: KeyboardEvent): string {
	const { key, code } = event;
	if (key.length === 1 && key.charCodeAt(0) < 0x80) return key.toLowerCase();
	return code.startsWith("Key") ? code.slice(3).toLowerCase() : "";
}
