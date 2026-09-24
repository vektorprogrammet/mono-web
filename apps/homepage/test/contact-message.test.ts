import { DepartmentJsonSchema, type DepartmentJson } from "@vektorprogrammet/http-api"
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const contactApi = { departments: Array<DepartmentJson>() };

const withDepartmentResponse = (deliver: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  if (url.pathname === "/api/departments") return Response.json(contactApi.departments, { headers: {
    "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
    vary: "Origin",
    etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
  } });

  return deliver(input, init);
};

beforeEach(() => {
  vi.stubEnv("API_URL", "http://api.test");
  vi.stubGlobal("fetch", withDepartmentResponse(async () => { throw new Error("Unexpected contact request"); }));
});

import { contactDepartmentSlug, type ContactFormValues } from "../src/lib/contact-message";
import {
  loadContactPage,
  submitContactMessage as submitWithIngress,
} from "../src/lib/contact-message.server";

const submitContactMessage = (request: Request, slug?: string) =>
  submitWithIngress(request, slug, {
    backendOrigin: "http://api.test",
    backendToken: "backend-test-00000000000000000000000",
    visitorIp: ContactVisitorIp.make("127.0.0.1"),
  });

import { ContactVisitorIp } from "@vektorprogrammet/http-api"
import { makeNativeProblem } from "@vektorprogrammet/http-api";

const makeDepartment = (overrides: Partial<typeof DepartmentJsonSchema.Encoded> = {}): DepartmentJson =>
  Schema.decodeUnknownSync(DepartmentJsonSchema)({
    departmentId: "department-17",
    name: "Vektorprogrammet Ås",
    shortName: "Ås",
    email: "aas@example.com",
    address: "Universitetsveien 1",
    city: "Ås",
    latitude: "59.66",
    longitude: "10.77",
    slackChannel: null,
    logoPath: null,
    active: true,
    revision: 0,
    ...overrides,
  });

const department = makeDepartment();

contactApi.departments = [department];

const formRequest = (values: ContactFormValues): Request =>
  new Request("http://homepage.test/kontakt/aas", {
    method: "POST",
    body: new URLSearchParams(values),
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  contactApi.departments = [department];
});

describe("homepage contact-message boundary", () => {
  it("maps the live department name to the stable route slug", () => {
    expect(contactDepartmentSlug(department)).toBe("aas");
  });

  it("submits the route-selected department without returning the draft", async () => {
    vi.stubEnv("API_URL", "http://api.test");

    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: { "cache-control": "no-store", vary: "Origin" },
        }),
      );

    vi.stubGlobal("fetch", withDepartmentResponse(fetchMock));

    const values = {
      name: "Ola Nordmann",
      email: "ola@example.com",
      subject: "Et spørsmål",
      message: "Når starter neste opptak?",
    } as const;

    const result = await submitContactMessage(formRequest(values), "aas");

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(values.email);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://api.test/api/contact-messages");
    expect(await new Response(init?.body).json()).toEqual({
      ...values,
      departmentId: department.departmentId,
    });
  });

  it("rejects an unknown or inactive department route", async () => {
    contactApi.departments = [department];

    await expect(loadContactPage("bergen")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects ambiguous department route slugs", async () => {
    contactApi.departments = [
      department,
      makeDepartment({
        departmentId: "department-18",
        name: "Vektorprogrammet Aas",
        shortName: "Aas",
      }),
    ];

    await expect(loadContactPage("aas")).rejects.toMatchObject({ status: 503 });
  });

  it("returns 503 (not 404) when the organization projection is empty", async () => {
    contactApi.departments = [];

    await expect(loadContactPage()).rejects.toMatchObject({ status: 503 });
    await expect(loadContactPage("aas")).rejects.toMatchObject({ status: 503 });
  });

  it("keeps 404 for a genuinely unknown department when others exist", async () => {
    contactApi.departments = [department];

    await expect(loadContactPage("nonexistent")).rejects.toMatchObject({ status: 404 });
  });

  it("keeps invalid private input out of the action response", async () => {
    vi.stubEnv("API_URL", "http://api.test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withDepartmentResponse(fetchMock));
    const privateCanary = "private-contact-canary";

    const result = await submitContactMessage(
      formRequest({
        name: "Ola Nordmann",
        email: "ola@example.com",
        subject: privateCanary,
        message: "",
      }),
      "aas",
    );

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(privateCanary);
  });

  it("classifies the typed native validation and rate-limit responses", async () => {
    vi.stubEnv("API_URL", "http://api.test");

    const values = {
      name: "Ola Nordmann",
      email: "ola@example.com",
      subject: "Et spørsmål",
      message: "Når starter neste opptak?",
    } as const;

    const validationFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ...makeNativeProblem("validation.failed", 422),
            validation: { errors: [], truncated: false },
          }),
          {
            status: 422,
            headers: {
              "content-type": "application/problem+json",
              "cache-control": "no-store",
              vary: "Origin",
            },
          },
        ),
      );

    vi.stubGlobal("fetch", withDepartmentResponse(validationFetch));

    await expect(submitContactMessage(formRequest(values), "aas")).resolves.toEqual({
      ok: false,
      message: "Fyll ut alle feltene med gyldig informasjon.",
    });

    vi.stubGlobal(
      "fetch",
      withDepartmentResponse(vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(makeNativeProblem("rate-limit.exceeded", 429)), {
            status: 429,
            headers: {
              "content-type": "application/problem+json",
              "cache-control": "no-store",
              vary: "Origin",
              "retry-after": "3600",
            },
          }),
        )),
    );
    await expect(submitContactMessage(formRequest(values), "aas")).resolves.toEqual({
      ok: false,
      message: "Du har sendt for mange meldinger. Prøv igjen senere.",
    });
  });
});
