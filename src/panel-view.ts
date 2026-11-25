/** チャット UI とターミナル UI は同じ view type を共有し、設定でどちらかを作る。 */
export const VIEW_TYPE_CLAUDE_PANEL = "claude-panel-view";

/**
 * main.ts と設定タブが、UI の種類（チャット / ターミナル）を問わずに呼ぶ操作。
 * view.ts と terminal-view.ts の両方が実装する。循環 import を避けるため、
 * このファイルはビューの実装を import しない。
 */
export interface PanelView {
	focusInput(): void;
	applyFontSize(): void;
	applyComposerBottomPadding(): void;
	rebuildLocalizedUI(): void;
	testNotificationSound(): void;
	commandClear(): void;
	/** 中断する対象があれば true。 */
	commandCancel(): boolean;
	commandToggleIncludeActive(): void;
}
