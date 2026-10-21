#!/bin/sh
# Build the soundtrack: a synthesised instrumental, generated to the film's cut points.
#
# There is no narration on purpose. The type already says everything, and the only TTS
# endpoints reachable from this host produce a voice that sounds synthetic — a spoken
# track would lower the film, not raise it.
set -e
OUT="${1:-/tmp/music}"
mkdir -p "$OUT"

# 1. compose: 24s, chords change exactly on the cuts (0, 4.2, 7.2, 11.4, 14.4, 18.8)
node "$(dirname "$0")/music.mjs" "$OUT/bed.wav"

# 2. give it a little presence, then set the level a background bed wants
ffmpeg -loglevel error -y -i "$OUT/bed.wav" \
  -af "treble=g=2.5:f=2600,volume=0.95,alimiter=limit=0.8" -ar 48000 -ac 2 "$OUT/mix.wav"

printf '%s  %ss\n' "$OUT/mix.wav" "$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT/mix.wav")"
