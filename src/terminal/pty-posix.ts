import { execFile, spawn, type ExecFileOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pythonSource from "./bridge/bridge.py";
import scriptSource from "./bridge/script-pty.sh";
import {
	clampSize,
	createPtySession,
	writeInputFrames,
	writeResizeFrame,
	writeStdin,
	type PtyOutcome,
} from "./pty-process";
import {
	PtyUnavailableError,
	type PtyFailure,
	type PtyHandlers,
	type PtyLaunch,
	type PtySession,
} from "./types";

type Env = Record<string, string>;

/** Python ブリッジ、無ければ script で起動する。 */
export async function openPosixPty(
	launch: PtyLaunch,
	handlers: PtyHandlers
): Promise<PtySession> {
	const python = await findPython(launch.env);
	if (python) return openWithPython(python, launch, handlers);
	if (await hasScript(launch.env)) return openWithScript(launch, handlers);
	throw new PtyUnavailableError("neither python3 (3.8+) nor script is available");
}

// ---- Python ブリッジ ----

function openWithPython(
	python: string,
	launch: PtyLaunch,
	handlers: PtyHandlers
): PtySession {
	const child = spawn(
		python,
		[
			"-I", "-S", "-u", "-X", "utf8", "-c", pythonSource,
			String(clampSize(launch.cols)),
			String(clampSize(launch.rows)),
			launch.cwd,
			launch.file,
			...launch.args,
		],
		{
			// python3 や xcrun が足す変数を claude に渡さないため、元の変数名を教える
			env: { ...launch.env, PTY_BRIDGE_ENV: Object.keys(launch.env).join("\n") },
			stdio: ["pipe", "pipe", "pipe"],
		}
	);
	// キャッシュした Python が更新などで消えていたら、次は探し直す
	child.once("error", () => {
		pythonPath = null;
	});
	return createPtySession(
		{
			child,
			write: (data) => writeInputFrames(child, data),
			resize: (cols, rows) => writeResizeFrame(child, cols, rows),
			terminate: () => child.stdin.destroy(),
			forceKill: true,
			// 126 / 127（claude を起動できない）の理由は端末に出るので、通常の終了として扱う
			classify: ({ code, stderr }) =>
				code === 125 && stderr ? { kind: "bridge", detail: stderr } : null,
		},
		handlers
	);
}

const PYTHON_CHECK =
	"import os,sys,termios,fcntl;" +
	"sys.exit(0 if sys.version_info>=(3,8) and hasattr(os,'forkpty') else 1)";

const MAC_PYTHONS = [
	"/Library/Developer/CommandLineTools/usr/bin/python3",
	"/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
	"/opt/homebrew/bin/python3",
	"/usr/local/bin/python3",
	"/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
];

/** 見つかった Python。見つからなかった結果は残さない（後から入れて再試行できる）。 */
let pythonPath: Promise<string | null> | null = null;

/** PTY のブリッジに使う Python（3.8 以降）の絶対パス。見つからなければ null。 */
export function findPython(env: Env): Promise<string | null> {
	pythonPath ??= detectPython(env).then((found) => {
		if (!found) pythonPath = null;
		return found;
	});
	return pythonPath;
}

async function detectPython(env: Env): Promise<string | null> {
	for (const candidate of await pythonCandidates(env)) {
		if (!(await isExecutable(candidate))) continue;
		if (await succeeds(candidate, ["-I", "-S", "-c", PYTHON_CHECK], env)) {
			return candidate;
		}
	}
	return null;
}

async function pythonCandidates(env: Env): Promise<string[]> {
	if (process.platform !== "darwin") {
		const dirs = [...pathDirs(env), "/usr/bin", "/usr/local/bin"];
		return [...new Set(dirs.map((dir) => path.join(dir, "python3")))];
	}
	// 開発ツールが無い Mac の /usr/bin/python3 は、実行するとインストールを促す画面を出す
	const hasDevTools = await succeeds("/usr/bin/xcode-select", ["-p"], env);
	return hasDevTools ? [...MAC_PYTHONS, "/usr/bin/python3"] : MAC_PYTHONS;
}

// ---- script ----

function openWithScript(launch: PtyLaunch, handlers: PtyHandlers): PtySession {
	const argv = [launch.file, ...launch.args];
	const env: Env = {
		...launch.env,
		PTYB_ROWS: String(clampSize(launch.rows)),
		PTYB_COLS: String(clampSize(launch.cols)),
		PTYB_CWD: launch.cwd,
		PTYB_ARGC: String(argv.length),
	};
	argv.forEach((arg, i) => {
		env[`PTYB_ARG${i}`] = arg;
	});
	const child = spawn("/bin/sh", ["-c", scriptSource, "script-pty"], {
		env,
		stdio: ["pipe", "pipe", "pipe", "pipe"],
	});

	// リサイズは端末名が分かってから 1 つずつ行い、待ち中の要求は最後のものだけ残す
	let tty: string | null = null;
	let wanted: { cols: number; rows: number } | null = null;
	let resizing = false;
	let ended = false;
	const applySize = (): void => {
		if (!tty || !wanted || resizing || ended) return;
		const { cols, rows } = wanted;
		wanted = null;
		resizing = true;
		execFile(
			"/bin/sh",
			["-c", 'exec stty rows "$1" cols "$2" <"$3"', "sh", String(rows), String(cols), tty],
			{ env: launch.env },
			() => {
				resizing = false;
				applySize();
			}
		);
	};
	// 終了後の端末名は別のプロセスに再利用されるので触らない
	child.once("exit", () => {
		ended = true;
	});
	let info = "";
	child.stdio[3]?.on("data", (chunk: Buffer) => {
		info += chunk.toString("utf8");
		const match = /^\d+ (\S+)\n/.exec(info);
		if (!match) return;
		tty = match[1];
		applySize();
	});

	return createPtySession(
		{
			child,
			write: (data) => writeStdin(child, data),
			resize: (cols, rows) => {
				wanted = { cols, rows };
				applySize();
			},
			terminate: () => {
				ended = true;
				child.stdin?.destroy();
			},
			// stdin が閉じたら自分で後始末をする。シグナルで落とすと claude が残る
			forceKill: false,
			classify: classifyScript,
		},
		handlers
	);
}

// claude を起動できない理由は端末（stdout）に出る。stderr に書くのは、作業フォルダを
// 作れない（125）か script 自体を実行できない（126 / 127）とき。
function classifyScript({ code, outputBytes, stderr }: PtyOutcome): PtyFailure | null {
	const failed = code !== null && code >= 125 && code <= 127;
	return failed && outputBytes === 0 && stderr
		? { kind: "bridge", detail: stderr }
		: null;
}

async function hasScript(env: Env): Promise<boolean> {
	for (const dir of pathDirs(env)) {
		if (await isExecutable(path.join(dir, "script"))) return true;
	}
	return false;
}

// ---- 共通 ----

/** PATH のうち絶対パスのディレクトリ（相対だと Vault 内の実行ファイルを拾いうる）。 */
function pathDirs(env: Env): string[] {
	return (env.PATH ?? "").split(":").filter((dir) => path.isAbsolute(dir));
}

async function isExecutable(file: string): Promise<boolean> {
	try {
		await fs.promises.access(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function succeeds(file: string, args: string[], env: Env): Promise<boolean> {
	const options: ExecFileOptions = { env, timeout: 3000 };
	return new Promise((resolve) => {
		execFile(file, args, options, (error) => resolve(error === null));
	});
}
