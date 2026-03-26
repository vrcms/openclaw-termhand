/**
 * TermHand UI Server
 * 本地管理界面，运行在 localhost:7654
 * 提供 session 列表 + xterm.js 终端
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// UI WebSocket 客户端列表
const uiClients = new Map(); // sessionId -> Set<ws>

function startUIServer(sessions, port) {
  port = port || 7654;

  const htmlPath = path.resolve(__dirname, 'ui.html');

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/' || url === '/index.html') {
      // 提供 UI 页面
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url === '/api/sessions') {
      // 返回所有 session 列表
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        shell: s.shell || 'shell',
        outputBuf: (Array.isArray(s.outputBuf) ? s.outputBuf : []).join(''),
        lastOutput: (Array.isArray(s.outputBuf) ? s.outputBuf : []).join('').replace(/\x1b\[[\d;]*[mGKHF]/g, '').slice(-200),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (url.startsWith('/api/input/')) {
      // POST /api/input/:sessionId  body: { input: "..." }
      const sessionId = url.replace('/api/input/', '');
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { input } = JSON.parse(body);
          const s = sessions.get(sessionId);
          if (s && s.proc && s.proc.stdin) {
            s.proc.stdin.write(input);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'session not found' }));
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // WebSocket：实时推送输出
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(req.url.replace(/^\/ws\?/, ''));
    const sessionId = params.get('session');
    if (!sessionId) { ws.close(); return; }

    if (!uiClients.has(sessionId)) uiClients.set(sessionId, new Set());
    uiClients.get(sessionId).add(ws);

    // 发送历史输出
    const s = sessions.get(sessionId);
    if (s && s.outputBuf) {
      const history = (Array.isArray(s.outputBuf) ? s.outputBuf : []).join('');
      if (history) ws.send(JSON.stringify({ type: 'history', data: history }));
    }

    ws.on('close', () => {
      if (uiClients.has(sessionId)) {
        uiClients.get(sessionId).delete(ws);
        if (uiClients.get(sessionId).size === 0) uiClients.delete(sessionId);
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[TermHand UI] 管理界面: http://localhost:${port}`);
    // 自动打开浏览器
    const { exec } = require('child_process');
    const open = process.platform === 'win32' ? `start http://localhost:${port}` :
                 process.platform === 'darwin' ? `open http://localhost:${port}` :
                 `xdg-open http://localhost:${port}`;
    exec(open);
  });

  // 广播函数：session 有新输出时调用
  function broadcast(sessionId, text) {
    const clients = uiClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const msg = JSON.stringify({ type: 'output', sessionId, data: text });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  return { broadcast, server };
}

module.exports = { startUIServer };
