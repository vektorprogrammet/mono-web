import type { UserProfileResponse } from "@vektorprogrammet/http-api";
export interface ProfileView {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly role: string;
}

export function projectProfile(data: typeof UserProfileResponse.Type): ProfileView {
  return {
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone ?? null,
    role: data.role,
  };
}
export async function loadProfile(
  read: () => Promise<typeof UserProfileResponse.Type>,
): Promise<ProfileView> {
  return projectProfile(await read());
}
