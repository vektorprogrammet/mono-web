import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { listSchoolDirectoryPostgres } from "./postgres.js";

it.effect("rejects an excess field from the persisted directory row", () =>
  Effect.gen(function* () {
    const row = {
      schoolId: "1",
      name: "Strict School",
      contactPerson: "Strict Contact",
      email: "strict@example.invalid",
      phone: "+47 900 00 020",
      language: "Norwegian",
      departments: [{ departmentId: "bergen", name: "Bergen" }],
      isActive: true,
      capacity: { monday: 2 },
    };
    const statement = ((_strings: TemplateStringsArray) => Effect.succeed([row])) as unknown as {
      (
        _strings: TemplateStringsArray,
        ..._values: ReadonlyArray<unknown>
      ): Effect.Effect<ReadonlyArray<typeof row>>;
      in: (_column: string, _values: ReadonlyArray<unknown>) => unknown;
    };
    statement.in = () => ({ _tag: "ScopeFragment" });
    const failure = yield* Effect.flip(
      listSchoolDirectoryPostgres({ scope: { _tag: "All" } }).pipe(
        Effect.provideService(Database, statement as unknown as DatabaseShape),
      ),
    );
    expect(failure._tag).toBe("SchoolsDecodeError");
    if (failure._tag !== "SchoolsDecodeError") return;
    expect(failure.operation).toBe("decode Schools directory rows");
    expect(failure.message).toContain("capacity");
  }),
);
