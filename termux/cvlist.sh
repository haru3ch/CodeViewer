#!/data/data/com.termux/files/usr/bin/bash
# 置き場所のリポジトリと、最新コミットの日付・内容を一覧にする
ROOT="$(cat "$HOME/.config/codeviewer/root" 2>/dev/null || echo "$HOME/storage/shared/Documents/git")"
echo "置き場所: $ROOT"
find "$ROOT" -maxdepth 3 -name .git -prune 2>/dev/null | sort | while IFS= read -r gitdir; do
  repo="$(dirname "$gitdir")"
  sparse=""
  [ "$(git -C "$repo" config --get core.sparseCheckout)" = "true" ] && sparse="（一部: $(git -C "$repo" sparse-checkout list | tr '\n' ' ')）"
  echo "■ ${repo#"$ROOT"/} $sparse"
  git -C "$repo" log -1 --format='   %cd  %s' --date=format:'%Y-%m-%d %H:%M'
done
