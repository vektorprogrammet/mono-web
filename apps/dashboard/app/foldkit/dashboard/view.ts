import { Button, Disclosure } from "@foldkit/ui";
import { Option, Schema as S } from "effect";
import type { Html, HtmlBuilder, TagName } from "foldkit/html";
import { DASHBOARD_ELEMENT as INTERVIEW_DASHBOARD_ELEMENT } from "../interview/elements";
import {
  RECRUITMENT_ELEMENT,
  RECRUITMENT_INPUT_ATTRIBUTE,
} from "../recruitment/elements";
import { RecruitmentInputJson } from "../recruitment/model";
import {
  ActivatedNavigation,
  ClosedMobileNavigation,
  DismissedNavigation,
  OpenedMobileNavigation,
  ToggledAdmissionMenu,
  ToggledProfileMenu,
  type Message,
} from "./message";
import type { Model, ReadyModel } from "./model";
import {
  admissionLinks,
  canViewLink,
  controlPanelLink,
  isActivePath,
  navigationSections,
  profileLinks,
  type NavigationEntry,
  type NavigationLink,
} from "./navigation";

const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("nb-NO") ?? "")
    .join("");

const avatarView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  model.identity.avatar === null
    ? h.span(
        [h.Class("fd-avatar fd-avatar--fallback"), h.AriaHidden(true)],
        [initials(model.identity.name)],
      )
    : h.img([
        h.Class("fd-avatar"),
        h.Src(model.identity.avatar),
        h.Alt(model.identity.name),
        h.Width("75"),
        h.Height("75"),
        h.Decoding("async"),
      ]);

const activeLinkAttributes = (model: ReadyModel, link: NavigationLink, h: HtmlBuilder<Message>) => {
  const isActive = !link.external && isActivePath(model.activePath, link.href);
  return [
    h.Href(link.href),
    h.Class(`fd-nav-link${isActive ? " is-active" : ""}`),
    ...(isActive ? [h.AriaCurrent("page")] : []),
    ...(link.external
      ? [h.Rel("external")]
      : [h.OnClick(ActivatedNavigation({ path: link.href }))]),
  ];
};

const navigationLinkView = (
  model: ReadyModel,
  link: NavigationLink,
  h: HtmlBuilder<Message>,
): Html => {
  if (!canViewLink(model.role, link)) return h.empty;

  return h.li([h.Class("fd-nav-item")], [h.a(activeLinkAttributes(model, link, h), [link.label])]);
};

const admissionMenuView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  Disclosure.view(
    {
      id: "fd-admission-menu",
      isOpen: model.isAdmissionMenuOpen,
      onToggle: (isOpen) => ToggledAdmissionMenu({ isOpen }),
      toView: ({ button, panel }) =>
        h.li(
          [h.Class("fd-nav-item fd-nav-disclosure")],
          [
            h.button(
              [
                ...button,
                h.Class(
                  `fd-nav-link fd-nav-disclosure__button${
                    admissionLinks.some((link) => isActivePath(model.activePath, link.href))
                      ? " is-active"
                      : ""
                  }`,
                ),
              ],
              [
                h.span([], ["Opptak"]),
                h.span(
                  [
                    h.Class(`fd-disclosure-chevron${model.isAdmissionMenuOpen ? " is-open" : ""}`),
                    h.AriaHidden(true),
                  ],
                  ["›"],
                ),
              ],
            ),
            h.ul(
              [...panel, h.Class("fd-nav-submenu"), h.Hidden(!model.isAdmissionMenuOpen)],
              admissionLinks.map((link) => navigationLinkView(model, link, h)),
            ),
          ],
        ),
    },
    h,
  );

const navigationEntryView = (
  model: ReadyModel,
  entry: NavigationEntry,
  h: HtmlBuilder<Message>,
): Html =>
  entry.kind === "admission-menu"
    ? admissionMenuView(model, h)
    : navigationLinkView(model, entry.link, h);

const primaryNavigationView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [h.AriaLabel("Hovedmeny")],
    [
      h.ul(
        [h.Class("fd-nav-list")],
        [
          navigationLinkView(model, controlPanelLink, h),
          ...navigationSections.flatMap((section) => [
            h.li([h.Class("fd-nav-title")], [section.label]),
            ...section.entries.map((entry) => navigationEntryView(model, entry, h)),
          ]),
        ],
      ),
    ],
  );

