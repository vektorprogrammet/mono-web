import { DepartmentId, type DepartmentJson } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { createHomepageApiClient } from "./api.server";
import {
  type ContactActionData,
  type ContactFormValues,
  type ContactPageData,
  contactDepartmentSlug,
} from "./contact-message";

const contactText = (maximumLength: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength)));

const ContactMessageRequest = Schema.Struct({
  name: contactText(100),
  email: contactText(254),
  subject: contactText(200),
  message: contactText(10_000),
  departmentId: DepartmentId,
});

const LegacyValidationResponse = Schema.Struct({
  violations: Schema.Array(
    Schema.Struct({
      propertyPath: Schema.String,
      message: Schema.String,
    }),
  ),
});

type ContactSubmission =
  | { readonly _tag: "Submitted" }
  | { readonly _tag: "Validation" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "Failure" };

async function submitLegacyContactMessage(input: unknown): Promise<ContactSubmission> {
  let payload: typeof ContactMessageRequest.Type;
  try {
    payload = Schema.decodeUnknownSync(ContactMessageRequest)(input, {
      onExcessProperty: "error",
    });
  } catch {
    return { _tag: "Validation" };
  }

  const apiUrl = process.env.API_URL;
  if (apiUrl === undefined) return { _tag: "Failure" };

  let response: Response;
  try {
    response = await fetch(new URL("/api/contact_messages", apiUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { _tag: "Failure" };
  }

  if (response.status === 201) return { _tag: "Submitted" };
  if (response.status === 429) return { _tag: "RateLimited" };
  if (response.status !== 422) return { _tag: "Failure" };

  try {
    Schema.decodeUnknownSync(LegacyValidationResponse)(await response.json(), {
      onExcessProperty: "error",
    });
    return { _tag: "Validation" };
  } catch {
    return { _tag: "Failure" };
  }
}

async function activeDepartments(): Promise<readonly DepartmentJson[]> {
  try {
    const result = await createHomepageApiClient().organization.listDepartments({
      headers: {},
    });
    if (result.body === undefined) {
      throw new Error("The conditional department response has no body.");
    }
    const departments = result.body.filter((department) => department.active);
    const slugs = new Set<string>();
    for (const department of departments) {
      const slug = contactDepartmentSlug(department);
      if (slug.length === 0 || slugs.has(slug)) {
        throw new Response("Kontaktdata er midlertidig utilgjengelig.", {
          status: 503,
        });
      }
      slugs.add(slug);
    }
    return departments;
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Kontaktavdelingene er midlertidig utilgjengelige.", {
      status: 503,
    });
  }
}

export async function loadContactPage(departmentSlug?: string): Promise<ContactPageData> {
  const departments = await activeDepartments();
  if (departments.length === 0) {
    throw new Response("Kontaktavdelingene er midlertidig utilgjengelige.", {
      status: 503,
    });
  }
  const selectedDepartment = departmentSlug
    ? departments.find((department) => contactDepartmentSlug(department) === departmentSlug)
    : departments[0];

  if (selectedDepartment === undefined) {
    throw new Response("Kontaktavdelingen finnes ikke.", { status: 404 });
  }

  return { departments, selectedDepartment };
}

const formValue = (formData: FormData, field: keyof ContactFormValues): string => {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
};

export async function submitContactMessage(
  request: Request,
  departmentSlug?: string,
): Promise<ContactActionData> {
  const page = await loadContactPage(departmentSlug);
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    formData = new FormData();
  }

  const values: ContactFormValues = {
    name: formValue(formData, "name"),
    email: formValue(formData, "email"),
    subject: formValue(formData, "subject"),
    message: formValue(formData, "message"),
  };
  const result = await submitLegacyContactMessage({
    ...values,
    departmentId: page.selectedDepartment.departmentId,
  });

  switch (result._tag) {
    case "Submitted":
      return { ok: true };
    case "RateLimited":
      return {
        ok: false,
        message: "Du har sendt for mange meldinger. Prøv igjen senere.",
      };
    case "Validation":
      return {
        ok: false,
        message: "Fyll ut alle feltene med gyldig informasjon.",
      };
    case "Failure":
      return {
        ok: false,
        message: "Meldingen kunne ikke sendes. Prøv igjen senere.",
      };
  }
}
