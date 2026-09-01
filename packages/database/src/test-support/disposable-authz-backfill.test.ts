import {
  authorDisposableAuthzBackfill,
  RECEIPT_DOMAIN_ID,
  persistDisposableAuthzBackfill,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/domain/database";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import { DatabaseTest } from "../layers.js";
import {
  disposableAuthzBackfillStartAt as startAt,
  reversedDisposableAuthzBackfillInput as reversedInput,
  validDisposableAuthzBackfillInput as validInput,
} from "./disposable-authz-backfill-fixtures.js";

const runtime = makeControlledTestRuntime(DatabaseTest());

interface CountRow {
  readonly count: string;
}

const clearAuthzRows = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`DELETE FROM public.authz_rules`;
  yield* sql`DELETE FROM public.authz_tag_assignments`;
  yield* sql`DELETE FROM public.authz_tags`;
});

const resetFixture = Effect.gen(function* () {
  const sql = yield* Database;
  yield* clearAuthzRows;
  yield* sql`DELETE FROM public.organization_departments`;
  yield* sql`DELETE FROM public.person_profiles`;
  yield* sql`
    INSERT INTO public.person_profiles (person_id, first_name, last_name)
    VALUES
      ('authz-backfill-person-a', 'Ada', 'Author'),
      ('authz-backfill-person-b', 'Bea', 'Backfill')
  `;
  yield* sql`
    INSERT INTO public.organization_departments (
      department_id, name, short_name, email, city
    ) VALUES (
      'authz-backfill-department', 'Disposable Department', 'DSP',
      'disposable-authz@example.invalid', 'Bergen'
    )
  `;
});

const authzCounts = Effect.gen(function* () {
  const sql = yield* Database;
  const tags = yield* sql<CountRow>`SELECT count(*)::text AS count FROM public.authz_tags`;
  const assignments = yield* sql<CountRow>`
    SELECT count(*)::text AS count FROM public.authz_tag_assignments
  `;
  const rules = yield* sql<CountRow>`SELECT count(*)::text AS count FROM public.authz_rules`;
  return {
    tags: Number(tags[0]?.count ?? "0"),
    assignments: Number(assignments[0]?.count ?? "0"),
    rules: Number(rules[0]?.count ?? "0"),
  };
});

const authzSnapshot = Effect.gen(function* () {
  const sql = yield* Database;
  const tags = yield* sql`
    SELECT tag_id AS "tagId", name, revision
    FROM public.authz_tags
    ORDER BY tag_id
  `;
  const assignments = yield* sql`
    SELECT
      assignment_id AS "assignmentId",
      tag_id AS "tagId",
      person_id AS "personId",
      start_at::text AS "startAt",
      end_at::text AS "endAt",
      revision
    FROM public.authz_tag_assignments
    ORDER BY assignment_id
  `;
  const rules = yield* sql`
    SELECT
      rule_id AS "ruleId",
      capability_id AS "capabilityId",
      effect_kind AS "effectKind",
      subject_kind AS "subjectKind",
      subject_person_id AS "subjectPersonId",
      subject_tag_id AS "subjectTagId",
      scope,
      department_id AS "departmentId",
      params,
      start_at::text AS "startAt",
      end_at::text AS "endAt",
      revision
    FROM public.authz_rules
    ORDER BY rule_id
  `;
  return { tags, assignments, rules };
});

