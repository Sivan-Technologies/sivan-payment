# Legacy frontend test reference archive

These `.ts.txt` files are **non-executable snapshots**, not passing or skipped
test suites. They preserve the original assertions during retirement of the
embedded frontend. Do not rename them into active backend scripts.

Sixteen UI-only/manual scripts were removed from `scripts/`; their npm/CI
entrypoints were removed where present. Nineteen mixed scripts retain their
backend assertions in `scripts/`; their original versions are here so remaining
UI assertions can be reviewed against the standalone product. No production
financial logic or provider behavior was changed by this split.

Replacement coverage and outstanding UI gaps are tracked in
`sivan-user-frontend/FRONTEND_TEST_MIGRATION.md` on the matching
`chore/retire-payment-frontend` branch. This archive is not a claim that every
legacy assertion has a passing replacement. In particular, explorer semantics,
rendered transfer/withdrawal journeys, notification lifecycle, and staging links
remain release gates.

Payment CI now owns backend install/typecheck/build/tests. Standalone frontend
CI owns its own install/typecheck/hooks/tests/build. Neither checkout should need
the other's node_modules or source tree. Both PR checks must be reviewed before
the product cutover; a green backend job does not certify the frontend.

The old `frontend` folder and manually invoked legacy `e2e/` browser harnesses
are still retained. Several browser harnesses build/read the old frontend and
must be replaced or retired before folder deletion; they are not invoked by
the payment CI runners changed here.

## Existing CI debt

Before this split, `test:ci-coverage` already reported 49 unwired test commands.
The guard remains blocking and no exemptions were added to conceal those gaps.
Some commands need provider/test-database configuration; do not automatically
wire every command into CI without reviewing isolation and credentials.

The backend scripts typecheck also exposed a stale WhatsApp deposit-notification
fixture. Its field names now match `WalletDepositRecord`, and callback capture
uses a typed request array. The notification implementation is unchanged.

## Local verification (2026-10-17)

- `npm run typecheck`, `npm run build`: passed.
- Build isolation: 8 checks passed, including no frontend in either resolved
  TypeScript graph.
- Frontend retirement guard: passed; wired into both backend test runners.
- `git diff --check`: passed.
- Isolated backend suites passed: transfer-confirmation (33),
  ngn-deposit-instruction (20), wallet-chain-family (37), buy-gate (38),
  transfer-fee-policy (50), display-currency (7), unified-balance (53),
  deposit-confirmation (18), deposit-detection (21), ngn-bvn-level2 (25).
  These are local source/unit/injected-request checks, not live E2E evidence.
- `transfer-toast-honesty` cannot run because the parent workspace lacks
  `cloudflare-worker-test-DEPLOY.js`.
- `ngn-fee-honesty`: 17 passed, 6 failed against retained fee/default/rounding
  expectations. `external-funding-toggle`: 9 passed, 2 failed because the
  actual default is enabled while the retained test expects disabled.
  The failing backend assertions were not changed by this retirement split;
  investigate separately rather than modifying financial rules for CI.
- `test:ci-coverage` remains failing on the 49 pre-existing unwired commands.

The selected runtime suites used mock providers, isolated JSON test storage,
disabled dotenv loading and a non-loopback fetch block. No staging deployment,
production transaction, or full-platform run was performed. These results do
not authorize deleting the old frontend or claim all CI is green.
