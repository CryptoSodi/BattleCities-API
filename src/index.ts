declare const Buffer: any;
declare const __dirname: string;
declare const process: any;
declare const require: any;

import app from './app';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const loadLocalEnv = require('./config/loadLocalEnv');
const database = require('./database');

loadLocalEnv.loadLocalEnv();

configureEmbeddedBroadcasterToken();
const embeddedBroadcaster = loadEmbeddedBroadcaster();

const port = parsePort(process.env.PORT, 3001);
const host = process.env.BATTLECITY_API_HOST || '127.0.0.1';
const diagnosticPages = new Set(['/ws-latency.html', '/webrtc-latency.html']);

const server = http.createServer(async (incoming: any, outgoing: any) => {
  try {
    if (
      embeddedBroadcaster !== null &&
      embeddedBroadcaster.isBroadcasterRequestPath(getPathname(incoming.url))
    ) {
      await embeddedBroadcaster.handleBroadcasterRequest(incoming, outgoing);
      return;
    }
    if (await serveDiagnosticPage(incoming, outgoing)) {
      return;
    }
    const request = await toFetchRequest(incoming);
    const response = await app.fetch(request);
    await sendFetchResponse(response, outgoing);
  } catch (error) {
    console.error('[battlecities-api] request failed', error);
    if (!outgoing.headersSent) {
      outgoing.statusCode = 500;
      outgoing.setHeader('content-type', 'application/json');
    }
    outgoing.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.on('upgrade', (request: any, socket: any) => {
  const pathname = getPathname(request.url);
  if (pathname !== '/ws-latency') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  acceptLatencyWebSocket(request, socket);
});

start().catch((error: unknown) => {
  console.error('[battlecities-api] startup failed', error);
  process.exitCode = 1;
});

async function start(): Promise<void> {
  await database.assertStartupReady();
  server.listen(port, host, () => {
    console.log(`[battlecities-api] listening on http://${host}:${port}`);
    if (embeddedBroadcaster !== null) {
      console.log('[battlecities-api] authoritative broadcaster is embedded');
    }
  });
}

async function serveDiagnosticPage(
  incoming: any,
  outgoing: any,
): Promise<boolean> {
  const method = String(incoming.method || 'GET').toUpperCase();
  const pathname = getPathname(incoming.url);
  if (!diagnosticPages.has(pathname)) {
    return false;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    outgoing.statusCode = 405;
    outgoing.setHeader('allow', 'GET, HEAD');
    outgoing.end('Method not allowed');
    return true;
  }
  const file = await readDiagnosticPage(pathname.slice(1));
  if (file === null) {
    outgoing.statusCode = 404;
    outgoing.setHeader('content-type', 'text/plain; charset=utf-8');
    outgoing.end('Not found');
    return true;
  }
  outgoing.statusCode = 200;
  outgoing.setHeader('content-type', 'text/html; charset=utf-8');
  outgoing.setHeader('cache-control', 'no-store');
  if (method === 'HEAD') {
    outgoing.end();
    return true;
  }
  outgoing.end(file);
  return true;
}

async function readDiagnosticPage(fileName: string): Promise<any | null> {
  const candidates = [
    path.resolve(process.cwd(), 'api-server', 'public', fileName),
    path.resolve(process.cwd(), 'public', fileName),
    path.resolve(__dirname, '..', '..', 'public', fileName),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.promises.readFile(candidate);
    } catch {
      // Try the next deployment layout.
    }
  }
  return null;
}

function acceptLatencyWebSocket(request: any, socket: any): void {
  const key = String(request.headers['sec-websocket-key'] || '');
  if (key.trim() === '') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
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

function loadEmbeddedBroadcaster(): any | null {
  if (!isEnabled(process.env.BATTLECITY_EMBED_BROADCASTER)) {
    return null;
  }
  const runtimePath = path.resolve(
    process.cwd(),
    'dist-broadcaster',
    'scripts',
    'headless-broadcaster-runtime.js',
  );
  return require(runtimePath);
}

function configureEmbeddedBroadcasterToken(): void {
  if (
    isEnabled(process.env.BATTLECITY_EMBED_BROADCASTER) &&
    String(process.env.BROADCASTER_SERVICE_TOKEN || '').trim() === ''
  ) {
    process.env.BROADCASTER_SERVICE_TOKEN = crypto.randomBytes(32).toString('hex');
  }
}

function isEnabled(value: unknown): boolean {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function getPathname(value: unknown): string {
  return new URL(String(value || '/'), 'http://127.0.0.1').pathname;
}

function parsePort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

async function toFetchRequest(incoming: any): Promise<Request> {
  const headers = new Headers();
  Object.entries(incoming.headers || {}).forEach(([name, rawValue]) => {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    values.forEach((value) => {
      if (value !== undefined) {
        headers.append(name, String(value));
      }
    });
  });

  const method = String(incoming.method || 'GET').toUpperCase();
  const authority = firstForwardedValue(headers.get('x-forwarded-host')) ||
    headers.get('host') ||
    `${host}:${port}`;
  const protocol = firstForwardedValue(headers.get('x-forwarded-proto')) ||
    (incoming.socket?.encrypted ? 'https' : 'http');
  const url = `${protocol}://${authority}${incoming.url || '/'}`;
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : await readBody(incoming);

  return new Request(url, { method, headers, body });
}

function firstForwardedValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const first = value.split(',')[0].trim();
  return first === '' ? null : first;
}

async function readBody(incoming: any): Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function sendFetchResponse(
  response: Response,
  outgoing: any,
): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    outgoing.setHeader(name, value);
  });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[battlecities-api] ${signal} received; shutting down`);
  void (async () => {
    if (embeddedBroadcaster !== null) {
      await embeddedBroadcaster.shutdownBroadcaster();
    }
    server.close(async (error: Error | undefined) => {
      if (error !== undefined) {
        console.error('[battlecities-api] shutdown failed', error);
        process.exitCode = 1;
      }
      await database.closePool();
    });
  })().catch((error) => {
    console.error('[battlecities-api] broadcaster shutdown failed', error);
    process.exitCode = 1;
    server.close(() => void database.closePool());
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
