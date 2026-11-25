# PTY ブリッジ (macOS / Linux, Python 3.8+, 標準ライブラリのみ)
#   python3 -I -S -u -X utf8 -c <このソース> COLS ROWS CWD CMD [ARG...]
#   stdin : [type:u8][len:u32 LE][payload]  type 0=入力, 1=リサイズ(cols:u16, rows:u16)
#   stdout: PTY 出力の生バイト / stderr: ブリッジ自身のエラーだけ
#   終了コード: 子の終了コード (シグナルは 128+n)。125=ブリッジの失敗, 126/127=起動失敗
# PTY_BRIDGE_ENV に親の環境変数名を改行区切りで渡すと、python3 や xcrun が足した変数を子に渡さない。
import errno, fcntl, os, select, signal, struct, sys, termios, time

CHUNK = 65536
LIMIT = 262144       # これを超えて溜まったら読むのを止める (背圧)
TAIL = 1 << 20       # 子の終了後に読む上限 (孫が出力し続ける場合の打ち切り)
MAX_FRAME = 1 << 26
GRACE = 2.0          # SIGHUP から SIGKILL までの猶予 (秒)
IUTF8 = 0x4000       # Linux / macOS 共通 (古い termios モジュールには定数がない)


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ,
                struct.pack("HHHH", max(rows, 1), max(cols, 1), 0, 0))


def child_env():
    env = dict(os.environb)
    keys = env.pop(b"PTY_BRIDGE_ENV", None)
    if keys is not None:
        allowed = set(keys.split(b"\n"))
        env = {k: v for k, v in env.items() if k in allowed}
    return env


def exec_child(cols, rows, cwd, argv, env, ready):
    code, where = 126, cwd
    try:
        # python が無視に変えたシグナルを戻す (SIG_IGN は exec 後も残る)
        for name in ("SIGPIPE", "SIGXFSZ", "SIGHUP", "SIGINT", "SIGQUIT",
                     "SIGTERM", "SIGCHLD"):
            signal.signal(getattr(signal, name), signal.SIG_DFL)
        signal.set_wakeup_fd(-1)
        set_size(0, cols, rows)
        os.close(ready)
        attr = termios.tcgetattr(0)
        attr[0] |= IUTF8
        termios.tcsetattr(0, termios.TCSANOW, attr)
        os.chdir(cwd)
        env[b"PWD"] = cwd
        where = argv[0]
        os.execvpe(argv[0], argv, env)
    except OSError as e:
        if where == argv[0] and e.errno == errno.ENOENT:
            code = 127
        msg = e.strerror or str(e)
    except BaseException as e:
        msg = str(e)
    os.write(2, b"pty-bridge: " + where + b": " + msg.encode("utf-8", "replace") + b"\n")
    os._exit(code)


def hung_up(fd):
    """読まずに相手の切断だけを調べる。"""
    p = select.poll()
    # macOS の poll は events に POLLHUP が無いと切断を返さない
    p.register(fd, select.POLLHUP | getattr(select, "POLLRDHUP", 0))
    return bool(p.poll(0))


def kill_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
        return True
    except OSError:
        return False


