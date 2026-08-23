import type { Department } from "@vektorprogrammet/sdk";

export type ContactPageData = {
  readonly departments: readonly Department[];
  readonly selectedDepartment: Department;
};

export type ContactFormValues = {
  readonly name: string;
  readonly email: string;
  readonly subject: string;
  readonly message: string;
};

export type ContactActionData =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
    };

export function contactDepartmentSlug(department: { readonly shortName: string }): string {
  return department.shortName
    .trim()
    .toLowerCase()
    .replaceAll("å", "aa")
    .replaceAll("æ", "ae")
    .replaceAll("ø", "o")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
