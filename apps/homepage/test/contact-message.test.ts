import type { DepartmentJson } from "@vektorprogrammet/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contactDepartmentSlug, type ContactFormValues } from "../src/lib/contact-message";
import { loadContactPage, submitContactMessage } from "../src/lib/contact-message.server";

const department = {
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
} as const satisfies DepartmentJson;

const departmentsResponse = (members: readonly DepartmentJson[] = [department]) =>
  new Response(JSON.stringify(members), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const formRequest = (values: ContactFormValues): Request =>
  new Request("http://homepage.test/kontakt/aas", {
    method: "POST",
    body: new URLSearchParams(values),
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("homepage contact-message boundary", () => {
  it("maps the live department name to the stable route slug", () => {
    expect(contactDepartmentSlug(department)).toBe("aas");
  });

  it("submits the route-selected department without returning the draft", async () => {
    vi.stubEnv("API_URL", "http://api.test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(departmentsResponse())
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const values = {
      name: "Ola Nordmann",
      email: "ola@example.com",
      subject: "Et spørsmål",
      message: "Når starter neste opptak?",
    } as const;

    const result = await submitContactMessage(formRequest(values), "aas");

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(values.email);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/contact_messages");
    expect(JSON.parse(String(init.body))).toEqual({
      ...values,
      departmentId: department.departmentId,
    });
  });

  it("rejects an unknown or inactive department route", async () => {
    vi.stubEnv("API_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(departmentsResponse()));

    await expect(loadContactPage("bergen")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects ambiguous department route slugs", async () => {
    vi.stubEnv("API_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          departmentsResponse([
            department,
            {
              ...department,
              departmentId: "department-18",
              name: "Vektorprogrammet Aas",
              shortName: "Aas",
            },
          ]),
        ),
    );

    await expect(loadContactPage("aas")).rejects.toMatchObject({ status: 503 });
  });

  it("keeps invalid private input out of the action response", async () => {
    vi.stubEnv("API_URL", "http://api.test");
    const fetchMock = vi.fn().mockResolvedValue(departmentsResponse());
    vi.stubGlobal("fetch", fetchMock);
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
});
