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

/** 生存中の PTY を同期ですべて終了する。例外は投げない。 */
export function killAllPtys(): void {
	for (const session of [...livePtys]) {
		try {
			session.kill();
		} catch (e) {
			console.warn("[claude-panel] failed to kill a PTY", e);
		}
	}
}
