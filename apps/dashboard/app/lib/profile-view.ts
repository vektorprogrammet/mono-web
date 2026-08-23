import type { UserProfile } from "@vektorprogrammet/sdk";
import { publicAssetUrl } from "./public-asset";
export interface ProfileView {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly study: string | null;
  readonly role: string;
  readonly profileImage: string;
}

export function projectProfile(data: UserProfile): ProfileView {
  return {
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone ?? null,
    study: data.fieldOfStudy?.name ?? null,
    role: data.role,
    profileImage: publicAssetUrl(data.profilePhoto),
  };
}
export async function loadProfile(read: () => Promise<UserProfile>): Promise<ProfileView> {
  return projectProfile(await read());
}
