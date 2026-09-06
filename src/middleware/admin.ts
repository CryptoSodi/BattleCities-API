declare const require: any;

const playerStore = require('../stores/playerStore');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

const ADMIN_EMAILS = new Set(['tassaduq009@gmail.com']);
const ADMIN_WALLETS = new Set([
  '9YpW9nYJaUVhRwqWaJBBh9wkjCYh5RLr6krYvfr7GGKo',
  '7P5t1uh64Kxh524jz1EMDhQNsnd7DxZju5gfjRtqxYUM',
]);

export type AdminAuthorization =
  | {
      ok: true;
      session: any;
      player: any;
      email: string;
    }
  | {
      ok: false;
      status: 401 | 403;
      email: string | null;
    };

export async function authorizeAdminRequest(
  request: Request,
): Promise<AdminAuthorization> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (sessionId === null) {
    return { ok: false, status: 401, email: null };
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return { ok: false, status: 401, email: null };
  }

  const email = normalizeEmail(session.googleEmail);
  const walletAddress = normalizeWalletAddress(session.walletAddress);
  const hasAdminEmail =
    session.provider === 'google' && ADMIN_EMAILS.has(email);
  const hasAdminWallet =
    session.provider === 'wallet' && ADMIN_WALLETS.has(walletAddress);
  if (!hasAdminEmail && !hasAdminWallet) {
    return { ok: false, status: 403, email: email || walletAddress || null };
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return { ok: false, status: 401, email: null };
  }

  return { ok: true, session, player, email: email || walletAddress };
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeWalletAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
