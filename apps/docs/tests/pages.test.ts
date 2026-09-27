// A new content folder needs no configuration: its pages get a route and a read path from the scan.
import { describe, expect, test } from "bun:test";
import { collisions, pagesIn } from "../markdown/pages";
import { markedSource, markerOf } from "../markdown/render";

const page = (title: string, body: string) =>
  `---\ntitle: ${title}\ndescription: A probe.\n---\n\n${body}\n`;

describe("pages", () => {
  test("a page in a workspace without earlier pages gets a route and a read path", () => {
    const [intro] = pagesIn(["tools/postgres/content/intro.mdx"], () => page("Intro", "Hello."));

    expect(intro).toMatchObject({
      url: "/docs/tools/postgres/intro",
      readPath: "docs/tools/postgres/intro.md",
      generated: true,
    });
  });

  test("a section folder adds nothing to the route or the read path", () => {
    const [system] = pagesIn(["content/(system)/system.mdx"], () => page("System", "Text."));

    expect(system).toMatchObject({ url: "/docs/system", readPath: "docs/system.md" });
  });

  test("a page that includes one document is read in place and not generated", () => {
    const [state] = pagesIn(["content/(start)/state.mdx"], () =>
      page("State", "<include>../../STATE.md</include>"),
    );

    expect(state).toMatchObject({ readPath: "STATE.md", generated: false });
  });

  test("two pages with one route are reported", () => {
    const pages = pagesIn(["content/(system)/system.mdx", "content/system.mdx"], () =>
      page("System", "Text."),
    );

    expect(collisions(pages)).not.toEqual([]);
  });

  test("only a generated file carries the marker that names its source", () => {
    expect(markedSource(`${markerOf("content/specs/x.mdx")}\n\n# X\n`)).toBe("content/specs/x.mdx");
    expect(markedSource("# X\n\nWritten by hand.\n")).toBeUndefined();
  });
});
