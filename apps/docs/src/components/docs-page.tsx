import { Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import { type SerializedPageTree, useFumadocsLoader } from "fumadocs-core/source/client";
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
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { getPageMarkdownUrl, gitConfig } from "@/lib/shared";
import { docs, source } from "@/lib/source";

/** The data of a page's route. */
export interface PageData {
  /** The page's file in the content collection, relative to the repository root. */
  readonly path: string;
  /** The file that GitHub opens to edit the page. */
  readonly editPath: string;
  readonly markdownUrl: string;
  readonly pageTree: SerializedPageTree;
}

const serverLoader = createServerFn({
  method: "GET",
})
  .validator((slugs: string[]) => slugs)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: slugs }): Promise<PageData> => {
    const page = source.getPage(slugs);

    if (!page) throw notFound();

    const { path } = page.data.info;

    return {
      path,
      // A page read in place is edited in the document that it includes.
      editPath: inPlaceDocumentOf(path, await page.data.getText("raw")) ?? path,
      markdownUrl: getPageMarkdownUrl(page).url,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

/** The route data of the page with these slugs, with its content loaded. */
export async function loadPage(slugs: string[]): Promise<PageData> {
  const data = await serverLoader({ data: slugs });

  await docs.getPage(data.path)?.preload();

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
  const { pageTree, path, editPath, markdownUrl } = useFumadocsLoader(data);

  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Link to={markdownUrl} hidden />
      <Suspense>
        <Content path={path} editPath={editPath} markdownUrl={markdownUrl} />
      </Suspense>
    </DocsLayout>
  );
}
