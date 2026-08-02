declare const require: any;

const playerStore = require('../stores/playerStore');
const sessionIdentity = require('../services/sessionIdentity');
const sessionStore = require('../stores/sessionStore');

const ADMIN_EMAILS = new Set(['tassaduq009@gmail.com']);

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
  if (session.provider !== 'google' || !ADMIN_EMAILS.has(email)) {
    return { ok: false, status: 403, email: email || null };
  }

  const player = await playerStore.readPlayer(session.playerId);
  if (player === null) {
    return { ok: false, status: 401, email: null };
  }

  return { ok: true, session, player, email };
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
