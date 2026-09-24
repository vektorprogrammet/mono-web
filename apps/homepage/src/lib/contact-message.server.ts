import { ContactMessage } from "@vektorprogrammet/http-api";
import { createEffectClient } from "@vektorprogrammet/sdk/effect";
import { Match, Predicate, Effect, Schema } from "effect";
import type { ContactMessagePayload, HomepageDepartment } from "./api-types";
import { createHomepageApiClient } from "./api.server";
import {
  CONTACT_BACKEND_HEADER,
  CONTACT_IP_HEADER,
  type ContactIngress,
} from "./contact-context.server";
import {
  type ContactActionData,
  type ContactFormValues,
  type ContactPageData,
  contactDepartmentSlug,
} from "./contact-message";


async function activeDepartments(backendOrigin?: string): Promise<readonly HomepageDepartment[]> {
  try {
    const result = await createHomepageApiClient(backendOrigin).organization.listDepartments({
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

export async function loadContactPage(
  departmentSlug?: string,
  backendOrigin?: string,
): Promise<ContactPageData> {
  const departments = await activeDepartments(backendOrigin);

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

  return Predicate.isString(value) ? value.trim() : "";
};

export async function submitContactMessage(
  request: Request,
  departmentSlug?: string,
  ingress?: ContactIngress,
): Promise<ContactActionData> {
  if (ingress === undefined)
    return { ok: false, message: "Meldingen kunne ikke sendes. Prøv igjen senere." };
  const page = await loadContactPage(departmentSlug, ingress.backendOrigin);
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

  let payload: ContactMessagePayload;

  try {
    payload = Schema.decodeUnknownSync(ContactMessage)(
      { ...values, departmentId: page.selectedDepartment.departmentId },
      { onExcessProperty: "error" },
    );
  } catch {
    return { ok: false, message: "Fyll ut alle feltene med gyldig informasjon." };
  }

  const client = createEffectClient(ingress.backendOrigin, {
    headers: { [CONTACT_BACKEND_HEADER]: ingress.backendToken },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.origin !== ingress.backendOrigin)
        throw new Error("Unsupported contact backend origin");
      // Workers supports manual redirects; never forward the scoped credential to a redirect target.
      const response = await fetch(input, { ...init, redirect: "manual" });

      if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
        await response.body?.cancel();
        throw new Error("Contact backend redirect rejected");
      }

      return response;
    },
  });

  return Effect.runPromise(
    client.contact
      .submitContactMessage({ payload, headers: { [CONTACT_IP_HEADER]: ingress.visitorIp } })
      .pipe(
        Effect.match({
          onSuccess: (): ContactActionData => ({ ok: true }),
          onFailure: (error): ContactActionData => ({
            ok: false,
            message:
              (error === null || Predicate.isObjectOrArray(error)) &&
              error !== null &&
              "body" in error &&
              (error.body === null || Predicate.isObjectOrArray(error.body)) &&
              error.body !== null &&
              "code" in error.body
                ? Match.value(error.body.code).pipe(Match.when("rate-limit.exceeded", () => "Du har sendt for mange meldinger. Prøv igjen senere." as const), Match.when("validation.failed", () => "Fyll ut alle feltene med gyldig informasjon." as const), Match.orElse(() => "Meldingen kunne ikke sendes. Prøv igjen senere." as const))
                : "Meldingen kunne ikke sendes. Prøv igjen senere.",
          }),
        }),
      ),
  );
}
