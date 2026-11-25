# script + stty による PTY (Python が無いときの代替)。POSIX sh。
#   /bin/sh -c <このソース> script-pty
#   stdin/stdout: 端末の生バイト   fd 3: "子のPID 端末名\n" を 1 行 (リサイズ用)
#   環境変数: PTYB_ROWS PTYB_COLS PTYB_CWD PTYB_ARGC PTYB_ARG0.. (引用符を組み立てないため環境変数で渡す)
PTYB_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ptyb.XXXXXX") || exit 125
export PTYB_DIR
PTYB_SHELL=${SHELL-}
export PTYB_SHELL
SHELL=/bin/sh              # util-linux の script -c は $SHELL で実行される
export SHELL
trap 'rm -rf "$PTYB_DIR"' EXIT

# 端末の中で動く部分
PTYB_INNER='
stty sane rows "$PTYB_ROWS" cols "$PTYB_COLS"
stty iutf8 2>/dev/null
PTYB_TTY=$(tty)
echo $$ >"$PTYB_DIR/pid.tmp" && mv "$PTYB_DIR/pid.tmp" "$PTYB_DIR/pid"
echo "$$ $PTYB_TTY" >&3
exec 3>&-
cd -- "$PTYB_CWD" || exit 126
set --
PTYB_I=0
while [ "$PTYB_I" -lt "$PTYB_ARGC" ]; do
	eval "set -- \"\$@\" \"\$PTYB_ARG$PTYB_I\"; unset PTYB_ARG$PTYB_I"
	PTYB_I=$((PTYB_I + 1))
done
if [ -n "$PTYB_SHELL" ]; then SHELL=$PTYB_SHELL; else unset SHELL; fi
unset SCRIPT PTYB_I PTYB_ARGC PTYB_CWD PTYB_ROWS PTYB_COLS PTYB_TTY PTYB_DIR PTYB_SHELL PTYB_INNER
exec "$@"
'
export PTYB_INNER

exec 4<&0 </dev/null
{
	# 入力の中継。本物のパイプを挟む (macOS の script はソケットや FIFO の stdin で落ちる)
	sh -c 'echo $$ >"$PTYB_DIR/cat"; exec cat' <&4 4<&- 3>&-
	# stdin が閉じた = 親が閉じたか死んだ。子が残っていれば片付ける
	# (起動直後に閉じると、端末側がまだ PID を書いていないことがある)
	PTYB_I=0
	while [ $PTYB_I -lt 100 ] && [ ! -f "$PTYB_DIR/rc" ] && [ ! -f "$PTYB_DIR/pid" ]; do
		sleep 0.05
		PTYB_I=$((PTYB_I + 1))
	done
	if [ ! -f "$PTYB_DIR/rc" ] && PTYB_P=$(cat "$PTYB_DIR/pid" 2>/dev/null); then
		kill -HUP -"$PTYB_P" 2>/dev/null
		kill -CONT -"$PTYB_P" 2>/dev/null
		PTYB_I=0
		while [ $PTYB_I -lt 20 ] && kill -0 "$PTYB_P" 2>/dev/null; do
			sleep 0.1
			PTYB_I=$((PTYB_I + 1))
		done
		kill -KILL -"$PTYB_P" 2>/dev/null
	fi
} 2>/dev/null | {
	exec 4<&-
	case $(uname -s) in
	Linux) script -qefc 'eval "$PTYB_INNER"' /dev/null ;;
	*) script -q /dev/null /bin/sh -c 'eval "$PTYB_INNER"' ;;
	esac
	PTYB_RC=$?
	echo $PTYB_RC >"$PTYB_DIR/rc"
	# 入力の中継を止める (script がすぐ終わると中継側がまだ PID を書いていないことがある)
	while [ ! -s "$PTYB_DIR/cat" ]; do sleep 0.05; done
	kill "$(cat "$PTYB_DIR/cat")" 2>/dev/null
	exit $PTYB_RC
}
PTYB_RC=$?
exit $PTYB_RC
