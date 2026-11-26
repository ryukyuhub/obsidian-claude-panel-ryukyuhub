import statusLineSource from "./bridge/status-line.ps1";
import { findPython } from "./pty-posix";
import { ensureTempScript, powershellPath } from "./pty-windows";

/**
 * 標準入力の JSON（claude の statusLine の入力）から「モデル名 · effort: 段階」の 1 行を出す。
 * sh の単一引用符に入れるので ASCII だけで書き、単一引用符を含めない。
 * 取れないとき・失敗したときは何も出さず、終了コードは 0。
 */
const PYTHON_SOURCE = [
	"import json,sys",
	"def text(node,*keys):",
	" for key in keys:",
	"  node=node.get(key) if isinstance(node,dict) else None",
	" if not isinstance(node,str):",
	"  return \"\"",
	" return \"\".join(c for c in node if c.isprintable()).strip()",
	"try:",
	" data=json.load(sys.stdin)",
	" model=text(data,\"model\",\"display_name\")",
	" effort=text(data,\"effort\",\"level\")",
	" if model:",
	"  sys.stdout.write(model+(\" \\u00b7 effort: \"+effort if effort else \"\")+\"\\n\")",
	"  sys.stdout.flush()",
	"except BaseException:",
	" pass",
].join("\n");

/**
 * sh と PowerShell のどちらの単一引用符の中にもそのまま書けるパス。
 * PowerShell は `'` のほか U+2018〜U+201B（‘ ’ ‚ ‛）も単一引用符として扱うので除く。
 * 制御文字と行・段落の区切り（U+2028 / U+2029）も除く。
 */
const SAFE_EXE_PATH = /^[A-Za-z]:[A-Za-z0-9_./-]*$/;
const SAFE_QUOTED_PATH = /^[^'\u2018-\u201B\p{Cc}\p{Zl}\p{Zp}]+$/u;

/**
 * claude の `statusLine` に渡すコマンド。作れない環境では null（statusLine を渡さない）。
 * `env` は claude に渡す環境（Python を探す PATH に使う）。例外は投げない。
 */
export async function buildStatusLineCommand(
	env: Record<string, string>
): Promise<string | null> {
	try {
		return process.platform === "win32"
			? await windowsCommand()
			: await posixCommand(env);
	} catch (e) {
		console.warn("[claude-panel] failed to prepare the status line", e);
		return null;
	}
}

// Python が無い（script 方式で動いている）ときは出さない
async function posixCommand(env: Record<string, string>): Promise<string | null> {
	const python = await findPython(env);
	if (!python) return null;
	return `${shQuote(python)} -I -S -X utf8 -c ${shQuote(PYTHON_SOURCE)}`;
}

/**
 * claude は Git Bash があれば Git Bash、無ければ PowerShell でコマンドを実行する。
 * 先頭は引用符なしの絶対パス、引数は単一引用符にして、どちらでも同じ意味になる形にする。
 */
async function windowsCommand(): Promise<string | null> {
	const exe = powershellPath().replace(/\\/g, "/");
	if (!SAFE_EXE_PATH.test(exe)) return null;
	const script = await ensureTempScript("claude-panel-statusline", statusLineSource);
	if (!SAFE_QUOTED_PATH.test(script)) return null;
	return (
		`${exe} -NoProfile -NonInteractive -ExecutionPolicy Bypass ` +
		`-File '${script}'`
	);
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
