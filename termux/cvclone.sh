#!/data/data/com.termux/files/usr/bin/bash
# 浅く clone する。フォルダを指定すると、そのフォルダだけを取り出す（sparse-checkout）。
#   cvclone https://github.com/user/repo.git
#   cvclone https://github.com/user/repo.git tools/foo docs
set -e
if [ -z "$1" ]; then
  echo "使い方: cvclone <URL> [取り出すフォルダ…]"; exit 1
fi
ROOT="$(cat "$HOME/.config/codeviewer/root" 2>/dev/null || echo "$HOME/storage/shared/Documents/git")"
URL="$1"; shift
NAME="$(basename "$URL" .git)"
cd "$ROOT"
if [ -d "$NAME" ]; then echo "$ROOT/$NAME はもうあります"; exit 1; fi
if [ $# -gt 0 ]; then
  git clone --depth 1 --filter=blob:none --sparse "$URL" "$NAME"
  git -C "$NAME" sparse-checkout set "$@"
else
  git clone --depth 1 "$URL" "$NAME"
fi
echo
echo "clone しました: $ROOT/$NAME"
echo "コード読解リーダーでは、このフォルダ（または中の読みたいフォルダ）を選んでください。"
