export interface DashboardShellUser {
  readonly name: string;
  readonly email: string;
}

export interface DashboardShellData {
  readonly user: DashboardShellUser | null;
  readonly isAdmin: boolean;
  readonly hasOrganizationContext: boolean;
}

export const dashboardShellVisibility = (
  user: DashboardShellUser | null,
  hasOrganizationContext: boolean,
) => ({
  showIdentityMenu: user !== null,
  showOrganizationContext: hasOrganizationContext,
  mountChildRoutes: true,
});

/** Coarse navigation visibility only; each destination enforces current native authority. */
export const visibleShellNavigationLinks = <T extends object>(
  links: ReadonlyArray<T>,
  coordinator: boolean,
): T[] =>
  links.filter(
    (link) => !("coordinatorOnly" in link && link.coordinatorOnly === true) || coordinator,
  );
