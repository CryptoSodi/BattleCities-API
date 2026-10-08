import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const network=require('../src/config/solanaNetwork.js');
test('production defaults to Mainnet; Devnet requires isolation and rejects Mainnet RPC', () => {
  const previous={network:process.env.BATTLECITY_SOLANA_NETWORK,environment:process.env.BATTLECITY_ENVIRONMENT};
  try {
    delete process.env.BATTLECITY_SOLANA_NETWORK; delete process.env.BATTLECITY_ENVIRONMENT;
    assert.equal(network.network(),'mainnet-beta');
    assert.equal(network.publicRpcUrl(),'https://api.mainnet-beta.solana.com');
    process.env.BATTLECITY_SOLANA_NETWORK='devnet';
    assert.throws(()=>network.network(),/unisolated/);
    process.env.BATTLECITY_ENVIRONMENT='devnet';
    assert.equal(network.network(),'devnet');
    assert.equal(network.assertRpcUrl('https://api.devnet.solana.com'),'https://api.devnet.solana.com');
    assert.throws(()=>network.assertRpcUrl('https://api.mainnet-beta.solana.com'),/Devnet RPC/);
    process.env.BATTLECITY_SOLANA_NETWORK='testnet';
    assert.throws(()=>network.network(),/Invalid/);
  } finally {
    for(const [key,value] of [['BATTLECITY_SOLANA_NETWORK',previous.network],['BATTLECITY_ENVIRONMENT',previous.environment]]) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
