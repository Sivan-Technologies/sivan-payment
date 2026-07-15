import crypto from 'node:crypto';
import { verifyBridgeWebhookSignature } from '../src/providers/bridge/bridge.webhooks.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const body = Buffer.from(JSON.stringify({ event_id: 'wh_test', event_category: 'liquidation_address.drain' }));
const timestamp = Date.now().toString();
const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const digest = crypto.createHash('sha256').update(signedPayload).digest();
const bridgeStyleSigner = crypto.createSign('RSA-SHA256');
bridgeStyleSigner.update(digest);
bridgeStyleSigner.end();
const bridgeStyleHeader = `t=${timestamp},v0=${bridgeStyleSigner.sign(privateKey).toString('base64')}`;

const rawSignature = crypto.sign('RSA-SHA256', signedPayload, privateKey).toString('base64');
const rawHeader = `t=${timestamp},v0=${rawSignature}`;

const staleHeader = `t=${Date.now() - 20 * 60 * 1000},v0=${rawSignature}`;
const badHeader = `t=${timestamp},v0=${Buffer.from('bad-signature').toString('base64')}`;

const results = {
  bridgeStyleOk: verifyBridgeWebhookSignature(body, bridgeStyleHeader, pem),
  rawFallbackOk: verifyBridgeWebhookSignature(body, rawHeader, pem),
  staleRejected: !verifyBridgeWebhookSignature(body, staleHeader, pem),
  badRejected: !verifyBridgeWebhookSignature(body, badHeader, pem)
};

console.log(JSON.stringify(results, null, 2));

if (!Object.values(results).every(Boolean)) {
  process.exit(1);
}
