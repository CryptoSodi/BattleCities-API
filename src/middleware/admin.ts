declare const require: any;

const playerStore = require('../stores/playerStore');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

const ADMIN_WALLETS = new Set([
  '9YpW9nYJaUVhRwqWaJBBh9wkjCYh5RLr6krYvfr7GGKo',
  '7P5t1uh64Kxh524jz1EMDhQNsnd7DxZju5gfjRtqxYUM',
]);

export type AdminAuthorization =
  | {
      ok: true;
      session: any;
      player: any;
      walletAddress: string;
    }
  | {
      ok: false;
      status: 401 | 403;
      walletAddress: string | null;
    };

export async function authorizeAdminRequest(
  request: Request,
): Promise<AdminAuthorization> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (sessionId === null) {
    return { ok: false, status: 401, walletAddress: null };
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return { ok: false, status: 401, walletAddress: null };
  }

  const walletAddress = normalizeWalletAddress(session.walletAddress);
  if (session.provider !== 'wallet' || !ADMIN_WALLETS.has(walletAddress)) {
    return { ok: false, status: 403, walletAddress: walletAddress || null };
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null || player.provider !== 'wallet' || player.walletAddress !== walletAddress) {
    return { ok: false, status: 401, walletAddress: null };
  }

  return { ok: true, session, player, walletAddress };
}

function normalizeWalletAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
