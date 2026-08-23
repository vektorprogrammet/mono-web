# Design spec 0046 — Foldkit live dashboard recreation

## Metadata

| Field | Value |
|---|---|
| Goal | Recreate the authenticated Symfony control-panel shell and its warranted landing summary as one owner-gated Foldkit program |
| Status | Frozen before product implementation |
| Actor | Authenticated team member, team leader, or administrator |
| Source authority | Legacy Symfony application revision `d05c261e9f73297f70ad228635c85ab566c51526` |
| Migration base | `5ebea91d00812ac76ab40d60476345b49a0c6177` |
| Route | `/dashboard/foldkit`, gated by `DASHBOARD_INTERVIEW_OWNER=foldkit` |
| Runtime boundary | React Router loader and one custom-element attribute; Foldkit owns Model, Message, Update, and View |
| Nested journey | The existing Foldkit interview program remains mounted without changing its SDK commands or transition ownership |

## Authority

The sole visual and behavioral authority is the legacy Symfony/PHP/Twig application at `/srv/share/projects/vektorprogrammet/vektorprogrammet`. In particular:

- `app/Resources/views/adminBase.html.twig` owns the desktop/mobile shell, breadcrumb order, and main-content hierarchy.
- `app/Resources/views/base/admin/main_navigation.html.twig` owns Norwegian labels, section order, profile actions, and explicit team-leader/admin conditions.
- `app/Resources/views/base/admin/nav_link.html.twig` owns active-link semantics and documents that legacy route visibility also depends on `has_access_to`.
- `app/Resources/views/control_panel/index.html.twig`, `control_panel/sbs.html.twig`, and `widgets/*.html.twig` own the legacy landing journey.
- `app/config/security.yml` and `src/AppBundle/Role/Roles.php` own the role hierarchy and the rule that `/kontrollpanel` requires `ROLE_TEAM_MEMBER` or an inheriting role.
- `app/Resources/assets/scss/control_panel.scss`, `_custom.scss`, `_colors.scss`, and `partials/_fonts.scss` own the 225 px sidebar, 992 px desktop breakpoint, Lato typography, light canvas, dark navigation, cyan interaction color, breadcrumb, and card hierarchy.

The React dashboard is not a design authority. Its route files and SDK calls are migration seams only: they identify reachable native route bodies, provide the authenticated profile call, and provide the optional dashboard-count projection. No React layout, grouping, casing, theme control, placeholder link, or fixture identity can establish parity.

## User journey

1. The owner flag is checked before the route reveals the feature.
2. The loader requires the existing authenticated cookie and reads the decoded SDK profile.
3. Only `ROLE_TEAM_MEMBER`, `ROLE_TEAM_LEADER`, and `ROLE_ADMIN` enter the Foldkit control panel. Other authenticated roles receive `403`.
4. The loader projects the warranted name, optional profile image, role, current pathname, and optional dashboard counts into one encoded attribute.
5. The custom element decodes that attribute again at runtime before it creates a ready Model.
6. The view shows the legacy dark sidebar, identity disclosure, ordered navigation, breadcrumb, control-panel summary, and existing Foldkit interview journey.
7. A navigation action uses the existing native route body. The Foldkit shell does not rewrite that nested workflow.
8. Sign-out posts to the existing `/logout` action.

Malformed or absent custom-element input never creates a synthetic user. It renders a Norwegian startup error state with no navigation or identity projection.

## Model ownership

The ready Model owns:

- decoded authenticated identity;
- decoded dashboard role;
- decoded landing-summary availability;
- current active pathname;
- desktop admission-menu expansion;
- profile-menu expansion;
- mobile sidebar visibility.

Messages and transitions are:

| Message | Transition |
|---|---|
| `OpenedMobileNavigation` | Opens the mobile sidebar |
| `ClosedMobileNavigation` | Closes the mobile sidebar and profile disclosure |
| `ToggledAdmissionMenu` | Toggles the legacy Opptak submenu |
| `ToggledProfileMenu` | Toggles authenticated profile actions |
| `ActivatedNavigation(path)` | Projects the selected path as active and closes mobile/profile navigation |
| `DismissedNavigation` | Escape closes all disclosures and the mobile sidebar |

