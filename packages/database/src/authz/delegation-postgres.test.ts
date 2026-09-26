import { describe, expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import {
  DelegationArea,
  DelegationCommand,
  type DelegableCapability,
  reachedDepartments,
  ReachedDepartments,
} from "@vektorprogrammet/domain/authz";
import {
  DepartmentId,
  Organization,
  PersonId,
  TeamId,
} from "@vektorprogrammet/domain/organization";
import {
  Economy,
  ReceiptCommandRequestSchema,
  ReceiptId,
  ReceiptSettlementCommandRequestSchema,
} from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "../receipt/postgres-layer.js";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";

const databaseLayer = DatabaseTestLive();

const trondheim = DepartmentId.make("delegation-trondheim");

const oslo = DepartmentId.make("delegation-oslo");

const rekruttering = TeamId.make("delegation-rekruttering");

const okonomi = TeamId.make("delegation-okonomi");

const person = {
  styret: PersonId.make("delegation-styret-leader"),
  osloStyret: PersonId.make("delegation-oslo-styret-leader"),
  hovedstyret: PersonId.make("delegation-hovedstyret-leader"),
  administrator: PersonId.make("delegation-global-administrator"),
  recruiter: PersonId.make("delegation-recruiter"),
  economyMember: PersonId.make("delegation-economy-member"),
  financeLead: PersonId.make("delegation-finance-lead"),
  owner: PersonId.make("delegation-receipt-owner"),
};

// The people, departments, teams, and memberships of every case, seeded once per suite.
const seedDelegationFixtures = Layer.effectDiscard(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES
        (${person.styret},'Styre','Trondheim'), (${person.osloStyret},'Styre','Oslo'),
        (${person.hovedstyret},'Hoved','Styret'), (${person.administrator},'Global','Admin'),
        (${person.recruiter},'Rekrut','Terer'), (${person.economyMember},'Øko','Medlem'),
        (${person.financeLead},'Finans','Leder'), (${person.owner},'Utlegg','Eier')`;
      yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified")
        SELECT person_id, first_name, person_id || '@example.invalid', true
        FROM person_profiles WHERE person_id LIKE 'delegation-%'`;
      yield* sql`INSERT INTO organization_departments
        (department_id,name,short_name,email,city,independent) VALUES
        (${trondheim},'Trondheim','TRD','trd@example.invalid','Trondheim',true),
        (${oslo},'Oslo','OSL','osl@example.invalid','Oslo',true)`;
      yield* sql`INSERT INTO organization_teams (team_id,department_id,name,kind,team_scope) VALUES
        ('delegation-styret-trondheim',${trondheim},'Styret Trondheim','DepartmentBoard','HomeDepartment'),
        ('delegation-styret-oslo',${oslo},'Styret Oslo','DepartmentBoard','HomeDepartment'),
        (${rekruttering},${trondheim},'Rekruttering','Team','HomeDepartment'),
        (${okonomi},${trondheim},'Økonomi','Team','National')`;
      yield* sql`INSERT INTO organization_national_boards (board_id,name) VALUES ('delegation-hs','Hovedstyret')`;
      yield* sql`INSERT INTO organization_memberships
        (membership_id,person_id,team_id,board_id,start_at,end_at,is_team_leader,is_suspended) VALUES
        ('d-styret',${person.styret},'delegation-styret-trondheim',NULL,'2020-01-01',NULL,true,false),
        ('d-oslo',${person.osloStyret},'delegation-styret-oslo',NULL,'2020-01-01',NULL,true,false),
        ('d-hs',${person.hovedstyret},NULL,'delegation-hs','2020-01-01',NULL,true,false),
        ('d-recruiter',${person.recruiter},${rekruttering},NULL,'2020-01-01',NULL,false,false),
        ('d-economy',${person.economyMember},${okonomi},NULL,'2020-01-01',NULL,false,false),
        ('d-finance',${person.financeLead},${okonomi},NULL,'2020-01-01',NULL,true,false),
        ('d-owner',${person.owner},${rekruttering},NULL,'2020-01-01',NULL,false,false)`;
      yield* sql`INSERT INTO organization_global_administrator_grants (grant_id,person_id,start_at,end_at,revision)
        VALUES ('delegation-grant',${person.administrator},'2020-01-01',NULL,0)`;
    }),
  ),
);

const delegationLayer = seedDelegationFixtures.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProfileLive.pipe(
        Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(databaseLayer))),
      ),
      EconomyLive.pipe(Layer.provide(databaseLayer)),
    ),
  ),
);

let commandNumber = 0;

const issue = (
  actor: PersonId,
  teamId: TeamId,
  capability: DelegableCapability,
  area: DelegationArea,
  input: { readonly holders?: "AllMembers" | "LeadersOnly"; readonly startAt?: string } = {},
) =>
  Organization.use((organization) =>
    organization.executeDelegation(
      DelegationCommand.cases.IssueDelegation.make({
        commandId: `delegation-command-${++commandNumber}`,
        reason: "Semesterstart",
        name: `${capability} for ${teamId}`,
        teamId,
        capability,
        area,
        holders: input.holders ?? "AllMembers",
        startAt: input.startAt ?? "2020-06-01T00:00:00.000Z",
        endAt: null,
      }),
      actor,
    ),
  );

