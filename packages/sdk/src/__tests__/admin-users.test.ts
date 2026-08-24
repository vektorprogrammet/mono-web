/**
 * Admin users domain tests (spec 0057).
 * Mocks globalThis.fetch to exercise strict decode, excess-field rejection,
 * and the nextCursor page walk with the unchanged list() two-array contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Schema } from "effect";
import { createTransport } from "../transport.js";
import {
  AdminUsersPageSchema,
  DirectoryEntrySchema,
  createAdminUsersDomain,
} from "../domains/admin/users.js";
import { OrganizationDecodeError } from "../errors.js";

function run<A>(effect: Effect.Effect<A, any>): Promise<A> {
  return Effect.runPromise(effect);
}

function runFail<E>(effect: Effect.Effect<any, E>): Promise<E> {
  return Effect.runPromise(effect.pipe(Effect.flip));
}

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const entry = (
  overrides: Partial<{
    personId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    studyProgramme: null;
    departments: string[];
    isActive: boolean;
  }> = {},
) => ({
  personId: "person-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.invalid",
  phone: "90000000",
  studyProgramme: null,
  departments: ["department-a"],
  isActive: true,
  ...overrides,
});

describe("AdminUsersPageSchema", () => {
  it("decodes the frozen eight-field entry", () => {
    const decoded = Schema.decodeUnknownSync(DirectoryEntrySchema)(entry(), {
      onExcessProperty: "error",
    });
    expect(decoded).toEqual(entry());
  });

  it("rejects excess entry fields under strict decoding", () => {
    expect(() =>
      Schema.decodeUnknownSync(DirectoryEntrySchema)(
        { ...entry(), role: "ROLE_ADMIN" },
        { onExcessProperty: "error" },
      ),
    ).toThrow(/role/);
  });

  it("rejects a fabricated non-null studyProgramme", () => {
    expect(() =>
      Schema.decodeUnknownSync(DirectoryEntrySchema)(entry({ studyProgramme: "MTFYMA" }), {
        onExcessProperty: "error",
      }),
    ).toThrow();
  });

  it("rejects a page with an unexpected top-level field", () => {
    expect(() =>
      Schema.decodeUnknownSync(AdminUsersPageSchema)(
        { activeUsers: [], inactiveUsers: [], total: 0 },
        { onExcessProperty: "error" },
      ),
    ).toThrow(/total/);
  });
});

describe("admin users list()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the two-array result for a single exhausted page", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(200, {
        activeUsers: [entry()],
        inactiveUsers: [entry({ personId: "person-2", isActive: false })],
        nextCursor: null,
      }),
    );
    const transport = createTransport("http://api.test");
    const domain = createAdminUsersDomain(transport);
    const result = await run(domain.list());
    expect(result.activeUsers.map((row) => row.personId)).toEqual(["person-1"]);
    expect(result.inactiveUsers.map((row) => row.personId)).toEqual(["person-2"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("walks nextCursor pages and accumulates deterministic arrays", async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeFetchResponse(200, {
          activeUsers: [entry()],
          inactiveUsers: [],
          nextCursor: "cursor-page-2",
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, {
          activeUsers: [],
          inactiveUsers: [entry({ personId: "person-ended", isActive: false })],
          nextCursor: null,
        }),
      );
    const transport = createTransport("http://api.test");
    const domain = createAdminUsersDomain(transport);
    const result = await run(domain.list());
    expect(result.activeUsers.map((row) => row.personId)).toEqual(["person-1"]);
    expect(result.inactiveUsers.map((row) => row.personId)).toEqual(["person-ended"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fails with a typed decode error when a page carries excess fields", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(200, {
        activeUsers: [{ ...entry(), legacyField: "surprise" }],
        inactiveUsers: [],
        nextCursor: null,
      }),
    );
    const transport = createTransport("http://api.test");
    const domain = createAdminUsersDomain(transport);
    const error = await runFail(domain.list());
    expect(error).toBeInstanceOf(OrganizationDecodeError);
  });
});
