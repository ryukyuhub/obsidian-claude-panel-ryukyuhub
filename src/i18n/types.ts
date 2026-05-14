import type { ja } from "./ja";

// 日本語辞書を「単一の真実」として、英語辞書はこの shape を必ず満たす。
export type Messages = typeof ja;
