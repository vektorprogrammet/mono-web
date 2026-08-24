import type { UserProfile } from "@vektorprogrammet/sdk";
export interface ProfileView {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly role: string;
}

export function projectProfile(data: UserProfile): ProfileView {
  return {
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone ?? null,
    role: data.role,
  };
}
export async function loadProfile(read: () => Promise<UserProfile>): Promise<ProfileView> {
  return projectProfile(await read());
}
