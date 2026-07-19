# Sivan Virtual Accounts

This folder is the provider-agnostic foundation for future virtual bank/account issuance.

The feature is intentionally **disabled by default**. It exists so Sivan can prepare the pipeline now without exposing virtual accounts to users until compliance, provider readiness, approval rules, and live pilots are complete.

## Why `virtual-accounts` instead of `virtualbk`

Use the clear product/engineering name:

```txt
virtual-accounts
```

Avoid short names like `virtualbk` because this feature may later support multiple account types and providers, not only one bank-account implementation.

## Target flow

```txt
User requests virtual account
→ eligibility check
→ admin approval
→ provider adapter provisions account
→ internal account record is stored
→ user sees account only after approval/activation
```

## Provider adapter design

Business logic must call the generic `VirtualAccountProvider` interface, not Bridge directly.

Provider adapters can include:

```txt
mock
bridge
nomba
monnify
flutterwave
bank partner
```

Switching providers should be controlled by env/config, for example:

```env
VIRTUAL_ACCOUNTS_ENABLED=false
VIRTUAL_ACCOUNT_REQUESTS_ENABLED=false
VIRTUAL_ACCOUNT_PROVIDER=mock
```

Existing accounts must keep their original provider. Provider switching should affect new accounts only unless a migration flow is explicitly built.
