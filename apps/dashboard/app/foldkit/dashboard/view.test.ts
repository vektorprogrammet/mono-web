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
