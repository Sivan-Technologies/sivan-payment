/**
 * Model Context Protocol (MCP) Tool Schemas & Definitions
 *
 * Certified tool definitions conforming to the Anthropic / MCP JSON-RPC 2.0 specification.
 * Allows autonomous AI agents (ElizaOS, Claude Desktop, Cursor, LangChain, AutoGPT, CrewAI)
 * to interact with Sivan multi-chain settlement rails, service agreements, and fiat payouts.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const SIVAN_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'sivan_create_payment_link',
    description:
      'Creates an instant zero-gas multi-chain payment link or direct transfer instruction across Stellar, Celo, Solana, Base, or BNB Chain. Recipient can claim funds via phone number or web claim vault.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: 'Payment amount in USDC, cUSD, or USDT (e.g. 15.50).',
        },
        currency: {
          type: 'string',
          enum: ['USDC', 'cUSD', 'USDT'],
          description: 'Payment currency symbol. Defaults to USDC.',
        },
        network: {
          type: 'string',
          enum: ['stellar', 'celo', 'solana', 'base', 'bsc'],
          description: 'Target blockchain network for settlement. Defaults to stellar.',
        },
        recipientIdentifier: {
          type: 'string',
          description: 'Recipient phone number (e.g. +2348012345678), username (@samson), or wallet address.',
        },
        memo: {
          type: 'string',
          description: 'Optional transfer memo or purpose description.',
        },
      },
      required: ['amount', 'recipientIdentifier'],
    },
  },
  {
    name: 'sivan_initiate_service_agreement',
    description:
      'Opens a secure milestone-based Service Agreement between two AI agents or an agent and a human contractor. Automatically extracts delivery deadlines from natural language descriptions (e.g. "deliver in 3 days").',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title or short summary of the agreement (e.g. "Logo design and brand kit").',
        },
        description: {
          type: 'string',
          description: 'Detailed contract scope and deliverables. Natural language deadlines like "deliver in 3 days" or "by Friday" are automatically extracted.',
        },
        amount: {
          type: 'number',
          description: 'Agreed milestone settlement amount (e.g. 25.00).',
        },
        currency: {
          type: 'string',
          enum: ['USDC', 'cUSD', 'USDT'],
          description: 'Settlement currency.',
        },
        network: {
          type: 'string',
          enum: ['stellar', 'celo', 'solana', 'base', 'bsc'],
          description: 'Blockchain network for custody and settlement.',
        },
        buyerUserId: {
          type: 'string',
          description: 'Sivan user ID or agent identifier of the buyer/funder.',
        },
        sellerUserId: {
          type: 'string',
          description: 'Sivan user ID, phone number, or agent identifier of the service provider.',
        },
        deadlineDays: {
          type: 'number',
          description: 'Optional explicit delivery deadline in calendar days (overrides auto-extraction if specified).',
        },
      },
      required: ['title', 'amount', 'buyerUserId', 'sellerUserId'],
    },
  },
  {
    name: 'sivan_verify_milestone_and_release',
    description:
      'Verifies completion of milestone deliverables and programmatically releases agreement funds to the seller payout account or crypto wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        agreementId: {
          type: 'string',
          description: 'The unique agreement identifier (e.g. SIV-123456-STELLAR).',
        },
        actorUserId: {
          type: 'string',
          description: 'User ID or agent identifier authorized to release the milestone.',
        },
        releaseNote: {
          type: 'string',
          description: 'Optional release confirmation note or delivery review feedback.',
        },
      },
      required: ['agreementId', 'actorUserId'],
    },
  },
  {
    name: 'sivan_resolve_bank_account',
    description:
      'Verifies a Nigerian bank account number against the central NIP switch and returns the registered account holder name before initiating fiat cashout.',
    inputSchema: {
      type: 'object',
      properties: {
        accountNumber: {
          type: 'string',
          description: '10-digit NUBAN account number (e.g. "0123456789").',
        },
        bankCode: {
          type: 'string',
          description: '3-digit CBN bank code or bank slug (e.g. "044" for Access Bank, "058" for GTBank).',
        },
      },
      required: ['accountNumber', 'bankCode'],
    },
  },
  {
    name: 'sivan_fiat_bank_cashout',
    description:
      'Executes an instant bank payout from spendable crypto balance directly to a verified Nigerian bank account (Naira / NGN) typically under 1 to 2 minutes via NIBSS / NIP rails.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'Sivan user ID or agent ID initiating the cashout.',
        },
        amountUsd: {
          type: 'number',
          description: 'Amount in USD to convert and send to the bank account.',
        },
        bankCode: {
          type: 'string',
          description: 'Bank code of the destination bank.',
        },
        accountNumber: {
          type: 'string',
          description: '10-digit destination NUBAN account number.',
        },
        accountName: {
          type: 'string',
          description: 'Verified account holder name.',
        },
      },
      required: ['userId', 'amountUsd', 'bankCode', 'accountNumber', 'accountName'],
    },
  },
  {
    name: 'sivan_get_balance',
    description:
      'Queries real-time spendable and held balance across all 5 supported blockchain networks (Stellar, Celo, Solana, Base, BSC) and local fiat accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'Sivan user ID, phone number, or agent identifier.',
        },
      },
      required: ['userId'],
    },
  },
];
