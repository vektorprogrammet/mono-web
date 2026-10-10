[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard/app/foldkit/dashboard

This folder is not a bounded context. The application shell: navigation and the routes to each context page.
The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.

## Entry points

No `exports` entry of [apps/dashboard/package.json](../../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Keyboard ownership

Navigation Escape dismissal belongs to the sidebar and the mobile toggle and overlay,
not the content-bearing shell or main column. The sidebar keeps mobile, profile, then
admission return-focus precedence. Mobile controls consume Escape only while mobile
navigation is open. Other keys and closed navigation fall through.

Recruitment and scheduling are independently embedded programs under main. Their
native Dialog resources own initial focus, Tab trapping, topmost Escape, and opener
return focus; shell navigation must not prevent those events. Keep dialog defaults
and child message/command lifting unchanged when repairing shell keyboard behavior.
The shell Scene and DOM regressions live in `view.test.ts` and `keyboard.test.ts`.
