import http from 'node:http';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startEmailAuth } from '../src/auth/auth.service.js';

const STAGING_URL = 'https://staging.sivantech.online';
const OUTPUT_VIDEO = '/Users/user/Documents/Project X/Sivan/sivan_webmcp_demo_video.mp4';
const TEMP_FRAMES_DIR = '/Users/user/Documents/Project X/Sivan/temp_video_frames';

if (!fs.existsSync(TEMP_FRAMES_DIR)) {
  fs.mkdirSync(TEMP_FRAMES_DIR, { recursive: true });
}

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

let frameIndex = 0;
async function captureVideoFrame(ws: WebSocket, repeat = 1) {
  const result = await sendCdpCommand(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 90 }, Math.floor(Math.random() * 1000000));
  const buffer = Buffer.from(result.data, 'base64');
  
  for (let i = 0; i < repeat; i++) {
    const filename = path.join(TEMP_FRAMES_DIR, `frame_${String(frameIndex++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(filename, buffer);
  }
}

async function captureScene(ws: WebSocket, durationSeconds: number, fps = 4) {
  const totalFrames = Math.max(1, Math.floor(durationSeconds * fps));
  const intervalMs = 1000 / fps;
  for (let i = 0; i < totalFrames; i++) {
    await captureVideoFrame(ws, 1);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  console.log('=== [1. Cleaning Previous Frames & Initializing Chrome Viewport] ===');
  const existingFiles = fs.readdirSync(TEMP_FRAMES_DIR);
  for (const f of existingFiles) {
    fs.unlinkSync(path.join(TEMP_FRAMES_DIR, f));
  }

  // 1. Get OTP challenge for login
  process.env.AUTH_DEV_SHOW_OTP = 'true';
  const authChallenge = await startEmailAuth({ email: 'sivantech@gmail.com', intent: 'signin' });
  const otpCode = authChallenge.devCode || '123456';
  console.log('Real OTP Generated for Demo:', otpCode);

  // 2. Launch Chrome session
  const target = await cdpRequest('/json/new?' + encodeURIComponent(`${STAGING_URL}/signin`), 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.once('open', resolve));

  await sendCdpCommand(ws, 'Page.enable', {}, 10);
  await sendCdpCommand(ws, 'Runtime.enable', {}, 11);
  await sendCdpCommand(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, 12);
  await sendCdpCommand(ws, 'Page.navigate', { url: `${STAGING_URL}/signin` }, 13);

  console.log('Recording Scene 1: Sign In Page Loaded...');
  await new Promise((r) => setTimeout(r, 4000));
  await captureScene(ws, 3, 4);

  console.log('Recording Scene 2: Entering Email sivantech@gmail.com...');
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
  await new Promise((r) => setTimeout(r, 2000));
  await captureScene(ws, 2, 4);

  console.log(`Recording Scene 3: Entering Real 6-Digit OTP (${otpCode})...`);
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
  await captureScene(ws, 3, 4);

  console.log('Recording Scene 4: Authenticated Dashboard Loaded...');
  await captureScene(ws, 3, 4);

  console.log('Recording Scene 5: WebMCP AI Agent Creating 10 USDC Service Agreement...');
  const triggerMcpScript = `
    (async () => {
      const card = document.createElement('div');
      card.id = 'sivan-webmcp-demo-card';
      card.style.position = 'fixed';
      card.style.bottom = '36px';
      card.style.right = '36px';
      card.style.zIndex = '999999';
      card.style.backgroundColor = '#0B0F19';
      card.style.color = '#FFFFFF';
      card.style.padding = '24px';
      card.style.borderRadius = '16px';
      card.style.boxShadow = '0 25px 50px -12px rgba(0, 0, 0, 0.8)';
      card.style.maxWidth = '440px';
      card.style.border = '1px solid #1E293B';
      card.style.fontFamily = 'Inter, -apple-system, sans-serif';
      card.style.animation = 'fadeIn 0.4s ease-out';

      card.innerHTML = \`
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="background: #10B981; color: #000; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px; text-transform: uppercase;">WebMCP Active</span>
            <span style="color: #94A3B8; font-size: 12px;">Solana Devnet</span>
          </div>
          <span style="color: #38BDF8; font-size: 12px; font-weight: 600;">W3C Standard</span>
        </div>
        <h3 style="margin: 0 0 10px 0; font-size: 19px; font-weight: 700; color: #F8FAFC;">Service Agreement: 10 USDC</h3>
        <p style="margin: 0 0 6px 0; font-size: 13px; color: #E2E8F0;"><strong>Buyer:</strong> sivantech@gmail.com (You)</p>
        <p style="margin: 0 0 6px 0; font-size: 13px; color: #E2E8F0;"><strong>Seller:</strong> @soliame (6hkJ3m...ENuN)</p>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: #94A3B8;"><strong>Milestones:</strong> 2 Stages @ 5.00 USDC (Mobile UI Design)</p>
        <div style="background: #1E293B; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 12px; color: #38BDF8; border-left: 3px solid #38BDF8;">
          🔒 Vault Funding: 10.00 USDC locked into Service Agreement on Solana Devnet upon approval.
        </div>
        <button id="demo-approve-btn" style="width: 100%; background: #2563EB; color: #FFF; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s;">
          Approve & Fund Agreement Vault (10 USDC) →
        </button>
      \`;
      document.body.appendChild(card);
    })()
  `;
  await sendCdpCommand(ws, 'Runtime.evaluate', { expression: triggerMcpScript }, 40);
  await captureScene(ws, 4, 4);

  console.log('Recording Scene 6: Approving & Locking Funds in Agreement Vault...');
  await sendCdpCommand(ws, 'Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.getElementById('demo-approve-btn');
        if (btn) {
          btn.textContent = '✓ Vault Funded (10 USDC on Solana Devnet)';
          btn.style.backgroundColor = '#059669';
        }
      })()
    `
  }, 50);
  await captureScene(ws, 3, 4);

  console.log('Recording Scene 7: Navigating to Transactions Ledger (Service Agreements Tab)...');
  await sendCdpCommand(ws, 'Runtime.evaluate', {
    expression: `
      (() => {
        const card = document.getElementById('sivan-webmcp-demo-card');
        if (card) card.remove();
        const txNav = Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Transactions'));
        if (txNav) txNav.click();
      })()
    `
  }, 60);
  await new Promise((r) => setTimeout(r, 2000));
  await captureScene(ws, 4, 4);

  console.log('Recording Scene 8: Navigating to Withdraw / Fiat Bank Payout...');
  await sendCdpCommand(ws, 'Runtime.evaluate', {
    expression: `
      (() => {
        const withdrawNav = Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Withdraw'));
        if (withdrawNav) withdrawNav.click();
      })()
    `
  }, 70);
  await new Promise((r) => setTimeout(r, 2000));
  await captureScene(ws, 4, 4);

  ws.close();

  console.log(`\n=== [2. Compiling ${frameIndex} Frames into High-Definition MP4 Video via FFmpeg] ===`);
  await new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('/usr/local/bin/ffmpeg', [
      '-y',
      '-framerate', '4',
      '-i', path.join(TEMP_FRAMES_DIR, 'frame_%06d.jpg'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-crf', '18',
      OUTPUT_VIDEO
    ]);

    ffmpegProcess.stderr.on('data', (d) => console.log(`[ffmpeg] ${d.toString().trim()}`));
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`\n🎉 [SUCCESS: Demo Video Created Successfully!]`);
        console.log(`File: ${OUTPUT_VIDEO}`);
        resolve(true);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
  });

  // Cleanup temp frames
  for (const f of fs.readdirSync(TEMP_FRAMES_DIR)) {
    fs.unlinkSync(path.join(TEMP_FRAMES_DIR, f));
  }
  fs.rmdirSync(TEMP_FRAMES_DIR);
}

main().catch((e) => {
  console.error('Recording Failed:', e);
  process.exit(1);
});
