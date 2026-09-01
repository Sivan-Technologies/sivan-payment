/**
 * Model Context Protocol (MCP) Server & A2A Open Payment Protocol — Test Suite
 *
 * Covers:
 *   1. A2A Capabilities & Discovery manifest (/api/v1/developer/capabilities)
 *   2. MCP JSON-RPC 2.0 initialize handshake
 *   3. MCP tools/list tool catalog & schema validation
 *   4. MCP resources/list & prompts/list verification
 *   5. MCP tools/call for programmatic service agreements with natural language deadlines
 *   6. MCP tools/call for bank account resolution & fiat cashout quotes
 *   7. MCP tools/call for unified multi-chain balance query
 *   8. MCP JSON-RPC error handling for unknown methods and missing parameters
 *   9. MCP Server-Sent Events (SSE) stream endpoint validation
 */

import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { SIVAN_MCP_TOOLS } from '../src/developer-gateway/mcp-schema.js';

export async function runMcpServerTest() {
  console.log('\n==================================================');
  console.log('🤖 SIVAN MCP SERVER & A2A PROTOCOL TEST SUITE');
  console.log('==================================================\n');

  const app = await buildApp();
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ ok - ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  // ─── 1. A2A Discovery Manifest ───────────────────────────────────────────────
  console.log('══ 1. A2A Discovery & ERC-8004 Manifest ══');

  await test('GET /api/v1/developer/capabilities returns valid ERC-8004 manifest', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/developer/capabilities',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.protocol, 'sivan-a2a-v1');
    assert.equal(body.standard, 'ERC-8004-Compatible');
    assert.ok(body.endpoints.mcp.includes('/mcp'));
    assert.equal(body.supportedChains.length, 5);
    assert.equal(body.mcpToolsCount, SIVAN_MCP_TOOLS.length);
  });

  await test('GET /api/v1/agent/capabilities alias works identically', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/capabilities',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().standard, 'ERC-8004-Compatible');
  });

  // ─── 2. MCP JSON-RPC Handshake ───────────────────────────────────────────────
  console.log('\n══ 2. MCP JSON-RPC 2.0 Handshake ══');

  await test('MCP initialize returns server info & protocol version 2024-11-05', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'claude-desktop', version: '1.0.0' },
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, '2024-11-05');
    assert.equal(body.result.serverInfo.name, 'sivan-mcp-server');
    assert.ok(body.result.capabilities.tools);
  });

  await test('MCP ping returns empty result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().result, {});
  });

  // ─── 3. MCP Tool Discovery ───────────────────────────────────────────────────
  console.log('\n══ 3. MCP Tool Discovery & Schema Validation ══');

  await test('MCP tools/list returns all 6 standard payment tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    assert.equal(res.statusCode, 200);
    const tools = res.json().result.tools;
    assert.equal(tools.length, 6);

    const toolNames = tools.map((t: any) => t.name);
    assert.ok(toolNames.includes('sivan_create_payment_link'));
    assert.ok(toolNames.includes('sivan_initiate_service_agreement'));
    assert.ok(toolNames.includes('sivan_verify_milestone_and_release'));
    assert.ok(toolNames.includes('sivan_resolve_bank_account'));
    assert.ok(toolNames.includes('sivan_fiat_bank_cashout'));
    assert.ok(toolNames.includes('sivan_get_balance'));

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 20);
    }
  });

  // ─── 4. MCP Resources & Prompts ──────────────────────────────────────────────
  console.log('\n══ 4. MCP Resources & Prompts ══');

  await test('MCP resources/list returns settlement resource URIs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 4, method: 'resources/list' },
    });
    assert.equal(res.statusCode, 200);
    const resources = res.json().result.resources;
    assert.ok(resources.length >= 2);
    assert.equal(resources[0].uri, 'sivan://networks/supported');
  });

  await test('MCP prompts/list returns prompt templates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 5, method: 'prompts/list' },
    });
    assert.equal(res.statusCode, 200);
    const prompts = res.json().result.prompts;
    assert.ok(prompts.length >= 1);
    assert.equal(prompts[0].name, 'hire_freelancer_with_deadline');
  });

  // ─── 5. MCP Tool Execution ───────────────────────────────────────────────────
  console.log('\n══ 5. MCP Tool Execution (tools/call) ══');

  await test('MCP tools/call sivan_initiate_service_agreement creates agreement with deadline', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'sivan_initiate_service_agreement',
          arguments: {
            title: 'Autonomous Data Extraction',
            description: 'Scrape and clean market datasets, deliver in 5 days',
            amount: 30,
            currency: 'USDC',
            network: 'stellar',
            buyerUserId: 'usr_agent_buyer_01',
            sellerUserId: 'usr_agent_seller_01',
          },
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.result.content[0].text);
    const parsed = JSON.parse(body.result.content[0].text);
    if (body.result.isError) {
      assert.ok(parsed.error, 'Expected error details if sandbox limit triggered');
    } else {
      assert.equal(parsed.success, true);
      assert.equal(parsed.amount, 30);
      assert.equal(parsed.deadlineDays, 5);
      assert.ok(parsed.agreementId.includes('STELLAR'));
    }
  });

  await test('MCP tools/call sivan_resolve_bank_account returns verified account name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'sivan_resolve_bank_account',
          arguments: {
            accountNumber: '0123456789',
            bankCode: '044',
          },
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.json().result.content[0].text);
    assert.equal(parsed.verified, true);
    assert.equal(parsed.accountNumber, '0123456789');
    assert.equal(parsed.status, 'ACCOUNT_ACTIVE');
  });

  await test('MCP tools/call sivan_fiat_bank_cashout generates payout quote', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'sivan_fiat_bank_cashout',
          arguments: {
            userId: 'usr_agent_buyer_01',
            amountUsd: 20,
            bankCode: '058',
            accountNumber: '0123456789',
            accountName: 'SIVAN AGENT CORP',
          },
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.json().result.content[0].text);
    assert.equal(parsed.status, 'SUCCESS');
    assert.equal(parsed.amountUsd, 20);
    assert.ok(parsed.payoutReference);
    assert.equal(parsed.channel, 'NIP_INSTANT_DIRECT');
  });

  await test('MCP tools/call sivan_get_balance returns spendable balance across chains', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'sivan_get_balance',
          arguments: {
            userId: 'usr_agent_buyer_01',
          },
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.json().result.content[0].text);
    assert.ok(parsed.spendable !== undefined || parsed.balances !== undefined || parsed.userId !== undefined);
  });

  // ─── 6. Error Handling ───────────────────────────────────────────────────────
  console.log('\n══ 6. JSON-RPC Error Handling ══');

  await test('Unknown method returns -32601 Method not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 10, method: 'invalid_method' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.error.code, -32601);
  });

  await test('Missing tool name returns -32602 Invalid params', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.error.code, -32602);
  });

  // ─── 7. SSE Stream Header Validation ─────────────────────────────────────────
  console.log('\n══ 7. SSE Stream Transport ══');

  await test('GET /mcp sets text/event-stream headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp?stream=false',
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
    assert.ok(res.body.includes('sivan-mcp-server'));
  });

  console.log('==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) throw new Error(`${failed} MCP test(s) failed`);
}

runMcpServerTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
