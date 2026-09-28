/** A real previous-schema fixture: execute canonical migrations through0036, seed immutable history, then caller applies0037 normally. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess } from "effect/unstable/process";
import { Pool } from "pg";
import { databaseMigrationDefinitions } from "@vektorprogrammet/database/migrations";

/** A step of the fixture that failed, with what it observed. */
class PreupgradeFixtureFailure extends Schema.TaggedError<PreupgradeFixtureFailure>()(
  "PreupgradeFixtureFailure",
  { message: Schema.String },
) {}

type MigrationDefinition = { readonly id: string; readonly url: URL };

const program = Effect.gen(function* () {
  const url = yield* Config.String("JOURNEY_SEED_PG_URL");

  const throughMigration0038 = yield* Config.option(
    Config.String("RECOMMENDATION_PREUPGRADE_THROUGH_0038"),
  );

  if (new URL(url).hostname !== "127.0.0.1")
    return yield* PreupgradeFixtureFailure.make({ message: "Loopback fixture only" });

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const applyMigrations = (definitions: ReadonlyArray<MigrationDefinition>) =>
    Migrator.make({})({
      table: "vektorprogrammet_schema_migrations",
      loader: Migrator.fromRecord(
        Object.fromEntries(
          definitions.map((d) => [
            d.id,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              const source = yield* path
                .fromFileUrl(d.url)
                .pipe(Effect.flatMap(fileSystem.readFileString), Effect.orDie);

              yield* sql.unsafe(source).raw;
            }),
          ]),
        ),
      ),
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })));

  // The conduct seed runs with this environment and skips identity; its output is kept for a failure.
  const runConductSeed = Effect.scoped(
    Effect.gen(function* () {
      const seed = yield* ChildProcess.make(
        "bun",
        ["apps/dashboard/e2e/native-conduct-journey-seed.mjs"],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
          env: { CONDUCT_SEED_SKIP_IDENTITY: "1" },
          extendEnv: true,
          stdin: "ignore",
        },
      );

      const [output, exitCode] = yield* Effect.all(
        [seed.all.pipe(Stream.decodeText(), Stream.mkString), seed.exitCode],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0)
        return yield* PreupgradeFixtureFailure.make({
          message: `conduct seed exited ${exitCode}: ${output}`,
        });
    }),
  );

  const previous = databaseMigrationDefinitions.filter((d) => Number(d.id.split("_")[0]) < 37);

  yield* applyMigrations(previous);

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url })),
    (owned) => Effect.promise(() => owned.end()),
  );

  const query = (text: string, values?: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => pool.query(text, values === undefined ? undefined : [...values]),
      catch: (cause) => PreupgradeFixtureFailure.make({ message: String(cause) }),
    });

  yield* query(
    `INSERT INTO public.person_profiles(person_id,first_name,last_name,revision) VALUES
      ('journey-conduct-leader-0063','Lina','Lagleder',0),
      ('journey-conduct-applicant-0063','Sofie','Gjennomfører',0)`,
  );
  yield* runConductSeed;
  yield* query("BEGIN");

  for (const suffix of ["maybe", "no", "history", "self", "link-race", "read-race"] as const) {
    const applicant = `applicant-recommendation-${suffix}`,
      application = `application-recommendation-${suffix}`,
      interview = `interview-recommendation-${suffix}`,
      invitation = `invitation-recommendation-${suffix}`;

    const clone = (table: string, where: string, values: Record<string, Schema.Json>) =>
      query(
        `INSERT INTO public.${table} SELECT (jsonb_populate_record(NULL::public.${table},to_jsonb(source)||$1::jsonb)).* FROM public.${table} source WHERE ${where}`,
        [JSON.stringify(values)],
      );

    yield* clone("admission_applicants", "applicant_id='applicant-native-conduct-a-0063'", {
      applicant_id: applicant,
      email: `${suffix}@example.invalid`,
      normalized_email: `${suffix}@example.invalid`,
      first_name: suffix,
      last_name: "Recommendation",
    });
    yield* clone("admission_applications", "application_id='application-native-conduct-a-0063'", {
      application_id: application,
      applicant_id: applicant,
    });
    yield* clone("recruitment_interviews", "interview_id='interview-native-conduct-a-0063'", {
      interview_id: interview,
      application_id: application,
    });
    yield* clone(
      "recruitment_interview_schedules",
      "interview_id='interview-native-conduct-a-0063'",
      { interview_id: interview },
    );
    yield* clone("recruitment_invitations", "invitation_id='invitation-native-conduct-a-0063'", {
      invitation_id: invitation,
      interview_id: interview,
      capability_sha256: {
        maybe: "c",
        no: "d",
        history: "e",
        self: "f",
        "link-race": "9",
        "read-race": "8",
      }[suffix]!.repeat(64),
    });
    yield* clone(
      "recruitment_invitation_response_audit",
      "invitation_id='invitation-native-conduct-a-0063'",
      {
        invitation_id: invitation,
        interview_id: interview,
      },
    );
    yield* clone(
      "recruitment_interview_question_snapshots",
      "interview_id='interview-native-conduct-a-0063'",
      { interview_id: interview },
    );
  }

  yield* query(
    `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision) VALUES('interview-recommendation-history','[]',7,8,9,'journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),1)`,
  );
  // Ordinary assigned member is the runtime subject, not an accidentally privileged fixture.
  yield* query(
    `UPDATE public.organization_memberships SET is_team_leader=false,position_id='member' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  yield* query("COMMIT");

  if (Option.contains(throughMigration0038, "1")) {
    yield* applyMigrations(
      databaseMigrationDefinitions.filter((d) => {
        const id = Number(d.id.split("_")[0]);

        return id >= 37 && id < 39;
      }),
    );
  }
});

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
