#!/data/data/com.termux/files/usr/bin/bash
# 置き場所の中のリポジトリを全部 pull する（読むだけ用。手元の変更があるものは飛ばす）
ROOT="$(cat "$HOME/.config/codeviewer/root" 2>/dev/null || echo "$HOME/storage/shared/Documents/git")"
[ -n "$1" ] && ROOT="$1"
ok=0; ng=0
echo "置き場所: $ROOT"
while IFS= read -r gitdir; do
  repo="$(dirname "$gitdir")"
  name="${repo#"$ROOT"/}"
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "⚠ $name: 手元に変更があるので飛ばしました"; ng=$((ng + 1)); continue
  fi
  before="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null)"
  if out="$(git -C "$repo" pull --ff-only 2>&1)"; then
    after="$(git -C "$repo" rev-parse --short HEAD)"
    if [ "$before" = "$after" ]; then echo "✓ $name: 最新です"; else echo "↓ $name: 更新しました ($before → $after)"; fi
    ok=$((ok + 1))
  else
    echo "✗ $name: 失敗しました"; echo "$out" | tail -n 3 | sed 's/^/    /'; ng=$((ng + 1))
  fi
done < <(find "$ROOT" -maxdepth 3 -name .git -prune 2>/dev/null | sort)
echo
echo "完了: 成功 $ok 件 / 失敗・スキップ $ng 件"
# ホーム画面ボタンから開いたときに結果が見えるよう、すぐには閉じない
if [ -z "$PS1" ] && [ -t 0 ]; then read -r -p "Enter で閉じます" _; fi
