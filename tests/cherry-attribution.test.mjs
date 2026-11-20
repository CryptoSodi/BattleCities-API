import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram } from '@solana/web3.js';
import attribution from '../src/services/cherryAttribution.js';

test('attribution adds a read-only non-signer account only for Cherry', () => {
  const ix = SystemProgram.transfer({fromPubkey:Keypair.generate().publicKey,toPubkey:Keypair.generate().publicKey,lamports:1});
  const initial = ix.keys.length;
  attribution.attributeTransfer(ix, false);
  assert.equal(ix.keys.length, initial);
  attribution.attributeTransfer(ix, true);
  attribution.attributeTransfer(ix, true);
  assert.equal(ix.keys.length, initial + 1);
  assert.equal(ix.keys[initial].pubkey.toBase58(), attribution.reference.toBase58());
  assert.equal(ix.keys[initial].isSigner, false);
  assert.equal(ix.keys[initial].isWritable, false);
});
