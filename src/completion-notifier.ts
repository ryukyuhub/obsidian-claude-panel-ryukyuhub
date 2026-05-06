import type { NotifyOnComplete } from "./settings";

const wantsSound = (mode: NotifyOnComplete): boolean =>
	mode === "sound" || mode === "both";
const wantsFlash = (mode: NotifyOnComplete): boolean =>
	mode === "flash" || mode === "both";

/** 0–100 の UI 値を 0–1 のゲイン係数へ。負値は 0 に丸める。 */
const normalizeVolume = (vol: number): number => {
	if (!Number.isFinite(vol)) return 0.7;
	return Math.max(0, Math.min(100, vol)) / 100;
};

interface NotifierConfig {
	getMode: () => NotifyOnComplete;
	getVolume: () => number;
	getSoundPath: () => string;
	panelRoot: HTMLElement;
}

/**
 * 応答完了時の通知（フラッシュ・音）を担う小さなコンポーネント。
 * view から状態を切り出すために独立クラスにしている。
 *
 * AudioContext は遅延生成し、view 単位で使い回す（Obsidian のウィンドウ
 * は長寿命なので毎回作るより安い）。連続した完了でフラッシュ CSS が
 * 途中キャンセルされないよう timeout id も保持する。カスタム音声ファイル
 * を指定された場合はパス→AudioBuffer の対応表をキャッシュし、Vault や
 * OS のファイルを毎回読み直さずに済ませる。
 */
export class CompletionNotifier {
	private audioCtx: AudioContext | null = null;
	private flashTimeoutId: number | null = null;
	private bufferCache = new Map<string, AudioBuffer>();
	private inflightLoads = new Map<string, Promise<AudioBuffer | null>>();

	constructor(private readonly config: NotifierConfig) {}

	/**
	 * 完了通知を発火する。`getMode()` の値に応じて音とフラッシュを実行する。
	 * 呼び出し側で「ユーザーがキャンセルしたランかどうか」を判定し、
	 * キャンセル時はそもそもこのメソッドを呼ばない方針。
	 */
	notify(): void {
		const mode = this.config.getMode();
		if (wantsSound(mode)) void this.playSound();
		if (wantsFlash(mode)) this.flash();
	}

	/**
	 * AudioContext をユーザージェスチャの最中に起こしておく。Chromium の
	 * autoplay policy では、ユーザージェスチャの文脈外で resume を呼ぶと
	 * suspended のままになり、completion beep が鳴らない。送信ボタンを
	 * 押した瞬間に呼んで running 状態に持っていく。
	 */
	warmup(): void {
		if (!wantsSound(this.config.getMode())) return;
		const ctx = this.ensureContext();
		if (!ctx) return;
		if (ctx.state === "suspended") {
			void ctx.resume().catch((e) => {
				console.warn("[claude-panel] AudioContext resume failed", e);
			});
		}
	}

	/** 設定タブのテストボタンから呼ばれる。モードに依存せず必ず音を出す。 */
	playTest(): void {
		void this.playSound({ force: true });
	}

	dispose(): void {
		if (this.flashTimeoutId !== null) {
			window.clearTimeout(this.flashTimeoutId);
			this.flashTimeoutId = null;
		}
		this.bufferCache.clear();
		this.inflightLoads.clear();
		if (this.audioCtx) {
			void this.audioCtx.close().catch(() => {
				/* close は冪等ではないが失敗しても無害なので無視する。 */
			});
			this.audioCtx = null;
		}
	}

	private ensureContext(): AudioContext | null {
		if (this.audioCtx) return this.audioCtx;
		try {
			this.audioCtx = new AudioContext();
		} catch (e) {
			console.warn("[claude-panel] AudioContext create failed", e);
			return null;
		}
		return this.audioCtx;
	}

	private async playSound(opts?: { force?: boolean }): Promise<void> {
		const ctx = this.ensureContext();
		if (!ctx) return;
		try {
			if (ctx.state === "suspended") await ctx.resume();
			if (ctx.state !== "running") {
				console.warn(
					"[claude-panel] AudioContext not running:",
					ctx.state
				);
				return;
			}
			const volume = normalizeVolume(this.config.getVolume());
			// 音量 0 ではテスト再生を除いて何も鳴らさない（不要な処理を避ける）。
			if (volume <= 0 && !opts?.force) return;
			const path = this.config.getSoundPath().trim();
			if (path) {
				const buf = await this.loadBuffer(ctx, path);
				if (buf) {
					this.playBuffer(ctx, buf, volume);
					return;
				}
				// 読み込み失敗時はチャイムへフォールバック（無音より気付ける）。
			}
			this.playChime(ctx, volume);
		} catch (e) {
			console.warn("[claude-panel] playSound failed", e);
		}
	}

