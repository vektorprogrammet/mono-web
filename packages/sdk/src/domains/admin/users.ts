/**
 * Admin users domain — the native user directory (spec 0057).
 *
 * Endpoints:
 *   GET /api/admin/users
 *
 * The endpoint returns { activeUsers, inactiveUsers, nextCursor } — a plain
 * object, NOT a Hydra collection. list() walks nextCursor pages until
 * exhaustion; the stable (lastName, firstName, personId) ordering law makes
 * the accumulated arrays deterministic.
 */

import { Effect, Schema } from "effect";
import type { Transport } from "../../transport.js";
import { OrganizationDecodeError, type InternalSdkError } from "../../errors.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
);

export const DirectoryEntrySchema = Schema.Struct({
  personId: NonEmpty,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  /** Null until spec 0058 adds the Organization-owned association. */
  studyProgramme: Schema.Null,
  departments: Schema.Array(Schema.String),
  isActive: Schema.Boolean,
});

export type DirectoryEntry = typeof DirectoryEntrySchema.Type;

export const AdminUsersPageSchema = Schema.Struct({
  activeUsers: Schema.Array(DirectoryEntrySchema),
  inactiveUsers: Schema.Array(DirectoryEntrySchema),
  nextCursor: Schema.NullOr(Schema.String),
});

export type AdminUsersPage = typeof AdminUsersPageSchema.Type;

const DIRECTORY_PAGE_LIMIT = 200;
export interface AdminUsersResult {
  readonly activeUsers: readonly DirectoryEntry[];
  readonly inactiveUsers: readonly DirectoryEntry[];
}

const strictAdminUsers = {
  strict: true,
  decodeError: () => new OrganizationDecodeError(),
} as const;

const accumulate = (
  transport: Transport,
  activeUsers: DirectoryEntry[],
  inactiveUsers: DirectoryEntry[],
  cursor?: string,
): Effect.Effect<AdminUsersResult, InternalSdkError | OrganizationDecodeError> =>
  Effect.flatMap(
    transport.get(
      "/api/admin/users",
      AdminUsersPageSchema,
      cursor === undefined ? undefined : { cursor },
      strictAdminUsers,
    ),
    (page) => {
      const nextActive = [...activeUsers, ...page.activeUsers];
      const nextInactive = [...inactiveUsers, ...page.inactiveUsers];
      if (page.nextCursor === null) {
        return Effect.succeed({ activeUsers: nextActive, inactiveUsers: nextInactive });
      }
      return accumulate(transport, nextActive, nextInactive, page.nextCursor);
    },
  );

export interface AdminUsersDomain {
  /**
   * Walks every directory page and accumulates the two deterministic arrays.
   * Every person lands in exactly one array by its derived isActive fact.
   */
  list(): Effect.Effect<AdminUsersResult, InternalSdkError | OrganizationDecodeError>;
}

export function createAdminUsersDomain(transport: Transport): AdminUsersDomain {
  return {
    list() {
      return accumulate(transport, [], [], undefined);
    },
  };
}

export const DIRECTORY_PAGE_SIZE = DIRECTORY_PAGE_LIMIT;
