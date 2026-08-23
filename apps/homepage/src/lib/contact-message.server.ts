import { RateLimitedError, ValidationError, type Department } from "@vektorprogrammet/sdk";
import { createHomepageApiClient } from "./api.server";
import {
  type ContactActionData,
  type ContactFormValues,
  type ContactPageData,
  contactDepartmentSlug,
} from "./contact-message";

async function activeDepartments(): Promise<readonly Department[]> {
  const departments = await createHomepageApiClient().public.departments();
  return departments.filter((department) => department.active);
}

export async function loadContactPage(departmentSlug?: string): Promise<ContactPageData> {
  const departments = await activeDepartments();
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

  try {
    await createHomepageApiClient().public.contactMessages.submit({
      ...values,
      departmentId: page.selectedDepartment.id,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return {
        ok: false,
        message: "Du har sendt for mange meldinger. Prøv igjen senere.",
      };
    }
    if (error instanceof ValidationError) {
      return {
        ok: false,
        message: "Fyll ut alle feltene med gyldig informasjon.",
      };
    }
    return {
      ok: false,
      message: "Meldingen kunne ikke sendes. Prøv igjen senere.",
    };
  }
}
