#!/bin/sh
# Assemble the demo: trim the recording, burn captions, place the narration, add a quiet
# pad and an end card. Usage: render.sh <record-dir> <voice-dir> <out.mp4>
set -e
REC="${1:-/tmp/demo-rec}"
VOICE="${2:-/tmp/voice}"
OUT="${3:-docs/screenshots/demo.mp4}"
FONT="${FONT:-/usr/share/fonts/opentype/noto/NotoSansSC-Medium.otf}"

# Where each scene starts in the recording, in seconds (printed by record.mjs), minus
# TRIM. Narration and captions are placed against these numbers.
TRIM=4.6
END=35.1
S1=0.4; S2=3.4; S3=9.4; S4=15.4; S5=20.8; S6=30.9

cd "$REC"

ffmpeg -loglevel error -y -f lavfi -i "color=c=0x0c0f13:s=1440x900:d=3:r=30" \
  -vf "format=yuv420p,drawtext=fontfile=$FONT:text='全局待办':fontcolor=0xe9edf3:fontsize=76:x=(w-text_w)/2:y=h/2-170,\
drawtext=fontfile=$FONT:text='跨会话一份清单 · 人和 Agent 读写同一份':fontcolor=0x9aa4b2:fontsize=30:x=(w-text_w)/2:y=h/2-40,\
drawtext=fontfile=$FONT:text='dsh plugin add dsh-global-todo':fontcolor=0x8fb0ff:fontsize=34:x=(w-text_w)/2:y=h/2+60,\
drawtext=fontfile=$FONT:text='lugabeeee.github.io/dsh-global-todo':fontcolor=0x9aa4b2:fontsize=26:x=(w-text_w)/2:y=h/2+130" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p endcard.mp4

ffmpeg -loglevel error -y -ss "$TRIM" -t "$END" -i "$(ls page@*.webm | head -1)" -i "$VOICE/mix.wav" -i endcard.mp4 \
  -filter_complex "[0:v]fps=30,scale=1440:900,format=yuv420p,setpts=PTS-STARTPTS,\
drawtext=fontfile=$FONT:text='跨会话一份清单':fontcolor=white:fontsize=26:box=1:boxcolor=0x000000@0.55:boxborderw=12:x=60:y=h-96:enable='between(t,$S1,3.4)',\
drawtext=fontfile=$FONT:text='加入时间 · 原话 · 步骤':fontcolor=white:fontsize=26:box=1:boxcolor=0x000000@0.55:boxborderw=12:x=60:y=h-96:enable='between(t,$S2,9.2)',\
drawtext=fontfile=$FONT:text='交给一个对话：不是一个链接':fontcolor=white:fontsize=26:box=1:boxcolor=0x000000@0.55:boxborderw=12:x=60:y=h-96:enable='between(t,$S3,14.8)',\
drawtext=fontfile=$FONT:text='Agent 说完成，那只是声明':fontcolor=white:fontsize=26:box=1:boxcolor=0x000000@0.55:boxborderw=12:x=60:y=h-96:enable='between(t,$S4,20.6)',\
drawtext=fontfile=$FONT:text='数据是一个 JSON 文件':fontcolor=white:fontsize=26:box=1:boxcolor=0x000000@0.55:boxborderw=12:x=60:y=h-96:enable='between(t,$S5,30.6)',\
drawtext=fontfile=$FONT:text='dsh plugin add dsh-global-todo':fontcolor=white:fontsize=26:box=1:boxcolor=0x000000@0.55:boxborderw=12:x=60:y=h-96:enable='between(t,$S6,$END)'[v0];\
[2:v]fps=30,format=yuv420p,setpts=PTS-STARTPTS[endv];\
[v0][endv]xfade=transition=fade:duration=0.5:offset=34.6,format=yuv420p[vout];\
[1:a]atrim=duration=38.0,afade=t=out:st=36.4:d=1.6[aout]" \
  -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 176k -shortest demo.mp4

cp demo.mp4 "$OUT"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
