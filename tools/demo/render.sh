#!/bin/sh
# Mux the rendered scenes with the sound design and pull a poster frame.
# Usage: render.sh <build-dir> <audio.wav> <out.mp4> [poster.png]
set -e
BUILD="${1:-/tmp/film/build}"
AUDIO="${2:-/tmp/film/audio/mix.wav}"
OUT="${3:-docs/screenshots/demo.mp4}"
POSTER="${4:-docs/screenshots/demo-poster.png}"

DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$BUILD/video.mp4")
FADE_OUT=$(awk "BEGIN{printf \"%.2f\", $DUR-0.5}")

ffmpeg -loglevel error -y -i "$BUILD/video.mp4" -i "$AUDIO" \
  -filter_complex "[0:v]fade=t=in:st=0:d=0.28,fade=t=out:st=$FADE_OUT:d=0.5[v]" \
  -map "[v]" -map 1:a -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 192k -shortest "$OUT"

ffmpeg -loglevel error -y -ss 2.6 -i "$OUT" -frames:v 1 "$POSTER"
printf '%s  %ss\n' "$OUT" "$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")"
