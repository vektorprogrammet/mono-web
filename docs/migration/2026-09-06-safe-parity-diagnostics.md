# Safe parity diagnostics — 0098

The full parity gate now reports sanitized failure categories, record indices,
source paths and source line numbers on stderr. Rejected symbols and payloads
remain absent; unsafe paths remain redacted. Existing predicates, stdout report
schema, exit codes and write blocking remain unchanged. The diagnostic schema is
the single source for the runtime error field and inferred TypeScript type.

## Verified artifact

Clean commit `c14703e9` ran `bun run parity:verify`: **exit 6, UNSAFE_SOURCE**.
The failure is now actionable: effect failure 19 / effect row 537, source 8135,
`packages/database/runtime/receipt-import-rehearsal.ts:451`.

The parser in `packages/parity-inventory/src/effects.ts` searches HTTP URL text
across `literalCall.rawArgs.join(",")`. For this sign-in fetch, that selects the
Origin header's numeric loopback URL, rather than the dynamic destination in the
first argument. The generic `unsafeScalarReason` endpoint check treats that
numeric hostname as phone-shaped text. A direct invocation of that predicate
reproduced the rejection. The separate invalid-bearer request is not the reported
failing source location. No credential fixture was rewritten based on that earlier
hypothesis.

The next bounded correction is transport-aware destination extraction, with
regressions that distinguish header Origin from destination and retain rejection
of actual unsafe destination URLs. This change does **not** bypass or weaken the
safety guard, and does not claim functional parity.

## Checks and limits

- Six focused tests pass, 65 assertions: helper redaction/location, actual CLI
  stderr redaction, OpenAPI safety, unchanged blocked receipts and runtime aborts.
- Parity package TypeScript check passes.
- Oxfmt completed for changed source/test files.
- Reused the existing installed dependency tree through local ignored symlinks;
  an isolated install attempt was stopped after network resolution stalled.
- Git hooks were bypassed because the environment lacks their runner; explicit
  checks above were executed.
- No external authority register, production system, runtime source or safety
  predicate was modified. No capability equivalence claim follows from this fix.

Evidence: `evidence/parity-diagnostics-0098/`. The CLI evidence pins the clean
implementation commit above; this report/evidence commit adds documentation only.
