# Design spec 0066 - native domain schema boundary

## Metadata

| Field | Value |
|---|---|
| Goal | Put every native domain table in PostgreSQL schema `public` while Better Auth remains the owner of schema `auth` |
| Status | Contract frozen; implementation and database evidence passed at integrated HEAD `478709596af6b145a0a44b0b59a8255a255cc344` |
| Base | `aceb9abf9ca45842d7be1432680ce7b65bb08bb1` |
| Depends on | 0054 native Identity via Better Auth; 0050 native Recruitment scheduling; 0063 native interview conduct |
| Integrated evidence HEAD | `478709596af6b145a0a44b0b59a8255a255cc344` (ancestor of the current final HEAD) |
| Operator boundary | Disposable PostgreSQL only. No production database, data import, deployment, credential change, provider, or external notification effect |

## Problem

The database pool sets `search_path=auth,public`. Better Auth owns the `auth` schema. Native domain tables belong in `public` under spec 0054.

Migration `packages/database/migrations/0021-native-recruitment-interview-conduct.sql` uses unqualified table, index, trigger, and function DDL. After migration `0015` creates schema `auth`, PostgreSQL therefore creates these conduct tables in `auth`:

- `recruitment_interview_schema_questions`
- `recruitment_interview_question_snapshots`
- `recruitment_interview_conducts`
- `recruitment_interview_cancellations`
- `recruitment_interview_lifecycle_command_receipts`
- `recruitment_interview_lifecycle_audit`

The scheduling tables from migration `0011` already exist in `public`. The default fixture `psql` path cannot find conduct questions because it looks for the domain table in `public`.

This creates two different final schemas. A fresh replay can create conduct tables in `auth`, while an established database can contain scheduling tables in `public`. Pool order can also make an accidental `auth` table hide the intended domain table. Better Auth must not become the owner of Recruitment data.

## Decision

`public` is the only schema for native domain tables. `auth` contains Better Auth identity and session tables only.

The correction uses one forward, idempotent migration after migration `0021`. It moves existing conduct tables from `auth` to `public` without copying, truncating, merging, or recreating rows. The migration is safe for both database states:

1. A fresh database where `0021` created the six tables in `auth`.
2. An initialized database where `0021` already ran and the six tables contain data in `auth`.

The implementation can also make migration `0021` explicit for fresh replay, but it must not depend on editing migration history. The forward correction remains required for databases that recorded `0021` before this contract.

## Frozen contract

### 1. Table ownership

The following tables MUST resolve as `public.<table>` after the correction:

```text
public.recruitment_interview_schema_questions
public.recruitment_interview_question_snapshots
public.recruitment_interview_conducts
public.recruitment_interview_cancellations
public.recruitment_interview_lifecycle_command_receipts
public.recruitment_interview_lifecycle_audit
```

All native tables from migrations `0009` through `0021`, including the existing scheduling tables, MUST resolve in `public`. Better Auth tables (`auth."user"`, `auth."session"`, `auth."account"`, and `auth."verification"`) MUST remain in `auth`.

The correction MUST NOT create a second copy of any table. If both `auth.<table>` and `public.<table>` exist for one name, the migration MUST fail before changing either table. It MUST report the collision and require operator review; it MUST NOT guess which rows to keep.

### 2. Explicit schema qualification

Every new or corrected domain SQL statement MUST qualify its schema. This includes:

- `CREATE TABLE public...` and `CREATE INDEX ... ON public...`;
- foreign-key references to domain tables, such as `REFERENCES public.recruitment_interviews` and `REFERENCES public.person_profiles`;
- trigger targets, trigger functions, and function calls;
- `ALTER`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, and `SELECT` statements in the migration and its verification SQL;
- catalog probes that distinguish `auth` from `public`.

The migration MUST NOT depend on the connection `search_path` for object creation, lookup, or foreign-key target selection. A qualified statement MAY run while `search_path=auth,public`, but its result MUST be unchanged if the search path is `public` or an unrelated schema.

### 3. Forward migration behavior

Add a new migration after `0021` in the existing migration runner. The migration MUST be idempotent when run against the same disposable database more than once.

For each of the six conduct tables, the migration MUST:

1. Detect `auth.<table>` and `public.<table>` by schema-qualified catalog lookup.
2. Do nothing when only `public.<table>` exists.
3. Transfer `auth.<table>` to `public` when only `auth.<table>` exists.
4. Fail before any transfer when both tables exist.
5. Preserve the table object and its rows during transfer.

`ALTER TABLE ... SET SCHEMA public` is the required transfer shape, or an equivalent operation with the same no-copy and no-rebuild properties. The migration MUST NOT use `CREATE TABLE AS`, row copy, `DROP TABLE`, `TRUNCATE`, or an unqualified `ALTER TABLE`.

The migration MUST handle the two conduct trigger functions created by `0021` as native objects. Their final function names and trigger bindings MUST be schema-qualified and MUST not resolve through `auth`. If the implementation transfers the existing functions, it MUST use an identity-preserving schema transfer. If it recreates a function, it MUST rebind all four immutable-record triggers in the same transaction and preserve their behavior; it MUST not leave the old `auth` function as the active native trigger target.

