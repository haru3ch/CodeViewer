#!/data/data/com.termux/files/usr/bin/bash
# Termux で、コード読解リーダー用の git 操作を簡単にする設定。
#
# 使い方（Termux で1回だけ実行）:
#   curl -fsSL https://raw.githubusercontent.com/haru3ch/CodeViewer/main/termux/setup.sh -o setup.sh
#   bash setup.sh
#
# できるようになること:
#   ・ホーム画面のボタン（Termux:Widget）から、ワンタップで全部まとめて pull
#   ・ターミナルで短いコマンド: pullall / cvclone / cvlist
set -e

BASE="https://raw.githubusercontent.com/haru3ch/CodeViewer/main/termux"
BIN="$HOME/bin"
CONF="$HOME/.config/codeviewer"
mkdir -p "$BIN" "$CONF" "$HOME/.shortcuts"

echo "== 必要なものを入れます（git / curl）"
command -v git >/dev/null 2>&1 || pkg install -y git
command -v curl >/dev/null 2>&1 || pkg install -y curl

if [ ! -d "$HOME/storage/shared" ]; then
  echo "== 端末の共有フォルダを使えるようにします（許可を求められたら「許可」）"
  termux-setup-storage
  sleep 3
fi

# 端末の共有フォルダ上のリポジトリは、所有者の違いで git が警告を出して止まるので、許可しておく
git config --global --get-all safe.directory | grep -qx '\*' || git config --global --add safe.directory '*'
# pull はマージを作らず「進めるだけ」にする（読むだけの用途で事故を防ぐ）
git config --global pull.ff only

echo
echo "== clone したリポジトリを置くフォルダを決めます"
DEFAULT="$HOME/storage/shared/Documents/git"
[ -f "$CONF/root" ] && DEFAULT="$(cat "$CONF/root")"
read -r -p "フォルダ [$DEFAULT]: " ROOT
ROOT="${ROOT:-$DEFAULT}"
mkdir -p "$ROOT"
echo "$ROOT" > "$CONF/root"

echo "== スクリプトを入れます"
for f in pullall cvclone cvlist; do
  curl -fsSL "$BASE/$f.sh" -o "$BIN/$f"
  chmod +x "$BIN/$f"
done
# ホーム画面ボタン用（Termux:Widget は ~/.shortcuts の中身をボタンにする）
cp "$BIN/pullall" "$HOME/.shortcuts/全部pull"
chmod +x "$HOME/.shortcuts/全部pull"

grep -q 'HOME/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> "$HOME/.bashrc"

cat <<MSG

設定が終わりました。
  置き場所: $ROOT

  pullall                    … 置き場所の中のリポジトリを全部 pull
  cvclone <URL> [フォルダ…]   … 浅く clone（フォルダを指定するとそこだけ取り出す）
  cvlist                     … 置き場所のリポジトリと最新コミットを一覧

ホーム画面からワンタップで pull したいときは、F-Droid から「Termux:Widget」を入れて
ホーム画面にウィジェットを置き、「全部pull」を押してください。

※ 新しいコマンドは、Termux を一度閉じて開き直すと使えます。
MSG
