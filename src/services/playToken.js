const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const network = require('../config/solanaNetwork');
const MINT = 'PLAYs3GSSadH2q2JLS7djp7yzeT75NK78XgrE5YLrfq';
function config() {
  return network.network() === 'mainnet-beta'
    ? { mint: MINT, decimals: 6, programId: TOKEN_PROGRAM_ID.toBase58(), currency: 'play', network: network.network() }
    : null;
}
function requireConfig() { const value = config(); if (!value) throw new Error('PLAY payments are available on mainnet only.'); return value; }
module.exports = { MINT, config, requireConfig };
