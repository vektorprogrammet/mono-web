import assert from "node:assert/strict";
import {
  Profile,
  ProfileCommandId,
  ProfileLive,
  type UpdateOwnProfileCommand,
} from "@vektorprogrammet/domain/profile";
import { PersonId, OrganizationLive } from "@vektorprogrammet/domain/organization";
import { Database } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Config, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { DatabaseLive } from "./layers.js";
import { databaseSchemaRevision } from "./migrations.js";

const personId = PersonId.make("profile-self-edit-e2e-0064");
const expectedRevision = Number(process.env.PROFILE_E2E_EXPECTED_REVISION ?? "2");
const left: UpdateOwnProfileCommand = {
  _tag: "UpdateOwnProfile",
  commandId: ProfileCommandId.make("profile-concurrency-left-0064"),
  expectedNameRevision: expectedRevision,
  expectedContactRevision: expectedRevision,
  firstName: "Ada Contender A",
  lastName: "Profile Contender A",
  email: "profile-contender-a-0064@example.invalid",
  phone: "+47 9000 0011",
};
const right: UpdateOwnProfileCommand = {
  ...left,
  commandId: ProfileCommandId.make("profile-concurrency-right-0064"),
  firstName: "Ada Contender B",
  lastName: "Profile Contender B",
  email: "profile-contender-b-0064@example.invalid",
  phone: "+47 9000 0012",
};

const makeProofLayer = (url: Redacted.Redacted<string>, applicationName: string) => {
  const database = DatabaseLive({ url, applicationName, maxConnections: 1 });
  const organization = OrganizationLive.pipe(Layer.provide(database));
  const profile = ProfileLive.pipe(Layer.provide(Layer.merge(database, organization)));
  return Layer.mergeAll(database, organization, profile);
};

