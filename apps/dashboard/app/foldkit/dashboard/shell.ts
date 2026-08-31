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
