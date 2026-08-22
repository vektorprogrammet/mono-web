import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionApplicationDecodeSdkError,
  AdmissionPeriodDecodeSdkError,
  NoOpenAdmissionPeriodError,
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

describe("native admission-period SDK", () => {
  it("lists strict management projections as a bounded page", async () => {
    const page = { items: [projection], totalItems: 1 };
    const fetchMock = vi.fn().mockResolvedValue(response(200, page));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "leader-token" });

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
    const client = createClient("http://api.test", { auth: "leader-token" });

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
    const client = createClient("http://api.test", { auth: "leader-token" });

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

  it("maps closed public submission to NoOpenAdmissionPeriod", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(409, { error: { tag: "NoOpenAdmissionPeriod" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(
      client.applications.submit({
        commandId: "application-command",
        departmentId: "department-1",
        applicantId: "applicant-1",
      }),
    ).rejects.toBeInstanceOf(NoOpenAdmissionPeriodError);
  });

  it("rejects excess public application fields before transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(
      client.applications.submit({
        commandId: "application-command",
        departmentId: "department-1",
        applicantId: "applicant-1",
        admissionPeriodId: "browser-selected",
      } as never),
    ).rejects.toBeInstanceOf(AdmissionApplicationDecodeSdkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