The migration MUST run in one transaction, or in the strongest transaction boundary supported by the migration runner. A collision, missing dependency, permission error, or failed constraint operation MUST roll back all changes.

### 4. Data and domain invariants

The correction MUST preserve, for every transferred table:

- all rows and row values;
- primary keys and unique keys;
- foreign keys and delete behavior;
- check constraints;
- indexes;
- immutable-record triggers;
- table and column nullability;
- sequence or identity ownership, if present;
- the Recruitment domain behavior defined by specs 0050 and 0063.

The correction MUST not alter interview assignments, schedules, invitation responses, question snapshots, answers, scores, completion, cancellation, receipts, audit facts, revisions, or actor identity. It MUST not change the `auth.user.id = public.person_profiles.person_id` identity relationship from spec 0054.

### 5. Runtime and operator boundary

The pool, runtime composition, Effect services, SDK boundaries, HTTP routes, authorization rules, and Better Auth configuration remain unchanged. Runtime SQL MUST use explicit `public.` qualification for native domain access where the query can otherwise be affected by `search_path`.

This spec changes schema placement only. It does not add a compatibility view in `auth`, dual writes, authorization exceptions, data cleanup, production repair, or a new identity model.

## Required evidence

Run all evidence against disposable PostgreSQL databases. Do not connect to a production or shared database.

### Fresh replay

1. Create an empty disposable database.
2. Run the complete migration runner from migration `0009` through the new correction.
3. Query `pg_catalog.pg_class` and `pg_catalog.pg_namespace` with explicit schema predicates.
4. Show that all six conduct tables and all existing scheduling tables are in `public`.
5. Show that Better Auth tables remain in `auth`.
6. Run the native interview-conduct fixture through the normal pool. It MUST read the question snapshots without a manual `SET search_path`.

### Upgrade correction

1. Create a second disposable database.
2. Run migrations through `0021` with the historical unqualified DDL.
3. Insert representative rows that exercise every conduct table, including question snapshots, answers, scores, receipts, and audit facts.
4. Record primary-key, unique-key, foreign-key, check-constraint, index, trigger, and row-count evidence.
5. Run only the new forward correction.
6. Repeat the same catalog, row, constraint, and fixture reads.
7. Run the correction again. It MUST make no further schema or row change.
8. Attempt an update and delete against each immutable conduct record. The operations MUST still fail with the existing immutable-record behavior.

### Search-path independence

Run the schema-qualified verification and a representative native read with `search_path=auth,public` and with `search_path=public`. Both runs MUST resolve the same `public` domain relations. An `auth` object with a conflicting name MUST not change the result.

### Replay and upgrade equivalence

Compare the fresh-replay and upgrade-correction catalog output. The six conduct tables MUST have the same schema, columns, constraints, indexes, trigger bindings, and function targets. Their row sets can differ only because the upgrade database contains its preserved representative data.

## Exact falsifiers

The contract is false or incomplete if any one of these conditions occurs:

- A native domain table, including one of the six conduct tables or an existing scheduling table, resolves in `auth` after the full migration replay.
- Any Better Auth table resolves in `public`, or any correction step changes an identity table.
- The correction copies rows, drops rows, truncates a table, recreates a table, or changes a primary key, unique key, foreign key, check constraint, index, nullability, or trigger behavior.
- A database that already ran `0021` fails to move its existing conduct rows to `public`.
- A database with both `auth.<table>` and `public.<table>` silently merges, overwrites, drops, or chooses one copy.
- Running the correction twice changes a row count, relation definition, trigger binding, index set, or constraint set on the second run.
- Any migration or runtime native-domain SQL relies on `search_path` or contains an unqualified domain relation in a new or corrected statement.
- The default fixture cannot read question snapshots through the normal pool without a manual search-path change.
- Interview scheduling, question snapshot, finalization, cancellation, receipt, audit, or authorization behavior changes apart from schema placement.
- `auth.user.id = public.person_profiles.person_id` no longer holds for seeded identity rows.
- The evidence uses a production, shared, or non-disposable database, or claims success from a stubbed database path.

## Definition of done

1. This spec is committed before implementation work starts.
2. A forward migration is registered after `0021` and runs in the existing migration runner.
3. The migration is idempotent and collision-safe.
4. Fresh replay and upgrade correction leave the same native domain tables in `public`.
5. Existing conduct data, keys, constraints, indexes, trigger behavior, and domain invariants remain intact.
6. Better Auth identity tables remain in `auth`, and the identity foreign key remains person-keyed.
7. New or corrected migration and runtime SQL uses explicit schema qualification.
8. The default fixture reads conduct questions through the normal pool with no manual search-path workaround.
9. The exact falsifiers above are exercised and none occurs.
10. All evidence uses disposable PostgreSQL only. No production effect occurs.
