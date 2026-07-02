const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Códigos de cor para logs bonitos no terminal
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

function log(type, message, details = '') {
  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  let badge = `[INFO]`;
  let color = colors.cyan;

  if (type === 'JOIN') { badge = `[CONEXÃO]`; color = colors.green; }
  else if (type === 'LEAVE') { badge = `[DESCONEXÃO]`; color = colors.yellow; }
  else if (type === 'SIGNAL') { badge = `[SINALIZAÇÃO]`; color = colors.magenta; }
  else if (type === 'ERROR') { badge = `[ERRO]`; color = colors.red; }

  console.log(`${colors.gray}${timestamp}${colors.reset} ${color}${badge}${colors.reset} ${message} ${colors.gray}${details}${colors.reset}`);
}

// 1. Servidor HTTP simples para servir a interface web (index.html)
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 - Arquivo não encontrado');
      } else {
        res.writeHead(500);
        res.end(`Erro no servidor: ${err.code}`);
      }
    } else {
      let extname = path.extname(filePath);
      let contentType = 'text/html; charset=utf-8';
      switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.json': contentType = 'application/json'; break;
        case '.png': contentType = 'image/png'; break;
        case '.jpg': contentType = 'image/jpg'; break;
        case '.svg': contentType = 'image/svg+xml'; break;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// 2. Servidor de Sinalização WebSocket
const wss = new WebSocketServer({ server });

// Estrutura de salas em memória: { roomId: { broadcaster: client, viewers: Map<id, client> } }
const rooms = new Map();
let nextPeerId = 1;

wss.on('connection', (ws, req) => {
  if (req.socket && req.socket.setNoDelay) {
    req.socket.setNoDelay(true); // Otimização 100% de latência: desativa algoritmo de Nagle
  }
  const peerId = `peer_${nextPeerId++}`;
  const ip = req.socket.remoteAddress;
  ws.peerId = peerId;
  ws.roomId = null;
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  log('JOIN', `Novo cliente conectado: ${peerId}`, `(IP: ${ip})`);

  ws.on('message', (messageRaw) => {
    let data;
    try {
      data = JSON.parse(messageRaw);
    } catch (e) {
      log('ERROR', `Mensagem mal formatada recebida de ${peerId}`);
      return;
    }

    const { type, roomId, targetPeerId } = data;

    switch (type) {
      case 'join-room': {
        ws.roomId = roomId || 'default-room';
        ws.role = data.role; // 'broadcaster' ou 'viewer'

        if (!rooms.has(ws.roomId)) {
          rooms.set(ws.roomId, { broadcaster: null, viewers: new Map() });
        }
        const room = rooms.get(ws.roomId);

        log('JOIN', `${peerId} entrou na sala [${ws.roomId}] como ${ws.role.toUpperCase()}`);

        if (ws.role === 'broadcaster') {
          // Se já houver um broadcaster antigo na sala, o substituímos ou notificamos
          room.broadcaster = ws;
          ws.send(JSON.stringify({
            type: 'room-joined',
            role: 'broadcaster',
            peerId,
            viewersCount: room.viewers.size
          }));

          // Se já houver visualizadores esperando na sala, notificar o broadcaster para iniciar ofertas
          for (const [vId] of room.viewers) {
            ws.send(JSON.stringify({ type: 'viewer-joined', peerId: vId }));
          }
        } else {
          // É um viewer
          room.viewers.set(peerId, ws);
          ws.send(JSON.stringify({
            type: 'room-joined',
            role: 'viewer',
            peerId,
            hasBroadcaster: !!room.broadcaster
          }));

          // Notifica o transmissor que um novo espectador entrou
          if (room.broadcaster && room.broadcaster.readyState === ws.OPEN) {
            log('SIGNAL', `Notificando broadcaster na sala [${ws.roomId}] sobre novo espectador: ${peerId}`);
            room.broadcaster.send(JSON.stringify({ type: 'viewer-joined', peerId }));
          }
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'quality-update': {
        if (!ws.roomId || !rooms.has(ws.roomId)) return;
        const room = rooms.get(ws.roomId);

        if (type !== 'ice-candidate') {
          log('SIGNAL', `[${type.toUpperCase()}] de ${peerId} para ${targetPeerId || 'Broadcaster'}`);
        }

        if (ws.role === 'broadcaster' && targetPeerId) {
          // Encaminhar do Transmissor para um Espectador específico
          const targetViewer = room.viewers.get(targetPeerId);
          if (targetViewer && targetViewer.readyState === ws.OPEN) {
            targetViewer.send(JSON.stringify({
              type,
              senderPeerId: peerId,
              payload: data.payload
            }));
          }
        } else if (ws.role === 'viewer' && room.broadcaster && room.broadcaster.readyState === ws.OPEN) {
          // Encaminhar do Espectador para o Transmissor
          room.broadcaster.send(JSON.stringify({
            type,
            senderPeerId: peerId,
            payload: data.payload
          }));
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        log('ERROR', `Tipo de sinalização desconhecido: ${type}`);
    }
  });

  ws.on('close', () => {
    log('LEAVE', `Cliente desconectado: ${peerId} (${ws.role || 'sem sala'})`);

    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      if (ws.role === 'broadcaster') {
        if (room.broadcaster === ws) {
          room.broadcaster = null;
          // Avisar visualizadores que a transmissão caiu/encerrou
          for (const [_, viewer] of room.viewers) {
            if (viewer.readyState === ws.OPEN) {
              viewer.send(JSON.stringify({ type: 'broadcaster-left' }));
            }
          }
        }
      } else if (ws.role === 'viewer') {
        room.viewers.delete(peerId);
        if (room.broadcaster && room.broadcaster.readyState === ws.OPEN) {
          room.broadcaster.send(JSON.stringify({ type: 'viewer-left', peerId }));
        }
      }

      // Limpar sala vazia
      if (!room.broadcaster && room.viewers.size === 0) {
        rooms.delete(ws.roomId);
        log('INFO', `Sala [${ws.roomId}] removida da memória por estar vazia.`);
      }
    }
  });
});

// Sistema de Heartbeat para manter conexões ativas sem queda por roteadores ou nuvem
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, 25000);

function getLocalLANIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIPs = getLocalLANIPs();
  console.log(`\n${colors.cyan}═════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.green}  🚀 Servidor WebRTC Nitro Signaling rodando na porta ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}  💻 Acesso Local (Mesmo PC): http://localhost:${PORT}${colors.reset}`);
  lanIPs.forEach(ip => {
    console.log(`${colors.yellow}  🌐 Acesso na Rede Wi-Fi/LAN: http://${ip}:${PORT}${colors.reset}`);
  });
  console.log(`${colors.cyan}═════════════════════════════════════════════════════════════════${colors.reset}\n`);
});
