import {
  ConfigurationError,
  ConflictError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  SdkError,
  UnauthorizedError,
  ValidationError,
} from "@vektorprogrammet/sdk";
import type { Sdk, User } from "@vektorprogrammet/sdk";
type InterviewSchemaValue = Awaited<
  ReturnType<Sdk["admin"]["interviews"]["schemas"]>
>[number];

export type ApplicantInterviewerOption = Pick<
  User,
  "id" | "firstName" | "lastName"
>;

export type ApplicantSchemaOption = Pick<InterviewSchemaValue, "id" | "name">;

export type ApplicantErrorContext = "applications" | "options" | "assignment";

export function projectInterviewerOption(
  user: User,
): ApplicantInterviewerOption {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

export function projectSchemaOption(
  schema: InterviewSchemaValue,
): ApplicantSchemaOption {
  return { id: schema.id, name: schema.name };
}

export function isUnauthorizedApplicantError(
  error: unknown,
): error is UnauthorizedError {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && error.type === "unauthorized")
  );
}

export function mapApplicantError(
  error: unknown,
  context: ApplicantErrorContext,
): string {
  if (error instanceof ConfigurationError) {
    return "API-konfigurasjon mangler eller er ugyldig.";
  }

  if (context === "assignment") {
    if (error instanceof ValidationError) {
      return "Kunne ikke tildele intervju. Kontroller valgene og prøv igjen.";
    }
    if (error instanceof ConflictError) {
      return "Søknaden er endret et annet sted. Last inn siden på nytt og prøv igjen.";
    }
    if (error instanceof NotFoundError) {
      return "Søknaden eller intervjueren ble ikke funnet.";
    }
    if (error instanceof RateLimitedError) {
      return "For mange forespørsler. Prøv igjen senere.";
    }
    if (error instanceof NetworkError) {
      return "Kunne ikke tildele intervju. Prøv igjen senere.";
    }
    if (error instanceof SdkError) {
      return "Kunne ikke tildele intervju.";
    }
    return "Kunne ikke tildele intervju.";
  }

  if (error instanceof ValidationError) {
    return context === "applications"
      ? "Kunne ikke laste søkere. Kontroller dataene og prøv igjen."
      : "Kunne ikke laste intervjualternativer. Kontroller dataene og prøv igjen.";
  }
  if (error instanceof ConflictError) {
    return context === "applications"
      ? "Søkerlisten er endret et annet sted. Last inn siden på nytt."
      : "Intervjualternativene er endret et annet sted. Last inn siden på nytt.";
  }
  if (error instanceof NotFoundError) {
    return context === "applications"
      ? "Søkerlisten ble ikke funnet."
      : "Intervjualternativene ble ikke funnet.";
  }
  if (error instanceof RateLimitedError) {
    return "For mange forespørsler. Prøv igjen senere.";
  }
  if (error instanceof NetworkError) {
    return context === "applications"
      ? "Kunne ikke laste søkere. Prøv igjen senere."
      : "Kunne ikke laste intervjualternativer. Prøv igjen senere.";
  }
  if (error instanceof SdkError) {
    return context === "applications"
      ? "Kunne ikke laste søkere."
      : "Kunne ikke laste intervjualternativer.";
  }
  return context === "applications"
    ? "Kunne ikke laste søkere."
    : "Kunne ikke laste intervjualternativer.";
}

