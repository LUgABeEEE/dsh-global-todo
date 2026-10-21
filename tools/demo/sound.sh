#!/bin/sh
set -e
cd /tmp/film
mkdir -p audio
# A quiet low pad: two sines, heavily filtered, no melody to fight the type.
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=55:duration=22.4" -f lavfi -i "sine=frequency=82.5:duration=22.4" \
  -filter_complex "[0:a]volume=0.5[a];[1:a]volume=0.28[b];[a][b]amix=2:normalize=0,lowpass=f=400,tremolo=f=0.1:d=0.25,volume=0.42,afade=t=in:st=0:d=1.2,afade=t=out:st=19.6:d=2.8[out]" \
  -map "[out]" -ar 48000 -ac 2 audio/pad.wav

ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=d=0.06:c=white:a=0.5" -af "highpass=f=2400,lowpass=f=7000,volume=1.6,afade=t=out:st=0.02:d=0.04" audio/tick.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=1200:duration=0.05" -af "volume=0.35,afade=t=out:st=0.01:d=0.04" audio/blip.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=60:duration=0.35" -af "volume=1.4,afade=t=out:st=0.02:d=0.32" audio/thud.wav

ffmpeg -loglevel error -y \
 -i audio/pad.wav -i audio/tick.wav -i audio/blip.wav -i audio/thud.wav \
 -filter_complex "\
[1:a]asplit=6[t0][t1][t2][t3][t4][t5];\
[t0]adelay=120|120[a0];[t1]adelay=4250|4250[a1];[t2]adelay=7250|7250[a2];[t3]adelay=11450|11450[a3];[t4]adelay=14450|14450[a4];[t5]adelay=18900|18900[a5];\
[2:a]asplit=6[b0][b1][b2][b3][b4][b5];\
[b0]adelay=140|140[c0];[b1]adelay=4270|4270[c1];[b2]adelay=7270|7270[c2];[b3]adelay=11470|11470[c3];[b4]adelay=14470|14470[c4];[b5]adelay=18920|18920[c5];\
[3:a]asplit=2[d0][d1];[d0]adelay=7260|7260[e0];[d1]adelay=14460|14460[e1];\
[0:a][a0][a1][a2][a3][a4][a5][c0][c1][c2][c3][c4][c5][e0][e1]amix=inputs=15:normalize=0,alimiter=limit=0.95,volume=1.8[aout]" \
 -map "[aout]" -ar 48000 -ac 2 audio/mix.wav

ffmpeg -hide_banner -i audio/mix.wav -af volumedetect -f null /dev/null 2>&1 | grep -E 'mean_volume|max_volume'