class Bridge:
    stop = False                    # シグナルによる終了要求

    def __init__(self, pid, master, wake_r):
        self.pid, self.master, self.wake_r = pid, master, wake_r
        self.ppid = os.getppid()
        self.frames = bytearray()   # 未解釈の stdin
        self.inbuf = bytearray()    # 子への入力待ち
        self.outbuf = bytearray()   # 親への出力待ち
        self.stdin_open = self.out_ok = self.master_open = True
        self.code = None            # 子の終了コード (回収後)
        self.tail = 0               # 回収後に読んだバイト数
        self.closing = None         # 終了処理を始めた時刻
        self.killed = False

    def parse(self):
        buf = self.frames
        while len(buf) >= 5:
            size = struct.unpack_from("<I", buf, 1)[0]
            if size > MAX_FRAME:
                raise ValueError("frame too large: %d" % size)
            if len(buf) < 5 + size:
                return
            if buf[0] == 0:
                self.inbuf += buf[5:5 + size]
            elif buf[0] == 1 and size >= 4 and self.master_open:
                cols, rows = struct.unpack_from("<HH", buf, 5)
                try:
                    set_size(self.master, cols, rows)
                except OSError:
                    pass
            del buf[:5 + size]

    def read_stdin(self):
        try:
            data = os.read(0, CHUNK)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b""
        if data:
            self.frames += data
            self.parse()
        else:
            self.stdin_open = False
            self.begin_close()

    def read_master(self):
        try:
            data = os.read(self.master, CHUNK)
        except (BlockingIOError, InterruptedError):
            return
        except OSError as e:
            if e.errno != errno.EIO:    # Linux は EOF を EIO で返す
                raise
            data = b""
        if not data:
            self.master_open = False
            self.inbuf.clear()
            return
        if self.code is not None:
            self.tail += len(data)
        # 終了処理中に親が読まなければ捨てる (子の終了を出力待ちで止めないため)
        if self.out_ok and len(self.outbuf) < LIMIT:
            self.outbuf += data

    def write_master(self):
        try:
            del self.inbuf[:os.write(self.master, self.inbuf[:CHUNK])]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            self.inbuf.clear()

    def write_stdout(self):
        try:
            del self.outbuf[:os.write(1, self.outbuf[:CHUNK])]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            self.out_ok = False
            self.outbuf.clear()
            self.begin_close()

    def reap(self):
        if self.code is None:
            pid, st = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.code = (os.WEXITSTATUS(st) if os.WIFEXITED(st)
                             else 128 + os.WTERMSIG(st))

    def signal_child(self, sig):
        # 前面ジョブが別のプロセスグループのこともある (bash など)
        groups = {self.pid}
        try:
            groups.add(os.tcgetpgrp(self.master))
        except OSError:
            pass
        for g in groups:
            if g > 1:
                kill_group(g, sig)

    def begin_close(self):
        if self.closing is None:
            self.closing = time.monotonic()
            self.signal_child(signal.SIGHUP)
            self.signal_child(signal.SIGCONT)

    def finished(self, idle):
        """ループを抜けてよいか。idle は子の出力が途切れたかどうか。"""
        if self.closing is not None:
            past = time.monotonic() - self.closing
            alive = self.code is None or kill_group(self.pid, 0)
            if past > GRACE and alive and not self.killed:
                self.killed = True
                self.signal_child(signal.SIGKILL)
            if past > GRACE + 1.5:
                return True
            if alive:
                return False
        elif self.code is None:
            return False
        # 子は終了済み。出力を流し切る (孫が端末を掴んだままなら途切れた時点で打ち切る)
        if self.master_open and not idle and self.tail < TAIL:
            return False
        return not self.outbuf

    def run(self):
        while True:
            full = len(self.outbuf) >= LIMIT
            want_master = (self.master_open and self.tail < TAIL
                           and (not full or self.closing is not None))
            rfds = [self.wake_r]
            if want_master:
                rfds.append(self.master)
            if self.stdin_open and len(self.inbuf) < LIMIT:
                rfds.append(0)
            elif self.stdin_open and hung_up(0):
                self.stdin_open = False     # 入力が詰まって読めない間の切断
                self.begin_close()
            wfds = []
            if self.inbuf and self.master_open:
                wfds.append(self.master)
            if self.outbuf:
                wfds.append(1)
            busy = self.closing is not None or self.code is not None
            r, w, _ = select.select(rfds, wfds, [], 0.1 if busy else 1.0)
            if self.wake_r in r:
                os.read(self.wake_r, 512)
            if self.stop or os.getppid() != self.ppid:
                self.begin_close()      # 終了要求 / 親が死んだ
            if 1 in w:
                self.write_stdout()
            if self.master in r:
                self.read_master()
            if 0 in r:
                self.read_stdin()
            if self.master in w and self.inbuf:
                self.write_master()
            reaped = self.code is not None
            self.reap()
            idle = reaped and want_master and not r and not w
            if self.finished(idle):
                break
        os.close(self.master)           # 残った前面ジョブへはカーネルが SIGHUP を送る
        return 129 if self.code is None else self.code


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cwd = os.fsencode(sys.argv[3])
    argv = [os.fsencode(a) for a in sys.argv[4:]]
    env = child_env()
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w, warn_on_full_buffer=False)

    def on_stop(*_):
        Bridge.stop = True

    signal.signal(signal.SIGCHLD, lambda *_: None)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_stop)
    ready_r, ready_w = os.pipe()
    pid, master = os.forkpty()
    if pid == 0:
        exec_child(cols, rows, cwd, argv, env, ready_w)
    # 子が最初の寸法を設定するまで待つ (先に届いたリサイズを上書きさせない)
    os.close(ready_w)
    os.read(ready_r, 1)
    os.close(ready_r)
    os.set_blocking(master, False)
    os.set_blocking(1, False)
    return Bridge(pid, master, wake_r).run()


if __name__ == "__main__":
    try:
        rc = main()
    except BaseException as e:
        try:
            os.write(2, ("pty-bridge: %s: %s\n" % (type(e).__name__, e)).encode("utf-8", "replace"))
        except OSError:
            pass
        rc = 125
    os._exit(rc)
