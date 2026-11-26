import { openPosixPty } from "./pty-posix";
import { livePtys } from "./pty-process";
import { openWindowsPty } from "./pty-windows";
import type { PtyHandlers, PtyLaunch, PtySession } from "./types";

/** PTY を開いて `launch` を起動する。使える方式が無ければ PtyUnavailableError。 */
export function openPty(
	launch: PtyLaunch,
	handlers: PtyHandlers
): Promise<PtySession> {
	return process.platform === "win32"
		? openWindowsPty(launch, handlers)
		: openPosixPty(launch, handlers);
}

const killAllListeners = new Set<() => void>();

/**
 * 生存中の PTY を同期ですべて終了し、onKillAll の登録先に知らせる。例外は投げない。
 * kill した PTY の onExit は呼ばれないので、終了を表示する側は onKillAll で知る
 * （終了が取り消されると、Obsidian はそのまま動き続ける）。
 */
export function killAllPtys(): void {
	for (const session of [...livePtys]) {
		try {
			session.kill();
		} catch (e) {
			console.warn("[claude-panel] failed to kill a PTY", e);
		}
	}
	for (const listener of [...killAllListeners]) {
		try {
			listener();
		} catch (e) {
			console.warn("[claude-panel] kill-all listener failed", e);
		}
	}
}

/** killAllPtys の後に呼ぶ関数を登録する。戻り値で解除する。 */
export function onKillAll(listener: () => void): () => void {
	killAllListeners.add(listener);
	return () => {
		killAllListeners.delete(listener);
	};
}
