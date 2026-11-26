import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import bridgeSource from "./bridge/bridge.ps1";
import {
	clampSize,
	createPtySession,
	encodeFrame,
	writeInputFrames,
	writeResizeFrame,
	writeStdin,
	type PtyOutcome,
} from "./pty-process";
import type { PtyFailure, PtyHandlers, PtyLaunch, PtySession } from "./types";

const FRAME_START = 2;
const ERROR_PREFIX = "[pty-bridge]";

/** ConPTY ブリッジ（PowerShell）で起動する。 */
export async function openWindowsPty(
	launch: PtyLaunch,
	handlers: PtyHandlers
): Promise<PtySession> {
	const script = await ensureTempScript("claude-panel-pty-bridge", bridgeSource);
	const child = spawn(
		powershellPath(),
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
		{ env: bridgeEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
	);
	const session = createPtySession(
		{
			child,
			write: (data) => writeInputFrames(child, data),
			resize: (cols, rows) => writeResizeFrame(child, cols, rows),
			terminate: () => child.stdin.end(),
			forceKill: true,
			classify,
		},
		handlers
	);
	writeStdin(child, startFrame(launch));
	return session;
}

/** Windows PowerShell 5.1 の絶対パス。 */
export function powershellPath(): string {
	const root = process.env.SystemRoot || "C:\\Windows";
	return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// PowerShell 7 から継いだ PSModulePath があると 5.1 の標準コマンドが読めない。
// claude に渡す環境は起動フレームで別に送るので、ここで除いても影響しない。
function bridgeEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === "PSMODULEPATH") delete env[key];
	}
	return env;
}

function startFrame(launch: PtyLaunch): Buffer {
	const records = [
		`file=${launch.file}`,
		`cwd=${launch.cwd}`,
		`cols=${clampSize(launch.cols)}`,
		`rows=${clampSize(launch.rows)}`,
		...launch.args.map((arg) => `arg=${arg}`),
		...Object.entries(launch.env).map(([key, value]) => `env=${key}=${value}`),
	];
	return encodeFrame(FRAME_START, Buffer.from(records.join("\0"), "utf8"));
}

/**
 * PowerShell のスクリプトを一時フォルダへ `<prefix>-<hash>.ps1` として書き出す。
 * 同じ内容のファイルがあれば再利用する。
 */
export async function ensureTempScript(prefix: string, source: string): Promise<string> {
	// BOM が無いと PowerShell 5.1 は ANSI として読む。esbuild は BOM を残すので一度はがす
	const content = Buffer.from("\uFEFF" + source.replace(/^\uFEFF/, ""), "utf8");
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
	const file = path.join(os.tmpdir(), `${prefix}-${hash}.ps1`);
	if (await hasContent(file, content)) {
		// 使われ続けているファイルがストレージセンサーなどに古いものとして消されないよう、更新日時を新しくする
		const now = new Date();
		await fs.promises.utimes(file, now, now).catch(() => {});
		return file;
	}

	const temp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
	try {
		await fs.promises.writeFile(temp, content, { flag: "wx" });
		await fs.promises.rename(temp, file);
	} catch (e) {
		await fs.promises.unlink(temp).catch(() => {});
		// 同時に起動した別のパネルが先に書き終えていれば、それを使う
		if (!(await hasContent(file, content))) throw e;
	}
	return file;
}

async function hasContent(file: string, content: Buffer): Promise<boolean> {
	try {
		return (await fs.promises.readFile(file)).equals(content);
	} catch {
		return false;
	}
}

function classify({ code, outputBytes, stderr }: PtyOutcome): PtyFailure | null {
	const at = stderr.indexOf(ERROR_PREFIX);
	if (at >= 0) {
		const detail = stderr.slice(at + ERROR_PREFIX.length).trim();
		const isLaunch = /^(CreateProcess |file must be|batch file arguments)/.test(detail);
		return { kind: isLaunch ? "launch" : "bridge", detail };
	}
	// グループポリシーによる実行拒否など、スクリプトが始まる前の失敗
	if (outputBytes === 0 && code !== 0 && stderr) {
		return { kind: "bridge", detail: stderr };
	}
	return null;
}
