# TermHand 技能（终端手）

远程控制用户本地终端。VPS 上的 OpenClaw 通过 WebSocket 向用户本地发送命令，本地 bridge 执行后回传输出。

## 架构

```
OpenClaw (VPS)
  └─ POST /termhand/session/new|input|output|kill
       └─ termhand-server.js（集成在云手 server.js 中）
            └─ WebSocket ws://VPS:9877/termhand-ws
                 └─ bridge.js（用户本地运行）
                      └─ child_process.spawn（本地 shell）
```

## 前提条件

1. TermHand Server 在 VPS 上运行（port 9877）
2. 用户本地运行 bridge.js 并已连接

## 第一步：检查连接状态

**每次使用前必须先检查 bridge 是否已连接：**

```bash
curl -s http://localhost:9877/termhand/status
```

返回示例：
```json
{"connected": true, "bridgeInfo": {"platform": "win32", "hostname": "dongge-pc"}, "activeSessions": []}
```

若 `connected: false`，告知用户：
> 终端手尚未连接，请先在本地运行 bridge.js

## 安装（用户本地）

下载 zip：
```
http://149.13.91.10:9876/download-termhand
```

解压后：
- **Windows**：双击 `install-windows.bat`
- **Mac/Linux**：`chmod +x install-mac.sh && ./install-mac.sh`

或手动：
```bash
npm install ws
node bridge.js --server ws://149.13.91.10:9877/termhand-ws --token <token>
```

token 获取：
```bash
curl -s http://localhost:9877/termhand/token
```

## AI 操作接口

### 新建 session
```bash
curl -s -X POST http://localhost:9877/termhand/session/new \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "s1", "shell": null}'
```

### 发送命令
```bash
curl -s -X POST http://localhost:9877/termhand/session/s1/input \
  -H 'Content-Type: application/json' \
  -d '{"text": "ls -la\n"}'
```

**注意：命令末尾加 `\n`（回车）才会执行**

### 读取输出
```bash
curl -s http://localhost:9877/termhand/session/s1/output
# 可选参数: ?lines=50（最近50行，默认100）
```

### 等待命令完成
发送命令后等待 1-5 秒再读输出（命令执行需要时间）：
```bash
curl -s -X POST http://localhost:9877/termhand/session/s1/input \
  -d '{"text": "echo done_marker\n"}'
# 等 2 秒
sleep 2
curl -s http://localhost:9877/termhand/session/s1/output | grep done_marker
```

### 列出所有 session
```bash
curl -s http://localhost:9877/termhand/sessions
```

### 关闭 session
```bash
curl -s -X POST http://localhost:9877/termhand/session/s1/kill
```

## 标准操作流程

1. 检查连接：`GET /termhand/status`
2. 新建 session：`POST /termhand/session/new`
3. 发命令：`POST /termhand/session/{id}/input`（命令末尾加 `\n`）
4. 等待 1-3 秒
5. 读输出：`GET /termhand/session/{id}/output`
6. 重复 3-5 直到任务完成
7. 关闭：`POST /termhand/session/{id}/kill`

## 安全说明

- bridge 只连接 VPS，本地不对外开端口
- Token 持久化在 VPS，重启不变（除非手动删除配置文件）
- bridge 断开后所有 session 自动清理
- 危险命令（rm -rf 等）执行前建议口头确认
