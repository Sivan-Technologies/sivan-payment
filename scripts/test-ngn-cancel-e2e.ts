/** Boots the app and exercises the real cancel route. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { nowIso, id } from '../src/shared/id.js';

const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
await fs.rm(dbPath, { force: true });
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const addr: any = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;
let token = ''; let userId = '';

async function req(m: string, u: string, b?: unknown) {
  const r = await fetch(base + u, { method: m, headers: { ...(b?{'Content-Type':'application/json'}:{}) , ...(token?{Authorization:`Bearer ${token}`}:{}) }, body: b?JSON.stringify(b):undefined });
  return { status: r.status, body: await r.json().catch(()=>({})) };
}

const email = `cancel-${Date.now()}@sivan.test`;
const s = await req('POST','/api/auth/email/start',{ email, fullName:'Cancel Test', intent:'signup', legalAcceptance:{accepted:true,termsVersion:'t',privacyVersion:'p',riskDisclosureVersion:'r'} });
const v = await req('POST','/api/auth/email/verify',{ email, code:(s.body as any).data.devCode });
token=(v.body as any).data.token; userId=(v.body as any).data.user.id;

// Seed an unfunded off-ramp exactly like a real one, network in quoteMetadata.
const t: any = { id:id('ngnt'), quoteId:id('ngnq'), userId, direction:'offramp', provider:'breet',
  sourceCurrency:'usdc', destinationCurrency:'ngn', sourceAmount:'50', destinationAmount:'82473.04',
  rate:'1649', feeAmount:'414', status:'awaiting_crypto_deposit',
  depositAddress:'AVXsBHMhRtc5LqoLTvaQBX7oUayS4f3h1TrATUX1v7Df',
  metadata:{ quoteMetadata:{ network:'solana', breet:true } },
  createdAt:nowIso(), updatedAt:nowIso() };
await db.upsertNgnTransferRecord(t);

let p=0,f=0; const ck=(n:string,ok:any,d='')=>{ ok?(p++,console.log('  ok   '+n)):(f++,console.log('  FAIL '+n+(d?' -> '+d:''))); };

const list = await req('GET',`/api/users/${userId}/ngn-transfers`);
const row:any = (list.body as any).data[0];
ck('network is exposed on the API', row.network === 'solana', String(row.network));
ck('expiresAt is present for an unfunded order', Boolean(row.expiresAt), String(row.expiresAt));
ck('it is ~24h out', Math.abs((Date.parse(row.expiresAt)-Date.now())/3600000 - 24) < 0.1, String((Date.parse(row.expiresAt)-Date.now())/3600000));
ck('cancellable is true', row.cancellable === true);

// Another user must not cancel it.
const e2 = `other-${Date.now()}@sivan.test`;
const s2 = await req('POST','/api/auth/email/start',{ email:e2, fullName:'Other', intent:'signup', legalAcceptance:{accepted:true,termsVersion:'t',privacyVersion:'p',riskDisclosureVersion:'r'} });
const v2 = await req('POST','/api/auth/email/verify',{ email:e2, code:(s2.body as any).data.devCode });
const keep = token; token=(v2.body as any).data.token; const otherId=(v2.body as any).data.user.id;
const steal = await req('POST',`/api/users/${otherId}/ngn-transfers/${t.id}/cancel`,{});
ck('another user cannot cancel it', steal.status >= 400, String(steal.status));
token = keep;

const ok = await req('POST',`/api/users/${userId}/ngn-transfers/${t.id}/cancel`,{ reason:'changed my mind' });
ck('the owner can cancel', ok.status === 200, JSON.stringify(ok.body).slice(0,160));
ck('status becomes cancelled', (ok.body as any).data?.status === 'cancelled', String((ok.body as any).data?.status));
ck('cancelling twice is refused', (await req('POST',`/api/users/${userId}/ngn-transfers/${t.id}/cancel`,{})).status === 400);

// Funded order must refuse.
const t2:any = { ...t, id:id('ngnt'), status:'awaiting_crypto_deposit', destinationTxHash:'0xdead', createdAt:nowIso(), updatedAt:nowIso() };
await db.upsertNgnTransferRecord(t2);
const funded = await req('POST',`/api/users/${userId}/ngn-transfers/${t2.id}/cancel`,{});
ck('an order with crypto on chain REFUSES cancel', funded.status === 400, String(funded.status));
ck('and says why', /already on the way/i.test(JSON.stringify(funded.body)), JSON.stringify(funded.body).slice(0,160));
const l2 = await req('GET',`/api/users/${userId}/ngn-transfers`);
const fundedRow:any = (l2.body as any).data.find((r:any)=>r.id===t2.id);
ck('a funded order is not marked cancellable', fundedRow.cancellable === false);
ck('and carries no expiry countdown', !fundedRow.expiresAt);

await app.close();
console.log(`\n${f===0?'✅':'❌'} ${p} passed, ${f} failed\n`);
process.exit(f===0?0:1);
