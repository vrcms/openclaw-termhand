# TermHand（终端手）

> 云手管浏览器，终端手管终端。

OpenClaw VPS 远程控制用户本地终端，支持多 session 并发，Windows/Mac/Linux 全平台兼容。

## 架构

```
OpenClaw (VPS)
  └─ termhand-server.js (port 9877)
       └─ WebSocket
            └─ bridge.js（用户本地运行）
                 └─ cmd / bash / zsh
```

## 快速开始

### 1. 下载安装包

```
http://YOUR_VPS_IP:9876/download-termhand
```

### 2. 本地运行 bridge

**Windows：**
```cmd
npm install ws
node bridge.js --server ws://YOUR_VPS_IP:9877/termhand-ws --token YOUR_TOKEN
```

**Mac/Linux：**
```bash
npm install ws
node bridge.js --server ws://YOUR_VPS_IP:9877/termhand-ws --token YOUR_TOKEN
```

### 3. 获取 token

在 VPS 上：
```bash
curl -s http://localhost:9877/termhand/token
```

## AI 操作接口

```bash
# 检查连接
curl http://localhost:9877/termhand/status

# 新建 session
curl -X POST http://localhost:9877/termhand/session/new \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "s1"}'

# 发送命令（末尾加 \n）
curl -X POST http://localhost:9877/termhand/session/s1/input \
  -H 'Content-Type: application/json' \
  -d '{"input": "dir\n"}'

# 读取输出
curl http://localhost:9877/termhand/session/s1/output

# 关闭 session
curl -X POST http://localhost:9877/termhand/session/s1/kill
```

## 特性

- Windows 自动 `chcp 65001`（UTF-8 编码，解决中文乱码）
- 多 session 并发，每个独立 shell
- 断线自动重连（指数退避，最多 30 秒）
- bridge 只连 VPS，本地不暴露任何端口
- token 鉴权

## 与云手（CloudHand）的关系

| | 云手 | 终端手 |
|---|---|---|
| 控制目标 | Chrome 浏览器 | 本地终端 |
| 本地组件 | Chrome 扩展 | Node.js 脚本 |
| 安装方式 | 装扩展 | 跑 node 脚本 |
| 状态 | 无状态 | 有状态（session 持久）|

## License

MIT
