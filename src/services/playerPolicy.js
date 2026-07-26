// Who counts as a REAL player vs a VIRTUAL one.
//
// Guest accounts are throwaway identities with unlimited fuel/items (see
// economyStore's guest provisioning) — they exist so anyone can try the full
// game instantly. That makes them meaningless as competitors and dangerous as
// economic actors, so they are fenced off server-side:
//   - their match results never enter leaderboards or rank calculations,
//   - they cannot claim quest rewards, stake, record trading volume, or hold
//     airdrop eligibility/allocations.
// Wallet and Google logins are real players.

function isVirtualPlayer(player) {
  return (
    typeof player !== 'object' || player === null || player.provider === 'guest'
  );
}

const VIRTUAL_PLAYER_MESSAGE =
  'Guest accounts are unranked - log in with a wallet or Google to compete';

module.exports = { isVirtualPlayer, VIRTUAL_PLAYER_MESSAGE };
