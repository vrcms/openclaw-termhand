#!/bin/bash
echo "================================================"
echo "  TermHand Bridge (终端手) - Mac/Linux 安装器"
echo "================================================"
echo

# 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "[错误] 未找到 Node.js！"
  echo "请先安装 Node.js: https://nodejs.org/"
  exit 1
fi

echo "[1/3] Node.js: $(node --version)"

# 安装依赖
echo
echo "[2/3] 安装依赖 (ws)..."
npm install ws --save --silent

echo
echo "[3/3] 启动 TermHand Bridge..."
echo
echo "================================================"
echo "  连接中..."
echo "  VPS: 149.13.91.10:9877"
echo "================================================"
echo

node bridge.js \
  --server ws://149.13.91.10:9877/termhand-ws \
  --token 3b5f7e6af054d030a28f7048304465eb0732902dc6314097ea97e6304da1c802
