const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint } = require('@solana/spl-token');

function config() {
  const mint = String(process.env.BATTLECITY_SKR_MINT || '').trim();
  const decimals = Number(process.env.BATTLECITY_SKR_DECIMALS);
  const programId = String(process.env.BATTLECITY_SKR_TOKEN_PROGRAM || TOKEN_PROGRAM_ID.toBase58());
  if (!mint || process.env.BATTLECITY_SKR_DECIMALS === undefined) return null;
  try { new PublicKey(mint); } catch { throw new Error('Invalid SKR mint configuration.'); }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9
    || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(programId)) {
    throw new Error('Invalid SKR token configuration.');
  }
  return { mint, decimals, programId, currency: 'skr', network: 'mainnet-beta' };
}
function requireConfig() {
  const value = config();
  if (!value) throw new Error('SKR mint and decimals are not configured.');
  return value;
}
function atomic(value, decimals) {
  const text = String(value);
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,9})?$/.test(text)) throw new Error('Invalid token amount.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error('Amount exceeds token precision.');
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= 0n || amount > 18446744073709551615n) throw new Error('Token amount is out of range.');
  return amount;
}
async function validateMint(connection, token) {
  const mint = await getMint(connection, new PublicKey(token.mint), 'confirmed', new PublicKey(token.programId));
  if (mint.decimals !== token.decimals) throw new Error('Configured SKR precision differs from its mint.');
  return mint;
}
module.exports = { config, requireConfig, atomic, validateMint };