	private async loadBuffer(
		ctx: AudioContext,
		path: string
	): Promise<AudioBuffer | null> {
		const cached = this.bufferCache.get(path);
		if (cached) return cached;
		const inflight = this.inflightLoads.get(path);
		if (inflight) return inflight;

		const promise = (async (): Promise<AudioBuffer | null> => {
			try {
				const arrayBuffer = await this.readFileAsArrayBuffer(path);
				if (!arrayBuffer) return null;
				// decodeAudioData はブラウザ実装によっては破壊的に
				// ArrayBuffer を消費するため、AudioContext の slice を渡す
				// より、そのまま渡してから例外を握る。
				const decoded = await ctx.decodeAudioData(arrayBuffer);
				this.bufferCache.set(path, decoded);
				return decoded;
			} catch (e) {
				console.warn(
					"[claude-panel] failed to load notification sound:",
					path,
					e
				);
				return null;
			} finally {
				this.inflightLoads.delete(path);
			}
		})();
		this.inflightLoads.set(path, promise);
		return promise;
	}

	/**
	 * 絶対パスの音声ファイルを Node の fs で読み、ArrayBuffer に変換する。
	 * Electron 環境前提（Obsidian デスクトップ版）。HTTP fetch は
	 * file:// で動かない環境があり、Vault.adapter は Vault 外の絶対パスを
	 * 扱えないため、Node の require("fs") を直接使うのが最も確実。
	 */
	private async readFileAsArrayBuffer(
		path: string
	): Promise<ArrayBuffer | null> {
		try {
			const req = (
				window as unknown as {
					require?: (id: string) => unknown;
				}
			).require;
			if (!req) return null;
			const fs = req("fs") as {
				promises: { readFile: (p: string) => Promise<Buffer> };
			};
			const buf = await fs.promises.readFile(path);
			// Node の Buffer は Uint8Array のサブクラス。ArrayBuffer 部分を
			// 切り出して渡す（offset/length が 0 とは限らないので注意）。
			return buf.buffer.slice(
				buf.byteOffset,
				buf.byteOffset + buf.byteLength
			) as ArrayBuffer;
		} catch (e) {
			console.warn("[claude-panel] read sound file failed", path, e);
			return null;
		}
	}

	private playBuffer(
		ctx: AudioContext,
		buffer: AudioBuffer,
		volume: number
	): void {
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		const gain = ctx.createGain();
		gain.gain.value = volume;
		src.connect(gain).connect(ctx.destination);
		src.start();
	}

	/** 内蔵の 2 音チャイム（A5 → E6）。完了感のある上昇 2 音にする。 */
	private playChime(ctx: AudioContext, volume: number): void {
		const baseTime = ctx.currentTime + 0.02;
		this.scheduleTone(ctx, 880, baseTime, 0.22, 0.5 * volume);
		this.scheduleTone(ctx, 1318.5, baseTime + 0.11, 0.28, 0.4 * volume);
	}

	private scheduleTone(
		ctx: AudioContext,
		freq: number,
		t0: number,
		duration: number,
		peak: number
	): void {
		// 0 のときは exponentialRampToValueAtTime が NaN を返すので終端値を
		// 0.0001 にクランプ。peak も極小だと意味がないので早期リターン。
		if (peak <= 0.0001) return;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		// クリックノイズを避けるため立ち上がり/減衰をフェード。
		gain.gain.setValueAtTime(0, t0);
		gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
		gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
		osc.connect(gain).connect(ctx.destination);
		osc.start(t0);
		osc.stop(t0 + duration + 0.05);
	}

	private flash(): void {
		const root = this.config.panelRoot;
		// 連続発火に備えて既存タイマーをクリアし、クラスを外してから再付与
		// することで CSS アニメーションを確実にリスタートさせる。
		if (this.flashTimeoutId !== null) {
			window.clearTimeout(this.flashTimeoutId);
		}
		root.removeClass("is-flash");
		void root.offsetWidth; // リフロー強制でアニメーションを巻き戻す。
		root.addClass("is-flash");
		// CSS 側のアニメーション総時間（3.0s）+ 余裕でクラスを外す。
		this.flashTimeoutId = window.setTimeout(() => {
			root.removeClass("is-flash");
			this.flashTimeoutId = null;
		}, 3100);
	}
}
