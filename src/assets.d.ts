// esbuild の text ローダーで文字列として取り込むファイル（esbuild.config.mjs の loader）。

declare module "*.ps1" {
	const source: string;
	export default source;
}

declare module "*.py" {
	const source: string;
	export default source;
}

declare module "*.sh" {
	const source: string;
	export default source;
}
