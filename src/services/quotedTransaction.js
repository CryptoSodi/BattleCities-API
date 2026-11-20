'use strict';

const { VersionedTransaction } = require('@solana/web3.js');

// The immutable Lighthouse v2 program's account-info and token-account
// assertion variants. MemoryWrite/MemoryClose are deliberately excluded.
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const ASSERTIONS = new Set([6, 10]);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function matchesApprovedTransaction(originalBytes, signedBytes) {
  try {
    const original = VersionedTransaction.deserialize(originalBytes);
    const signed = VersionedTransaction.deserialize(signedBytes);
    if (original.version !== 'legacy' || signed.version !== 'legacy') return false;
    const before = original.message, after = signed.message;
    if (before.header.numRequiredSignatures !== 1 || after.header.numRequiredSignatures !== 1
      || before.staticAccountKeys[0].toBase58() !== after.staticAccountKeys[0].toBase58()
      || before.recentBlockhash !== after.recentBlockhash) return false;
    const beforeKeys = before.staticAccountKeys.map(k => k.toBase58());
    const afterKeys = after.staticAccountKeys.map(k => k.toBase58());
    if (new Set(beforeKeys).size !== beforeKeys.length || new Set(afterKeys).size !== afterKeys.length) return false;
    for (let i = 0; i < beforeKeys.length; i++) {
      const j = afterKeys.indexOf(beforeKeys[i]);
      if (j < 0 || before.isAccountSigner(i) !== after.isAccountSigner(j)
        || before.isAccountWritable(i) !== after.isAccountWritable(j)) return false;
    }
    for (let i = 0; i < afterKeys.length; i++) {
      if (!beforeKeys.includes(afterKeys[i]) && (after.isAccountSigner(i) || after.isAccountWritable(i))) return false;
    }
    const resolve = (m, keys, ix) => ({
      program: keys[ix.programIdIndex],
      accounts: Array.from(ix.accountKeyIndexes, i => keys[i]),
      data: ix.data,
    });
    const expected = before.compiledInstructions.map(ix => resolve(before, beforeKeys, ix));
    let index = 0, assertions = 0;
    for (const ix of after.compiledInstructions.map(ix => resolve(after, afterKeys, ix))) {
      if (!ix.program || ix.accounts.some(k => !k)) return false;
      const want = expected[index];
      if (want && ix.program === want.program && sameBytes(ix.accounts, want.accounts)
        && sameBytes(ix.data, want.data)) { index++; continue; }
      if (ix.program !== LIGHTHOUSE || !ASSERTIONS.has(ix.data[0]) || ix.accounts.length !== 1
        || ++assertions > 16) return false;
    }
    return index === expected.length;
  } catch { return false; }
}

module.exports = { matchesApprovedTransaction };
