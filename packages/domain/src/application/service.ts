import { Context, Effect } from "effect";
import type {
  PublicApplicationCatalog,
  PublicApplicationCatalogContext,
  PublicApplicationConfirmation,
  PublicApplicationSubmitContext,
  PublicApplicationSubmitResult,
} from "./schema.js";
import type { PublicApplicationError } from "./errors.js";

export interface PublicApplicationAuthorityShape {
  readonly execute: (
    input: unknown,
    context: PublicApplicationSubmitContext,
  ) => Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError>;
  readonly catalog: (
    context: PublicApplicationCatalogContext,
  ) => Effect.Effect<PublicApplicationCatalog, PublicApplicationError>;
  readonly confirmation: (
    applicationId: string,
  ) => Effect.Effect<PublicApplicationConfirmation, PublicApplicationError>;
}

export class PublicApplicationAuthority extends Context.Service<
  PublicApplicationAuthority,
  PublicApplicationAuthorityShape
>()("@vektorprogrammet/domain/PublicApplicationAuthority") {}

export const executePublicApplicationWithAuthority = (
  input: unknown,
  context: PublicApplicationSubmitContext,
) => PublicApplicationAuthority.use(({ execute }) => execute(input, context));

export const listPublicApplicationCatalogWithAuthority = (
  context: PublicApplicationCatalogContext,
) => PublicApplicationAuthority.use(({ catalog }) => catalog(context));

export const findPublicApplicationConfirmationWithAuthority = (applicationId: string) =>
  PublicApplicationAuthority.use(({ confirmation }) => confirmation(applicationId));
