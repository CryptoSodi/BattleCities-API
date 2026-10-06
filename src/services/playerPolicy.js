// Guests have saved progress and inventory. Wallet verification is required
// for on-chain purchases, social rewards and competition prizes.
function isVirtualPlayer(player) {
  return !player || player.provider !== 'wallet';
}
const VIRTUAL_PLAYER_MESSAGE = 'Wallet login is required for this action';
module.exports = { isVirtualPlayer, VIRTUAL_PLAYER_MESSAGE };
