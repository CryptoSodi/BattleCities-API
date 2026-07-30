declare const require: any;

import { createJsonResponse } from '../../_helpers';

const nodeCrypto = require('crypto');
const discordVerificationStore = require('../../../stores/discordVerificationStore');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export async function POST(request: Request): Promise<Response> {
  const publicKeyHex = String(
    process.env.DISCORD_APPLICATION_PUBLIC_KEY ||
      process.env.DISCORD_APP_PUBLIC_KEY ||
      process.env.DISCORD_PUBLIC_KEY ||
      '',
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

  if (
    !isValidDiscordSignature(publicKeyHex, signatureHex, timestamp, rawBody)
  ) {
    return createJsonResponse(
      request,
      { error: 'Invalid request signature' },
      401,
    );
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

  if (interaction?.type === 2 && interaction?.data?.name === 'verify') {
    return handleVerifyCommand(request, interaction);
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

async function handleVerifyCommand(
  request: Request,
  interaction: any,
): Promise<Response> {
  const expectedGuildId = String(process.env.DISCORD_GUILD_ID || '').trim();
  if (expectedGuildId === '' || interaction.guild_id !== expectedGuildId) {
    return discordMessage(
      request,
      'This command is only available in the Battle Cities server.',
    );
  }

  const code = interaction.data?.options?.find(
    (option: any) => option?.name === 'code',
  )?.value;
  const user = interaction.member?.user || interaction.user;
  const result = await discordVerificationStore.verifyCode(
    code,
    user?.id,
    user?.global_name || user?.username,
  );
  return discordMessage(
    request,
    result.ok
      ? 'Discord verified. Return to Battle Cities to see your completed quest.'
      : result.error || 'Discord verification failed.',
  );
}

function discordMessage(request: Request, content: string): Response {
  return createJsonResponse(request, {
    type: 4,
    data: { content, flags: 64 },
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