The invalid-input Model accepts no transition. React owns none of these values and uses no state or lifecycle effect.

## Role and navigation projection

The Foldkit route itself follows the Symfony hierarchy:

| Decoded role | Route | Explicit team-leader links | Administrator-only link |
|---|---|---|---|
| `ROLE_USER` | Denied | No | No |
| `ROLE_TEAM_MEMBER` | Allowed | Hidden | Hidden |
| `ROLE_TEAM_LEADER` | Allowed | Shown | Hidden |
| `ROLE_ADMIN` | Allowed through hierarchy | Shown | Held because no native Access Control route exists |

The navigation preserves the Twig order and spelling for every reachable native route:

1. Kontrollpanel
2. Opptak: Opptaksperioder; Opptak disclosure with Nye søkere, Tidligere assistenter, Intervjufordeling, and Intervjuer; Intervjuskjema for team leaders; Opptaksstatistikk
3. Assistenter: Assistenter, Vikarer, Attester for team leaders
4. Team: Team, Teaminteresse for team leaders
5. Brukere: Brukere, Epostlister
6. Økonomi: Sponsorer, Utlegg
7. Annet: Avdelinger, Skoler, Linjer for team leaders, and Slab

A link is active when the decoded pathname equals its path or is nested below it. Kontrollpanel is active only on `/dashboard/foldkit`. If a child of the Opptak disclosure is initially active, that disclosure starts expanded. Clicking a native link updates the projection before normal browser navigation and closes the mobile sidebar.

## Desktop parity

At viewport widths of at least the legacy 992 px breakpoint:

- the 225 px dark sidebar is visible and fixed to the inline start;
- the main region is offset by the same width;
- the mobile open/close controls and overlay are absent;
- sidebar navigation scrolls independently for long role-aware inventories;
- the profile image is grayscale, the authenticated name is visible, and profile actions are a button-controlled disclosure;
- the breadcrumb reads `Forsiden` then active `Kontrollpanel`;
- the content uses the legacy light canvas, compact Lato type, flat bordered cards, and cyan active/hover treatment.

## Mobile parity

Below 992 px:

- the sidebar is translated off-canvas and hidden from focus until Update opens it;
- a labelled native button in the breadcrumb opens it;
- a labelled close button and full-canvas overlay close it;
- open/closed controls expose `aria-expanded` and `aria-controls`;
- Escape dispatches `DismissedNavigation` through Foldkit and returns every disclosure to closed state;
- navigation is single-column and the summary cards collapse to one column;
- no horizontal page overflow is required to reach a link or control.

## Landing projection

The optional `GET /api/me/dashboard` SDK result is a data seam, not a visual authority. When it decodes, Foldkit shows compact legacy-style summary cards using Twig terminology and links:

- Assistenter;
- Nye søkere;
- Intervjuer.

A zero count remains a valid visible observation. If the dashboard call fails or its current server representation does not match the SDK schema, the shell remains usable and the landing region shows one Norwegian error state. It never substitutes mock counts, a fixture department, or a fixture identity.

The existing `vektor-interview-dashboard` custom element remains in the content region. This preserves its current loading, empty, failure, scheduling, and feedback states and its same-origin SDK bridge. Its dashboard root becomes a section rather than a second nested `main` landmark; its commands, messages, update, and candidate response flow remain unchanged.

## Accessibility contract

- The document remains Norwegian at the feature boundary.
- There is one primary `main` landmark and one labelled primary navigation landmark.
- All disclosures use native buttons, visible focus, `aria-expanded`, and `aria-controls`.
- Active links use `aria-current=page`.
- Profile images have the authenticated name as alternative text; a text initial is used only when the decoded profile has no image.
- Hidden menus use the native `hidden` state.
- The mobile overlay is a labelled button, not a pointer-only surface.
- Sign-out remains a native POST form.
- Motion is short and disabled under `prefers-reduced-motion`.

