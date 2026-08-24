import {
  DepartmentListSchema,
  FieldOfStudyListSchema,
  TeamListSchema,
} from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";

export const OrganizationCatalogKind = S.Union([
  S.Literal("Team"),
  S.Literal("FieldOfStudy"),
]);
export type OrganizationCatalogKind = S.Schema.Type<typeof OrganizationCatalogKind>;

export const OrganizationCatalogRequestId = S.Int.check(S.isGreaterThanOrEqualTo(1));

export const TeamCatalogSnapshot = S.Struct({
  _tag: S.Literal("Team"),
  departments: DepartmentListSchema,
  records: TeamListSchema,
});
export type TeamCatalogSnapshot = S.Schema.Type<typeof TeamCatalogSnapshot>;

export const FieldOfStudyCatalogSnapshot = S.Struct({
  _tag: S.Literal("FieldOfStudy"),
  departments: DepartmentListSchema,
  records: FieldOfStudyListSchema,
});
export type FieldOfStudyCatalogSnapshot = S.Schema.Type<typeof FieldOfStudyCatalogSnapshot>;

export const OrganizationCatalogSnapshot = S.Union([
  TeamCatalogSnapshot,
  FieldOfStudyCatalogSnapshot,
]);
export type OrganizationCatalogSnapshot = S.Schema.Type<typeof OrganizationCatalogSnapshot>;

export const OrganizationCatalogData = AsyncData.Schema(OrganizationCatalogSnapshot, S.String);

export const Model = S.Struct({
  catalogKind: OrganizationCatalogKind,
  catalog: OrganizationCatalogData.schema,
  requestId: OrganizationCatalogRequestId,
  retryCount: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});
export type Model = S.Schema.Type<typeof Model>;

export const makeInitialModel = (catalogKind: OrganizationCatalogKind): Model => ({
  catalogKind,
  catalog: OrganizationCatalogData.Loading(),
  requestId: 1,
  retryCount: 0,
});
