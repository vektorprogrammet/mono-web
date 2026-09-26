import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Pool } from "pg";
import { selectDatabaseMigration } from "./migrations.js";
import { withPostgresTestDatabase } from "./test-support/postgres.js";

/**
 * PostgreSQL adds days, weeks, months, and years to a timestamptz in the session TimeZone, so the
 * result moves by an hour when the span crosses a daylight saving change. Migration 0027 checked
 * the OAuth refresh windows that way, and the code exchange failed on a server in Europe/Oslo.
 * The migrated schema therefore shifts instants by hours, minutes, and seconds only, or names the
 * zone of a calendar shift with `date_add(instant, interval, zone)` or `date_subtract`.
 */

// An interval constant as PostgreSQL prints it ('30 days'::interval) or as a function body holds
// it (interval '30 days'), and make_interval with a calendar argument.
const intervalConstant =
  /'([^']*)'::interval|\binterval\s*'([^']*)'|\bmake_interval\s*\(([^)]*)\)/giu;

const calendarAmount =
  /\d\s*(?:millenni\w*|centur\w*|decades?|years?|yrs?|y|mons?|months?|weeks?|w|days?|d)\b|^\s*[+-]?P[^T]*[YMWD]/iu;

const calendarArgument = /\b(?:years|months|weeks|days)\s*=>/iu;

// The zone argument of date_add or date_subtract after the interval.
const explicitZone = /^\s*,\s*'[^']*'(?:::text)?\s*\)/u;

/** The calendar shifts in one definition that do not name their zone. */
const zonelessCalendarShifts = (definition: string) =>
  [...definition.matchAll(intervalConstant)].flatMap(
    ({ 0: constant, 1: printed, 2: written, 3: argumentList, index }) =>
      (
        argumentList === undefined
          ? calendarAmount.test(printed ?? written ?? "") &&
            !explicitZone.test(definition.slice(index + constant.length))
          : calendarArgument.test(argumentList)
      )
        ? [constant]
        : [],
  );

/** Every definition in the schemas that the migrations own, as PostgreSQL prints it. */
const readDefinitions = (pool: Pool) =>
  Effect.promise(() =>
    pool.query<{ readonly object: string; readonly definition: string }>(`
      WITH owned AS (
        SELECT oid FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema')
           AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
      )
      SELECT 'check ' || conrelid::regclass || ' ' || conname AS object,
             pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE contype = 'c' AND connamespace IN (SELECT oid FROM owned)
      UNION ALL
      SELECT 'default ' || attrdef.adrelid::regclass || ' ' || attribute.attname,
             pg_get_expr(attrdef.adbin, attrdef.adrelid)
        FROM pg_attrdef attrdef
        JOIN pg_attribute attribute
          ON attribute.attrelid = attrdef.adrelid AND attribute.attnum = attrdef.adnum
        JOIN pg_class relation ON relation.oid = attrdef.adrelid
       WHERE relation.relnamespace IN (SELECT oid FROM owned)
      UNION ALL
      SELECT 'view ' || oid::regclass, pg_get_viewdef(oid)
        FROM pg_class WHERE relkind IN ('v', 'm') AND relnamespace IN (SELECT oid FROM owned)
      UNION ALL
      SELECT 'index ' || indexrelid::regclass, pg_get_indexdef(indexrelid)
        FROM pg_index JOIN pg_class relation ON relation.oid = pg_index.indexrelid
       WHERE relation.relnamespace IN (SELECT oid FROM owned)
      UNION ALL
      SELECT 'trigger ' || tgrelid::regclass || ' ' || tgname, pg_get_triggerdef(oid)
        FROM pg_trigger WHERE NOT tgisinternal
      UNION ALL
      SELECT 'function ' || function.oid::regprocedure, pg_get_functiondef(function.oid)
        FROM pg_proc function JOIN pg_language language ON language.oid = function.prolang
       WHERE language.lanname IN ('sql', 'plpgsql') AND function.prokind IN ('f', 'p')
         AND function.pronamespace IN (SELECT oid FROM owned)
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend
            WHERE classid = 'pg_proc'::regclass AND objid = function.oid AND deptype = 'e'
         )
      ORDER BY object
    `),
  ).pipe(
    Effect.map((result) =>
      result.rows.flatMap(({ object, definition }) =>
        zonelessCalendarShifts(definition).map((shift) => `${object}: ${shift}`),
      ),
    ),
  );

describe("calendar arithmetic in the migrated schema", () => {
  it.effect("finds the refresh-window checks of migration 0027 before migration 0077", () =>
    Effect.promise(() =>
      withPostgresTestDatabase(
        (pool) => Effect.runPromise(readDefinitions(pool)),
        selectDatabaseMigration("77_oauth-refresh-elapsed-windows").preceding,
      ),
    ).pipe(
      Effect.map((findings) =>
        expect(findings).toEqual([
          "check auth.oauth_refresh_families oauth_refresh_families_check1: '30 days'::interval",
          "check auth.oauth_refresh_families oauth_refresh_families_check2: '7 days'::interval",
        ]),
      ),
    ),
  );

  it.effect("shifts no instant by a calendar amount in the session TimeZone", () =>
    Effect.promise(() =>
      withPostgresTestDatabase((pool) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const migrated = yield* readDefinitions(pool);

            // Each calendar shift is a finding; hours and a named zone are the negative controls.
            yield* Effect.promise(() =>
              pool.query(`
                CREATE SCHEMA calendar_control;
                CREATE TABLE calendar_control.windows (
                  opened_at timestamptz NOT NULL,
                  closes_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '1 day',
                  CONSTRAINT calendar CHECK (closes_at <= opened_at + interval '30 days'),
                  CONSTRAINT iso CHECK (closes_at <= opened_at + interval 'P1M'),
                  CONSTRAINT elapsed CHECK (closes_at <= opened_at + interval '720 hours'),
                  CONSTRAINT zoned CHECK (closes_at <= date_add(opened_at, interval '1 mon', 'UTC'))
                );
                CREATE VIEW calendar_control.earlier AS
                  SELECT opened_at - interval '1 year' AS opened_before FROM calendar_control.windows;
                CREATE FUNCTION calendar_control.extend(instant timestamptz) RETURNS timestamptz
                  LANGUAGE plpgsql AS $$ BEGIN RETURN instant + interval '2 weeks'; END $$;
                CREATE FUNCTION calendar_control.extend_days(instant timestamptz) RETURNS timestamptz
                  LANGUAGE sql RETURN instant + make_interval(days => 2);
                CREATE FUNCTION calendar_control.extend_hours(instant timestamptz) RETURNS timestamptz
                  LANGUAGE sql RETURN instant + make_interval(hours => 2);
                CREATE FUNCTION calendar_control.extend_zoned(instant timestamptz) RETURNS timestamptz
                  LANGUAGE sql RETURN date_subtract(instant, interval '3 days', 'Europe/Oslo');
              `),
            );

            return { migrated, controls: yield* readDefinitions(pool) };
          }),
        ),
      ),
    ).pipe(
      Effect.map((findings) =>
        expect(findings).toEqual({
          migrated: [],
          controls: [
            "check calendar_control.windows calendar: '30 days'::interval",
            "check calendar_control.windows iso: '1 mon'::interval",
            "default calendar_control.windows closes_at: '1 day'::interval",
            "function calendar_control.extend(timestamp with time zone): interval '2 weeks'",
            "function calendar_control.extend_days(timestamp with time zone): make_interval(days => 2)",
            "view calendar_control.earlier: '1 year'::interval",
          ],
        }),
      ),
    ),
  );
});
