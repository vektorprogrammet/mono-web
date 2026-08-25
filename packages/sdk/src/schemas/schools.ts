import { Schema } from "effect";

const text = (maxLength: number) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.trim().length > 0, {
        message: "a non-empty string",
      }),
      Schema.isMaxLength(maxLength),
    ),
  );

export const SchoolId = Schema.Int.pipe(
  Schema.check(
    Schema.makeFilter(Number.isSafeInteger, { message: "a safe integer" }),
    Schema.isGreaterThan(0),
  ),
  Schema.brand("SchoolId"),
);
export type SchoolId = typeof SchoolId.Type;

export const SchoolDepartmentId = text(255).pipe(Schema.brand("SchoolDepartmentId"));
export type SchoolDepartmentId = typeof SchoolDepartmentId.Type;

export const SchoolLanguageSchema = Schema.Literals(["Norwegian", "International"]);
export type SchoolLanguage = typeof SchoolLanguageSchema.Type;

export const SchoolDirectoryDepartmentSchema = Schema.Struct({
  departmentId: SchoolDepartmentId,
  name: Schema.String,
});
export type SchoolDirectoryDepartment = typeof SchoolDirectoryDepartmentSchema.Type;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const SchoolDirectoryDepartmentsSchema = Schema.Array(SchoolDirectoryDepartmentSchema).pipe(
  Schema.check(
    Schema.makeFilter(
      (departments) =>
        departments.every(
          (department, index) =>
            index === 0 ||
            compareText(departments[index - 1]!.departmentId, department.departmentId) < 0,
        ),
      { message: "departments sorted by unique departmentId" },
    ),
  ),
);

export const SchoolDirectoryEntrySchema = Schema.Struct({
  schoolId: SchoolId,
  name: text(255),
  contactPerson: text(255),
  email: text(255).pipe(
    Schema.check(
      Schema.makeFilter((value) => /^[^@\s]+@[^@\s]+$/u.test(value), {
        message: "an email address",
      }),
    ),
  ),
  phone: text(255),
  language: SchoolLanguageSchema,
  departments: SchoolDirectoryDepartmentsSchema,
  isActive: Schema.Boolean,
});
export type SchoolDirectoryEntry = typeof SchoolDirectoryEntrySchema.Type;

export const SchoolDirectorySchema = Schema.Struct({
  activeSchools: Schema.Array(SchoolDirectoryEntrySchema),
  inactiveSchools: Schema.Array(SchoolDirectoryEntrySchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (directory) => {
        if (directory.activeSchools.some((school) => !school.isActive)) return false;
        if (directory.inactiveSchools.some((school) => school.isActive)) return false;
        const schoolIds = [
          ...directory.activeSchools.map((school) => school.schoolId),
          ...directory.inactiveSchools.map((school) => school.schoolId),
        ];
        return new Set(schoolIds).size === schoolIds.length;
      },
      { message: "one correctly partitioned directory entry per school" },
    ),
  ),
);
export type SchoolDirectory = typeof SchoolDirectorySchema.Type;

export interface AdminSchoolsListInput {
  readonly department?: SchoolDepartmentId;
}
