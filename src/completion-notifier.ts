import type { NotifyOnComplete } from "./settings";

const wantsSound = (mode: NotifyOnComplete): boolean =>
	mode === "sound" || mode === "both";
const wantsFlash = (mode: NotifyOnComplete): boolean =>
	mode === "flash" || mode === "both";

/**
 * 応答完了時の通知（フラッシュ・ビープ）を担う小さなコンポーネント。
 * view から状態を切り出すために独立クラスにしている。
 *
 * AudioContext は遅延生成し、view 単位で使い回す（Obsidian のウィンドウ
 * は長寿命なので毎回作るより安い）。連続した完了でフラッシュ CSS が
 * 途中キャンセルされないよう timeout id も保持する。
 */
export class CompletionNotifier {
	private audioCtx: AudioContext | null = null;
	private flashTimeoutId: number | null = null;

	constructor(
		private readonly getMode: () => NotifyOnComplete,
		private readonly panelRoot: HTMLElement
	) {}

	/**
	 * 完了通知を発火する。`getMode()` の値に応じて音とフラッシュを実行する。
	 * 呼び出し側で「ユーザーがキャンセルしたランかどうか」を判定し、
	 * キャンセル時はそもそもこのメソッドを呼ばない方針。
	 */
	notify(): void {
		const mode = this.getMode();
		if (wantsSound(mode)) void this.playBeep();
		if (wantsFlash(mode)) this.flash();
	}

	/**
	 * AudioContext をユーザージェスチャの最中に起こしておく。Chromium の
	 * autoplay policy では、ユーザージェスチャの文脈外で resume を呼ぶと
	 * suspended のままになり、completion beep が鳴らない。送信ボタンを
	 * 押した瞬間に呼んで running 状態に持っていく。
	 */
	warmup(): void {
		if (!wantsSound(this.getMode())) return;
		const ctx = this.ensureContext();
		if (!ctx) return;
		if (ctx.state === "suspended") {
			void ctx.resume().catch((e) => {
				console.warn("[claude-panel] AudioContext resume failed", e);
			});
		}
	}

	dispose(): void {
		if (this.flashTimeoutId !== null) {
			window.clearTimeout(this.flashTimeoutId);
			this.flashTimeoutId = null;
		}
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

	private async playBeep(): Promise<void> {
		const ctx = this.ensureContext();
		if (!ctx) return;
		try {
			// resume を await してから時刻スケジュールする。await しないと
			// 旧 currentTime 基準で start() を呼んでしまい、resume 完了時
			// には既にスケジュール時刻が過去になり「無音」になることがある。
			// なお Chromium の autoplay policy はユーザージェスチャの最中に
			// resume を呼ぶことを要求する場合があるため、warmup() が本命で
			// ここはフォールバック。
			if (ctx.state === "suspended") await ctx.resume();
			if (ctx.state !== "running") {
				console.warn(
					"[claude-panel] AudioContext not running:",
					ctx.state
				);
				return;
			}
			// 2 音のチャイム（A5 → E6）。完了感のある上昇 2 音にする。
			const baseTime = ctx.currentTime + 0.02;
			this.scheduleTone(ctx, 880, baseTime, 0.22, 0.5);
			this.scheduleTone(ctx, 1318.5, baseTime + 0.11, 0.28, 0.4);
		} catch (e) {
			console.warn("[claude-panel] playBeep failed", e);
		}
	}

	private scheduleTone(
		ctx: AudioContext,
		freq: number,
		t0: number,
		duration: number,
		peak: number
	): void {
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
		const root = this.panelRoot;
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
