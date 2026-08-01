declare const Buffer: any;
declare const process: any;
declare const require: any;

import app from './app';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const loadLocalEnv = require('./config/loadLocalEnv');
const database = require('./database');

loadLocalEnv.loadLocalEnv();

configureEmbeddedBroadcasterToken();
const embeddedBroadcaster = loadEmbeddedBroadcaster();

const port = parsePort(process.env.PORT, 3001);
const host = process.env.BATTLECITY_API_HOST || '127.0.0.1';

const server = http.createServer(async (incoming: any, outgoing: any) => {
  try {
    if (
      embeddedBroadcaster !== null &&
      embeddedBroadcaster.isBroadcasterRequestPath(getPathname(incoming.url))
    ) {
      await embeddedBroadcaster.handleBroadcasterRequest(incoming, outgoing);
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
