import assert from 'node:assert/strict';
import { buildOnrampCapabilities } from '../src/onramp/service/onramp-capabilities.js';
const controls = {
  payoutCurrencies: [{currency:'usd',enabled:true},{currency:'eur',enabled:false},{currency:'ngn',enabled:true}],
  sourceAssets: [{asset:'usdc',enabled:true},{asset:'usdt',enabled:true}],
  sourceNetworks: [{network:'base',enabled:true},{network:'ethereum',enabled:false},{network:'solana',enabled:true},{network:'celo',enabled:true}],
};
const supports = (asset:string, network:string) => !(asset === 'usdt' && network === 'base');
const available = buildOnrampCapabilities(controls,true,supports);
assert.deepEqual(available.currencies,[{currency:'usd',rails:['ach_push']}]);
assert.deepEqual(available.assets,[{asset:'usdc',networks:['base','solana']},{asset:'usdt',networks:['solana']}]);
assert.deepEqual(buildOnrampCapabilities(controls,false,supports),{enabled:false,requiresIdentityVerification:true,currencies:[],assets:[]});
assert.deepEqual(buildOnrampCapabilities({...controls,sourceNetworks:[]},true,supports).assets,[]);
assert.deepEqual(buildOnrampCapabilities({...controls,sourceAssets:[{asset:'usdt',enabled:false}]},true,supports).assets,[]);
console.log('On-ramp capability contract checks passed (isolated; no provider or database calls).');
