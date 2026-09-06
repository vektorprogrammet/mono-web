# 0100 — Synthetic native password cohort migration

Status: frozen for local implementation, 2026-09-06.
Authority: accepted continuation plan and operator instruction to proceed.
This is a synthetic rehearsal and reusable import boundary, not production approval.

## Goal and source

An operator can reconcile an explicitly mapped legacy credential cohort into
native identity, preserve supported legacy password login, and move a migrated
account to native password recovery without creating duplicate or enabled
formerly disabled accounts. Observe sign-in against the real credential engine.

Legacy authority is apps/server/config/packages/security.yaml (bcrypt),
App/Identity/Infrastructure/Entity/User.php and UserChecker.php. Installed Better
Auth is authoritative for native hash, credential issuer and account shape.
Existing 0067 organization import and 0095 receipt import are prior art for
occurrence accounting, explicit mappings, replay, quarantine and restore.
The disposable identity seed is explicitly unsuitable for migration.

## Contract

1. Input is a bounded snapshot with source repository/revision, transform revision,
   stable source occurrence IDs and explicit source User-to-Person mappings.
   Require pre-existing canonical Person/profile and an explicit attestation that
   the selected login email belongs to that mapped person. Email equality alone
   never establishes a mapping. Never import roles or grant affiliation here.
2. Freeze the supported cohort: active users with one unambiguous canonical email,
   valid supported legacy bcrypt hash and exactly one attested mapping. Quarantine
   inactive, missing-password, unsupported/malformed hash, missing/ambiguous map,
   duplicate source or canonical email, conflicting target identity and invalid
   source rows with bounded reason codes. No silent skip, credential overwrite,
   activation, reset-link conversion or inferred emailVerified=true.
3. One accepted source user establishes one native credential with canonical
   PersonId, Better Auth local issuer/accountId semantics and an immutable import
   provenance. Never copy legacy sessions, reset/activation tokens or plaintext.
   Credential creation and accepted occurrence evidence commit atomically.
4. Every source occurrence has an accepted or quarantined result. Exact snapshot
   replay is deterministic and creates nothing new; changed reuse of a source
   identity/receipt rejects. Existing native auth identity is a conflict unless
   the same committed import proves exact replay. Preserve canonical profiles.
5. Native new passwords continue using Better Auth's installed native hash.
   A narrow password verification bridge accepts only validated supported legacy
   bcrypt representations and native hashes. Unsupported encodings fail closed.
   Reuse available trusted runtime/library crypto, not handwritten bcrypt.
   Bound bcrypt cost to the source-supported cost12 to prevent attacker-selected
   work factors. Preserve source byte-length semantics; explicitly test the
   72-byte boundary and non-ASCII inputs before claiming compatibility.
6. Do not claim automatic rehash on sign-in: verify installed engine behavior.
   A successful 0054.2 reset writes the native hash and revokes old sessions.
   Imported users sign in and recover through the same native credential engine.
7. The CLI requires an explicit disposable numeric-loopback PostgreSQL URL and
   explicit synthetic source input. It must reject remote/production intent.
   Credentials/hashes/source personal data are private input, not output/logs.
   Reports contain safe counts, occurrence IDs and bounded disposition codes.
8. Legacy username/company-email aliases are not silently introduced into native
   email login. Report their unsupported disposition and production policy gate.
   This bounded cohort does not assert all legacy accounts are migrated.

## Acceptance and falsifiers

Run a synthetic snapshot through the actual importer and PostgreSQL. Independently
observe every occurrence, accepted credential provenance and unchanged profiles.
Use actual Better Auth sign-in: supported old password works, wrong password fails,
quarantined/disabled accounts cannot sign in, and replay changes no credential.
Exercise conflicting snapshots, target/email collisions, concurrent replay and
injected transaction failure without partial native account/provenance.

Integrate with 0054.2 for acknowledged-mail reset of a migrated account: old
password/session rejected, new native password accepted and hash family changed.
Rehearse nonempty database backup/restore and authenticate against the restored
database. Evidence must identify exact code revision and synthetic resources.
No passwords, hashes, reset tokens, cookies or sensitive source rows in retained
reports. No claim of production delivery, real mapping attestation or full cohort
coverage follows from the synthetic rehearsal.

## Ownership

Migration0036 is reserved. A separate credential-codec module is the sole hash
bridge authority; the integration lead wires it into auth-engine configuration
owned by0054.2. Keep imports/rehearsal separate from onboarding0035. One heavy
runtime/browser/build job across lanes; acquire admission before starting.

## Explicit compatibility amendment — 2026-09-06

Initial source support is only PHP-produced `$2y$12$` bcrypt, not unverified historical `$2a$`/`$2b$` or other costs. Source UTF-8 bytes are truncated at72 before Bun verification, with no Unicode normalization. Actual PHP8.4.24/Bun1.3.13 samples showed direct Bun verification differs for long passwords, while truncated bytes preserve the source result. NUL-containing input for legacy bcrypt verification is explicitly rejected (native hashing/verification retains installed semantics): PHP accepts a correct password followed by a NUL suffix, whereas Bun does not; this is an intentional tightening, not an asserted equivalence. Native hashing retains the installed Better Auth scrypt representation and normalization. No automatic rehash on login is added.
