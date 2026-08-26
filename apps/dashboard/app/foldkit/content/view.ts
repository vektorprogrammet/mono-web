import type { ContentWorkspace } from "@vektorprogrammet/sdk/effect";
import { DepartmentId as DepartmentIdSchema } from "@vektorprogrammet/sdk/effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./message";
import { ChangedDepartmentFilter, ChangedDepartmentSelection, DeselectedArticle } from "./message";
import {
  DismissedBanner,
  EditedField,
  RetriedWorkspace,
  SelectedArticle,
  SubmittedCreate,
  SubmittedPublish,
  SubmittedRevise,
  SubmittedUnpublish,
} from "./message";
import { visibleEntries } from "./update";
import type { Model } from "./model";

const bannerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.banner === null) return h.empty;
  return h.div(
    [h.Class("content-workspace__banner"), h.Role("alert")],
    [
      h.p([], [model.banner.message]),
      // A failed load offers exactly one recovery action: a new request id.
      model.banner._tag === "Failed"
        ? h.button([h.Type("button"), h.OnClick(RetriedWorkspace())], ["Prøv igjen"])
        : h.empty,
    ],
  );
};

const stateView = (model: Model, h: HtmlBuilder<Message>, h2: Html): Html => {
  if (model.workspace._tag === "Loading") {
    return h.p(
      [h.Role("status"), h.Class("content-workspace__loading")],
      ["Laster artikkeladministrasjonen …"],
    );
  }
  if (model.workspace._tag === "Failure") {
    return h.div(
      [h.Role("status"), h.Class("content-workspace__empty")],
      [h.h3([], ["Ingen artikler vist"]), h.p([], ["Prøv å laste på nytt."])],
    );
  }
  void model;
  void h2;
  return h.empty;
};

const rows = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.workspace._tag !== "Success") return h.empty;
  const entries = visibleEntries(model);
  if (entries.length === 0) {
    return h.p(
      [h.Role("status"), h.Class("content-workspace__empty")],
      ["Ingen artikler i denne visningen."],
    );
  }
  return h.ul(
    [h.Class("content-workspace__list"), h.Role("list")],
    entries.map((entry) =>
      h.li(
        [h.Class("content-workspace__row"), h.DataAttribute("article-id", String(entry.articleId))],
        [
          h.button(
            [
              h.Type("button"),
              h.Class("content-workspace__select"),
              h.OnClick(SelectedArticle({ articleId: entry.articleId })),
            ],
            [
              `${entry.sticky ? "★ " : ""}${entry.title} — ${
                entry.status === "Draft" ? "Kladd" : "Publisert"
              } · ${entry.authorDisplayName}`,
            ],
          ),
          ...(entry.canPublish
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.OnClick(
                      SubmittedPublish({
                        commandId: `publish-${entry.articleId}-${model.requestId + 1}`,
                        articleId: entry.articleId,
                      }),
                    ),
                  ],
                  ["Publiser"],
                ),
                ...(entry.status === "Published"
                  ? [
                      h.button(
                        [
                          h.Type("button"),
                          h.OnClick(
                            SubmittedUnpublish({
                              commandId: `unpublish-${entry.articleId}-${model.requestId + 1}`,
                              articleId: entry.articleId,
                            }),
                          ),
                        ],
                        ["Avpubliser"],
                      ),
                    ]
                  : []),
              ]
            : []),
        ],
      ),
    ),
  );
};

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("content-workspace"), h.AriaLabelledBy("content-workspace-title")],
    [
      h.header(
        [h.Class("content-workspace__header")],
        [
          h.p([h.Class("content-workspace__eyebrow")], ["Innhold"]),
          h.h1([h.Id("content-workspace-title")], ["Artikler"]),
          bannerView(model, h),
          model.workspace._tag === "Loading" ? stateView(model, h, h.empty) : rows(model, h),
        ],
      ),
      h.section(
        [
          h.Class("content-workspace__editor"),
          h.DataAttribute("dirty", String(model.dirty)),
          h.AriaLabel("Artikkelfelt"),
        ],
        [
          h.label([h.For("content-editor-title")], ["Tittel"]),
          h.input([
            h.Id("content-editor-title"),
            h.Type("text"),
            h.Value(model.editor.title),
            h.OnInput((value) => EditedField({ title: value, bodyHtml: null, sticky: null })),
          ]),
          h.label([h.For("content-editor-body")], ["Brødtekst"]),
          h.textarea(
            [
              h.Id("content-editor-body"),
              h.OnInput((value) => EditedField({ title: null, bodyHtml: value, sticky: null })),
            ],
            [model.editor.bodyHtml],
          ),
          ...(() => {
            const options = new Set<string>();
            if (model.workspace._tag === "Success") {
              for (const entry of model.workspace.data.entries) {
                for (const id of entry.departmentIds) options.add(id);
              }
            }
            for (const id of model.editor.departmentIds) options.add(id);
            return [...options].map((id) =>
              h.div(
                [h.Class("content-workspace__dept-option")],
                [
                  h.input([
                    h.Id(`content-dept-${id}`),
                    h.Type("checkbox"),
                    h.Name(`content-dept-${id}`),
                    h.Checked(model.editor.departmentIds.includes(id as never)),
                    h.OnChange((checked: string) =>
                      ChangedDepartmentSelection({
                        departmentId: DepartmentIdSchema.make(id),
                        checked: checked === "on",
                      }),
                    ),
                  ]),
                  h.label([h.For(`content-dept-${id}`)], [id]),
                ],
              ),
            );
          })(),
          h.input([
            h.Id("content-editor-sticky"),
            h.Type("checkbox"),
            h.Checked(model.editor.sticky),
            h.OnChange((checked) =>
              EditedField({ title: null, bodyHtml: null, sticky: checked === "on" }),
            ),
          ]),
          h.label([h.For("content-editor-sticky")], ["Festet"]),
          h.button(
            [h.Type("button"), h.OnClick(DeselectedArticle()), h.Class("content-workspace__new")],
            ["Ny artikkel"],
          ),
          model.dirty && model.selectedArticleId === null
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("content-editor-save"),
                  h.OnClick(SubmittedCreate({ commandId: `create-${Date.now()}` })),
                ],
                ["Lagre kladd"],
              )
            : h.empty,
          model.dirty && model.selectedArticleId !== null
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("content-editor-revise"),
                  h.OnClick(SubmittedRevise({ commandId: `revise-${Date.now()}` })),
                ],
                ["Lagre endringer"],
              )
            : h.empty,
          h.button(
            [h.Type("button"), h.OnClick(DismissedBanner()), h.Class("content-workspace__dismiss")],
            ["Lukk melding"],
          ),
        ],
      ),
      h.div(
        [h.Class("content-workspace__filters")],
        [
          h.label([h.For("content-department-filter")], ["Avdelingsfilter"]),
          h.select(
            [
              h.Id("content-department-filter"),
              h.OnChange((value) =>
                ChangedDepartmentFilter({ departmentId: value === "" ? null : (value as never) }),
              ),
            ],
            [],
          ),
          h.button([h.Type("button"), h.OnClick(RetriedWorkspace())], ["Last på nytt"]),
        ],
      ),
    ],
  );

void SubmittedRevise;
void visibleEntries;
type Unused<T> = T;
void ({} as unknown as Unused<ContentWorkspace>);
