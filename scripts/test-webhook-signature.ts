import crypto from 'node:crypto';
import { verifyBridgeWebhookSignature } from '../src/providers/bridge/bridge.webhooks.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const body = Buffer.from(JSON.stringify({ event_id: 'wh_test', event_category: 'liquidation_address.drain' }));
const timestamp = Date.now().toString();
const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
const signature = crypto.sign('RSA-SHA256', signedPayload, privateKey).toString('base64');
const header = `t=${timestamp},v0=${signature}`;
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
console.log({ ok: verifyBridgeWebhookSignature(body, header, pem) });
