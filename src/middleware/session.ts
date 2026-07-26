declare const require: any;

const playerStore = require('../stores/playerStore');
const sessionStore = require('../stores/sessionStore');
const sessionIdentity = require('../services/sessionIdentity');

// Resolves the authenticated session cookie to its canonical player record.
export async function resolveSessionPlayer(request: Request): Promise<any> {
  const sessionId = sessionIdentity.resolveSession(
    request.headers.get('cookie') || '',
  );
  if (sessionId === null) {
    return null;
  }

  const session = await sessionStore.readSession(sessionId);
  if (session === null || session.playerId === null) {
    return null;
  }

  return playerStore.readPlayer(session.playerId);
}
