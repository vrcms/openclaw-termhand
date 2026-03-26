/**
 * TermHand Bridge - 本地运行
 * 连接到 VPS 的 TermHand Server，管理本地 PTY/shell 会话
 *
 * 用法:
 *   node bridge.js --server ws://YOUR_VPS_IP:9877/termhand-ws --token YOUR_TOKEN
 *   node bridge.js --update   # 检查并更新到最新版本
 *
 * Windows: cmd、PowerShell 都支持
 * Mac/Linux: bash、zsh 都支持
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { startUIServer } = require('./ui');

const CURRENT_VERSION = '0.1.9';
const GITHUB_RAW = 'https://raw.githubusercontent.com/vrcms/openclaw-termhand/master';
const VPS_DOWNLOAD = 'http://149.13.91.10:9877';

// ── 自动更新 ────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function checkUpdate(andApply) {
  try {
    // 优先从 VPS 读版本（无缓存），GitHub 备用
    let latest;
    try {
      const remoteCode = await fetchText(`${VPS_DOWNLOAD}/bridge-js`);
      const match = remoteCode.match(/const CURRENT_VERSION = '([^']+)'/);
      if (!match) throw new Error('version not found in bridge-js');
      latest = match[1];
    } catch (e) {
      const pkg = JSON.parse(await fetchText(`${GITHUB_RAW}/package.json`));
      latest = pkg.version;
    }
    if (latest === CURRENT_VERSION) {
      if (andApply) console.log(`[TermHand] 已是最新版本 v${CURRENT_VERSION}`);
      return false;
    }
    console.log(`[TermHand] ============================================`);
    console.log(`[TermHand] 发现新版本 v${latest}（当前 v${CURRENT_VERSION}）`);
    if (!andApply) {
      console.log(`[TermHand] 升级方法: Ctrl+C 退出后运行 node bridge.js --update`);
      console.log(`[TermHand] ============================================`);
      return true;
    }
    // 从 manifest.json 获取文件列表，逐一下载
    console.log(`[TermHand] 正在下载 v${latest}...`);
    const selfDir = path.dirname(path.resolve(process.argv[1]));
    let manifest;
    try {
      manifest = JSON.parse(await fetchText(`${VPS_DOWNLOAD}/manifest`));
    } catch (e) {
      // fallback: 只更新 bridge.js
      manifest = { files: [{ name: 'bridge.js', url: '/bridge-js' }] };
    }
    for (const f of manifest.files) {
      try {
        const code = await fetchText(`${VPS_DOWNLOAD}${f.url}`);
        if (!code || code.length < 10) throw new Error('空文件');
        fs.writeFileSync(path.join(selfDir, f.name), code, 'utf8');
        console.log(`[TermHand] 已更新 ${f.name}`);
      } catch (e) {
        console.warn(`[TermHand] 跳过 ${f.name}: ${e.message}`);
      }
    }
    console.log(`[TermHand] 更新完成！请重新运行: node bridge.js --server ... --token ...`);
    process.exit(0);
  } catch (e) {
    if (andApply) console.error('[TermHand] 更新失败:', e.message);
  }
  return false;
}

// ── 参数解析 ────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

// --update 模式
if (args.includes('--update')) {
  checkUpdate(true).then(() => process.exit(0)).catch((e) => { console.error('[TermHand] 更新失败:', e.message); process.exit(1); });
  return;
}

const SERVER_URL = getArg('--server') || process.env.TERMHAND_SERVER;
const TOKEN = getArg('--token') || process.env.TERMHAND_TOKEN;

if (!SERVER_URL || !TOKEN) {
  console.error('Usage: node bridge.js --server ws://VPS_IP:9877/termhand-ws --token YOUR_TOKEN');
  console.error('       node bridge.js --update   # 升级到最新版本');
  console.error('Or set TERMHAND_SERVER and TERMHAND_TOKEN environment variables');
  process.exit(1);
}

// ── Shell 检测 ───────────────────────────────────────────────
function getDefaultShell(preferred) {
  if (preferred) return preferred;
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// ── Session 管理 ─────────────────────────────────────────────
const sessions = new Map(); // sessionId -> { proc, outputBuf, shell }

function createSession(sessionId, shell) {
  if (sessions.has(sessionId)) {
    return { existed: true };
  }

  const shellPath = getDefaultShell(shell);
  const isWindows = process.platform === 'win32';

  // Windows: cmd /Q（安静模式）+ chcp 65001 切换 UTF-8, Unix: 交互式 bash
  const shellArgs = isWindows ? ['/Q'] : [];
  const env = { ...process.env, TERM: 'xterm-256color' };
  if (isWindows) env['PYTHONIOENCODING'] = 'utf-8';

  const proc = spawn(shellPath, shellArgs, {
    cwd: process.env.HOME || process.env.USERPROFILE || '.',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const session = {
    proc,
    shell: shellPath,
    outputBuf: [],
    createdAt: Date.now(),
  };

  // Windows cmd 默认 GBK，尝试转 UTF-8
  const decodeOutput = (data) => {
    if (isWindows) {
      try {
        // 尝试用 iconv-lite 解码（如果有的话）
        const iconv = (() => { try { return require('iconv-lite'); } catch { return null; } })();
        if (iconv) return iconv.decode(data, 'gbk');
      } catch {}
    }
    return data.toString('utf8');
  };

  proc.stdout.on('data', (data) => {
    const text = decodeOutput(data);
    session.outputBuf.push(text);
    if (session.outputBuf.length > 1000) session.outputBuf.shift();
    sendToServer({ type: 'session_output', sessionId, text });
    if (ui) ui.broadcastOutput(sessionId, text);
  });

  proc.stderr.on('data', (data) => {
    const text = decodeOutput(data);
    session.outputBuf.push(text);
    if (session.outputBuf.length > 1000) session.outputBuf.shift();
    sendToServer({ type: 'session_output', sessionId, text });
    if (ui) ui.broadcastOutput(sessionId, text);
  });

  proc.on('exit', (code) => {
    sessions.delete(sessionId);
    sendToServer({ type: 'session_exit', sessionId, exitCode: code });
    console.log(`[Bridge] Session ${sessionId} exited with code ${code}`);
    if (ui) ui.broadcastSessions();
  });

  proc.on('error', (err) => {
    sendToServer({ type: 'session_error', sessionId, error: err.message });
    console.error(`[Bridge] Session ${sessionId} error:`, err.message);
  });

  sessions.set(sessionId, session);
  console.log(`[Bridge] Created session ${sessionId} (${shellPath})`);
  if (ui) ui.broadcastSessions();
  return { existed: false };
}

function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  try {
    session.proc.kill();
  } catch (e) {
    // ignore
  }
  sessions.delete(sessionId);
  return true;
}

function inputToSession(sessionId, input) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  // 自动加换行（如果输入是命令）
  const text = input.endsWith('\n') ? input : input + '\n';
  session.proc.stdin.write(text);
}

// 一次性执行命令（不保持会话）
function execOneshot(requestId, command, cwd) {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
  const shellFlag = isWindows ? '/c' : '-c';

  const proc = spawn(shell, [shellFlag, command], {
    cwd: cwd || process.env.HOME || process.env.USERPROFILE || '.',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('exit', (code) => {
    sendToServer({ type: 'exec_oneshot_result', requestId, stdout, stderr, exitCode: code });
  });

  proc.on('error', (err) => {
    sendToServer({ type: 'exec_oneshot_result', requestId, stdout, stderr, exitCode: -1, error: err.message });
  });
}

// ── WebSocket 连接 ───────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'session_new': {
      const { sessionId, shell } = msg;
      const result = createSession(sessionId, shell);
      // Windows: 自动切换 UTF-8 编码
      if (!result.existed && process.platform === 'win32') {
        setTimeout(() => inputToSession(sessionId, 'chcp 65001\r\n'), 300);
      }
      sendToServer({ type: 'session_ready', sessionId, existed: result.existed });
      break;
    }

    case 'session_input': {
      try {
        inputToSession(msg.sessionId, msg.input);
      } catch (e) {
        sendToServer({ type: 'session_error', sessionId: msg.sessionId, error: e.message });
      }
      break;
    }

    case 'session_kill': {
      const ok = killSession(msg.sessionId);
      sendToServer({ type: 'session_killed', sessionId: msg.sessionId, ok });
      break;
    }

    case 'session_list': {
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        sessionId: id,
        shell: s.shell,
        createdAt: s.createdAt,
        bufferLines: s.outputBuf.length,
      }));
      sendToServer({ type: 'session_list_result', sessions: list });
      break;
    }

    case 'session_read': {
      const session = sessions.get(msg.sessionId);
      const lines = msg.lines || 50;
      const buf = session ? session.outputBuf : [];
      const text = buf.slice(-lines).join('');
      sendToServer({ type: 'session_read_result', sessionId: msg.sessionId, text, totalLines: buf.length });
      break;
    }

    case 'exec_oneshot': {
      execOneshot(msg.requestId, msg.command, msg.cwd);
      break;
    }

    case 'ping':
      sendToServer({ type: 'pong' });
      break;

    default:
      console.log('[Bridge] Unknown message type:', msg.type);
  }
}

function connect() {
  console.log(`[Bridge] Connecting to ${SERVER_URL}...`);

  ws = new WebSocket(SERVER_URL, {
    headers: { 'x-termhand-token': TOKEN },
  });

  ws.on('open', () => {
    reconnectDelay = 2000; // 重置重连延迟
    console.log('[Bridge] Connected to TermHand Server');
    console.log(`[Bridge] Platform: ${process.platform} ${process.arch} @ ${os.hostname()}`);
    console.log(`[Bridge] Node: ${process.version}`);

    // 连接成功后异步检查更新（不阻塞主流程）
    checkUpdate(false).catch(() => {});

    // 上报 bridge 信息
    sendToServer({
      type: 'bridge_hello',
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      nodeVersion: process.version,
      shell: getDefaultShell(),
    });
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }
    handleServerMessage(msg);
  });

  ws.on('close', (code, reason) => {
    console.log(`[Bridge] Disconnected (${code}: ${reason}). Reconnecting in ${reconnectDelay / 1000}s...`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Bridge] Error:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // 最多 30 秒
    connect();
  }, reconnectDelay);
}

// ── 启动 ────────────────────────────────────────────────────
console.log('='.repeat(50));
console.log('  TermHand Bridge (终端手 · 本地桥接)');
console.log(`  Platform: ${process.platform} ${process.arch}`);
console.log(`  Node: ${process.version}`);
console.log(`  Server: ${SERVER_URL}`);
console.log('='.repeat(50));

// 启动本地 UI 管理界面（http://localhost:7654）
const ui = startUIServer(sessions, 7654, sendToServer);

connect();

// 优雅退出：关掉所有 session
process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  for (const [id] of sessions) killSession(id);
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [id] of sessions) killSession(id);
  if (ws) ws.close();
  process.exit(0);
});
