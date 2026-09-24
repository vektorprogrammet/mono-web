import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import {
  FieldOfStudyCatalogSnapshot,
  OrganizationCatalogKind,
  OrganizationCatalogRequestId,
  TeamCatalogSnapshot,
} from "./model";

export const RetriedCatalog = taggedStruct("RetriedCatalog", {});

export const SucceededTeamCatalog = taggedStruct("SucceededTeamCatalog", {
  requestId: OrganizationCatalogRequestId,
  catalogKind: S.Literal("Team"),
  snapshot: TeamCatalogSnapshot,
});

export const SucceededFieldOfStudyCatalog = taggedStruct("SucceededFieldOfStudyCatalog", {
  requestId: OrganizationCatalogRequestId,
  catalogKind: S.Literal("FieldOfStudy"),
  snapshot: FieldOfStudyCatalogSnapshot,
});

export const FailedOrganizationCatalog = taggedStruct("FailedOrganizationCatalog", {
  requestId: OrganizationCatalogRequestId,
  catalogKind: OrganizationCatalogKind,
  message: S.String,
});

export const Message = S.Union([
  RetriedCatalog,
  SucceededTeamCatalog,
  SucceededFieldOfStudyCatalog,
  FailedOrganizationCatalog,
]);

export type Message = S.Schema.Type<typeof Message>;