const inTrondheim = DelegationArea.cases.Department.make({ departmentId: trondheim });

const nationally = DelegationArea.cases.Organization.make({});

const authorityAt = (personId: PersonId, instant: string) =>
  Organization.use((organization) => organization.resolvePersonAuthority(personId, instant));

layer(delegationLayer, { excludeTestServices: true, timeout: "30 seconds" })(
  "delegations",
  (it) => {
    describe("delegation management (O8-12, O8-14)", () => {
      it.effect(
        "lets a Styret leader manage delegations only for the teams of its own department",
        () =>
          Effect.gen(function* () {
            const issued = yield* issue(
              person.styret,
              rekruttering,
              "admissions.outcomes",
              inTrondheim,
            );

            expect(issued.revision).toBe(0);

            const otherDepartment = yield* Effect.flip(
              issue(person.osloStyret, rekruttering, "admissions.outcomes", inTrondheim),
            );

            expect(otherDepartment).toMatchObject({ code: "Denied" });

            const nationalTeam = yield* Effect.flip(
              issue(person.styret, okonomi, "receipts.approve", nationally),
            );

            expect(nationalTeam).toMatchObject({ code: "Denied" });

            const management = yield* Organization.use((organization) =>
              organization.readDelegationManagement(person.osloStyret),
            );

            expect(management.teams).toEqual([]);
          }),
      );

      it.effect("lets Hovedstyret's leader and a global administrator manage national teams", () =>
        Effect.gen(function* () {
          const byHovedstyret = yield* issue(
            person.hovedstyret,
            okonomi,
            "receipts.approve",
            nationally,
          );

          const byAdministrator = yield* issue(
            person.administrator,
            okonomi,
            "receipts.settle",
            nationally,
            {
              holders: "LeadersOnly",
            },
          );

          expect(byHovedstyret.revision).toBe(0);
          expect(byAdministrator.revision).toBe(0);

          const leadersOnly = yield* Effect.flip(
            issue(person.administrator, okonomi, "receipts.settle", nationally),
          );

          expect(leadersOnly).toMatchObject({ code: "Invalid" });
        }),
      );

      it.effect(
        "replays an identical command and rejects a changed one under the same identifier",
        () =>
          Effect.gen(function* () {
            const command = DelegationCommand.cases.IssueDelegation.make({
              commandId: "delegation-replay",
              reason: "Semesterstart",
              name: "Rekruttering leser brukere",
              teamId: rekruttering,
              capability: "people.read",
              area: inTrondheim,
              holders: "LeadersOnly",
              startAt: "2020-06-01T00:00:00.000Z",
              endAt: null,
            });

            const execute = (input: typeof command) =>
              Organization.use((organization) =>
                organization.executeDelegation(input, person.styret),
              );

            const first = yield* execute(command);
            const replay = yield* execute(command);

            expect(replay).toEqual(first);

            const changed = yield* Effect.flip(execute({ ...command, holders: "AllMembers" }));

            expect(changed).toMatchObject({ code: "Conflict" });
          }),
      );
    });

    describe("delegated reach (O8-12)", () => {
      it.effect(
        "gives exactly the capability in the area during the interval, and nothing after its end",
        () =>
          Effect.gen(function* () {
            const startedAt = yield* DateTime.now;
            const now = DateTime.formatIso(startedAt);
            const endsAt = DateTime.add(startedAt, { milliseconds: 60_000 });
            const endAt = DateTime.formatIso(endsAt);

            const issued = yield* issue(
              person.styret,
              rekruttering,
              "admissions.periods",
              inTrondheim,
              { startAt: now },
            );

            const before = yield* authorityAt(
              person.recruiter,
              DateTime.formatIso(DateTime.subtract(startedAt, { milliseconds: 1 })),
            );

            const during = yield* authorityAt(person.recruiter, now);

            expect(reachedDepartments(before, "admissions.periods")).toEqual(
              ReachedDepartments.Departments({ departmentIds: [] }),
            );
            expect(reachedDepartments(during, "admissions.periods")).toEqual(
              ReachedDepartments.Departments({ departmentIds: [trondheim] }),
            );
            expect(reachedDepartments(during, "placements.coordinate")).toEqual(
              ReachedDepartments.Departments({ departmentIds: [] }),
            );

            const ended = yield* Organization.use((organization) =>
              organization.executeDelegation(
                DelegationCommand.cases.EndDelegation.make({
                  commandId: "delegation-end",
                  reason: "Opptaket er ferdig",
                  delegationId: issued.delegationId,
                  expectedRevision: 0,
                  endAt,
                }),
                person.styret,
              ),
            );

            expect(ended.revision).toBe(1);

            const lastInstant = yield* authorityAt(
              person.recruiter,
              DateTime.formatIso(DateTime.subtract(endsAt, { milliseconds: 1 })),
            );

            const atEnd = yield* authorityAt(person.recruiter, endAt);

            expect(reachedDepartments(lastInstant, "admissions.periods")).toEqual(
              ReachedDepartments.Departments({ departmentIds: [trondheim] }),
            );
            // The end instant is exclusive.
            expect(reachedDepartments(atEnd, "admissions.periods")).toEqual(
              ReachedDepartments.Departments({ departmentIds: [] }),
            );
          }),
      );

      it.effect("reaches no suspended member", () =>
        Effect.gen(function* () {
          yield* Database.use(
            (sql) =>
              sql`UPDATE organization_memberships SET is_suspended = true, revision = revision + 1 WHERE membership_id = 'd-recruiter'`,
          );

          yield* Effect.gen(function* () {
            const suspended = yield* authorityAt(person.recruiter, "2021-01-01T00:00:00.000Z");

            expect(reachedDepartments(suspended, "admissions.outcomes")).toEqual(
              ReachedDepartments.Departments({ departmentIds: [] }),
            );
          }).pipe(
            Effect.ensuring(
              Database.use(
                (sql) =>
                  sql`UPDATE organization_memberships SET is_suspended = false, revision = revision + 1 WHERE membership_id = 'd-recruiter'`,
              ).pipe(Effect.orDie),
            ),
          );

          const reinstated = yield* authorityAt(person.recruiter, "2021-01-01T00:00:00.000Z");

          expect(reachedDepartments(reinstated, "admissions.outcomes")).toEqual(
            ReachedDepartments.Departments({ departmentIds: [trondheim] }),
          );
        }),
      );
    });

    describe("the economy team's national delegations (O8-15)", () => {
      const instant = "2038-06-15T12:00:00.000Z";

      const receipt = (receiptId: string, digest: string) =>
        Database.use(
          (sql) => sql`INSERT INTO public.economy_receipts (
        receipt_id, visual_id, owner_person_id, department_id, amount_ore, currency, description,
        receipt_date, submitted_at, status, approved_at, payment_account_ciphertext, file_ref,
        file_object_key, file_content_type, file_byte_length, file_sha256, revision
      ) VALUES (
        ${receiptId}, ${receiptId.toUpperCase()}, ${person.owner}, ${oslo}, 12345, 'NOK', 'Reise',
        '2038-06-14', '2038-06-14T10:00:00.000Z', 'Pending', NULL, 'ciphertext:v1:delegation',
        ${`${receiptId}-file`}, ${`temporary/${receiptId}`}, 'application/pdf', 128, ${digest}, 0
      )`,
        );

      const principal = (personId: PersonId) => ({ personId, authorizationInstant: instant });

      it.effect("lets every member approve and only the finance lead record the settlement", () =>
        Effect.gen(function* () {
          yield* receipt("delegation-receipt-1", "a".repeat(64));

          const approved = yield* Economy.use((economy) =>
            economy.executeReceipt(
              ReceiptCommandRequestSchema.cases.ApproveReceipt.make({
                commandId: "delegation-approve-1",
                receiptId: ReceiptId.make("delegation-receipt-1"),
                expectedRevision: 0,
              }),
              principal(person.economyMember),
            ),
          );

          expect(approved.receipt.status).toBe("Approved");

          const settle = (personId: PersonId, commandId: string) =>
            Economy.use((economy) =>
              economy.recordReceiptSettlement(
                ReceiptSettlementCommandRequestSchema.cases.RecordReceiptSettlement.make({
                  commandId,
                  receiptId: ReceiptId.make("delegation-receipt-1"),
                  expectedRevision: approved.receipt.revision,
                  externalAuthority: "delegation-bank",
                  externalReference: commandId,
                  settledAt: "2038-06-15T11:00:00.000Z",
                }),
                principal(personId),
              ),
            );

          const memberSettlement = yield* Effect.flip(
            settle(person.economyMember, "delegation-settle-member"),
          );

          expect(memberSettlement).toHaveProperty("_tag", "ReceiptNotFound");

          const leaderSettlement = yield* settle(person.financeLead, "delegation-settle-lead");

          expect(leaderSettlement.receipt.receiptId).toBe("delegation-receipt-1");
        }),
      );

      it.effect("gives an ordinary team's member no approval", () =>
        Effect.gen(function* () {
          yield* receipt("delegation-receipt-2", "b".repeat(64));

          const denied = yield* Effect.flip(
            Economy.use((economy) =>
              economy.executeReceipt(
                ReceiptCommandRequestSchema.cases.ApproveReceipt.make({
                  commandId: "delegation-approve-2",
                  receiptId: ReceiptId.make("delegation-receipt-2"),
                  expectedRevision: 0,
                }),
                principal(person.recruiter),
              ),
            ),
          );

          expect(denied).toHaveProperty("_tag", "ReceiptScopeDenied");
        }),
      );
    });
  },
);
