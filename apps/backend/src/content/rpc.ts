/**
 * The ContentRpcs handlers: staff article drafts and publication, and the public news.
 *
 * A staff read resolves the person at one authorization instant and evaluates the RPC's AccessSpec
 * over the article or department it reads. A command resolves the credential and the authority
 * inside the serializable transaction that commits it, compares `ifMatch` there, and stores its
 * answer as a command receipt. The public news reads evaluate their anonymous AccessSpec.
 */
import { ContentRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";
import { createArticle, publishArticle, reviseArticle, unpublishArticle } from "./commands.js";
import { listNews, readArticle, readContentWorkspace, readNewsArticle } from "./reads.js";

/** The ContentRpcs handlers. */
export const ContentRpcHandlers = (options: NativeRpcOptions) =>
  ContentRpcs.toLayer({
    "content.readContentWorkspace": (query, { headers }) =>
      readContentWorkspace({ headers, query, options }),
    "content.createArticle": ({ idempotencyKey, request }, { headers }) =>
      createArticle({ headers, idempotencyKey, request }),
    "content.readArticle": ({ articleId }, { headers }) =>
      readArticle({ headers, articleId, options }),
    "content.reviseArticle": (payload, { headers }) => reviseArticle({ headers, ...payload }),
    "content.publishArticle": (payload, { headers }) => publishArticle({ headers, ...payload }),
    "content.unpublishArticle": (payload, { headers }) => unpublishArticle({ headers, ...payload }),
    "content.listNews": (query) => listNews(query),
    "content.readNewsArticle": (query) => readNewsArticle(query),
  });
