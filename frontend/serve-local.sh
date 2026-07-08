#!/bin/bash
# 本地预览静态构建产物，不需要后端
cd "$(dirname "$0")/dist"
echo "Opening http://localhost:8080 ..."
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 0.5
open http://localhost:8080
echo "Press Ctrl+C to stop"
trap "kill $SERVER_PID" INT
wait $SERVER_PID
