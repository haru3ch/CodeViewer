#!/bin/bash
# Finder でダブルクリックすると起動する（初回は右クリック→「開く」が必要なことがあります）
cd "$(dirname "$0")"
exec python3 serve.py "$@"
