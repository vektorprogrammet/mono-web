import { visibleShellNavigationLinks } from "./shell";
import { expect, it } from "vitest";


it("keeps coordinator report navigation out of the ordinary member shell", () => {
  const ordinary = { title: "Intervjuer", url: "/dashboard/intervjuer" };

  const report = {
    title: "Fullførte intervjuer",
    url: "/dashboard/intervjuer/rapport",
    coordinatorOnly: true,
  };

  expect(visibleShellNavigationLinks([ordinary, report], false)).toEqual([ordinary]);
  expect(visibleShellNavigationLinks([ordinary, report], true)).toEqual([ordinary, report]);

});
