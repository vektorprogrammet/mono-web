import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer } from "effect";
import { executeReceiptCommand } from "./postgres.js";
import { ReceiptAuthority } from "./service.js";

export const ReceiptAuthorityPostgres = Layer.effect(
  ReceiptAuthority,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return ReceiptAuthority.of({
      execute: (input, context) =>
        executeReceiptCommand(input, context).pipe(Effect.provideService(PgClient.PgClient, sql)),
    });
  }),
);

export const makeReceiptPostgresLayer = PgClient.layer;
