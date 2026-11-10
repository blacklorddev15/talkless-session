#!/usr/bin/env bash
# start.sh — keep the bot alive on panels that don't auto-restart a crashed node.
#
# Symptom this fixes: the bot answers for a couple of minutes, the node process
# exits (no error in the console), the container shows "offline", and WhatsApp
# goes silent until someone presses Start again.
#
# Panel → Startup tab:
#   Startup file      start.sh
#   Startup command   bash start.sh
#
# The loop restarts the bot 5 s after any exit and logs the exit code, so the
# console shows "bot exited with code N" instead of just stopping.

set -u
cd "$(dirname "$0")" || exit 1

restarts=0
while true; do
  echo "[start.sh] $(date -Is) starting bot (restart #$restarts)"
  node index.js
  code=$?
  restarts=$((restarts + 1))
  echo "[start.sh] $(date -Is) bot exited with code $code — restarting in 5s"
  sleep 5
done
