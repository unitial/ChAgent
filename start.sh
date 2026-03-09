#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== 构建前端 ==="
cd frontend
npm run build
cd ..

echo "=== 启动后端（监听所有网卡 0.0.0.0:8000）==="
echo ""
# 显示本机 IP，方便告知学生
echo "本机 IP 地址："
hostname -I | tr ' ' '\n' | grep -v '^$'
echo ""
echo "学生访问地址：http://<上面的IP>:8000"
echo ""

source venv/bin/activate 2>/dev/null || true
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
