/** A real previous-schema fixture: execute canonical migrations through0036, seed immutable history, then caller applies0037 normally. */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Pool } from "pg";
import { databaseMigrationDefinitions } from "../src/migrations.js";
const url = process.env.JOURNEY_SEED_PG_URL!;
if (new URL(url).hostname !== "127.0.0.1") throw new Error("Loopback fixture only");
const previous = databaseMigrationDefinitions.filter((d) => Number(d.id.split("_")[0]) < 37);
await Effect.runPromise(
  Migrator.make({})({
    table: "vektorprogrammet_schema_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(
        previous.map((d) => [
          d.id,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const source = yield* Effect.promise(() => readFile(d.url, "utf8"));
            yield* sql.unsafe(source).raw;
          }),
        ]),
      ),
    ),
  }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) }))),
);
const pool = new Pool({ connectionString: url });
try {
  await pool.query(
    `INSERT INTO public.person_profiles(person_id,first_name,last_name,revision) VALUES('journey-conduct-leader-0063','Lina','Lagleder',0)`,
  );
  execFileSync("bun", ["apps/dashboard/e2e/native-conduct-journey-seed.mjs"], {
    env: { ...process.env, CONDUCT_SEED_SKIP_IDENTITY: "1" },
    stdio: "pipe",
  });
  await pool.query("BEGIN");
  for (const suffix of ["maybe", "no", "history"] as const) {
    const applicant = `applicant-recommendation-${suffix}`,
      application = `application-recommendation-${suffix}`,
      interview = `interview-recommendation-${suffix}`,
      invitation = `invitation-recommendation-${suffix}`;
    const clone = async (table: string, where: string, values: Record<string, unknown>) =>
      pool.query(
        `INSERT INTO public.${table} SELECT (jsonb_populate_record(NULL::public.${table},to_jsonb(source)||$1::jsonb)).* FROM public.${table} source WHERE ${where}`,
        [JSON.stringify(values)],
      );
    await clone("admission_applicants", "applicant_id='applicant-native-conduct-a-0063'", {
      applicant_id: applicant,
      email: `${suffix}@example.invalid`,
      normalized_email: `${suffix}@example.invalid`,
      first_name: suffix,
      last_name: "Recommendation",
    });
    await clone("admission_applications", "application_id='application-native-conduct-a-0063'", {
      application_id: application,
      applicant_id: applicant,
    });
    await clone("recruitment_interviews", "interview_id='interview-native-conduct-a-0063'", {
      interview_id: interview,
      application_id: application,
    });
    await clone(
      "recruitment_interview_schedules",
      "interview_id='interview-native-conduct-a-0063'",
      { interview_id: interview },
    );
    await clone("recruitment_invitations", "invitation_id='invitation-native-conduct-a-0063'", {
      invitation_id: invitation,
      interview_id: interview,
      capability_sha256: { maybe: "c", no: "d", history: "e" }[suffix]!.repeat(64),
    });
    await clone(
      "recruitment_invitation_response_audit",
      "invitation_id='invitation-native-conduct-a-0063'",
      {
        invitation_id: invitation,
        interview_id: interview,
      },
    );
    await clone(
      "recruitment_interview_question_snapshots",
      "interview_id='interview-native-conduct-a-0063'",
      { interview_id: interview },
    );
  }
  await pool.query(
    `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision) VALUES('interview-recommendation-history','[]',7,8,9,'journey-conduct-leader-0063',CURRENT_TIMESTAMP,1)`,
  );
  // Ordinary assigned member is the runtime subject, not an accidentally privileged fixture.
  await pool.query(
    `UPDATE public.organization_memberships SET is_team_leader=false,position_id='member' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  await pool.query("COMMIT");
} finally {
  await pool.end();
}
