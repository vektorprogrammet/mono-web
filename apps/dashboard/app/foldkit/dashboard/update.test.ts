import { describe, expect, it } from "vitest";
import {
  ActivatedNavigation,
  DismissedNavigation,
  OpenedMobileNavigation,
  ToggledProfileMenu,
} from "./message";
import { makeInitialModel } from "./model";
import { canViewLink, navigationSections } from "./navigation";
import { update } from "./update";

const input = {
  identity: { name: "Ada Lovelace", avatar: null },
  role: "ROLE_TEAM_MEMBER" as const,
  activePath: "/dashboard/intervjuer",
  summary: { _tag: "Unavailable" as const },
};

describe("Foldkit dashboard state", () => {
  it("opens the legacy Opptak disclosure for an active child route", () => {
    const model = makeInitialModel(input);
    expect(model).toMatchObject({
      _tag: "Ready",
      isAdmissionMenuOpen: true,
      isMobileNavigationOpen: false,
      isProfileMenuOpen: false,
    });
  });

  it("closes transient navigation state after route activation and Escape", () => {
    const initial = makeInitialModel(input);
    const [mobile] = update(initial, OpenedMobileNavigation());
    const [profile] = update(mobile, ToggledProfileMenu({ isOpen: true }));
    const [activated] = update(profile, ActivatedNavigation({ path: "/dashboard/team" }));
    expect(activated).toMatchObject({
      activePath: "/dashboard/team",
      isMobileNavigationOpen: false,
      isProfileMenuOpen: false,
    });
    if (activated._tag !== "Ready") throw new Error("ready model became invalid");

    const [dismissed] = update({ ...activated, isAdmissionMenuOpen: true }, DismissedNavigation());
    expect(dismissed).toMatchObject({
      isAdmissionMenuOpen: false,
      isMobileNavigationOpen: false,
      isProfileMenuOpen: false,
    });
  });

  it("keeps team-leader-only destinations structurally hidden from team members", () => {
    const leaderOnly = navigationSections
      .flatMap((section) => section.entries)
      .flatMap((entry) => (entry.kind === "link" ? [entry.link] : entry.links))
      .filter((link) => link.requiredRole === "team-leader");

    expect(leaderOnly.length).toBeGreaterThan(0);
    expect(leaderOnly.every((link) => !canViewLink("ROLE_TEAM_MEMBER", link))).toBe(true);
    expect(leaderOnly.every((link) => canViewLink("ROLE_TEAM_LEADER", link))).toBe(true);
  });
});