beforeEach(async () => {
  await runtime.runPromise(resetFixture);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("disposable authorization backfill in PGlite", () => {
  it("persists reverse-order permutations identically and replays without duplicate rows", async () => {
    const forwardPlan = await runtime.runPromise(persistDisposableAuthzBackfill(validInput()));
    const forwardSnapshot = await runtime.runPromise(authzSnapshot);

    await runtime.runPromise(clearAuthzRows);
    const reversePlan = await runtime.runPromise(persistDisposableAuthzBackfill(reversedInput()));
    const reverseSnapshot = await runtime.runPromise(authzSnapshot);
    const replayPlan = await runtime.runPromise(persistDisposableAuthzBackfill(validInput()));

    expect(canonicalJson(reversePlan)).toBe(canonicalJson(forwardPlan));
    expect(canonicalJson(replayPlan)).toBe(canonicalJson(forwardPlan));
    expect(canonicalJson(reverseSnapshot)).toBe(canonicalJson(forwardSnapshot));
    expect(await runtime.runPromise(authzCounts)).toEqual({ tags: 2, assignments: 2, rules: 3 });
  });

  it("rejects an absent person before writing tags, assignments, or rules", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        persistDisposableAuthzBackfill({
          disposable: true,
          tags: [{ name: "Missing person tag" }],
          assignments: [],
          rulesBySubject: [
            {
              subject: { _tag: "Person", personId: "authz-backfill-absent-person" },
              rules: [
                {
                  capabilityId: "approveReceipt",
                  effectKind: "delegate",
                  scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
                  params: { slot: "EconomyGlobalReceiptApprovalGrant" },
                  startAt,
                  endAt: null,
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "DisposableAuthzBackfillMissingReference",
      referenceKind: "Person",
      referenceId: "authz-backfill-absent-person",
    });
    expect(await runtime.runPromise(authzCounts)).toEqual({ tags: 0, assignments: 0, rules: 0 });
  });

  it("rejects an absent tag before opening a persistence path", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        persistDisposableAuthzBackfill({
          disposable: true,
          tags: [],
          assignments: [],
          rulesBySubject: [
            {
              subject: { _tag: "Tag", tagName: "Absent disposable tag" },
              rules: [
                {
                  capabilityId: "approveReceipt",
                  effectKind: "delegate",
                  scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
                  params: { slot: "EconomyGlobalReceiptApprovalGrant" },
                  startAt,
                  endAt: null,
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "DisposableAuthzBackfillMissingReference",
      referenceKind: "Tag",
      referenceId: "Absent disposable tag",
    });
    expect(await runtime.runPromise(authzCounts)).toEqual({ tags: 0, assignments: 0, rules: 0 });
  });

  it("rejects an absent department before any otherwise-valid row is persisted", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        persistDisposableAuthzBackfill({
          disposable: true,
          tags: [{ name: "Department reference tag" }],
          assignments: [
            {
              tagName: "Department reference tag",
              personId: "authz-backfill-person-a",
              startAt,
              endAt: null,
            },
          ],
          rulesBySubject: [
            {
              subject: { _tag: "Person", personId: "authz-backfill-person-a" },
              rules: [
                {
                  capabilityId: "approveReceipt",
                  effectKind: "delegate",
                  scope: { _tag: "Department", departmentId: "authz-backfill-absent-department" },
                  params: { slot: "EconomyDepartmentApprovalGrant" },
                  startAt,
                  endAt: null,
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "DisposableAuthzBackfillMissingReference",
      referenceKind: "Department",
      referenceId: "authz-backfill-absent-department",
    });
    expect(await runtime.runPromise(authzCounts)).toEqual({ tags: 0, assignments: 0, rules: 0 });
  });

  it("rejects invalid capability and params before writing", async () => {
    const base = validInput();
    const personGroup = base.rulesBySubject[1];
    if (personGroup === undefined) throw new Error("missing fixture person group");
    const rule = personGroup.rules[0];
    if (rule === undefined) throw new Error("missing fixture rule");
    const invalidInputs: ReadonlyArray<unknown> = [
      {
        ...base,
        rulesBySubject: [
          { ...personGroup, rules: [{ ...rule, capabilityId: "unknownCapability" }] },
        ],
      },
      {
        ...base,
        rulesBySubject: [
          {
            ...personGroup,
            rules: [
              {
                ...rule,
                capabilityId: "submitReceipt",
                params: { slot: "EconomyPaymentAuthority", ignored: true },
              },
            ],
          },
        ],
      },
    ];

    for (const invalidInput of invalidInputs) {
      const failure = await runtime.runPromise(
        Effect.flip(persistDisposableAuthzBackfill(invalidInput)),
      );
      expect(failure._tag).toBe("DisposableAuthzBackfillDecodeError");
    }
    expect(await runtime.runPromise(authzCounts)).toEqual({ tags: 0, assignments: 0, rules: 0 });
  });

  it("rolls back earlier create commands when a later database write fails", async () => {
    const input = {
      disposable: true,
      tags: [{ name: "Atomic tag A" }, { name: "Atomic tag B" }],
      assignments: [],
      rulesBySubject: [],
    };
    const plan = await runtime.runPromise(authorDisposableAuthzBackfill(input));
    const conflictingTag = plan.tags[1];
    if (conflictingTag === undefined) throw new Error("missing second atomicity tag");
    await runtime.runPromise(
      Database.use(
        (sql) => sql`
          INSERT INTO public.authz_tags (tag_id, name, revision)
          VALUES ('preexisting-conflicting-tag', ${conflictingTag.name}, 0)
        `,
      ),
    );

    const failure = await runtime.runPromise(Effect.flip(persistDisposableAuthzBackfill(input)));
    expect(failure._tag).toBe("AuthzPersistenceError");
    const snapshot = await runtime.runPromise(authzSnapshot);
    expect(snapshot.tags).toEqual([
      { tagId: "preexisting-conflicting-tag", name: conflictingTag.name, revision: 0 },
    ]);
    expect(snapshot.assignments).toEqual([]);
    expect(snapshot.rules).toEqual([]);
  });
});
