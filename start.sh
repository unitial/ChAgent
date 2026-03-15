#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== 构建前端 ==="
cd frontend
if [ ! -d node_modules ] || ! npm ls --depth=0 >/dev/null 2>&1; then
  echo "前端依赖缺失或不完整，正在执行 npm ci..."
  npm ci
fi
npm run build
cd ..

echo "=== 启动后端（监听所有网卡 0.0.0.0:8000）==="
echo ""
# 显示本机 IP，方便告知学生
echo "本机 IP 地址："
if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
  hostname -I | tr ' ' '\n' | grep -v '^$'
elif command -v ipconfig >/dev/null 2>&1; then
  ips=$(ifconfig | awk '
    /^[a-zA-Z0-9]+: / {
      iface=$1
      sub(":", "", iface)
    }
    /inet / && $2 != "127.0.0.1" && iface ~ /^en[0-9]+$/ {
      print $2
    }
  ')
  if [ -n "$ips" ]; then
    echo "$ips"
  else
    ifconfig | awk '/inet / && $2 != "127.0.0.1" { print $2 }'
  fi
else
  ifconfig | awk '/inet / && $2 != "127.0.0.1" { print $2 }'
fi
echo ""
echo "学生访问地址：http://<上面的IP>:8000"
echo ""

source venv/bin/activate 2>/dev/null || true
cd backend
if [ -x ../venv/bin/python ]; then
  PYTHON_BIN=../venv/bin/python
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
else
  PYTHON_BIN=python
fi

"$PYTHON_BIN" ../tools/init_data.py
uvicorn main:app --host 0.0.0.0 --port 8000
