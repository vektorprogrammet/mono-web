import { Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import { type SerializedPageTree, useFumadocsLoader } from "fumadocs-core/source/client";
import type { OpenAPIPageProps_Spec } from "fumadocs-openapi/server";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense, use } from "react";
import { inPlaceDocumentOf } from "../../markdown/pages";
import { OpenAPIPage } from "@/components/api-page";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { getPageMarkdownUrl, gitConfig } from "@/lib/shared";
import { docs } from "@/lib/docs";

/** Route data is either a content page or an API operation from the OpenAPI contract. */
export type PageData =
  | {
      readonly type: "docs";
      readonly path: string;
      readonly editPath: string;
      readonly markdownUrl: string;
      readonly pageTree: SerializedPageTree;
    }
  | {
      readonly type: "openapi";
      readonly title: string;
      readonly description?: string;
      readonly props: OpenAPIPageProps_Spec;
      readonly pageTree: SerializedPageTree;
    };

const serverLoader = createServerFn({
  method: "GET",
})
  .validator((slugs: string[]) => slugs)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: slugs }): Promise<PageData> => {
    const { source } = await import("@/lib/source");

    const [fs, nodePath] = await Promise.all([import("node:fs"), import("node:path")]);

    const page = source.getPage(slugs);

    if (!page) throw notFound();

    const pageTree = await source.serializePageTree(source.getPageTree());

    if (page.type === "openapi") {
      const title = page.data.title;

      if (title === undefined) throw new Error(`The OpenAPI page ${page.url} has no title`);

      return {
        type: "openapi",
        title,
        description: page.data.description,
        props: page.data.getOpenAPIPageProps(),
        pageTree,
      };
    }

    const { path } = page.data.info;

    return {
      type: "docs",
      path,
      // A page read in place is edited in the document that it includes.
      editPath:
        inPlaceDocumentOf(
          path,
          fs.readFileSync(nodePath.resolve(process.cwd(), "../..", path), "utf8"),
        ) ?? path,
      markdownUrl: getPageMarkdownUrl(page).url,
      pageTree,
    };
  });

/** The route data of the page with these slugs, with its content loaded. */
export async function loadPage(slugs: string[]): Promise<PageData> {
  const data = await serverLoader({ data: slugs });

  if (data.type === "docs") await docs.getPage(data.path)?.preload();

  return data;
}

function Content({
  path,
  editPath,
  markdownUrl,
}: {
  path: string;
  editPath: string;
  markdownUrl: string;
}) {
  const page = docs.getPage(path);

  if (!page) throw new Error(`unknown page: ${path}`);

  const { toc } = use(page.load());
  const MDX = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${editPath}`}
        />
      </div>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function DocsRoutePage({ data }: { data: PageData }) {
  const page = useFumadocsLoader(data);

  return (
    <DocsLayout {...baseOptions()} tree={page.pageTree}>
      {page.type === "docs" && <Link to={page.markdownUrl} hidden />}
      <Suspense>
        {page.type === "openapi" ? (
          <DocsPage full>
            <DocsTitle>{page.title}</DocsTitle>
            <DocsDescription>{page.description}</DocsDescription>
            <DocsBody>
              <OpenAPIPage {...page.props} />
            </DocsBody>
          </DocsPage>
        ) : (
          <Content path={page.path} editPath={page.editPath} markdownUrl={page.markdownUrl} />
        )}
      </Suspense>
    </DocsLayout>
  );
}