## Frozen scope holds

These are authority gaps. This slice records them and does not guess around them.

1. **Per-route access rules.** Legacy `nav_link.html.twig` calls database-backed `has_access_to(route)`. The current profile and SDK expose a role string but no decoded route-capability set. This slice can enforce the explicit Twig role conditions only. It cannot claim parity for administrator-edited access rules.
2. **Unavailable native routes.** Stand, Timeplan, Hovedstyret, Brukergruppesamling, Arrangementer, Undersøkelser, Undersøkelsevarsler, Artikler, Changelog, Feedback, Access Control, Min side, and Mine vektorpartnere have no body in the verified React route inventory. They are not emitted as broken or guessed links.
3. **Active-assistant identity.** Symfony shows Mine vektorpartnere from `app.user.isActiveAssistant()`. The authenticated profile seam exposes no equivalent warrant, so the item stays absent.
4. **Dynamic legacy landing widgets.** The Symfony step-by-step phase, application graph, available surveys, detailed assigned-interview table, pending-receipt table, changelog, feedback form, flash messages, and survey popup have no equivalent loader or SDK projection in this slice. The three decoded dashboard counts do not close that parity gap.
5. **Homepage route identity.** Twig resolves `home` inside the Symfony router. The native dashboard only exposes `/` as its current home seam; no absolute legacy deployment origin is inferred.
6. **Image transformation.** Twig applies the legacy `profile_img_small` image filter. The native profile seam supplies only a public asset path, so the browser uses the decoded image without claiming transformed-byte parity.
7. **Theme.** The Symfony control panel has no theme toggle. React theme controls are therefore intentionally absent.

Closing a hold requires a separate accepted authority or service seam. A visual approximation, fixture, hard-coded permission list presented as complete access control, or invented destination does not close it.

## Definition of done

1. Spec 0046 is committed before implementation changes.
2. `/dashboard/foldkit` opts out of the React dashboard layout and mounts exactly one dashboard custom element.
3. Owner disabled returns `404`; missing auth redirects through the existing auth seam; assistant-only role returns `403`.
4. Both server projection and browser custom-element input are runtime decoded.
5. No production branch returns fixture identity or fixture summary data.
6. Foldkit Model/Message/Update/View owns disclosure, mobile, active-path, and rendering state.
7. Desktop and mobile controls are semantic, labelled, keyboard operable, and visibly focused.
8. Reachable native routes use current route-inventory destinations and Twig labels/order.
9. The existing interview program remains reachable and its candidate route is unchanged.
10. The implementation adds no dependency, backend/API/database change, React state/effect, Radix primitive, duplicate client, placeholder link, or TODO.

## Falsifiers

This contract is false if any condition occurs:

- the implementation copies the React dashboard grouping or theme behavior as visual authority;
- a user, role, count, department, image, or permission is produced from a production fixture or fallback;
- an undecoded loader attribute reaches a ready Model;
- React `useState`, `useEffect`, or another React store owns a dashboard interaction;
- a disclosure or mobile control mutates DOM state outside Update;
- an assistant-only identity can render the control panel;
- team-member navigation hides Team or Økonomi merely because the user is not a team leader;
- a team member sees Intervjuskjema, Attester, Teaminteresse, or Linjer;
- a held destination is emitted as `#`, an invented path, or a broken native route;
- active navigation lacks `aria-current` or does not close the mobile sidebar after selection;
- an off-canvas closed sidebar remains keyboard focusable;
- the page contains two primary `main` landmarks;
- sign-out becomes a GET-only affordance or bypasses `/logout`;
- the Foldkit interview command/update journey is rewritten rather than composed;
- a held legacy widget is presented as parity evidence;
- the source contains a placeholder, TODO, production fixture identity, or silent malformed-input fallback.
