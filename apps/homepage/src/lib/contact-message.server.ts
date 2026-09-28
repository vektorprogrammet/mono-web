import { ContactMessage, isProblem } from "@vektorprogrammet/rpc";
import { Match, Predicate, Schema } from "effect";
import type { HomepageDepartment } from "./api-types";
import { callHomepageNative } from "./api.server";
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
    const listed = await callHomepageNative(
      (client) => client["organization.listDepartments"](),
      { explicitOrigin: backendOrigin },
    );

    const departments = listed.filter((department) => department.active);
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
  ingress: ContactIngress | null = null,
): Promise<ContactActionData> {
  if (ingress === null)
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

  let message: ContactMessage;

  try {
    message = Schema.decodeSync(ContactMessage)(
      { ...values, departmentId: page.selectedDepartment.departmentId },
      { onExcessProperty: "error" },
    );
  } catch {
    return { ok: false, message: "Fyll ut alle feltene med gyldig informasjon." };
  }

  try {
    // The deployment secret and the visitor address travel with this one call only.
    await callHomepageNative((client) => client["contact.submitContactMessage"](message), {
      explicitOrigin: ingress.backendOrigin,
      headers: {
        [CONTACT_BACKEND_HEADER]: ingress.backendToken,
        [CONTACT_IP_HEADER]: ingress.visitorIp,
      },
    });

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: isProblem(error)
        ? Match.value(error.code).pipe(
            Match.when("rate-limit.exceeded", () => "Du har sendt for mange meldinger. Prøv igjen senere." as const),
            Match.when("validation.failed", () => "Fyll ut alle feltene med gyldig informasjon." as const),
            Match.orElse(() => "Meldingen kunne ikke sendes. Prøv igjen senere." as const),
          )
        : "Meldingen kunne ikke sendes. Prøv igjen senere.",
    };
  }
}
