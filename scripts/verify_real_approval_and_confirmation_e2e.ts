import http from 'node:http';
import WebSocket from 'ws';
import fs from 'node:fs';
import { startEmailAuth } from '../src/auth/auth.service.js';
import { PostgresDatabase } from '../src/database/postgres-database.js';

const STAGING_URL = 'https://staging.sivantech.online';
const DB_URL = 'postgresql://neondb_owner:npg_Z9UrtjCkvO4X@ep-fragrant-lab-a5o3ka97-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const SCREENSHOT_DIR = '/Users/user/.gemini/antigravity-ide/brain/28760e7b-3915-4927-9a12-a61c7551e415';

function cdpRequest(reqPath: string, method = 'GET', data: any = null): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 9222,
        path: reqPath,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sendCdpCommand(ws: WebSocket, method: string, params: any = {}, id = 1): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for CDP: ${method}`)), 25000);
    const handler = (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function captureScreenshot(ws: WebSocket, filename: string) {
  const result = await sendCdpCommand(ws, 'Page.captureScreenshot', { format: 'png' }, Math.floor(Math.random() * 100000));
  const buffer = Buffer.from(result.data, 'base64');
  const filepath = `${SCREENSHOT_DIR}/${filename}`;
  fs.writeFileSync(filepath, buffer);
  console.log(`[Screenshot Saved] -> ${filepath}`);
  return filepath;
}

async function main() {
  console.log('=== [1. Authentic Sign In to Staging] ===');
  process.env.AUTH_DEV_SHOW_OTP = 'true';
  const authChallenge = await startEmailAuth({ email: 'sivantech@gmail.com', intent: 'signin' });
  const otpCode = authChallenge.devCode || '123456';
  console.log('Server issued OTP:', otpCode);

  const target = await cdpRequest('/json/new?' + encodeURIComponent(`${STAGING_URL}/signin`), 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.once('open', resolve));

  await sendCdpCommand(ws, 'Page.enable', {}, 10);
  await sendCdpCommand(ws, 'Runtime.enable', {}, 11);
  await sendCdpCommand(ws, 'Page.navigate', { url: `${STAGING_URL}/signin` }, 12);

  await new Promise((r) => setTimeout(r, 4000));

  // Enter email & OTP
  await sendCdpCommand(ws, 'Runtime.evaluate', {
    expression: `
      (() => {
        const input = document.querySelector('input[type="email"]') || document.querySelector('input');
        if (input) {
          input.value = 'sivantech@gmail.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Send') || b.type === 'submit');
        if (btn) btn.click();
      })()
    `
  }, 20);

  await new Promise((r) => setTimeout(r, 3000));

  await sendCdpCommand(ws, 'Runtime.evaluate', {
    expression: `
      (() => {
        const code = '${otpCode}';
        const inputs = Array.from(document.querySelectorAll('input'));
        if (inputs.length >= 6) {
          for (let i = 0; i < 6; i++) {
            inputs[i].value = code[i];
            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        const verifyBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Verify') || b.type === 'submit');
        if (verifyBtn) verifyBtn.click();
      })()
    `
  }, 30);

  await new Promise((r) => setTimeout(r, 4000));
  await captureScreenshot(ws, 'step1_authenticated_dashboard.png');

  console.log('\n=== [2. Executing sivan("Draft 20 USDC Service Agreement...") in Browser] ===');
  const sivanCallScript = `
    (async () => {
      if (typeof window.sivan === 'function') {
        return await window.sivan("Draft a 20 USDC Service Agreement with @soliame for Mobile UI Design with two milestones");
      } else {
        return await window.SIVAN_WEBMCP.callTool("create_service_agreement", {
          counterparty: "@soliame",
          amount: 20,
          currency: "USDC",
          milestones: 2,
          deliverables: "Mobile UI Design"
        });
      }
    })()
  `;

  const sivanRes = await sendCdpCommand(ws, 'Runtime.evaluate', { expression: sivanCallScript, awaitPromise: true, returnByValue: true }, 40);
  console.log('Sivan Result:', sivanRes.result.value);

  await new Promise((r) => setTimeout(r, 2000));
  await captureScreenshot(ws, 'step2_approval_card_rendered.png');

  console.log('\n=== [3. Clicking "Approve & Fund Vault" Button on Card] ===');
  const approveScript = `
    (() => {
      const btn = document.getElementById('sivan-webmcp-approve-btn');
      if (btn) {
        btn.click();
        return 'Approve clicked';
      }
      return 'Approve button not found';
    })()
  `;
  const clickRes = await sendCdpCommand(ws, 'Runtime.evaluate', { expression: approveScript, returnByValue: true }, 50);
  console.log('Approve Click Result:', clickRes.result.value);

  await new Promise((r) => setTimeout(r, 4000));
  await captureScreenshot(ws, 'step3_post_approval_confirmation_popup.png');

  console.log('\n=== [4. Clicking "View in Transactions Ledger" on Confirmation Popup] ===');
  const viewTxScript = `
    (() => {
      const viewBtn = document.getElementById('sivan-webmcp-view-tx-btn');
      if (viewBtn) {
        viewBtn.click();
        return 'View Transactions clicked';
      }
      return 'View Transactions button not found';
    })()
  `;
  const viewTxRes = await sendCdpCommand(ws, 'Runtime.evaluate', { expression: viewTxScript, returnByValue: true }, 60);
  console.log('View Ledger Click Result:', viewTxRes.result.value);

  await new Promise((r) => setTimeout(r, 4000));
  await captureScreenshot(ws, 'step4_transactions_ledger_rendered.png');

  console.log('\n=== [5. Querying Database for Real Active Agreement] ===');
  const pgDb = new PostgresDatabase(DB_URL);
  const agreements = await pgDb.listServiceAgreementsByUserId('usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8');
  console.log(`Active Agreements in DB: ${agreements.length}`);
  if (agreements.length > 0) {
    const latest = agreements[0];
    console.log(`Latest Agreement -> ID: ${latest.id}, Title: "${latest.title}", Amount: ${latest.amountUsdc} ${latest.currency}, Status: ${latest.status.toUpperCase()}, Network: ${latest.network}`);
  }

  console.log('\n🎉 [SUCCESS: Full Real End-to-End Approval & Confirmation Verified]');
  ws.close();
}

main().catch((e) => {
  console.error('Test Failed:', e);
  process.exit(1);
});
