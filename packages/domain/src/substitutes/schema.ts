import { Schema } from "effect";
import {
  PublicApplicationIdSchema,
  PublicApplicationYearOfStudySchema,
  PublicApplicationNameSchema,
  PublicApplicationEmailSchema,
  PublicApplicationPhoneSchema,
} from "../application/schema.js";
import { AdmissionPeriodId } from "../admission-period/schema.js";
import { DepartmentId, SemesterId } from "../organization/schema.js";

export const SubstitutePreferences = Schema.Struct({
  monday: Schema.Boolean,
  tuesday: Schema.Boolean,
  wednesday: Schema.Boolean,
  thursday: Schema.Boolean,
  friday: Schema.Boolean,
  language: Schema.Literals(["Norwegian", "English", "NorwegianAndEnglish"]),
});

export type SubstitutePreferences = typeof SubstitutePreferences.Type;

export const SubstituteMutation = Schema.Struct({
  ...SubstitutePreferences.fields,
  yearOfStudy: PublicApplicationYearOfStudySchema,
});

export type SubstituteMutation = typeof SubstituteMutation.Type;

export const SubstituteCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("deactivate") }),
  Schema.Struct({ action: Schema.Literals(["activate", "edit"]), input: SubstituteMutation }),
]);

export type SubstituteCommand = typeof SubstituteCommand.Type;

export const SubstituteEntryFields = {
  applicationId: PublicApplicationIdSchema,
  admissionPeriodId: AdmissionPeriodId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  firstName: PublicApplicationNameSchema,
  lastName: PublicApplicationNameSchema,
  email: PublicApplicationEmailSchema,
  phone: PublicApplicationPhoneSchema,
  yearOfStudy: PublicApplicationYearOfStudySchema,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
};

export const SubstituteEntry = Schema.Union([
  Schema.Struct({
    ...SubstituteEntryFields,
    active: Schema.Literal(true),
    preferences: SubstitutePreferences,
  }),
  Schema.Struct({
    ...SubstituteEntryFields,
    active: Schema.Literal(false),
    preferences: Schema.NullOr(SubstitutePreferences),
  }),
]);

export type SubstituteEntry = typeof SubstituteEntry.Type;

export const SubstituteScope = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
});

export type SubstituteScope = typeof SubstituteScope.Type;

export const SubstitutePool = Schema.Struct({
  admissionPeriodId: Schema.NullOr(AdmissionPeriodId),
  entries: Schema.Array(SubstituteEntry),
});

export type SubstitutePool = typeof SubstitutePool.Type;

export const SubstituteScopes = Schema.Struct({
  departments: Schema.Array(Schema.Struct({ departmentId: DepartmentId, name: Schema.String })),
  semesters: Schema.Array(
    Schema.Struct({ semesterId: SemesterId, startAt: Schema.String, endAt: Schema.String }),
  ),
});

export type SubstituteScopes = typeof SubstituteScopes.Type;