const contender = (
  command: UpdateOwnProfileCommand,
  ready: Deferred.Deferred<void>,
  start: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const profile = yield* Profile;
    const [connection] = yield* sql<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`;
    yield* Deferred.succeed(ready, undefined);
    yield* Deferred.await(start);
    const outcome = yield* Effect.result(
      profile.updateOwnProfile({ actorPersonId: personId, command }),
    );
    return { pid: connection?.pid ?? -1, commandId: command.commandId, outcome };
  });

const race = (url: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const readyA = yield* Deferred.make<void>();
    const readyB = yield* Deferred.make<void>();
    const start = yield* Deferred.make<void>();
    const fiberA = yield* Effect.forkScoped(
      contender(left, readyA, start).pipe(
        Effect.provide(makeProofLayer(url, "profile-concurrency-left-0064")),
      ),
    );
    const fiberB = yield* Effect.forkScoped(
      contender(right, readyB, start).pipe(
        Effect.provide(makeProofLayer(url, "profile-concurrency-right-0064")),
      ),
    );
    yield* Deferred.await(readyA);
    yield* Deferred.await(readyB);
    yield* Deferred.succeed(start, undefined);
    return yield* Effect.all([Fiber.join(fiberA), Fiber.join(fiberB)], {
      concurrency: "unbounded",
    });
  });

const observe = (url: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const [profile] = yield* sql<{
      readonly personId: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly email: string;
      readonly phone: string;
      readonly nameRevision: number;
      readonly contactRevision: number;
    }>`
      SELECT p.person_id AS "personId", p.first_name AS "firstName", p.last_name AS "lastName",
             c.email, c.phone, p.revision AS "nameRevision", c.revision AS "contactRevision"
      FROM person_profiles p INNER JOIN person_contact_profiles c ON c.person_id = p.person_id
      WHERE p.person_id = ${personId}
    `;
    const receipts = yield* sql<{
      readonly commandId: string;
      readonly commandSha256: string;
      readonly commandJson: unknown;
      readonly resultJson: unknown;
      readonly actorPersonId: string;
      readonly expectedNameRevision: number;
      readonly expectedContactRevision: number;
      readonly committedNameRevision: number;
      readonly committedContactRevision: number;
    }>`
      SELECT command_id AS "commandId", command_sha256 AS "commandSha256", command_json AS "commandJson",
             result_json AS "resultJson", actor_person_id AS "actorPersonId",
             expected_name_revision AS "expectedNameRevision", expected_contact_revision AS "expectedContactRevision",
             committed_name_revision AS "committedNameRevision", committed_contact_revision AS "committedContactRevision"
      FROM profile_self_edit_commands
      WHERE command_id IN (${left.commandId}, ${right.commandId})
      ORDER BY command_id
    `;
    return { profile, receipts };
  }).pipe(Effect.provide(makeProofLayer(url, "profile-proof-observer-0064")));

const runCommand = (
  url: Redacted.Redacted<string>,
  command: UpdateOwnProfileCommand,
  applicationName: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const profile = yield* Profile;
      return yield* profile.updateOwnProfile({ actorPersonId: personId, command });
    }).pipe(Effect.provide(makeProofLayer(url, applicationName))),
  );

export const program = Effect.scoped(
  Effect.gen(function* () {
    const url = yield* Config.redacted("PROFILE_E2E_PG_URL");
    const raceResults = yield* race(url);
    const successes = raceResults.filter((entry) => entry.outcome._tag === "Success");
    const stale = raceResults.filter(
      (entry) =>
        entry.outcome._tag === "Failure" && entry.outcome.failure._tag === "ProfileStaleRevision",
    );
    assert.equal(raceResults.length, 2);
    assert.equal(successes.length, 1);
    assert.equal(stale.length, 1);
    assert.notEqual(raceResults[0]?.pid, raceResults[1]?.pid);
    const winner = successes[0];
    assert.ok(winner);
    const winnerCommand = winner.commandId === left.commandId ? left : right;
    const observed = yield* observe(url);
    assert.equal(observed.receipts.length, 1);
    assert.ok(observed.profile);
    assert.equal(observed.profile.nameRevision, expectedRevision + 1);
    assert.equal(observed.profile.contactRevision, expectedRevision + 1);
    assert.equal(observed.profile.firstName, winnerCommand.firstName);
    assert.equal(observed.profile.lastName, winnerCommand.lastName);
    assert.equal(observed.profile.email, winnerCommand.email);
    assert.equal(observed.profile.phone, winnerCommand.phone);
    const receipt = observed.receipts[0];
    assert.ok(receipt);
    const payload = {
      actorPersonId: personId,
      _tag: winnerCommand._tag,
      commandId: winnerCommand.commandId,
      expectedNameRevision: winnerCommand.expectedNameRevision,
      expectedContactRevision: winnerCommand.expectedContactRevision,
      firstName: winnerCommand.firstName,
      lastName: winnerCommand.lastName,
      email: winnerCommand.email,
      phone: winnerCommand.phone,
    };
    assert.equal(receipt.commandId, winnerCommand.commandId);
    assert.equal(receipt.actorPersonId, personId);
    assert.equal(receipt.commandSha256, sha256Hex(canonicalJsonBytes(payload)));
    assert.equal(canonicalJson(receipt.commandJson), canonicalJson(payload));
    assert.equal(receipt.committedNameRevision, expectedRevision + 1);
    assert.equal(receipt.committedContactRevision, expectedRevision + 1);
    assert.deepEqual(receipt.resultJson, observed.profile);

    const replay = yield* Effect.result(
      runCommand(url, winnerCommand, "profile-proof-replay-0064"),
    );
    assert.equal(replay._tag, "Success");
    if (replay._tag === "Success")
      assert.equal(canonicalJson(replay.success), canonicalJson(receipt.resultJson));
    const conflictCommand = { ...winnerCommand, firstName: `${winnerCommand.firstName} Changed` };
    const conflict = yield* Effect.result(
      runCommand(url, conflictCommand, "profile-proof-conflict-0064"),
    );
    assert.equal(conflict._tag, "Failure");
    if (conflict._tag === "Failure") assert.equal(conflict.failure._tag, "ProfileCommandConflict");
    const afterReplay = yield* observe(url);
    assert.equal(afterReplay.receipts.length, 1);
    assert.deepEqual(afterReplay.profile, observed.profile);
    const evidence = {
      specId: "0064",
      database: "PostgreSQL",
      schemaRevision: databaseSchemaRevision,
      expectedRevision,
      independentConnectionPids: raceResults.map((entry) => entry.pid),
      contenderOutcomes: raceResults.map((entry) => ({
        commandId: entry.commandId,
        pid: entry.pid,
        outcome:
          entry.outcome._tag === "Success"
            ? { tag: "Success" }
            : { tag: entry.outcome.failure._tag },
      })),
      winnerCommandId: winnerCommandId(winnerCommand),
      finalProfile: observed.profile,
      receipt: {
        countForContenders: observed.receipts.length,
        commandId: receipt.commandId,
        commandSha256: receipt.commandSha256,
        actorPersonId: receipt.actorPersonId,
        expectedNameRevision: receipt.expectedNameRevision,
        expectedContactRevision: receipt.expectedContactRevision,
        committedNameRevision: receipt.committedNameRevision,
        committedContactRevision: receipt.committedContactRevision,
        commandFields: Object.keys(payload).sort(),
        resultFields: Object.keys(receipt.resultJson as Record<string, unknown>).sort(),
      },
      replay: {
        tag: replay._tag,
        byteEqualResult: true,
        revisionsUnchanged: true,
        receiptCountUnchanged: true,
      },
      changedPayloadConflict: {
        tag: "ProfileCommandConflict",
        dataUnchanged: true,
        receiptUnchanged: true,
      },
    };
    process.stdout.write(`${canonicalJson(evidence)}\n`);
  }),
);

function winnerCommandId(command: UpdateOwnProfileCommand): string {
  return command.commandId;
}
