import {
  assertSelfAgentLimit,
  verifyFastifyAgentRequest,
} from '../src/security/self-agent-verifier.service.js';

async function demonstrateBlockedBot() {
  console.log('================================================================');
  console.log('SIMULATION: Unverified Bot Invoking Action Over $50 ($100 USD)');
  console.log('Endpoint: POST https://api.sivantech.online/api/v1/agent/invoke');
  console.log('================================================================\n');

  // Simulated inbound request from an unverified bot (no x-self-agent signature headers)
  const simulatedRequest: any = {
    method: 'POST',
    url: '/api/v1/agent/invoke',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Python/3.11 requests/2.31.0 AutonomousBot',
    },
    body: {
      tool: 'sivan_initiate_service_agreement',
      params: {
        title: 'Front-End Development Milestone',
        amount: 100, // Exceeds $50 USD unverified ceiling!
        currency: 'USDC',
        network: 'celo',
      },
    },
  };

  console.log('--- INCOMING REQUEST ---');
  console.log(JSON.stringify(simulatedRequest, null, 2));
  console.log('\n--- EVALUATING SELF AGENT ID VERIFICATION GATE ---');

  // Step 1: Run verification check
  const verification = await verifyFastifyAgentRequest(simulatedRequest);
  console.log('Verification Outcome:', verification);

  // Step 2: Enforce limit
  const requestedAmount = Number(simulatedRequest.body.params.amount);
  const toolName = simulatedRequest.body.tool;
  const limitCheck = assertSelfAgentLimit(verification, requestedAmount, toolName);

  console.log('\n--- GATE DECISION ---');
  console.log('Allowed:', limitCheck.allowed);

  console.log('\n--- HTTP 403 FORBIDDEN RESPONSE RETURNED TO BOT ---');
  const errorPayload = {
    status: 'error',
    ...limitCheck.errorResponse,
    selfVerification: {
      isVerified: verification.isVerified,
      tier: verification.tier,
      maxTransactionLimitUsd: verification.maxTransactionLimitUsd,
    },
  };
  console.log(JSON.stringify(errorPayload, null, 2));
}

demonstrateBlockedBot().catch(console.error);
