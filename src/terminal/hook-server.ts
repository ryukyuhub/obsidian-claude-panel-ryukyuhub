import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as http from "http";
import type { AddressInfo, Socket } from "net";
import type { HookEndpoint, HookHandler, HookReply, HookRequest } from "./types";

const HOST = "127.0.0.1";
const MAX_BODY = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

interface Endpoint {
	tokenDigest: Buffer;
	handler: HookHandler;
}

/** claude の HTTP hook を受けるループバック限定のサーバー。 */
export class HookServer {
	private readonly endpoints = new Map<string, Endpoint>();
	private readonly sockets = new Set<Socket>();
	private server: http.Server | null = null;
	private listening: Promise<number> | null = null;
	private closed = false;

	/** 初回の呼び出しで待ち受けを始める。待ち受けに失敗したら reject する。 */
	async register(handler: HookHandler): Promise<HookEndpoint> {
		const port = await this.listen();
		if (this.closed) throw new Error("hook server is closed");
		const path = `/hook/${randomBytes(16).toString("hex")}`;
		const token = randomBytes(32).toString("hex");
		this.endpoints.set(path, { tokenDigest: sha256(token), handler });
		return {
			url: `http://${HOST}:${port}${path}`,
			token,
			dispose: () => {
				this.endpoints.delete(path);
			},
		};
	}

	/** 待ち受けをやめ、つながっている接続も切る。以後は register できない。例外は投げない。 */
	close(): void {
		this.closed = true;
		this.endpoints.clear();
		for (const socket of this.sockets) socket.destroy();
		this.server?.close();
	}

	private listen(): Promise<number> {
		if (this.closed) return Promise.reject(new Error("hook server is closed"));
		this.listening ??= this.startServer().catch((e: unknown) => {
			this.listening = null;
			throw e;
		});
		return this.listening;
	}

	private startServer(): Promise<number> {
		const options: http.ServerOptions = {
			requestTimeout: REQUEST_TIMEOUT_MS,
			headersTimeout: REQUEST_TIMEOUT_MS,
			// 上の 2 つの制限時間を確認する間隔（既定は 30 秒）
			connectionsCheckingInterval: 1000,
		};
		const server = http.createServer(options, (req, res) => this.handle(req, res));
		this.server = server;
		server.on("connection", (socket) => {
			if (this.closed) {
				socket.destroy();
				return;
			}
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			// 待ち受けの準備中に close された
			server.once("close", () => reject(new Error("hook server is closed")));
			server.listen(0, HOST, () => {
				server.off("error", reject);
				server.on("error", (e) => console.warn("[claude-panel] hook server error", e));
				// 準備中の close が待ち受けを止められていないことがある
				if (this.closed) server.close();
				resolve((server.address() as AddressInfo | null)?.port ?? 0);
			});
		});
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const endpoint = this.endpoints.get(req.url ?? "");
		const status = this.check(req, endpoint);
		if (status !== null || !endpoint) {
			reply(req, res, status ?? 404);
			return;
		}

		const chunks: Buffer[] = [];
		let received = 0;
		let rejected = false;
		req.on("error", () => {});
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			received += chunk.length;
			if (received > MAX_BODY) {
				rejected = true;
				chunks.length = 0;
				reply(req, res, 413);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (rejected) return;
			const request = parseRequest(Buffer.concat(chunks).toString("utf8"));
			if (!request) {
				reply(req, res, 400);
				return;
			}
			reply(req, res, 200, runHandler(endpoint.handler, request));
		});
	}

	/** 拒否するときの HTTP ステータス。問題なければ null。 */
	private check(req: http.IncomingMessage, endpoint: Endpoint | undefined): number | null {
		if (!isLoopback(req.socket.remoteAddress)) return 403;
		// ブラウザー経由の要求（DNS リバインディングや他サイトからの送信）を拒む
		if (req.headers.host !== `${HOST}:${req.socket.localPort}`) return 403;
		if (req.headers.origin !== undefined) return 403;
		if (req.method !== "POST") return 405;
		if (!endpoint) return 404;
		const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
		if (!match || !timingSafeEqual(sha256(match[1]), endpoint.tokenDigest)) return 401;
		if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return 413;
		return null;
	}
}

function sha256(text: string): Buffer {
	return createHash("sha256").update(text).digest();
}

function isLoopback(address: string | undefined): boolean {
	return address !== undefined && /^(::1$|(::ffff:)?127\.)/.test(address);
}

function parseRequest(body: string): HookRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { hook_event_name, session_id, prompt } = parsed as Record<string, unknown>;
	return {
		event: typeof hook_event_name === "string" ? hook_event_name : "",
		sessionId: typeof session_id === "string" ? session_id : null,
		prompt: typeof prompt === "string" ? prompt : null,
	};
}

function runHandler(handler: HookHandler, request: HookRequest): HookReply {
	try {
		return handler(request) ?? {};
	} catch (e) {
		console.warn("[claude-panel] hook handler failed", e);
		return {};
	}
}

/** `body` を省くと本文なしで返す。読み残した要求は捨てる。 */
function reply(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	status: number,
	body?: HookReply
): void {
	const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : Buffer.alloc(0);
	res.writeHead(status, {
		Connection: "close",
		"Content-Length": payload.length,
		...(body ? { "Content-Type": "application/json" } : {}),
	});
	res.end(payload);
	req.resume();
}
