#!/bin/sh
# Synthesise the six narration lines into "$1" (default /tmp/voice).
# A public TTS endpoint is used on purpose: this repository has no dependencies and
# should not grow one just to make a video. If the endpoint is unavailable, skip this
# step — the burned-in captions still carry the demo.
set -e
OUT="${1:-/tmp/voice}"
mkdir -p "$OUT"

say() {
  i="$1"; text="$2"
  enc=$(printf '%s' "$text" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))')
  curl -sS -m 30 -o "$OUT/line$i.mp3" "https://fanyi.baidu.com/gettts?lan=zh&text=$enc&spd=5&source=web"
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT/line$i.mp3" 2>/dev/null || echo 0)
  printf 'line %s  %ss  %s\n' "$i" "$dur" "$text"
}

say 1 "一个清单，跨所有会话。"
say 2 "每条待办都记着加入时间、原话，和它自己的步骤。"
say 3 "交给一个对话，不是一个链接，是带编号的计划。"
say 4 "Agent 说做完了，那只是声明。你点头，才算完成。"
say 5 "数据和你的代码一样，是一个 JSON 文件，能 diff，能进仓库。"
say 6 "装上它：dsh plugin add dsh-global-todo。"
