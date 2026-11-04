#!/usr/bin/env bash
# Side-by-side, labelled comparison of recordings, each starting 1 s before its
# first press. Needs an ffmpeg with libx264 and drawtext (not Playwright's).
# Usage: compose.sh output.mp4 label1 label2 [label3 ...]
#   DURATION=7 seconds per clip; FONT=path to a TrueType font
set -euo pipefail
cd "$(dirname "$0")/../../../test-results/gallery-latency"
font=${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}
output=$1; shift
inputs=(); filters=""; stack=""; i=0
for label in "$@"; do
  offset=$(sed -n 's/^firstPressOffsetMs //p' "$label.timeline.txt")
  start=$(awk -v ms="$offset" 'BEGIN { printf "%.3f", (ms - 1000) / 1000 }')
  inputs+=(-ss "$start" -t "${DURATION:-7}" -i "$label.webm")
  filters+="[$i:v]setpts=PTS-STARTPTS,scale=640:-2,drawtext=fontfile=${font}:text='${label}':x=12:y=12:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8[v$i];"
  stack+="[v$i]"; i=$((i + 1))
done
ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex \
  "${filters}${stack}hstack=inputs=$i:shortest=1,drawtext=fontfile=${font}:text='t=%{pts\:hms} (first press at 1s)':x=w-tw-12:y=h-th-12:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6[out]" \
  -map "[out]" -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart "$output"
ls -la "$output"
