/** PTY と hook サーバーの共有型。 */

export interface PtyLaunch {
	/** 絶対パス（Windows は .exe / .cmd / .bat） */
	file: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}

/** `bridge` は PTY を開く側の失敗、`launch` は claude を起動できなかった失敗。 */
export interface PtyFailure {
	kind: "bridge" | "launch";
	detail: string;
}

export interface PtyExit {
	code: number | null;
	failure: PtyFailure | null;
}

export interface PtyHandlers {
	onData(chunk: Uint8Array): void;
	/** 1 回だけ呼ばれる。 */
	onExit(exit: PtyExit): void;
}

export interface PtySession {
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	pause(): void;
	resume(): void;
	/** 何度呼んでもよい。呼んだ後は onData / onExit を呼ばない。 */
	kill(): void;
}

/** 使える方式が無いときに openPty が投げる。 */
export class PtyUnavailableError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "PtyUnavailableError";
	}
}

export type SessionMode =
	| { kind: "new" }
	| { kind: "continue" }
	| { kind: "resume"; sessionId: string };

export interface HookRequest {
	event: string;
	sessionId: string | null;
	prompt: string | null;
}

export type HookReply = Record<string, unknown>;

/** null を返すと応答は `{}` になる。 */
export type HookHandler = (req: HookRequest) => HookReply | null;

export interface HookEndpoint {
	url: string;
	token: string;
	dispose(): void;
}
