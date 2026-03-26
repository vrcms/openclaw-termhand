/**
 * TermHand Server Module
 * 运行在 VPS 端，管理 bridge 连接和 AI 调用接口
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(process.env.HOME || '/root', '.openclaw/termhand/config.json');
fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
if (!config.bridgeToken) {
  config.bridgeToken = crypto.randomBytes(32).toString('hex');
  saveConfig(config);
}

// ── 状态 ────────────────────────────────────────────────────
let bridgeWs = null;       // bridge 的 WS 连接
let bridgeInfo = null;     // bridge 上报的平台信息

// 挂起的请求：requestId -> { resolve, reject, timer }
const pendingRequests = new Map();

// ── 工具函数 ─────────────────────────────────────────────────
function genRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

function sendToBridge(msg) {
  if (!bridgeWs) throw new Error('Bridge not connected');
  const { WebSocket } = require('ws');
  if (bridgeWs.readyState !== WebSocket.OPEN) throw new Error('Bridge connection not ready');
  bridgeWs.send(JSON.stringify(msg));
}

function waitForResponse(requestId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Request ${requestId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
  });
}

function resolveRequest(requestId, data) {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.resolve(data);
  }
}

// session 输出缓冲（VPS 侧缓存，供 AI 读取）
const sessionOutputs = new Map(); // sessionId -> string[]

function appendOutput(sessionId, text) {
  if (!sessionOutputs.has(sessionId)) sessionOutputs.set(sessionId, []);
  const buf = sessionOutputs.get(sessionId);
  buf.push(text);
  if (buf.length > 500) buf.splice(0, buf.length - 500);
}

// ── Bridge WS 处理 ──────────────────────────────────────────
function handleBridgeMessage(msg) {
  switch (msg.type) {

    case 'bridge_hello':
      bridgeInfo = msg;
      console.log(`[TermHand] Bridge connected: ${msg.platform} ${msg.hostname} (${msg.shell})`);
      break;

    case 'session_ready':
      resolveRequest('new_' + msg.sessionId, msg);
      break;

    case 'session_output':
      appendOutput(msg.sessionId, msg.text);
      // 如果有等待输出的 poll，不在这里处理（poll 是主动读取）
      break;

    case 'session_exit':
      appendOutput(msg.sessionId, `\n[Session exited with code ${msg.exitCode}]\n`);
      resolveRequest('exit_' + msg.sessionId, msg);
      break;

    case 'session_error':
      appendOutput(msg.sessionId, `\n[Error: ${msg.error}]\n`);
      break;

    case 'session_killed':
      resolveRequest('kill_' + msg.sessionId, msg);
      break;

    case 'session_list_result':
      resolveRequest('list', msg);
      break;

    case 'session_read_result':
      resolveRequest('read_' + msg.sessionId, msg);
      break;

    case 'exec_oneshot_result':
      resolveRequest('oneshot_' + msg.requestId, msg);
      break;

    case 'pong':
      break;

    default:
      console.log('[TermHand] Unknown msg from bridge:', msg.type);
  }
}

function handleBridgeConnection(ws, req) {
  const token = req.headers['x-termhand-token'];
  if (token !== config.bridgeToken) {
    ws.close(1008, 'Invalid token');
    console.warn('[TermHand] Bridge rejected: invalid token');
    return;
  }

  if (bridgeWs) {
    bridgeWs.close(1001, 'Replaced by new connection');
  }

  bridgeWs = ws;
  bridgeInfo = null;
  console.log('[TermHand] Bridge connected');

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }
    handleBridgeMessage(msg);
  });

  ws.on('close', () => {
    if (bridgeWs === ws) {
      bridgeWs = null;
      bridgeInfo = null;
      console.log('[TermHand] Bridge disconnected');
    }
  });

  ws.on('error', (e) => console.error('[TermHand] Bridge WS error:', e.message));

  // 心跳
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
    else clearInterval(ping);
  }, 30000);
}

// ── REST API 路由 ────────────────────────────────────────────
function registerRoutes(app) {

  // 状态检查
  app.get('/termhand/status', (req, res) => {
    res.json({
      connected: !!bridgeWs,
      bridgeInfo,
      activeSessions: Array.from(sessionOutputs.keys()),
    });
  });

  // 获取 bridge token（用于配置 bridge）
  app.get('/termhand/token', (req, res) => {
    res.json({ token: config.bridgeToken });
  });

  // 新建 session
  app.post('/termhand/session/new', async (req, res) => {
    try {
      const { sessionId, shell } = req.body;
      const id = sessionId || 'session-' + Date.now();
      sendToBridge({ type: 'session_new', sessionId: id, shell });
      const result = await waitForResponse('new_' + id, 10000);
      res.json({ ok: true, sessionId: id, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 发送输入到 session
  app.post('/termhand/session/:id/input', (req, res) => {
    try {
      const { id } = req.params;
      const { input } = req.body;
      if (!input) return res.status(400).json({ ok: false, error: 'input required' });
      sendToBridge({ type: 'session_input', sessionId: id, input });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 读取 session 输出（VPS 侧缓存）
  app.get('/termhand/session/:id/output', (req, res) => {
    const { id } = req.params;
    const lines = parseInt(req.query.lines) || 50;
    const buf = sessionOutputs.get(id) || [];
    const text = buf.slice(-lines).join('');
    res.json({ ok: true, sessionId: id, text, totalLines: buf.length });
  });

  // 从 bridge 实时读取 session 输出（最近N行）
  app.get('/termhand/session/:id/read', async (req, res) => {
    try {
      const { id } = req.params;
      const lines = parseInt(req.query.lines) || 50;
      sendToBridge({ type: 'session_read', sessionId: id, lines });
      const result = await waitForResponse('read_' + id, 10000);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 关闭 session
  app.post('/termhand/session/:id/kill', async (req, res) => {
    try {
      const { id } = req.params;
      sendToBridge({ type: 'session_kill', sessionId: id });
      const result = await waitForResponse('kill_' + id, 5000);
      sessionOutputs.delete(id);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 列出所有 session（从 bridge 获取）
  app.get('/termhand/sessions', async (req, res) => {
    try {
      sendToBridge({ type: 'session_list' });
      const result = await waitForResponse('list', 5000);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 下载 termhand.zip 安装包
  app.get('/download', (req, res) => {
    const zipPath = require('path').resolve(__dirname, 'termhand.zip');
    if (!require('fs').existsSync(zipPath)) {
      return res.status(404).json({ error: 'termhand.zip not found' });
    }
    res.download(zipPath, 'termhand.zip');
  });

  // 直接返回最新文件（供 --update 自升级使用）
  const serveFile = (filePath, contentType) => (req, res) => {
    const p = require('path').resolve(__dirname, filePath);
    if (!require('fs').existsSync(p)) return res.status(404).json({ error: `${filePath} not found` });
    res.setHeader('Content-Type', contentType);
    res.sendFile(p);
  };
  app.get('/bridge-js', serveFile('bridge.js', 'application/javascript'));
  app.get('/ui-js',     serveFile('ui.js',     'application/javascript'));
  app.get('/ui-html',   serveFile('ui.html',   'text/html'));

  // 一次性执行命令（不保持 session）
  app.post('/termhand/exec', async (req, res) => {
    try {
      const { command, cwd, timeout } = req.body;
      if (!command) return res.status(400).json({ ok: false, error: 'command required' });
      const requestId = genRequestId();
      sendToBridge({ type: 'exec_oneshot', requestId, command, cwd });
      const result = await waitForResponse('oneshot_' + requestId, timeout || 30000);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

}

module.exports = { handleBridgeConnection, registerRoutes, getBridgeToken: () => config.bridgeToken };
