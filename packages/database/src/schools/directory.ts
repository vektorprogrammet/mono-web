import { Match, Predicate, Effect, Schema } from "effect";
import { Database } from "../service.js";
import type { OrganizationAuthorityInstant } from "@vektorprogrammet/domain/organization";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { Organization } from "@vektorprogrammet/domain/organization";
import { resolveSchoolsDirectoryScope } from "@vektorprogrammet/domain/schools";
import {
  SchoolsAuthorityInactive,
  SchoolsDecodeError,
  SchoolsDepartmentNotFound,
  SchoolsDepartmentOutOfScope,
  SchoolsNotInScope,
  SchoolsPersistenceError,
  type ReadSchoolsDirectoryFailure,
} from "@vektorprogrammet/domain/schools";
import {
  SchoolDirectoryQuerySchema,
  type SchoolDirectory,
  type SchoolDirectoryQuery,
} from "@vektorprogrammet/domain/schools";
import { Schools } from "@vektorprogrammet/domain/schools";

const decodeError = (operation: string, cause: unknown): SchoolsDecodeError =>
  new SchoolsDecodeError({ operation, message: String(cause) });

const persistenceError = (operation: string, cause: unknown): SchoolsPersistenceError =>
  new SchoolsPersistenceError({ operation, message: String(cause) });

/**
 * Authenticates no session and captures no clock: both values are explicit
 * inputs from the adapter. The journey resolves Organization once and reads
 * Schools in one repeatable-read, write-free transaction.
 */
export const readSchoolsDirectory = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  query: SchoolDirectoryQuery,
): Effect.Effect<SchoolDirectory, ReadSchoolsDirectoryFailure, Database | Organization | Schools> =>
  Effect.gen(function* () {
    const decodedQuery = yield* Schema.decodeUnknownEffect(SchoolDirectoryQuerySchema)(query, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Schools directory query", cause)));

    const database = yield* Database;
    const organization = yield* Organization;
    const schools = yield* Schools;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          // Organization supplies its canonical non-locking projection inside this snapshot.
          yield* database`
            SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY
          `.pipe(Effect.asVoid);

          const authority = yield* organization
            .resolvePersonAuthorityForRead(personId, authorizationInstant)
            .pipe(
              Effect.catchTag("OrganizationDecodeError", (cause) =>
                Effect.fail(decodeError("resolve Schools directory authority", cause)),
              ),
              Effect.catchTag("OrganizationPersistenceError", (cause) =>
                Effect.fail(persistenceError("resolve Schools directory authority", cause)),
              ),
            );

          if (authority.evaluatedAt !== authorizationInstant) {
            return yield* decodeError(
              "resolve Schools directory authority",
              "Organization authority used a different authorization instant",
            );
          }

          const decision = resolveSchoolsDirectoryScope(authority);

          if (Predicate.isTagged(decision, "Deny")) {
            return yield* decision.reason === "AuthorityInactive"
              ? new SchoolsAuthorityInactive({})
              : new SchoolsNotInScope({});
          }

          const scope = decision.value;
          const departmentId = decodedQuery.departmentId;

          if (departmentId !== undefined) {
            yield* organization.readDepartment(departmentId).pipe(
              Effect.asVoid,
              Effect.mapError((cause) => {
                return Match.value(cause).pipe(
                  Match.tag("DepartmentNotFound", () => {
                    return new SchoolsDepartmentNotFound({ departmentId });
                  }),
                  Match.tag("OrganizationPersistenceError", (cause) => {
                    return persistenceError("read Schools directory department", cause);
                  }),
                  Match.orElse((cause) => {
                    return decodeError("read Schools directory department", cause);
                  }),
                );
              }),
            );

            if (
              Predicate.isTagged(scope, "DepartmentIds") &&
              !scope.departmentIds.includes(departmentId)
            ) {
              return yield* new SchoolsDepartmentOutOfScope({ departmentId });
            }
          }

          return yield* schools.listDirectory({ ...decodedQuery, scope });
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read Schools directory snapshot", cause)),
        ),
      );
  });
