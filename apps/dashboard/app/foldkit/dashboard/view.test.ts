// @vitest-environment happy-dom
import { Scene } from "foldkit/test";
import { describe, it } from "vitest";
import { init, LandingSummary } from "./model";
import { update } from "./update";
import { view } from "./view";

describe("Foldkit dashboard nullable user shell", () => {
  it("hides identity-only content while retaining the dashboard shell", () => {
    Scene.scene({update, view},
      Scene.given(init({user: null, role: null, activePath: "/dashboard/skoler", summary: LandingSummary.make({}), recruitment: null})),
      Scene.expect(Scene.role("link", {name: /Tilbake til forsiden/})).toBeVisible(),
      Scene.expectAll(Scene.all.text("Logg ut")).toBeEmpty(),
      Scene.expectAll(Scene.all.text("Min profil")).toBeEmpty(),
    );
  });
});

describe("navigation disclosure controls", () => {
  it("dismisses admission from its sidebar boundary and permits reopening and toggling", () => {
    const admission = Scene.role("button", { name: "Opptak" });
    Scene.scene(
      { update, view },
      Scene.given(init({ user: null, role: "ROLE_TEAM_MEMBER", activePath: "/dashboard/sokere", summary: LandingSummary.make({}), recruitment: null })),
      Scene.expect(admission).toHaveAttr("aria-expanded", "true"),
      Scene.keydown("#fd-primary-sidebar", "Escape"),
      Scene.expect(admission).toHaveAttr("aria-expanded", "false"),
      Scene.click(admission),
      Scene.expect(admission).toHaveAttr("aria-expanded", "true"),
      Scene.click(admission),
      Scene.expect(admission).toHaveAttr("aria-expanded", "false"),
    );
  });

  it("lets Tab fall through at mobile controls without dismissing admission", () => {
    Scene.scene(
      { update, view },
      Scene.given(init({ user: null, role: "ROLE_TEAM_MEMBER", activePath: "/dashboard/sokere", summary: LandingSummary.make({}), recruitment: null })),
      Scene.keydown("#fd-mobile-navigation-toggle", "Tab"),
      Scene.expectIgnored(),
      Scene.expect(Scene.role("button", { name: "Opptak" })).toHaveAttr("aria-expanded", "true"),
    );
  });
});
