import { createHash } from 'crypto';
import { createServer } from 'http';

declare const Buffer: any;

const server = createServer((_request, response) => {
  response.statusCode = 426;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end('Upgrade required');
});

server.on('upgrade', (request: any, socket: any) => {
  const pathname = new URL(
    request.url || '/',
    `https://${request.headers.host || 'localhost'}`,
  ).pathname;
  if (pathname !== '/api/ws-latency') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  acceptLatencyWebSocket(request, socket);
});

function acceptLatencyWebSocket(request: any, socket: any): void {
  const key = String(request.headers['sec-websocket-key'] || '');
  if (key.trim() === '') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: any) => {
    buffered = Buffer.concat([buffered, chunk]);
    buffered = drainLatencyFrames(buffered, socket);
  });
  socket.on('error', () => undefined);
}

function drainLatencyFrames(buffer: any, socket: any): any {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      if (high !== 0 || low > 1024 * 1024) {
        socket.destroy();
        return Buffer.alloc(0);
      }
      payloadLength = low;
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) break;
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(
      buffer.slice(payloadOffset, payloadOffset + payloadLength),
    );
    if (masked) {
      const mask = buffer.slice(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    if (opcode === 0x8) {
      socket.end(createWebSocketFrame(Buffer.alloc(0), 0x8));
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) {
      socket.write(createWebSocketFrame(payload, 0xA));
    }
    if (opcode === 0x1) {
      socket.write(createLatencyPong(payload));
    }
    offset += frameLength;
  }
  return buffer.slice(offset);
}

function createLatencyPong(payload: any): any {
  let body: any;
  try {
    const message = JSON.parse(payload.toString('utf8'));
    body = {
      type: 'pong',
      sequence: Number.isFinite(Number(message.sequence))
        ? Number(message.sequence)
        : null,
      clientSentAt: message.sentAt ?? null,
      serverReceivedAt: Date.now(),
    };
  } catch {
    body = { type: 'pong', serverReceivedAt: Date.now() };
  }
  return createWebSocketFrame(Buffer.from(JSON.stringify(body)), 0x1);
}

function createWebSocketFrame(payload: any, opcode = 0x1): any {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(length, 6);
  return Buffer.concat([header, payload]);
}

export default server;
