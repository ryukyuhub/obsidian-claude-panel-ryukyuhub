import { type App, normalizePath } from "obsidian";
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { ChatMessage, MessageUsage } from "./chat-message";

/**
 * チャットの永続化（Obsidian 再起動を跨いで会話を保持する）。
 * 保存先: .obsidian/plugins/<id>/chat.json
 *
 * view からは状態を入れた snapshot を渡し、ロード時は snapshot を返す
 * 単純な I/O モジュール。失敗時は警告だけ出して握りつぶす（UI を
 * ブロックしない）— 既存挙動の踏襲。
 */
export interface ChatSnapshot {
	messages: ChatMessage[];
	attachments: string[];
	draft: string;
	lastUsage: MessageUsage | null;
	currentSessionId: string | null;
}

export function chatStatePath(app: App, pluginId: string): string {
	return normalizePath(
		`${app.vault.configDir}/plugins/${pluginId}/chat.json`
	);
}

export async function saveChat(
	app: App,
	pluginId: string,
	snap: ChatSnapshot
): Promise<void> {
	try {
		const persisted = {
			version: 1,
			// interactive メッセージ（スラッシュコマンドの UI 出力等）は
			// コールバック関数を含むためシリアライズできない上、そもそも
			// 一時的なものなので保存対象から除外する。
			messages: snap.messages
				.filter((m) => !m.interactive)
				.map((m) => ({
					id: m.id,
					role: m.role,
					parts: m.parts,
					mentions: m.mentions,
					selectionRef: m.selectionRef,
					result: m.result,
					inputText: m.inputText,
					usage: m.usage,
				})),
			attachments: snap.attachments,
			draft: snap.draft,
			lastUsage: snap.lastUsage,
			currentSessionId: snap.currentSessionId,
		};
		await app.vault.adapter.write(
			chatStatePath(app, pluginId),
			JSON.stringify(persisted)
		);
	} catch {
		/* ベストエフォート永続化 — ディスクエラーで UI をブロックしない */
	}
}

export async function loadChat(
	app: App,
	pluginId: string
): Promise<Partial<ChatSnapshot> | null> {
	const adapter = app.vault.adapter;
	const path = chatStatePath(app, pluginId);
	try {
		if (!(await adapter.exists(path))) return null;
		const raw = await adapter.read(path);
		const data = JSON.parse(raw) as {
			messages?: ChatMessage[];
			attachments?: string[];
			draft?: string;
			lastUsage?: MessageUsage;
			currentSessionId?: string | null;
		};

		const out: Partial<ChatSnapshot> = {};

		if (Array.isArray(data.messages)) {
			out.messages = data.messages.map((m) => ({
				...m,
				streaming: false,
				// 前回保存時に pending のままだったパーミッションカードは
				// もう古い（発行元の agent ランは消滅している）ので、
				// denied 表示で復元する。
				parts: m.parts.map((p) =>
					p.type === "permission" && p.status === "pending"
						? { ...p, status: "denied" as const }
						: p
				),
			}));
		}
		if (typeof data.currentSessionId === "string") {
			out.currentSessionId = data.currentSessionId;
		}
		if (Array.isArray(data.attachments)) {
			// 既に存在しないパスは除去する（前回 unload 時にクリップボード
			// 画像が削除されているケース等）。Vault 相対パスは Obsidian の
			// adapter で、OS の絶対パスは Node の fs で存在確認する。
			const live: string[] = [];
			for (const p of data.attachments) {
				const exists = nodePath.isAbsolute(p)
					? nodeFs.existsSync(p)
					: await adapter.exists(p);
				if (exists) live.push(p);
			}
			out.attachments = live;
		}
		if (typeof data.draft === "string") {
			out.draft = data.draft;
		}
		if (data.lastUsage) {
			out.lastUsage = data.lastUsage;
		}
		return out;
	} catch {
		/* ファイル破損 — 新規状態で開始し、ユーザーには通知しない */
		return null;
	}
}
