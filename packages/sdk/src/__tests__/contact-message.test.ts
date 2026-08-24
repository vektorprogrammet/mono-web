import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError, ValidationError, createClient } from "../promise.js";

const validInput = {
  name: "Ola Nordmann",
  email: "ola@example.com",
  departmentId: "department-7",
  subject: "Spørsmål om Vektorprogrammet",
  message: "Når starter neste opptak?",
} as const;

const response = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("public contact-message SDK", () => {
  it("sends one decoded JSON command and accepts an empty 201 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(client.public.contactMessages.submit(validInput)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/contact_messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(validInput),
      }),
    );
  });

  it("rejects invalid and excess input before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(
      client.public.contactMessages.submit({
        ...validInput,
        email: "not-an-email",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.public.contactMessages.submit({
        ...validInput,
        departmentId: 7,
      } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.public.contactMessages.submit({
        ...validInput,
        browserDepartment: "wrong-authority",
      } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps API validation and rate-limit failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(422, {
          violations: [{ propertyPath: "message", message: "This value is too long." }],
        }),
      )
      .mockResolvedValueOnce(response(429, { detail: "Too many requests" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await expect(client.public.contactMessages.submit(validInput)).rejects.toMatchObject({
      name: "ValidationError",
      fields: { message: "This value is too long." },
    });
    await expect(client.public.contactMessages.submit(validInput)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
