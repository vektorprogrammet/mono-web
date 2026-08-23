import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer } from "effect";
import {
  executePublicApplicationCommand,
  findPublicApplicationConfirmation,
  listPublicApplicationCatalog,
} from "./postgres.js";
import { PublicApplicationAuthority } from "./service.js";

export const PublicApplicationAuthorityPostgres = Layer.effect(
  PublicApplicationAuthority,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return PublicApplicationAuthority.of({
      execute: (input, context) =>
        executePublicApplicationCommand(input, context).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
      catalog: (context) =>
        listPublicApplicationCatalog(context).pipe(Effect.provideService(PgClient.PgClient, sql)),
      confirmation: (applicationId) =>
        findPublicApplicationConfirmation(applicationId).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
    });
  }),
);

export const makePublicApplicationPostgresLayer = PgClient.layer;