const profileMenuView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  Disclosure.view(
    {
      id: "fd-profile-menu",
      isOpen: model.isProfileMenuOpen,
      onToggle: (isOpen) => ToggledProfileMenu({ isOpen }),
      toView: ({ button, panel }) =>
        h.div(
          [h.Class("fd-profile")],
          [
            h.button(
              [...button, h.Class("fd-profile__trigger")],
              [
                avatarView(model, h),
                h.span([h.Class("fd-profile__name")], [model.identity.name]),
                h.span(
                  [
                    h.Class(`fd-disclosure-chevron${model.isProfileMenuOpen ? " is-open" : ""}`),
                    h.AriaHidden(true),
                  ],
                  ["›"],
                ),
              ],
            ),
            h.ul(
              [...panel, h.Class("fd-profile__menu"), h.Hidden(!model.isProfileMenuOpen)],
              [
                ...profileLinks.map((link) => navigationLinkView(model, link, h)),
                h.li(
                  [h.Class("fd-nav-item")],
                  [
                    h.form(
                      [h.Action("/logout"), h.Method("post")],
                      [
                        h.button(
                          [h.Class("fd-nav-link fd-sign-out"), h.Type("submit")],
                          ["Logg ut"],
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
    },
    h,
  );

const mobileCloseButton = (h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      type: "button",
      toView: ({ button }) =>
        h.button(
          [
            ...button,
            h.Id("fd-mobile-navigation-close"),
            h.Class("fd-mobile-close"),
            h.AriaLabel("Lukk meny"),
            h.OnClickFocus("#fd-mobile-navigation-toggle", ClosedMobileNavigation()),
          ],
          [h.span([h.AriaHidden(true)], ["×"]), h.small([], ["lukk"])],
        ),
    },
    h,
  );

const sidebarView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [
      h.Id("fd-primary-sidebar"),
      h.Class(`fd-sidebar${model.isMobileNavigationOpen ? " is-mobile-open" : ""}`),
      h.AriaLabel("Kontrollpanelmeny"),
    ],
    [
      mobileCloseButton(h),
      h.a(
        [h.Class("fd-home-link"), h.Href("/")],
        [h.span([h.AriaHidden(true)], ["‹"]), " Tilbake til forsiden"],
      ),
      profileMenuView(model, h),
      h.hr([h.Class("fd-sidebar-rule")]),
      h.div(
        [h.Class("fd-sidebar__scroll")],
        [
          primaryNavigationView(model, h),
          h.footer(
            [h.Class("fd-sidebar-footer")],
            [
              h.a(
                [h.Href("/"), h.Class("fd-sidebar-footer__link")],
                [
                  h.img([
                    h.Src("/vektor-logo-circle.svg"),
                    h.Alt("Vektorprogrammet"),
                    h.Width("72"),
                    h.Height("72"),
                  ]),
                  h.span([], [h.span([h.AriaHidden(true)], ["‹"]), " Tilbake til forsiden"]),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );

const mobileOpenButton = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      type: "button",
      onClick: OpenedMobileNavigation(),
      toView: ({ button }) =>
        h.button(
          [
            ...button,
            h.Id("fd-mobile-navigation-toggle"),
            h.Class("fd-mobile-toggle"),
            h.AriaLabel("Åpne meny"),
            h.AriaControls("fd-primary-sidebar"),
            h.AriaExpanded(model.isMobileNavigationOpen),
          ],
          [h.span([h.AriaHidden(true)], ["☰"])],
        ),
    },
    h,
  );

const mobileOverlay = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      type: "button",
      toView: ({ button }) =>
        h.button(
          [
            ...button,
            h.Class("fd-mobile-overlay"),
            h.Hidden(!model.isMobileNavigationOpen),
            h.AriaLabel("Lukk meny"),
            h.OnClickFocus("#fd-mobile-navigation-toggle", ClosedMobileNavigation()),
          ],
          [],
        ),
    },
    h,
  );

const breadcrumbsView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class("fd-header")],
    [
      h.ol(
        [h.Class("fd-breadcrumb"), h.AriaLabel("Brødsmuler")],
        [
          h.li([h.Class("fd-breadcrumb__mobile")], [mobileOpenButton(model, h)]),
          h.li([h.Class("fd-breadcrumb__item")], [h.a([h.Href("/")], ["Forsiden"])]),
          h.li(
            [h.Class("fd-breadcrumb__item is-current"), h.AriaCurrent("page")],
            [model.recruitment === null ? "Kontrollpanel" : "Søkere"],
          ),
        ],
      ),
    ],
  );

const summaryLink = (
  model: ReadyModel,
  label: string,
  value: number,
  href: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("fd-summary-card")],
    [
      h.dt([], [h.a([h.Href(href), h.OnClick(ActivatedNavigation({ path: href }))], [label])]),
      h.dd([], [String(value)]),
    ],
  );

const landingView = (model: ReadyModel, h: HtmlBuilder<Message>): Html => {
  if (model.summary._tag === "Unavailable") {
    return h.section(
      [
        h.Class("fd-landing fd-landing--error"),
        h.AriaLabelledBy("fd-landing-title"),
        h.Role("alert"),
      ],
      [
        h.h1([h.Id("fd-landing-title"), h.Class("fd-visually-hidden")], ["Kontrollpanel"]),
        h.div(
          [h.Class("fd-error-card")],
          [
            h.h2([], ["Oversikten kunne ikke hentes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
      ],
    );
  }

  return h.section(
    [h.Class("fd-landing"), h.AriaLabelledBy("fd-landing-title")],
    [
      h.h1([h.Id("fd-landing-title"), h.Class("fd-visually-hidden")], ["Kontrollpanel"]),
      h.p([h.Class("fd-landing__context")], [model.summary.department]),
      h.dl(
        [h.Class("fd-summary-grid")],
        [
          summaryLink(
            model,
            "Assistenter",
            model.summary.activeAssistants,
            "/dashboard/assistenter",
            h,
          ),
          summaryLink(
            model,
            "Nye søkere",
            model.summary.pendingApplications,
            "/dashboard/sokere",
            h,
          ),
          summaryLink(
            model,
            "Intervjuer",
            model.summary.upcomingInterviews,
            "/dashboard/intervjuer",
            h,
          ),
        ],
      ),
    ],
  );
};

const readyView = (model: ReadyModel, h: HtmlBuilder<Message>): Html => {
  const hasOpenNavigation =
    model.isMobileNavigationOpen || model.isAdmissionMenuOpen || model.isProfileMenuOpen;

  return h.div(
    [
      h.Class("foldkit-dashboard"),
      h.OnKeyDownFocus((key) => {
        if (key !== "Escape" || !hasOpenNavigation) return Option.none();

        const focusSelector = model.isMobileNavigationOpen
          ? "#fd-mobile-navigation-toggle"
          : model.isProfileMenuOpen
            ? `#${Disclosure.buttonId("fd-profile-menu")}`
            : `#${Disclosure.buttonId("fd-admission-menu")}`;

        return Option.some({
          focusSelector,
          message: DismissedNavigation(),
        });
      }),
    ],
    [
      h.a([h.Class("fd-skip-link"), h.Href("#fd-main")], ["Hopp til innhold"]),
      sidebarView(model, h),
      mobileOverlay(model, h),
      h.div(
        [h.Class("fd-main-column")],
        [
          breadcrumbsView(model, h),
          h.main(
            [h.Id("fd-main"), h.Class("fd-main"), h.Tabindex(-1)],
            [
              ...(model.recruitment === null
                ? [
                    landingView(model, h),
                    h.section(
                      [h.Class("fd-interview-region"), h.AriaLabel("Intervjuer")],
                      [
                        h.keyed(INTERVIEW_DASHBOARD_ELEMENT as TagName)(
                          "foldkit-interview-dashboard",
                          [h.Id("fd-interview-program")],
                        ),
                      ],
                    ),
                  ]
                : [
                    h.keyed(RECRUITMENT_ELEMENT as TagName)("foldkit-recruitment-board", [
                      h.Id("fd-recruitment-program"),
                      h.Attribute(
                        RECRUITMENT_INPUT_ATTRIBUTE,
                        S.encodeSync(RecruitmentInputJson)(model.recruitment),
                      ),
                    ]),
                  ]),
            ],
          ),
        ],
      ),
    ],
  );
};

const invalidInputView = (h: HtmlBuilder<Message>): Html =>
  h.main(
    [h.Class("foldkit-dashboard fd-startup-error"), h.Role("alert")],
    [
      h.section(
        [h.Class("fd-error-card")],
        [
          h.h1([], ["Kontrollpanelet kunne ikke startes"]),
          h.p([], ["Last siden på nytt og prøv igjen."]),
        ],
      ),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  model._tag === "Ready" ? readyView(model, h) : invalidInputView(h);
