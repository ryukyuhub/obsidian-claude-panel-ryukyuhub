import type { EffortLevel, ThinkingMode } from "./settings";

/**
 * チャットメッセージのデータモデルと、parts 配列を in-place で組み立てる
 * 純粋関数群。DOM 描画は `chat-message-render.ts` に分離している。
 *
 * 「型のためだけに ChatMessage を import したい」モジュール
 * （context-meter.ts など）が描画コードを引き込まずに済むよう、
 * obsidian の依存はこのファイルから外している。
 */

export type PermissionStatus = "pending" | "approved" | "denied";

export type Part =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; input: unknown }
	| {
			type: "permission";
			toolName: string;
			input: unknown;
			toolUseId: string;
			status: PermissionStatus;
			// CLI が提供する任意の理由文（例: Bash コマンドが拒否された
			// 経緯など）。承認カードに表示してユーザーが判断材料にできる。
			reason?: string;
	  };

/** 承認 UI からユーザーが返す判定の型。SDK の PermissionResult と同じ
 *  形状にしているため、agent 層がそのまま転送できる。 */
export type PermissionDecision =
	| { allow: true }
	| { allow: false; message?: string };

export interface RunResult {
	durationMs: number;
	costUsd?: number;
	/** CLI が解決した実モデルの正規 ID（例 `claude-opus-4-8`）。フッター表示用。 */
	model?: string;
}

export interface SelectionRef {
	filePath: string | null;
	startLine: number;
	lineCount: number;
}

export interface MessageUsage {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	parts: Part[];
	streaming?: boolean;
	interactive?: (container: HTMLElement) => void;
	result?: RunResult;
	// 自動／手動で添付されたファイルがあるユーザーメッセージ向け。
	// メッセージ本文の先頭に "@path @path …" を並べる代わりに、
	// チップ（Mention chip）として描画する。
	mentions?: string[];
	// 選択テキストへの参照。本文をバブルに丸ごと貼らず、コンパクトな
	// pill として表示し、何を参照したかだけを示す。選択範囲の本文自体は
	// プロンプト内で claude に送られている。
	selectionRef?: SelectionRef;
	// ユーザーメッセージ専用: 入力された生テキスト。プロンプト履歴
	// ナビゲーション（textarea 内の Up/Down キー）で使う。
	inputText?: string;
	// ユーザーメッセージ専用: 送信時に有効だった thinking mode。
	// バブル本文には混ぜず、役割ラベル横の小さなバッジとして表示する。
	thinkingMode?: ThinkingMode;
	// ユーザーメッセージ専用: 送信時に有効だった effort レベル。
	// `auto` のときは保存しない。役割ラベル横にバッジ表示する。
	effortLevel?: EffortLevel;
	// ユーザーメッセージ専用: 送信時に選択されていたモデル（エイリアスまたは
	// フル ID）。effort と違い「未指定」状態がないため常に保存し、役割ラベル
	// 横にバッジ表示する。アシスタント側フッターの model が CLI の解決後の
	// 実モデルなのに対し、こちらは送信時のリクエスト値。
	model?: string;
	// アシスタントメッセージ専用: ユーザーが割り込みで中断したターン。
	// 部分応答はそのまま残し、role 行の横に「中断」バッジを出すための
	// 描画用フラグ。`runtime.inject()` 発火時に true がセットされる。
	interrupted?: boolean;
	// アシスタントメッセージ専用: 当該ターンのトークン使用量。
	// メッセージ単位で保持することで、セッション累計メーターが
	// リロードを跨いでも復元できるようにしている。
	usage?: MessageUsage;
}

let _msgCounter = 0;
export function nextMsgId(): string {
	return `m${Date.now()}_${_msgCounter++}`;
}

/**
 * メッセージの parts にテキストチャンクを追記する。末尾が text part なら
 * そこに連結し、そうでなければ新しい text part を開く。
 */
export function appendText(parts: Part[], chunk: string): void {
	const last = parts[parts.length - 1];
	if (last && last.type === "text") {
		last.text += chunk;
	} else {
		parts.push({ type: "text", text: chunk });
	}
}

export function pushTool(parts: Part[], name: string, input: unknown): void {
	parts.push({ type: "tool", name, input });
}

export function pushPermission(
	parts: Part[],
	toolName: string,
	input: unknown,
	toolUseId: string,
	reason?: string
): void {
	parts.push({
		type: "permission",
		toolName,
		input,
		toolUseId,
		status: "pending",
		reason,
	});
}

/** pending 状態のパーミッション part を in-place で書き換える。見つかれば true を返す。 */
export function setPermissionStatus(
	parts: Part[],
	toolUseId: string,
	status: PermissionStatus
): boolean {
	for (const p of parts) {
		if (p.type === "permission" && p.toolUseId === toolUseId) {
			p.status = status;
			return true;
		}
	}
	return false;
}
