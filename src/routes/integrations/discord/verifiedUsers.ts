declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../../_helpers';

const crypto = require('crypto');
const discordVerificationStore = require('../../../stores/discordVerificationStore');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function GET(
  request: Request,
  discordUserId: string,
): Promise<Response> {
  const configuredToken = String(
    process.env.DISCORD_BOT_SERVICE_TOKEN || '',
  ).trim();
  if (configuredToken === '') {
    return createJsonResponse(
      request,
      { ok: false, error: 'Discord bot verification is not configured' },
      503,
    );
  }

  if (!tokensMatch(configuredToken, readBearerToken(request))) {
    return createJsonResponse(request, { ok: false, error: 'Forbidden' }, 403);
  }

  if (!/^\d{16,22}$/.test(discordUserId)) {
    return createJsonResponse(
      request,
      { ok: false, error: 'Invalid Discord user ID' },
      400,
    );
  }

  const verified = await discordVerificationStore.isDiscordUserVerified(
    discordUserId,
  );
  return createJsonResponse(request, {
    ok: true,
    discordUserId,
    verified,
  });
}

function readBearerToken(request: Request): string {
  const authorization = String(request.headers.get('authorization') || '');
  return authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
}

function tokensMatch(expected: string, supplied: string): boolean {
  if (expected === '' || supplied === '') {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}
