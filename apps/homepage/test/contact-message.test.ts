import { RouterContextProvider } from "react-router";
import { contactIngressContext } from "../src/lib/contact-context.server";
import { ContactVisitorIp } from "@vektorprogrammet/rpc";
import type { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NativeBackend,
  nativeRpcProblem,
  nativeRpcSuccess,
  stubNativeBackend,
} from "./native-rpc";

vi.stubEnv("API_URL", "http://api.test");

const backend = stubNativeBackend();

/** A department as `organization.listDepartments` encodes it. */
const makeDepartment = (overrides: { readonly [field: string]: Schema.Json } = {}) => ({
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

const contactApi = { departments: Array<ReturnType<typeof makeDepartment>>() };

/** Answers the department list, and passes every other call to `contact`. */
const withDepartments =
  (contact: NativeBackend): NativeBackend =>
  (call) =>
    call.tag === "organization.listDepartments"
      ? nativeRpcSuccess(call, contactApi.departments)
      : contact(call);

const unexpectedContact: NativeBackend = (call) => {
  throw new Error(`Unexpected contact request ${call.tag}`);
};

beforeEach(() => {
  vi.stubEnv("API_URL", "http://api.test");
  backend.calls.length = 0;
  backend.answer(withDepartments(unexpectedContact));
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

const department = makeDepartment();

contactApi.departments = [department];

const formRequest = (values: ContactFormValues): Request =>
  new Request("http://homepage.test/kontakt/aas", {
    method: "POST",
    body: new URLSearchParams(values),
  });

afterEach(() => {
  contactApi.departments = [department];
});

describe("homepage contact-message boundary", () => {
  it("denies contact writes without a bound ingress context before fetching", async () => {
    const context = new RouterContextProvider();
    const request = new Request("http://127.0.0.1:8787/kontakt", { method: "POST" });

    const result = await submitWithIngress(request, undefined, context.get(contactIngressContext));

    expect(result.ok).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it("maps the live department name to the stable route slug", () => {
    expect(contactDepartmentSlug(department)).toBe("aas");
  });

  it("submits the route-selected department without returning the draft", async () => {
    backend.answer(withDepartments((call) => nativeRpcSuccess(call, null)));

    const values = {
      name: "Ola Nordmann",
      email: "ola@example.com",
      subject: "Et spørsmål",
      message: "Når starter neste opptak?",
    } as const;

    const result = await submitContactMessage(formRequest(values), "aas");

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(values.email);

    const contact = backend.calls.filter(({ tag }) => tag === "contact.submitContactMessage");

    expect(contact).toHaveLength(1);
    expect(contact[0]?.url).toBe("http://api.test/api/rpc/");
    expect(contact[0]?.payload).toEqual({ ...values, departmentId: department.departmentId });
    expect(contact[0]?.headers.get("x-vektor-contact-backend")).toBe(
      "backend-test-00000000000000000000000",
    );
    expect(contact[0]?.headers.get("x-vektor-contact-ip")).toBe("127.0.0.1");
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
    expect(backend.calls.map(({ tag }) => tag)).not.toContain("contact.submitContactMessage");
  });

  it("classifies the typed native validation and rate-limit problems", async () => {
    const values = {
      name: "Ola Nordmann",
      email: "ola@example.com",
      subject: "Et spørsmål",
      message: "Når starter neste opptak?",
    } as const;

    backend.answer(withDepartments((call) => nativeRpcProblem(call, "validation.failed")));

    await expect(submitContactMessage(formRequest(values), "aas")).resolves.toEqual({
      ok: false,
      message: "Fyll ut alle feltene med gyldig informasjon.",
    });

    backend.answer(withDepartments((call) => nativeRpcProblem(call, "rate-limit.exceeded")));

    await expect(submitContactMessage(formRequest(values), "aas")).resolves.toEqual({
      ok: false,
      message: "Du har sendt for mange meldinger. Prøv igjen senere.",
    });

    backend.answer(withDepartments((call) => nativeRpcProblem(call, "contact.unavailable")));

    await expect(submitContactMessage(formRequest(values), "aas")).resolves.toEqual({
      ok: false,
      message: "Meldingen kunne ikke sendes. Prøv igjen senere.",
    });
  });
});
