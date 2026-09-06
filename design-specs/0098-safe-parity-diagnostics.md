# 0098 — Safe parity failure diagnostics

Lifecycle: spec-frozen

## Journey and goal

A migration reviewer running the full legacy parity gate can locate the stage and
source record that caused an unsafe-source rejection, without exposing the rejected
value or allowing projection output that the existing safety gate rejects.

## Constraints

Reuse the existing scanner, source references, gate and CLI. Keep all safety
predicates and exit semantics. Diagnostics must not print unsafe scalar values,
source contents or unchecked paths. Do not modify external authority registers.
Root roadmap and STATE are outside this change.

## Acceptance

- Identify the current real-checkout rejection using bounded safe diagnostics.
- Regression tests show diagnostics identify the failing category while sensitive
  values remain absent and unsafe projections remain blocked.
- Run the real CLI on a clean committed tree; record remaining failure honestly.
- No claim of functional parity follows from a tooling correction.

## Explicit amendment — transport destination extraction

Observed clean-tree diagnostics identify receipt rehearsal sign-in fetch line451.
The integration parser incorrectly treats the Origin header URL as the transport
endpoint because it searches all arguments. For fetch calls, derive destination
only from the first argument; dynamic destinations remain unknown. Headers/body
must not establish a destination. Preserve rejection of actual unsafe destination
URLs. Other transport conventions and safety predicates remain unchanged.
