# Future Build Plan - Celo Native CIP-64 Fee Abstraction via Privy Raw Sign

Document Type: Architecture & Implementation Specification
Author: Samson Micheal, Technical Founder and Product Engineer, Sivan Ai
Target Branch: multichain
Status: ✅ COMPLETED & 100% VERIFIED LIVE ON-CHAIN

---

## 1. Context and Problem Statement

On Celo, users should be able to send stablecoins (such as USDC) with network gas fees deducted directly from their stablecoin balance, rather than holding native CELO. This capability is natively supported by Celo validators under CIP-64 (Type 0x7b transactions) using the feeCurrency transaction field.

In the current implementation, Sivan Ai calls Privy's high-level RPC endpoint:
POST https://api.privy.io/v1/wallets/{wallet_id}/rpc with method: eth_sendTransaction

Privy's server validates all transaction parameters strictly against standard Ethereum EIP-1559 schemas. When Sivan Ai includes Celo's custom feeCurrency field, Privy's schema validator rejects the request:
Input error: params.transaction: Unrecognized key(s) in object: 'feeCurrency'

Without the feeCurrency parameter, Privy broadcasts a standard EVM transaction that requires native CELO to pay for gas. When the user's wallet has 0 CELO, the Celo node reverts with:
Execution reverted with reason: gas required exceeds allowance (0)

---

## 2. Solution: Privy raw_sign with Direct CIP-64 RPC Broadcast

To achieve true gasless stablecoin transfers while keeping non-custodial security, Sivan Ai separates cryptographic signing from transaction broadcasting.

Privy provides a low-level cryptographic signing endpoint:
POST https://api.privy.io/v1/wallets/{wallet_id}/raw_sign

This endpoint takes a pre-computed 32-byte keccak256 transaction hash, signs it with the user's secp256k1 private key inside Privy's secure hardware enclave (HSM / TEE), and returns the cryptographic signature (r, s, v / yParity). Because it operates on raw hashes, Privy's schema validator never inspects or rejects Celo-specific fields.

Sivan Ai then attaches the signature to the CIP-64 envelope and broadcasts it directly to Celo RPC via eth_sendRawTransaction.

---

## 3. Custody and Security Guarantees

1. Key Custody: 100% Privy
Sivan Ai never touches, exports, or stores the user's private key. The private key remains permanently inside Privy's secure hardware enclave.

2. Signature Authenticity: 100% Privy
Privy performs the ECDSA secp256k1 signature on the hash. Sivan Ai only provides the transaction hash and Sivan's authorization signature.

3. User Authorization:
The transaction authorization flow and idempotency keys enforced by Sivan Ai remain identical to all existing transfers.

4. Non-Custodial Integrity:
Sivan Ai maintains its non-custodial posture under Bridge ToS and regulatory guidelines.

---

## 4. Technical Architecture and Data Flow

### Step 1: Resolve Celo Nonce and Fee Parameters
Sivan Ai queries the Celo RPC endpoint for the user's current transaction count and gas price parameters:
- Transaction nonce: eth_getTransactionCount(userAddress, 'pending')
- Base fee and priority fee: eth_gasPrice or maxPriorityFeePerGas from Celo node
- Gas limit: 65,000 for standard ERC-20 transfer, or estimateGas with feeCurrency

### Step 2: Assemble the Unsigned CIP-64 Envelope
A Celo CIP-64 transaction is an RLP-encoded structure prefixed by the transaction type byte 0x7b:
0x7b || rlp([
  chainId,
  nonce,
  maxPriorityFeePerGas,
  maxFeePerGas,
  gasLimit,
  to,
  value,
  data,
  accessList,
  feeCurrency
])

Parameters:
- chainId: 11142220 (Celo Sepolia) or 42220 (Celo Mainnet)
- to: ERC-20 token address (Celo USDC)
- data: transfer(recipientAddress, netAmount)
- feeCurrency: Celo USDC fee adapter contract address:
  - Testnet (Celo Sepolia): 0x4A6b0f90597e7429Ce8400fC0E2745Add343df8
  - Mainnet: 0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B

### Step 3: Compute the Signing Hash
The hash to sign is the keccak256 hash of the serialized unsigned envelope:
signingHash = keccak256(0x7b || unsignedRlpPayload)

### Step 4: Call Privy raw_sign
Sivan Ai calls Privy:
POST https://api.privy.io/v1/wallets/{wallet_id}/raw_sign
Headers:
- Authorization: Basic base64(appId:appSecret)
- privy-app-id: appId
- privy-authorization-signature: Sivan ECDSA authorization signature
Body:
{
  "hash": "0x" + signingHashHex
}

Privy returns the signature:
{
  "data": {
    "signature": "0x..." // 65-byte hex string containing r, s, and v / yParity
  }
}

### Step 5: Assemble the Signed Raw Transaction
Sivan Ai extracts r, s, and yParity from the signature and constructs the complete signed CIP-64 transaction:
0x7b || rlp([
  chainId,
  nonce,
  maxPriorityFeePerGas,
  maxFeePerGas,
  gasLimit,
  to,
  value,
  data,
  accessList,
  feeCurrency,
  yParity,
  r,
  s
])

### Step 6: Direct Broadcast to Celo Node
Sivan Ai broadcasts the signed raw transaction to Celo RPC:
POST https://forno.celo-sepolia.celo-testnet.org
{
  "jsonrpc": "2.0",
  "method": "eth_sendRawTransaction",
  "params": ["0x7b..."],
  "id": 1
}

The Celo node verifies the signature against the user's address, decodes feeCurrency, debits gas in USDC, executes the transfer, and returns the transaction hash.

---

## 5. Implementation Roadmap

### Phase A: CIP-64 Serializer Utility
Create src/wallets/celo/cip64-serializer.ts:
- Encode unsigned CIP-64 payload with type 0x7b
- Generate keccak256 hash for signing
- Parse Privy raw signature into r, s, yParity
- Encode finalized signed raw transaction hex string

### Phase B: Privy raw_sign Integration
Update src/wallets/provider/privy-wallet.provider.ts:
- Add rawSign(walletId, hash, idempotencyKey) method wrapping POST /v1/wallets/{id}/raw_sign
- Include proper privy-authorization-signature headers

### Phase C: Celo Transfer Handler Refactoring
Update sendCeloTransfer in privy-wallet.provider.ts:
- Use cip64-serializer to construct the unsigned payload
- Fetch nonce and gas estimates from Celo RPC
- Request signature via rawSign
- Broadcast via eth_sendRawTransaction to Celo RPC
- Return standard WalletTransfer object with on-chain txHash

### Phase D: Automated Testing & Verification
1. Test unit serialization against known CIP-64 test vectors.
2. Test end-to-end send on Celo Sepolia with a wallet holding only USDC and 0 CELO.
3. Verify on Blockscout / Celo Explorer that feeCurrency is populated and gas is paid in USDC.

---

## 6. Success Criteria

1. A user wallet with 0.0 CELO and 10 USDC can transfer 5 USDC to an external address without reverting.
2. Network gas is visibly deducted in USDC on the Celo block explorer.
3. Sivan Ai collects the $0.10 micro-rail fee in USDC accurately.
4. Zero reliance on Privy gas sponsorship or centralized hot-wallet gas dispensers.
