const { PublicKey } = require('@solana/web3.js');
const { getAppReferenceKeyBytes } = require('@cherrydotfun/miniapp-sdk');
const { APP_ID } = require('./cherryAuth');

const reference = new PublicKey(getAppReferenceKeyBytes(APP_ID));

// Apply to the transfer before simulation and quote hashing. The caller must
// derive isCherrySession from verified server-side session state, never input.
function attributeTransfer(instruction, isCherrySession) {
  if (!isCherrySession) return instruction;
  if (!instruction || !Array.isArray(instruction.keys)) throw new Error('Cannot attribute payment');
  if (!instruction.keys.some(key => key.pubkey.equals(reference))) {
    instruction.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  }
  return instruction;
}

module.exports = { attributeTransfer, reference };
