/**
 * TermHand 独立 Server（可选）
 * 如果不想集成进云手 server.js，可以单独运行这个
 * 
 * 用法: node server.js [--port 9877]
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { handleBridgeConnection, registerRoutes } = require('./termhand-server');

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i+1] : null; };

const PORT = getArg('--port') || process.env.TERMHAND_PORT || 9877;
const HOST = '0.0.0.0';

const app = express();
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => res.json({ ok: true, service: 'termhand' }));

// 注册 TermHand REST 路由
registerRoutes(app);

const server = http.createServer(app);

// WebSocket：bridge 连入
const wss = new WebSocketServer({ server, path: '/termhand-ws' });
wss.on('connection', (ws, req) => handleBridgeConnection(ws, req));

server.listen(PORT, HOST, () => {
  console.log('='.repeat(50));
  console.log('  TermHand Server (终端手)');
  console.log(`  Listening on ${HOST}:${PORT}`);
  console.log(`  Bridge WS: ws://0.0.0.0:${PORT}/termhand-ws`);
  console.log(`  REST API:  http://0.0.0.0:${PORT}/termhand/`);
  console.log('='.repeat(50));
  
  // 打印 token 供 bridge 使用
  const { getBridgeToken } = require('./termhand-server');
  console.log(`[TermHand] Bridge token: ${getBridgeToken()}`);
  console.log(`[TermHand] Start bridge with:`);
  console.log(`  node bridge.js --server ws://YOUR_VPS_IP:${PORT}/termhand-ws --token ${getBridgeToken()}`);
});
