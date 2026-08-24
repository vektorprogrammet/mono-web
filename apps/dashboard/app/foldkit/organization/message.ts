import { Schema as S } from "effect";
import { m } from "foldkit/message";
import {
  FieldOfStudyCatalogSnapshot,
  OrganizationCatalogKind,
  OrganizationCatalogRequestId,
  TeamCatalogSnapshot,
} from "./model";

export const RetriedCatalog = m("RetriedCatalog");
export const SucceededTeamCatalog = m("SucceededTeamCatalog", {
  requestId: OrganizationCatalogRequestId,
  catalogKind: S.Literal("Team"),
  snapshot: TeamCatalogSnapshot,
});
export const SucceededFieldOfStudyCatalog = m("SucceededFieldOfStudyCatalog", {
  requestId: OrganizationCatalogRequestId,
  catalogKind: S.Literal("FieldOfStudy"),
  snapshot: FieldOfStudyCatalogSnapshot,
});
export const FailedOrganizationCatalog = m("FailedOrganizationCatalog", {
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
