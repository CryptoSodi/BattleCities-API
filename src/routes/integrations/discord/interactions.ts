declare const require: any;

import { createJsonResponse } from '../../_helpers';

const nodeCrypto = require('crypto');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export async function POST(request: Request): Promise<Response> {
  const publicKeyHex = String(
    process.env.DISCORD_APPLICATION_PUBLIC_KEY || '',
  ).trim();
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
    return createJsonResponse(
      request,
      { error: 'Discord interactions are not configured' },
      503,
    );
  }

  const signatureHex = request.headers.get('x-signature-ed25519') || '';
  const timestamp = request.headers.get('x-signature-timestamp') || '';
  const rawBody = await request.text();

  if (!isValidDiscordSignature(publicKeyHex, signatureHex, timestamp, rawBody)) {
    return createJsonResponse(request, { error: 'Invalid request signature' }, 401);
  }

  let interaction: any;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return createJsonResponse(request, { error: 'Invalid JSON' }, 400);
  }

  // Discord sends type 1 while validating the configured endpoint URL.
  if (interaction?.type === 1) {
    return createJsonResponse(request, { type: 1 });
  }

  // Keep the endpoint valid while the /verify command flow is being built.
  return createJsonResponse(request, {
    type: 4,
    data: {
      content: 'Battle Cities verification is not available yet.',
      flags: 64,
    },
  });
}

function isValidDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): boolean {
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || timestamp === '') {
    return false;
  }

  try {
    const publicKey = nodeCrypto.createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(publicKeyHex, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    return nodeCrypto.verify(
      null,
      Buffer.from(`${timestamp}${rawBody}`),
      publicKey,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}
