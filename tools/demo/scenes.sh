#!/bin/sh
set -e
FONT=/data/agent/.fonts/NotoSansSC-Medium.otf
IN=/tmp/film
OUT=/tmp/film/build
rm -rf "$OUT"; mkdir -p "$OUT"
BG=0x0b0e13
CARD_BG=0x0f141a
INK=0xe9edf3
MUTED=0x9aa4b2
ACCENT=0x8fb0ff
BORDER=0x252d38

# Wide stills only: the same 1180x940 window for every product shot, letterboxed.
norm () {
  ffmpeg -loglevel error -y -i "$IN/$1" \
    -vf "scale=1180:940:force_original_aspect_ratio=decrease:flags=lanczos,pad=1180:940:(ow-iw)/2:(oh-ih)/2:color=$CARD_BG" \
    -frames:v 1 "$OUT/$2"
}
norm s1-list.png c-list.png
norm s4-review.png c-review.png
norm s5-frame.png c-file.png

# Product scene: still on the left, three lines of copy on the right.
scene () {
  name="$1"; img="$2"; dur="$3"; kicker="$4"; head="$5"; body="$6"
  ffmpeg -loglevel error -y -loop 1 -t "$dur" -i "$OUT/$img" -f lavfi -t "$dur" -i "color=c=$BG:s=1920x1080:r=30" \
    -filter_complex "\
[0:v]scale=w='1180*(1+0.0018*t)':h=-1:eval=frame:flags=lanczos,pad=iw+2:ih+2:1:1:color=$BORDER[card];\
[1:v][card]overlay=x='40+(1200-overlay_w)/2':y='(H-overlay_h)/2'[base];\
[base]drawbox=x=1340:y=430:w='44*(min(t/0.5,1))':h=3:color=$ACCENT@1:t=fill,\
drawtext=fontfile=$FONT:text='$kicker':fontcolor=$MUTED:fontsize=19:x=1340:y=452:alpha='if(lt(t,0.45),t/0.45,1)',\
drawtext=fontfile=$FONT:text='$head':fontcolor=$INK:fontsize=46:x=1340:y='500-16*(1-min(t/0.6,1))':alpha='if(lt(t,0.55),t/0.55,1)',\
drawtext=fontfile=$FONT:text='$body':fontcolor=$MUTED:fontsize=22:x=1342:y='590-12*(1-min(t/0.8,1))':alpha='if(lt(t,0.8),t/0.8,1)'[v]" \
    -map "[v]" -r 30 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "$OUT/$name.mp4"
  echo "scene $name $dur s"
}

# Statement scene: no product shot, one sentence held still. Type is the narrator.
statement () {
  name="$1"; dur="$2"; kicker="$3"; head="$4"; sub="$5"
  ffmpeg -loglevel error -y -f lavfi -t "$dur" -i "color=c=$BG:s=1920x1080:r=30" \
    -vf "drawbox=x=180:y='460-8*(1-min(t/0.5,1))':w='60*(min(t/0.55,1))':h=3:color=$ACCENT@1:t=fill,\
drawtext=fontfile=$FONT:text='$kicker':fontcolor=$MUTED:fontsize=20:x=180:y='492-10*(1-min(t/0.6,1))':alpha='if(lt(t,0.5),t/0.5,1)',\
drawtext=fontfile=$FONT:text='$head':fontcolor=$INK:fontsize=72:x=180:y='540-18*(1-min(t/0.7,1))':alpha='if(lt(t,0.6),t/0.6,1)',\
drawtext=fontfile=$FONT:text='$sub':fontcolor=$MUTED:fontsize=26:x=182:y='640-12*(1-min(t/1,1))':alpha='if(lt(t,0.9),t/0.9,1)'" \
    -r 30 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "$OUT/$name.mp4"
  echo "scene $name $dur s"
}

scene s1 c-list.png 4.2 "01 — THE LIST"    "跨所有会话，一份清单" "人和 Agent 读写同一份。"
statement s2 3.0 "02 — THE RECORD" "加入时间、原话、步骤" "写下的不只是标题。"
scene s3 c-review.png 4.2 "03 — THE CLAIM"  "「做完了」是声明" "你点头，才算完成。"
statement s4 3.0 "04 — THE HAND-OFF" "交出去的是编号计划" "不是一个链接，是带勾选的步骤。"
scene s5 c-file.png 4.4 "05 — THE FILE"   "一个 JSON 文件" "能 cat，能 diff，能进仓库。"

ffmpeg -loglevel error -y -f lavfi -i "color=c=$BG:s=1920x1080:d=3.6:r=30" \
  -vf "drawtext=fontfile=$FONT:text='全局待办':fontcolor=$INK:fontsize=88:x=(w-text_w)/2:y=380:alpha='if(lt(t,0.4),t/0.4,1)',\
drawtext=fontfile=$FONT:text='dsh plugin add dsh-global-todo':fontcolor=$ACCENT:fontsize=36:x=(w-text_w)/2:y=560:alpha='if(lt(t,0.6),t/0.6,1)',\
drawtext=fontfile=$FONT:text='lugabeeee.github.io/dsh-global-todo':fontcolor=$MUTED:fontsize=26:x=(w-text_w)/2:y=640:alpha='if(lt(t,0.9),t/0.9,1)'" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "$OUT/s6.mp4"
echo "scene s6 3.6 s"

printf "file '%s'\n" "$OUT/s1.mp4" "$OUT/s2.mp4" "$OUT/s3.mp4" "$OUT/s4.mp4" "$OUT/s5.mp4" "$OUT/s6.mp4" > "$OUT/list.txt"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$OUT/list.txt" -c copy "$OUT/video.mp4"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT/video.mp4"
