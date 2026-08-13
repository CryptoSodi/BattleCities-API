// Only wallet and Google identities may act as API players. Keep this guard at
// economic/ranking boundaries even though the session store enforces the same
// provider allow-list.

function isVirtualPlayer(player) {
  return (
    typeof player !== 'object' ||
    player === null ||
    (player.provider !== 'wallet' && player.provider !== 'google')
  );
}

const VIRTUAL_PLAYER_MESSAGE =
  'A wallet or Google account is required for this action';

module.exports = { isVirtualPlayer, VIRTUAL_PLAYER_MESSAGE };
