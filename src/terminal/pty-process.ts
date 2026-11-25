import type { ChildProcess } from "child_process";
import type { PtyExit, PtyFailure, PtyHandlers, PtySession } from "./types";

/** ブリッジのプロセスを PtySession として扱う、方式に依存しない部分。 */

const STDERR_LIMIT = 8 * 1024;
const FORCE_KILL_DELAY_MS = 5000;
const INPUT_CHUNK = 64 * 1024;
const MAX_SIZE = 32767;

const FRAME_INPUT = 0;
const FRAME_RESIZE = 1;

/** 終了を確認できていない PTY。kill した後もプロセスが消えるまで残る。 */
export const livePtys = new Set<PtySession>();

export interface PtyOutcome {
	code: number | null;
	outputBytes: number;
	stderr: string;
}

export interface PtyTransport {
	child: ChildProcess;
	write(data: Buffer): void;
	resize(cols: number, rows: number): void;
	/** 正常な手順での終了を要求する。 */
	terminate(): void;
	/** 終了の要求に応じないとき、ブリッジを強制終了してよいか。 */
	forceKill: boolean;
	classify(outcome: PtyOutcome): PtyFailure | null;
}

export function clampSize(value: number): number {
	return Math.min(Math.max(Math.trunc(value) || 1, 1), MAX_SIZE);
}

/** ブリッジの stdin に送る 1 フレーム: [種別 u8][長さ u32 LE][本体] */
export function encodeFrame(type: number, payload: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head.writeUInt8(type, 0);
	head.writeUInt32LE(payload.length, 1);
	return Buffer.concat([head, payload]);
}

export function writeStdin(child: ChildProcess, data: Buffer): void {
	if (child.stdin?.writable) child.stdin.write(data);
}

export function writeInputFrames(child: ChildProcess, data: Buffer): void {
	for (let i = 0; i < data.length; i += INPUT_CHUNK) {
		writeStdin(child, encodeFrame(FRAME_INPUT, data.subarray(i, i + INPUT_CHUNK)));
	}
}

export function writeResizeFrame(child: ChildProcess, cols: number, rows: number): void {
	const payload = Buffer.alloc(4);
	payload.writeUInt16LE(cols, 0);
	payload.writeUInt16LE(rows, 2);
	writeStdin(child, encodeFrame(FRAME_RESIZE, payload));
}

export function createPtySession(
	transport: PtyTransport,
	handlers: PtyHandlers
): PtySession {
	const { child } = transport;
	const stderr: Buffer[] = [];
	let stderrBytes = 0;
	let outputBytes = 0;
	let killed = false;
	let finished = false;
	let forceKillTimer: number | null = null;

	const onData = (chunk: Buffer): void => {
		outputBytes += chunk.length;
		handlers.onData(chunk);
	};

	const finish = (exit: PtyExit): void => {
		if (finished) return;
		finished = true;
		livePtys.delete(session);
		if (forceKillTimer !== null) window.clearTimeout(forceKillTimer);
		if (!killed) handlers.onExit(exit);
	};

	const session: PtySession = {
		write(data) {
			if (killed || finished) return;
			transport.write(
				typeof data === "string"
					? Buffer.from(data, "utf8")
					: Buffer.from(data.buffer, data.byteOffset, data.byteLength)
			);
		},
		resize(cols, rows) {
			if (killed || finished) return;
			transport.resize(clampSize(cols), clampSize(rows));
		},
		pause() {
			if (!killed) child.stdout?.pause();
		},
		resume() {
			child.stdout?.resume();
		},
		kill() {
			if (killed || finished) return;
			killed = true;
			// 出力が詰まっているとブリッジが終われないので、読み捨てに切り替える
			child.stdout?.off("data", onData);
			child.stdout?.resume();
			transport.terminate();
			if (transport.forceKill) {
				forceKillTimer = window.setTimeout(
					() => child.kill("SIGKILL"),
					FORCE_KILL_DELAY_MS
				);
			}
		},
	};

	child.on("error", (e) => {
		// 起動後の error はシグナル送信の失敗など。終了は close で分かる
		if (child.pid !== undefined) return;
		finish({ code: null, failure: { kind: "bridge", detail: e.message } });
	});
	child.on("close", (code) => {
		const outcome = {
			code,
			outputBytes,
			stderr: Buffer.concat(stderr).toString("utf8").trim(),
		};
		finish({ code, failure: transport.classify(outcome) });
	});
	// 終了と行き違いになった書き込みの EPIPE
	child.stdin?.on("error", () => {});
	child.stdout?.on("data", onData);
	child.stderr?.on("data", (chunk: Buffer) => {
		const rest = STDERR_LIMIT - stderrBytes;
		if (rest <= 0) return;
		const kept = chunk.subarray(0, rest);
		stderrBytes += kept.length;
		stderr.push(kept);
	});

	livePtys.add(session);
	return session;
}
