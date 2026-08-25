export interface DashboardShellUser {
  readonly name: string;
  readonly email: string;
}

export interface DashboardShellData {
  readonly user: DashboardShellUser | null;
  readonly isAdmin: boolean;
}

export const dashboardShellVisibility = (user: DashboardShellUser | null) => ({
  showIdentityMenu: user !== null,
  showOrganizationContext: user !== null,
  mountChildRoutes: true,
});
