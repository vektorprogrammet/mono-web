# Synthetic credential cohort import

Contract: [0100](../../design-specs/0100-synthetic-password-cohort.md). This boundary migrates only explicitly mapped, active, supported credentials with attested login-email ownership. It is a synthetic rehearsal, not permission to import production identities.

## Sources and deliberate dispositions

Legacy [security configuration](../../apps/server/config/packages/security.yaml) selects bcrypt cost12; [User.setPassword](../../apps/server/src/App/Identity/Infrastructure/Entity/User.php) uses PHP `PASSWORD_BCRYPT`. Passwords are nullable, user activity is separate, and [UserChecker](../../apps/server/src/App/Identity/Infrastructure/UserChecker.php) rejects disabled accounts. [UserRegistration](../../apps/server/src/App/Identity/Infrastructure/UserRegistration.php) and [PasswordManager](../../apps/server/src/App/Identity/Infrastructure/PasswordManager.php) own activation/reset tokens. This importer copies neither tokens nor sessions and never activates an account.

The source supports username, email and company-email login; native Better Auth sign-in uses lowercased email. Username/company-email aliases remain **unsupported**, pending an explicit production disposition. Historical accounts outside the supported cohort remain quarantined, not silently enabled or described as migrated.

Installed Better Auth1.7.1 resolves `@better-auth/utils`0.4.2 for native hashing. Its source and exposed `better-auth/crypto` exports are authoritative for scrypt representation and normalization. Its custom password verifier receives only hash/password and its sign-in route does not upgrade hashes. The [codec](../../packages/database/src/password-codec.ts) retains native hash/verification behavior and dispatches supported legacy hashes to trusted Bun crypto. Root composition installs `nativeAndLegacyPasswordCodec` as `emailAndPassword.password`; no login-time rehash is implemented. A native recovery reset replaces the credential using the installed native hash and revokes sessions through0054.2.

Source-matching PHP8.4.24→Bun1.3.13 samples established an important boundary: direct Bun bcrypt verification fails for correct legacy passwords exceeding72 bytes, while verification of the first72 UTF-8 bytes succeeds, including a multibyte character cut at that boundary. The codec therefore truncates **bytes**, without Unicode normalization, before legacy verification. Initial import accepts only PHP `$2y$` cost12, not unverified historical prefixes/costs. Legacy verification rejects NUL input as an explicit tightening: PHP accepts a valid password with a NUL suffix whereas Bun rejects it. Native NUL and normalization behavior remains unchanged.

## Identity and evidence ownership

The [snapshot schema/importer](../../packages/database/src/identity-cohort.ts) is the authoritative input contract. It requires pre-existing canonical `person_profiles` and exactly one source-User→Person mapping with explicit email-ownership attestation. This is an operator assertion; the importer cannot prove real-world ownership. Email equality never creates the mapping, and attestation does not invent `emailVerified=true`.

The prior Organization importer uses stringified legacy User IDs as Person references. Preserve those established identities or explicitly reconcile them; do not choose a new prefix or merge people by email. Existing native identity/email collisions quarantine. The disposable [identity seed](../../packages/database/src/identity-seed-main.ts), which skips on matching ID **or** email and provisions verified fixture accounts through separate calls, is unsuitable for this migration.

Reuse of0067/0095 is limited to their established occurrence accounting, quarantine, reconciliation and restore approach. Credential import does not reuse raw-row quarantine storage: hashes and personal data stay in protected input and the canonical credential, while provenance stores digests and bounded disposition codes. No roles, team membership, volunteer affiliation or canonical profile fields are imported or overwritten.

The existing credential issuer/account identity conventions are taken from the installed engine. Credential creation, immutable source linkage, occurrence disposition and administrative security audit commit in one PostgreSQL transaction. Concurrent cohort runs serialize through one import lock. Exact snapshots replay their original report without rewriting credentials; changed snapshot/source identities fail. Later successful password reset remains authoritative—replay never restores the legacy hash.

## Running the synthetic boundary

Use a protected, operator-owned regular input file with mode0600. The [CLI boundary](../../packages/database/src/identity-cohort-cli.ts) requires explicit synthetic intent, local deployment and a numeric-loopback PostgreSQL URL with an explicit port and disposable cohort database name. Its validation is a guard against accidental use, not proof that arbitrary local data is disposable.

```sh
IDENTITY_COHORT_MODE=synthetic \
NATIVE_IDENTITY_DEPLOYMENT=local \
IDENTITY_COHORT_PG_URL=postgres://postgres@127.0.0.1:49123/identity_cohort_rehearsal \
IDENTITY_COHORT_INPUT=/protected/synthetic-cohort.json \
bun run packages/database/runtime/identity-cohort-main.ts
```

The reusable importer never logs source rows, emails, hashes or passwords. Reports contain safe occurrence IDs, counts and disposition codes. Existing native credentials are a conflict unless immutable import provenance proves exact replay; there is no overwrite option.

The [owned rehearsal](../../packages/database/runtime/identity-cohort-rehearsal.ts) requires PostgreSQL tools, Bun and a PHP binary (`IDENTITY_COHORT_PHP` may select the installed executable):

```sh
bun run packages/database/runtime/identity-cohort-rehearsal.ts
```

It observes source-compatible sign-in, quarantine/account absence, exact/concurrent/conflicting replay, injected rollback, unchanged profiles, acknowledged local recovery delivery, reset/session behavior and actual login against a restored nonempty database. It uses the real Better Auth engine and canonical recovery wrapper/HTTP adapter. Evidence names the exact clean commit and supported scope. The runner removes its credential input, backup and PostgreSQL files and closes owned resources; it retains only safe evidence.

Real mapping attestations, full legacy hash inventory, login-alias policy, inactive-account lifecycle and production writer fencing remain production gates. No real recipients or external providers are involved.
