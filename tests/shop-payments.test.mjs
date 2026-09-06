import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const shop = require('../src/services/shopPaymentService');

const wallet = new PublicKey('7P5t1uh64Kxh524jz1EMDhQNsnd7DxZju5gfjRtqxYUM');
const treasury = new PublicKey(shop.TREASURY);
const mint = new PublicKey(shop.TOKEN_MINT);
const config = { treasury, tokenMint: mint };
const quote = {
  id: 'quote-test-1',
  walletAddress: wallet.toBase58(),
  currency: 'sol',
  amountAtomic: '10000000',
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_120_000,
};

function transaction(instructions) {
  return {
    blockTime: 1_800_000_030,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: wallet.toBase58(), signer: true }],
        instructions: [
          ...instructions,
          {
            program: 'spl-memo',
            programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            parsed: 'BATC-SHOP-V1:quote-test-1',
          },
        ],
      },
    },
  };
}

test('shop mainnet constants target the production BATC treasury', () => {
  assert.equal(shop.NETWORK, 'mainnet-beta');
  assert.equal(shop.TOKEN_MINT, 'Hxs5gXuPHv3Jhm7PYQv9iFMQp5ZYL2Fk6bgWdvQz15bz');
  assert.equal(shop.TREASURY, '6wQz66BgRsX6DVHAD3PDCXjKVpe3LLrj3FGiQwCSZV7F');
});

test('verifies an exact SOL shop transfer', () => {
  assert.doesNotThrow(() => shop.verifyPayment(transaction([{
    program: 'system',
    parsed: {
      type: 'transfer',
      info: {
        source: wallet.toBase58(),
        destination: treasury.toBase58(),
        lamports: 10_000_000,
      },
    },
  }]), quote, config));
});

test('rejects a SOL transfer sent anywhere except the treasury', () => {
  assert.throws(() => shop.verifyPayment(transaction([{
    program: 'system',
    parsed: {
      type: 'transfer',
      info: {
        source: wallet.toBase58(),
        destination: wallet.toBase58(),
        lamports: 10_000_000,
      },
    },
  }]), quote, config), /does not match/);
});

test('verifies an exact Token-2022 BATC transfer to the treasury ATA', () => {
  const source = getAssociatedTokenAddressSync(
    mint, wallet, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    mint, treasury, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const tokenQuote = { ...quote, currency: 'token', amountAtomic: '150000000' };
  assert.doesNotThrow(() => shop.verifyPayment(transaction([{
    program: 'spl-token',
    programId: TOKEN_2022_PROGRAM_ID.toBase58(),
    parsed: {
      type: 'transferChecked',
      info: {
        authority: wallet.toBase58(),
        source: source.toBase58(),
        destination: destination.toBase58(),
        mint: mint.toBase58(),
        tokenAmount: { amount: '150000000', decimals: 6 },
      },
    },
  }]), tokenQuote, config));
});
