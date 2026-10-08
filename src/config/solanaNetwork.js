// Mainnet remains the default. Devnet must be explicitly selected for an
// isolated test deployment, never inferred from a request or wallet address.
function network() {
  const value = process.env.BATTLECITY_SOLANA_NETWORK || 'mainnet-beta';
  if (value === 'mainnet-beta') return value;
  if (value === 'devnet' && process.env.BATTLECITY_ENVIRONMENT === 'devnet') return value;
  throw new Error('Invalid or unisolated Solana network configuration.');
}
function publicRpcUrl() {
  return network() === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
}
function assertRpcUrl(url) {
  if (network() === 'devnet' && url !== publicRpcUrl()) throw new Error('Devnet must use the Devnet RPC endpoint.');
  return url;
}
module.exports = { network, publicRpcUrl, assertRpcUrl };
