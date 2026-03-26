/**
 * TermHand UI Server
 * 本地管理界面，运行在 localhost:7654
 * 单一 WebSocket 连接，推送所有 session 输出
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const uiClients = new Set(); // 所有 UI WebSocket 连接

function startUIServer(sessions, port, sendToServer) {
  port = port || 7654;

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/' || url === '/index.html') {
      const htmlPath = path.resolve(__dirname, 'ui.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500);
        res.end('ui.html not found');
      }
      return;
    }

    if (url === '/api/sessions') {
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        shell: s.shell || 'shell',
        lastOutput: (Array.isArray(s.outputBuf) ? s.outputBuf : [])
          .join('').replace(/\x1b\[[\d;]*[mGKHF]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(-200),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (url.startsWith('/api/input/')) {
      const sessionId = decodeURIComponent(url.replace('/api/input/', ''));
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { input } = JSON.parse(body);
          const session = sessions.get(sessionId);
          if (!session) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'session not found' })); return; }
          if (session.proc && session.proc.stdin) {
            session.proc.stdin.write(input);
          } else if (session.proc && session.proc.write) {
            session.proc.write(input);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // 单一 WebSocket 连接，推送所有 session 事件
  const wss = new WebSocketServer({ server, path: '/ui-ws' });
  wss.on('connection', (ws) => {
    uiClients.add(ws);

    // 发送当前 session 列表
    const list = Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      shell: s.shell || 'shell',
      lastOutput: (Array.isArray(s.outputBuf) ? s.outputBuf : [])
        .join('').replace(/\x1b\[[\d;]*[mGKHF]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(-200),
    }));
    ws.send(JSON.stringify({ type: 'sessions', sessions: list }));

    // 发送所有 session 的历史输出
    for (const [id, s] of sessions.entries()) {
      const history = (Array.isArray(s.outputBuf) ? s.outputBuf : []).join('');
      if (history) {
        ws.send(JSON.stringify({ type: 'history', sessionId: id, data: history }));
      }
    }

    // 接收输入
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'input' && msg.sessionId && msg.data) {
          const session = sessions.get(msg.sessionId);
          if (session) {
            // cmd.exe 管道模式需要 \r\n，xterm 只发 \r
            const data = msg.data.replace(/\r(?!\n)/g, '\r\n');
            if (session.proc && session.proc.stdin) session.proc.stdin.write(data);
            else if (session.proc && session.proc.write) session.proc.write(data);
          }
          // 异步上报给 VPS 记录（fire-and-forget，不影响本地响应速度）
          if (typeof sendToServer === 'function') {
            sendToServer({ type: 'session_input_log', sessionId: msg.sessionId, data: msg.data });
          }
        }
      } catch (e) {}
    });

    ws.on('close', () => uiClients.delete(ws));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[TermHand UI] 管理界面: http://localhost:${port}`);
    const { exec } = require('child_process');
    const open = process.platform === 'win32' ? `start http://localhost:${port}` :
                 process.platform === 'darwin' ? `open http://localhost:${port}` :
                 `xdg-open http://localhost:${port}`;
    exec(open);
  });

  // 广播：session 新输出
  function broadcastOutput(sessionId, text) {
    if (uiClients.size === 0) return;
    const msg = JSON.stringify({ type: 'output', sessionId, data: text });
    for (const ws of uiClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // 广播：session 列表更新
  function broadcastSessions() {
    if (uiClients.size === 0) return;
    const list = Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      shell: s.shell || 'shell',
      lastOutput: (Array.isArray(s.outputBuf) ? s.outputBuf : [])
        .join('').replace(/\x1b\[[\d;]*[mGKHF]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(-200),
    }));
    const msg = JSON.stringify({ type: 'sessions', sessions: list });
    for (const ws of uiClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  return { broadcastOutput, broadcastSessions, server };
}

module.exports = { startUIServer };
