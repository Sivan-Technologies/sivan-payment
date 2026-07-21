# NGN Pipeline

Provider-agnostic NGN on-ramp/off-ramp pipeline for Sivan Payment.

This module intentionally separates architecture from provider integration:

```txt
NGN Pipeline -> Provider Adapter -> Linkio / Eversend / Nomba / Future provider
```

Phase 1 uses a mock adapter and runtime Admin Controls. Real provider API calls are added after provider approval.

## Flows

On-ramp:

```txt
NGN deposit -> quote -> virtual account/bank instruction -> deposit confirmed -> USDC/USDT sent -> completed
```

Off-ramp:

```txt
USDC/USDT deposit -> blockchain confirmed -> quote -> settlement -> bank transfer -> completed
```

## Runtime controls

Use `/api/admin/ngn/controls` to enable/disable:

- NGN on-ramp
- NGN off-ramp
- mock provider
- active provider
- backup provider
- limits
