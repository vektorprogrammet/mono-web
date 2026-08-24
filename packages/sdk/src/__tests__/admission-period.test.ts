import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionPeriodDecodeSdkError,
  NoEligibleAdmissionPeriodError,
  PublicApplicationRateLimitExceededError,
  PublicApplicationDecodeSdkError,
  createClient,
} from "../promise.js";

const period = {
  id: "period-1",
  departmentId: "department-1",
  semesterId: "semester-1",
  startAt: "2026-08-01T00:00:00.000Z",
  endAt: "2026-09-01T00:00:00.000Z",
  revision: 0,
  lastCommandId: "command-create",
};
const projection = { ...period, eligible: true };
const response = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe("native admission and public application SDK", () => {
  it("lists strict management projections as a bounded page", async () => {
    const page = { items: [projection], totalItems: 1 };
    const fetchMock = vi.fn().mockResolvedValue(response(200, page));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { cookie: "better-auth.session_token=leader-session" });

    await expect(client.admissionPeriods.listForManagement()).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/admin/admission-periods",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates and revises through semantic strict JSON routes", async () => {
    const created = { _tag: "Created", commandId: "command-create", period };
    const revised = {
      _tag: "Revised",
      commandId: "command-revise",
      period: { ...period, endAt: "2026-08-20T00:00:00.000Z", revision: 1, lastCommandId: "command-revise" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(201, created))
      .mockResolvedValueOnce(response(200, revised));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { cookie: "better-auth.session_token=leader-session" });

    await expect(
      client.admissionPeriods.create({
        commandId: "command-create",
        semesterId: "semester-1",
        startAt: period.startAt,
        endAt: period.endAt,
      }),
    ).resolves.toEqual(created);
    await expect(
      client.admissionPeriods.revise("period-1", {
        commandId: "command-revise",
        expectedRevision: 0,
        startAt: period.startAt,
        endAt: revised.period.endAt,
      }),
    ).resolves.toEqual(revised);

    const [, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(createInit.body))).toEqual({
      commandId: "command-create",
      semesterId: "semester-1",
      startAt: period.startAt,
      endAt: period.endAt,
    });
    const [reviseUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(reviseUrl).toBe("http://api.test/api/admin/admission-periods/period-1/revise");
  });

  it("rejects excess authority fields before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { cookie: "better-auth.session_token=leader-session" });

    await expect(
      client.admissionPeriods.create({
        commandId: "command-create",
        semesterId: "semester-1",
        startAt: period.startAt,
        endAt: period.endAt,
        actor: "browser-authority",
      } as never),
    ).rejects.toBeInstanceOf(AdmissionPeriodDecodeSdkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the public catalog through the canonical route", async () => {
    const catalog = {
      departments: [
        {
          departmentId: "department-1",
          name: "Oslo",
          closesAt: "2026-09-01T00:00:00.000Z",
          fieldsOfStudy: [{ fieldOfStudyId: "field-1", name: "Computer Science" }],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(response(200, catalog));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(client.applications.catalog()).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/applications/catalog",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("submits the complete public command and returns only the opaque response", async () => {
    const submitted = {
      _tag: "Submitted",
      commandId: "application-command",
      applicationId: "application-1",
    };
    const fetchMock = vi.fn().mockResolvedValue(response(201, submitted));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");
    const input = {
      commandId: "application-command",
      departmentId: "department-1",
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "90000000",
      email: "ada@example.com",
      gender: 1,
      fieldOfStudyId: "field-1",
      yearOfStudy: 1,
    } as const;

    await expect(client.applications.submit(input)).resolves.toEqual(submitted);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("loads an opaque confirmation without exposing applicant data", async () => {
    const confirmation = { _tag: "ApplicationConfirmed", applicationId: "application-1" };
    const fetchMock = vi.fn().mockResolvedValue(response(200, confirmation));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(client.applications.confirmation("application-1")).resolves.toEqual(confirmation);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/applications/application-1/confirmation",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps typed public rejection tags and rejects excess fields before transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(409, { error: { tag: "NoEligibleAdmissionPeriod" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(
      client.applications.submit({
        commandId: "application-command",
        departmentId: "department-1",
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "90000000",
        email: "ada@example.com",
        gender: 1,
        fieldOfStudyId: "field-1",
        yearOfStudy: 1,
        applicantId: "browser-authority",
      } as never),
    ).rejects.toBeInstanceOf(PublicApplicationDecodeSdkError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      client.applications.submit({
        commandId: "application-command",
        departmentId: "department-1",
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "90000000",
        email: "ada@example.com",
        gender: 1,
        fieldOfStudyId: "field-1",
        yearOfStudy: 1,
      }),
    ).rejects.toBeInstanceOf(NoEligibleAdmissionPeriodError);

    const rateLimitedFetch = vi.fn().mockResolvedValue(
      response(429, { error: { tag: "PublicApplicationRateLimitExceeded" } }),
    );
    vi.stubGlobal("fetch", rateLimitedFetch);
    await expect(
      client.applications.confirmation("application-1"),
    ).rejects.toBeInstanceOf(PublicApplicationRateLimitExceededError);
  });
});
