# Vektorprogrammet — live AccessRule policy snapshot (2026-08-10)

Captured from production `vektorprogrammet.no/kontrollpanel/admin/accessrules` (the legacy monolith, source of truth for authorization today). This is the F3 ground truth: the AccessRule table is DB-resident and unauditable from the repo, so it is snapshotted here. **229 rules.** The per-user grant column is REDACTED (volunteer PII); only counts are kept.

## Structure

| Metric | Count |
|---|---|
| Total rules | 229 |
| Routing-style (`METHOD /path`) | 223 |
| Resource-name style (`checkAccess('name')`) | 6 (5 real + header) |
| Empty (no role/team/user → grants everyone = **public whitelist**) | 62 |
| Role-only scoped | 72 |
| Team-scoped | 92 |
| **Per-user grants** | **3** |

Role usage: Admin 96 · Teamleder ~93 · Teammedlem ~72 · Bruker ~18.

## The `survey_admin` resource (F3 focus)

Confidential-survey access IS scoped in production — not open:

| Rule | Roles | Teams |
|---|---|---|
| Admin can see confidential surveys | Admin | — |
| Can see confidential surveys | Teamleder;Admin | Styret;Evaluering;Rekruttering |
| Survey admin for evaluering | (any) | Evaluering;Hovedstyret |

**F3 implication**: mono-web must migrate/seed these rows AND default to DENY. The legacy 'empty rule = public' whitelist (62 rules) is the ONLY intended everyone-grant; every other route is role/team scoped.

## Full inventory (user column redacted)

| Name | Resource | Roles | Teams | Per-user |
|---|---|---|---|---|
| About | `GET /omvektor` |  |  |  |
| About | `GET /om` |  |  |  |
| Access Rule Copy | `GET /kontrollpanel/admin/accessrules/copy/{id}` | Admin |  |  |
| Access Rule Copy | `POST /kontrollpanel/admin/accessrules/copy/{id}` | Admin |  |  |
| Access Rule Create | `POST /kontrollpanel/admin/accessrules/create` | Admin |  |  |
| Access Rule Delete | `POST /kontrollpanel/admin/accessrules/delete/{id}` | Admin |  |  |
| Existing Admission | `GET /eksisterendeopptak` |  |  |  |
| Opptaksperiode Admin | `GET /kontrollpanel/opptaksperiode` |  | Styret;Rekruttering;Hovedstyret |  |
| Opptaksperiode Admin Create | `GET /kontrollpanel/opptaksperiode/opprett/{id}` |  | Styret;Rekruttering;Hovedstyret |  |
| Opptaksperiode Admin Create | `POST /kontrollpanel/opptaksperiode/opprett/{id}` |  | Styret;Rekruttering;Hovedstyret |  |
| Opptaksperiode Admin Delete | `GET /kontrollpanel/opptaksperiode/slett/{id}` |  | Styret;Rekruttering;Hovedstyret |  |
| Opptaksperiode Admin Delete | `POST /kontrollpanel/opptaksperiode/slett/{id}` |  | Styret;Rekruttering;Hovedstyret |  |
| Opptaksperiode Admin Edit | `GET /kontrollpanel/opptaksperiode/update/{id}` |  | Styret;Rekruttering;Hovedstyret |  |
| Assistants City | `GET /opptak/{city}` |  |  |  |
| Assistants By City | `GET /avdeling/{city}` |  |  |  |
| Admission Notification | `GET /opptak/notification` |  |  |  |
| Admission notification unsubscribe | `GET /opptak/notification/unsubscribe/{code}` |  |  |  |
| Skolekoordinering kan se intervjuscores | `GET /kontrollpanel/opptak` | Teammedlem;Teamleder;Admin | Styret;Evaluering;Rekruttering;Skolekoordinering;Hovedstyret |  |
| Assistants | `GET /opptak` |  |  |  |
| Assistants ShortName | `GET app_assistant_admissionactionbyshortname` |  |  |  |
| Assistants ShortName | `GET app_assistant_admissionactionbyshortname_1` |  |  |  |
| Assistants Department | `GET app_assistant_admissionactionbyshortname_2` |  |  |  |
| My Page | `GET app_client_index_1` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Admission Confirmation | `GET /assistenter/opptak/bekreftelse` |  |  |  |
| skolekord, se poeng | `GET /kontrollpanel/opptak/intervjuet` | Teammedlem;Teamleder;Bruker | Styret;Evaluering;Rekruttering;Skolekoordinering;Sponsor;Økonomi;Ekspansjon;IT;Profilering;Sponsorteam;Sosialt;Hovedstyret |  |
| News For Department | `GET /nyheter/{department}` |  |  |  |
| Nyhet | `GET /nyhet/{slug}` |  |  |  |
| Assistanthistory delete | `POST /kontrollpanel/deltakerhistorikk/slett/{id}` | Teammedlem;Teamleder;Admin | Styret;Skolekoordinering;Hovedstyret |  |
| Assistanthistory edit | `GET /kontrollpanel/deltakerhistorikk/rediger/{id}` | Teammedlem;Teamleder;Admin | Styret;Skolekoordinering;Hovedstyret |  |
| Assistanthistory edit | `POST /kontrollpanel/deltakerhistorikk/rediger/{id}` | Teammedlem;Teamleder;Admin | Styret;Skolekoordinering;Hovedstyret |  |
| Assistants | `GET /assistenter/{id}` |  |  |  |
| Team page | `GET /styretogteam` |  |  |  |
| Bedrifter | `GET /bedrifter` |  |  |  |
| Attests | `GET /kontrollpanel/attest/{id}` | Teamleder | Styret;Skolekoordinering;Hovedstyret |  |
| Attests Create Signature | `POST /kontrollpanel/attest/{id}` | Teamleder | Styret;Skolekoordinering;Hovedstyret |  |
| Changelog create GET | `GET /kontrollpanel/changelog/create` |  | IT |  |
| Changelog create POST | `POST /kontrollpanel/changelog/create` |  | IT |  |
| Changelog delete | `POST /kontrollpanel/changelog/delete/{id}` |  | IT |  |
| Changelog edit | `GET /kontrollpanel/changelog/edit/{id}` |  | IT |  |
| Changelog edit POST | `POST /kontrollpanel/changelog/edit/{id}` |  | IT |  |
| Confirmation | `GET /bekreftelse` |  |  |  |
| Contact | `GET /kontakt` |  |  |  |
| Contact | `POST /kontakt` |  |  |  |
| Contact Department | `GET /kontakt/avdeling/{id}` |  |  |  |
| Contact Department | `POST /kontakt/avdeling/{id}` |  |  |  |
| Read/Edit Mode | `GET /profil/mode/{mode}` | Admin |  |  |
| Read/Edit Mode | `POST /profil/mode/{mode}` | Admin |  |  |
| ControlPanel Show | `GET /kontrollpanel` | Teammedlem;Teamleder |  |  |
| Field of Studies Create | `GET /kontrollpanel/linje` |  | Styret;Hovedstyret |  |
| Field of Studies Create | `POST /kontrollpanel/linje` |  | Styret;Hovedstyret |  |
| Create todo list item | `GET create_todoItem` |  | Styret;Hovedstyret |  |
| Create todo list item | `POST create_todoItem` |  | Styret;Hovedstyret |  |
| Delete todo list item | `GET delete_todo_item` |  | Styret;Hovedstyret |  |
| Delete todo list item | `POST delete_todo_item` |  | Styret;Hovedstyret |  |
| Department Create | `GET /kontrollpanel/avdelingadmin/opprett` |  | Hovedstyret |  |
| Department Create | `POST /kontrollpanel/avdelingadmin/opprett` |  | Hovedstyret |  |
| Department Delete | `GET /kontrollpanel/avdelingadmin/slett/{id}` | Admin |  |  |
| Department Delete | `POST /kontrollpanel/avdelingadmin/slett/{id}` | Admin |  |  |
| Departments | `GET /kontrollpanel/avdelingadmin` |  | Styret;Hovedstyret |  |
| Department Update | `GET /kontrollpanel/avdelingadmin/update/{id}` |  | Styret;Hovedstyret |  |
| Department Update | `POST /kontrollpanel/avdelingadmin/update/{id}` |  | Styret;Hovedstyret |  |
| Field of Studies Update | `GET /kontrollpanel/linje/{id}` |  | Styret;Hovedstyret |  |
| Field of Studies Update | `POST /kontrollpanel/linje/{id}` |  | Styret;Hovedstyret |  |
| Modify todo list item | `GET edit_todoItem` |  | Styret;Hovedstyret |  |
| Modify todo item | `POST edit_todoItem` |  | Styret;Hovedstyret |  |
| Hovedstyret Add member | `GET /kontrollpanel/hovedstyret/nytt_medlem/{id}` |  | Hovedstyret |  |
| Hovedstyret Add member | `POST /kontrollpanel/hovedstyret/nytt_medlem/{id}` |  | Hovedstyret |  |
| Executive Board (public) | `GET /hovedstyret` |  |  |  |
| Hovedstyret Show | `GET /kontrollpanel/hovedstyret` |  | Hovedstyret |  |
| Hovedstyret Edit | `GET /kontrollpanel/hovedstyret/oppdater` |  | Hovedstyret |  |
| Hovedstyret Edit | `POST /kontrollpanel/hovedstyret/oppdater` |  | Hovedstyret |  |
| FAQ | `GET /faq` |  |  |  |
| Feedback delete | `POST /kontrollpanel/feedback/delete/{id}` |  | IT |  |
| Feedback list | `GET /kontrollpanel/feedback/list` |  | IT |  |
| Get Feedback list | `GET /kontrollpanel/feedback/list` |  | IT |  |
| Feedback show | `GET /kontrollpanel/feedback/show/{id}` |  | IT |  |
| Get Feedback specific | `GET /kontrollpanel/feedback/show/{id}` |  | IT |  |
| Github Webhook | `POST /webhook/github` |  |  |  |
| Home | `GET /` |  |  |  |
| TeamInterest ShortName (public) | `GET /interesseliste/{shortName}` |  |  |  |
| TeamInterest (public) | `GET /interesseliste/{id}` |  |  |  |
| Interview Accept | `GET /intervju/aksepter/{responseCode}` |  |  |  |
| Inteview Cancel | `GET /intervju/kanseller/tilbakemelding/{responseCode}` |  |  |  |
| Interview NewTime | `GET /intervju/nytid/{responseCode}` |  |  |  |
| Interview Respond (public) | `GET /intervju/{responseCode}` |  |  |  |
| Interview Schema Show | `GET /kontrollpanel/intervju/skjema` | Teammedlem;Teamleder;Admin | Styret;Rekruttering;Skolekoordinering;Hovedstyret |  |
| Interview Schema Create | `GET /kontrollpanel/intervju/skjema/opprett` | Teammedlem;Teamleder;Admin | Styret;Rekruttering;Skolekoordinering;Hovedstyret |  |
| Interview Schema Create | `POST /kontrollpanel/intervju/skjema/opprett` | Teammedlem;Teamleder;Admin | Styret;Rekruttering;Skolekoordinering;Hovedstyret |  |
| Interview Schema Delete | `GET /kontrollpanel/intervju/skjema/slett/{id}` | Admin |  |  |
| Interview Schema Delete | `POST /kontrollpanel/intervju/skjema/slett/{id}` | Admin |  |  |
| Interview Schema Edit | `GET /kontrollpanel/intervju/skjema/{id}` | Teammedlem;Teamleder;Admin | Styret;Rekruttering;Skolekoordinering;Hovedstyret |  |
| Interview Schema Edit | `POST /kontrollpanel/intervju/skjema/{id}` | Teammedlem;Teamleder;Admin | Styret;Rekruttering;Skolekoordinering;Hovedstyret |  |
| skolekort tilgang til intervju | `GET /kontrollpanel/intervju/vis/{id}` | Teammedlem;Teamleder;Bruker | Styret;Evaluering;Rekruttering;Skolekoordinering;Sponsor;Økonomi;Ekspansjon;IT;Profilering;Sponsorteam;Sosialt;Hovedstyret |  |
| Image cache | `GET /media/cache/resolve/{filter}/{path}` |  |  |  |
| Image cache | `GET /media/cache/resolve/{filter}/rc/{hash}/{path}` |  |  |  |
| Login Check | `GET /login_check` |  |  |  |
| Login Check | `POST /login_check` |  |  |  |
| Login redirect | `GET /login/redirect` |  |  |  |
| Login | `GET /login` |  |  |  |
| Logout | `GET /logout` |  |  |  |
| My page | `GET /min-side` | Teammedlem;Teamleder;Bruker |  |  |
| Partners | `GET /profil/partnere` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| News | `GET /nyheter` |  |  |  |
| Article | `GET /artikkel/{slug}` |  |  |  |
| Profile | `GET /profile` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| User SetActive | `POST /profile/aktiv/{id}` | Admin |  |  |
| User Activation | `GET /bruker/aktiver/{newUserCode}` |  |  |  |
| Attests Download | `GET /profile/attest/{id}` | Teamleder | Styret;Skolekoordinering;Hovedstyret |  |
| User Change Role | `POST /profile/rolle/endre/{id}` | Admin |  |  |
| User SetDeactive | `GET /profile/deaktiv/{id}` | Admin |  |  |
| User SetDeactive | `POST /profile/deaktiv/{id}` | Admin |  |  |
| Profile Edit | `GET /profil/rediger` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Profile Edit | `POST /profil/rediger` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Password Edit | `GET /profil/rediger/passord/` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Password Edit | `POST /profil/rediger/passord/` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Profile Image | `GET /profil/rediger/profilbilde/{id}` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Profile Image | `POST /profil/rediger/profilbilde/{id}` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Profile Image Upload | `POST /profil/rediger/profilbilde/upload/{id}` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Public Files | `GET /Offentlige filer/{file_path}` |  |  |  |
| Receipts Edit | `GET /kontrollpanel/utlegg/rediger/{receipt}` | Teammedlem;Teamleder | Økonomi;Hovedstyret |  |
| Receipts Edit | `POST /kontrollpanel/utlegg/rediger/{receipt}` | Teammedlem;Teamleder | Økonomi;Hovedstyret |  |
| Receipt | `GET /utlegg` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Receipt | `POST /utlegg` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Receipt Delete | `POST /utlegg/slett/{receipt}` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Receipt Edit | `GET /utlegg/rediger/{receipt}` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Receipt Edit | `POST /utlegg/rediger/{receipt}` | Teammedlem;Teamleder;Bruker;Admin |  |  |
| Jan Haakon can change receipt status | `POST /kontrollpanel/utlegg/status/{receipt}` |  |  | 1 named user(s) [redacted] |
| Receipts Change Status | `POST /kontrollpanel/utlegg/status/{receipt}` | Teammedlem;Teamleder | Økonomi;Hovedstyret |  |
| Youlduz can change receipt status | `POST /kontrollpanel/utlegg/status/{receipt}` |  |  | 1 named user(s) [redacted] |
| Receipts Show | `GET /kontrollpanel/utlegg` | Teammedlem;Teamleder | Økonomi;Hovedstyret |  |
| Receipts Show national | `GET /kontrollpanel/utlegg` |  |  | 5 named user(s) [redacted] |
| Reset Password | `GET /resetpassord` |  |  |  |
| Reset Password | `POST /resetpassord` |  |  |  |
| Reset password sent | `GET /resetsendt` |  |  |  |
| Timeplan | `GET /kontrollpanel/skole/timeplan/` | Teammedlem;Teamleder | Styret;Skolekoordinering;Hovedstyret |  |
| Semester Delete | `GET /kontrollpanel/skoleadmin/slett/{id}` | Admin |  |  |
| Semester Delete | `POST /kontrollpanel/skoleadmin/slett/{id}` | Admin |  |  |
| Schools (public) | `GET /skoler` |  |  |  |
| Semester Admin Other Departments | `GET semester_show_by_department` |  | Hovedstyret |  |
| Semester Admin Edit | `POST semester_update` |  | Styret;Rekruttering;Hovedstyret |  |
| Field of Studies | `GET /kontrollpanel/linjer` |  | Styret;Hovedstyret |  |
| Signature | `GET /signatures/{imageName}` | Teammedlem;Teamleder;Admin |  |  |
| Create Event | `GET /kontrollpanel/arrangement/opprett` | Teammedlem;Teamleder;Admin |  |  |
| Create Event | `POST /kontrollpanel/arrangement/opprett` | Teammedlem;Teamleder;Admin |  |  |
| Delete Event | `POST /kontrollpanel/arrangement/slett/{id}` | Teammedlem;Teamleder;Admin |  |  |
| Edit Event | `GET /kontrollpanel/arrangement/endre/{id}` | Teammedlem;Teamleder;Admin |  |  |
| Edit Event | `POST /kontrollpanel/arrangement/endre/{id}` | Teammedlem;Teamleder;Admin |  |  |
| Profile specific | `GET /profile/{id}` |  |  |  |
| Sponsors Create | `GET /kontrollpanel/sponsor/create` | Teammedlem;Teamleder | Styret;Sponsor;Sponsorteam;Hovedstyret |  |
| Sponsors Create | `POST /kontrollpanel/sponsor/create` | Teammedlem;Teamleder | Styret;Sponsor;Sponsorteam;Hovedstyret |  |
| Sponors Delete | `POST /kontrollpanel/sponsor/delete/{id}` | Teammedlem;Teamleder | Styret;Sponsor;Sponsorteam;Hovedstyret |  |
| Sponsors Edit | `GET /kontrollpanel/sponsor/edit/{id}` | Teammedlem;Teamleder | Styret;Sponsor;Sponsorteam;Hovedstyret |  |
| Sponsors Edit | `POST /kontrollpanel/sponsor/edit/{id}` | Teammedlem;Teamleder | Styret;Sponsor;Sponsorteam;Hovedstyret |  |
| Sponsors Show | `GET /kontrollpanel/sponsorer` | Teammedlem;Teamleder | Styret;Sponsor;Sponsorteam;Hovedstyret |  |
| SSO Login | `POST /sso/login` |  |  |  |
| Stand | `GET /kontrollpanel/stand` | Teammedlem;Teamleder;Admin |  |  |
| Students | `GET /studenter` |  |  |  |
| Copy survey | `POST /kontrollpanel/undersokelse/kopier/{id}` | Teammedlem;Teamleder;Admin | Styret;Evaluering;Skolekoordinering;IT;Rekruttering |  |
| Create survey | `GET /kontrollpanel/undersokelse/opprett` | Teamleder | Styret;Evaluering;Hovedstyret |  |
| Edit survey | `GET /kontrollpanel/undersokelse/endre/{id}` | Teammedlem;Teamleder;Admin | Evaluering;IT;Rekruttering |  |
| Edit survey | `POST /kontrollpanel/undersokelse/endre/{id}` | Teammedlem;Teamleder;Admin | Evaluering;IT;Rekruttering |  |
| Create survey notification | `GET /kontrollpanel/undersokelsevarsel/opprett` | Teammedlem;Teamleder;Admin | IT |  |
| Create survey notification | `POST /kontrollpanel/undersokelsevarsel/opprett` | Teammedlem;Teamleder;Admin | IT |  |
| Send survey notification | `DELETE /kontrollpanel/undersokelsevarsel/slett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Delete survey | `POST /kontrollpanel/undersokelsevarsel/slett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Send survey notification | `POST /kontrollpanel/undersokelsevarsel/slett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Edit survey notification | `GET /kontrollpanel/undersokelsevarsel/rediger/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Edit survey notification | `POST /kontrollpanel/undersokelsevarsel/rediger/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Send survey notification | `POST /kontrollpanel/undersokelsevarsel/send/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Create survey notification | `GET /kontrollpanel/undersokelsevarsel` | Teammedlem;Teamleder;Admin | IT |  |
| Create survey notification | `POST /kontrollpanel/undersokelsevarsel` | Teammedlem;Teamleder;Admin | IT |  |
| Survey | `GET /undersokelse/{id}` |  |  |  |
| Survey | `POST /undersokelse/{id}` |  |  |  |
| Teachers | `GET /laerere` |  |  |  |
| Team Page | `GET /team` |  |  |  |
| Team Application | `GET /team/application/{id}` |  |  |  |
| Team Application | `POST /team/application/{id}` |  |  |  |
| Team Application Confirmation | `GET /team/application/bekreftelse/{team_name}` |  |  |  |
| Team Application Delete | `GET /kontrollpanel/team/applications/slett/{id}` | Teamleder;Admin |  |  |
| Team Application Delete | `POST /kontrollpanel/team/applications/slett/{id}` | Teamleder;Admin |  |  |
| Team Application | `GET /kontrollpanel/team/application/{id}` | Teammedlem;Teamleder;Admin |  |  |
| Team Applications | `GET /kontrollpanel/team/applications/{id}` | Teammedlem;Teamleder;Admin |  |  |
| Team Interest | `GET /teaminteresse/{id}` |  |  |  |
| Team Interest | `POST /teaminteresse/{id}` |  |  |  |
| Team Specific | `GET /team/{id}` |  |  |  |
| Team Specific | `GET /team/{departmentCity}/{teamName}` |  |  |  |
| It | `GET /it` |  |  |  |
| Team New Member | `GET /kontrollpanel/teamadmin/team/nytt_medlem/{id}` | Teamleder;Admin |  |  |
| Team New Member | `POST /kontrollpanel/teamadmin/team/nytt_medlem/{id}` | Teamleder;Admin |  |  |
| Team Positions Create | `GET /kontrollpanel/teamadmin/opprett/stilling` | Teamleder;Admin |  |  |
| Team Positions Create | `POST /kontrollpanel/teamadmin/opprett/stilling` | Teamleder;Admin |  |  |
| Team Create | `GET /kontrollpanel/teamadmin/avdeling/opprett/{id}` | Teamleder;Admin |  |  |
| Team Create | `POST /kontrollpanel/teamadmin/avdeling/opprett/{id}` | Teamleder;Admin |  |  |
| Team Delete | `GET /kontrollpanel/teamadmin/slett/{id}` | Admin |  |  |
| Team Delete | `POST /kontrollpanel/teamadmin/slett/{id}` | Admin |  |  |
| Team Positions Update | `GET /kontrollpanel/teamadmin/rediger/stilling/{id}` | Admin |  |  |
| Team Positions Update | `POST /kontrollpanel/teamadmin/rediger/stilling/{id}` | Teamleder;Admin |  |  |
| Team Positions Delete | `GET /kontrollpanel/teamadmin/stilling/slett/{id}` | Admin |  |  |
| Team Positions Delete | `POST /kontrollpanel/teamadmin/stilling/slett/{id}` | Admin |  |  |
| Team Member Delete | `GET /kontrollpanel/teamadmin/team/slett/bruker/{id}` | Admin |  |  |
| Team Member Delete | `POST /kontrollpanel/teamadmin/team/slett/bruker/{id}` | Admin |  |  |
| Teams | `GET /kontrollpanel/team/avdeling/{id}` | Teamleder;Admin |  |  |
| Team Positions | `GET /kontrollpanel/teamadmin/stillinger` | Teamleder;Admin |  |  |
| Team show | `GET /kontrollpanel/teamadmin/team/{id}` | Teammedlem;Teamleder;Admin |  |  |
| Team Edit | `GET /kontrollpanel/teamadmin/update/{id}` | Teamleder;Admin |  |  |
| Team Edit | `POST /kontrollpanel/teamadmin/update/{id}` | Teamleder;Admin |  |  |
| Team Member Update | `GET /kontrollpanel/teamadmin/oppdater/teamhistorie/{id}` | Teamleder;Admin |  |  |
| Team Member Update | `POST /kontrollpanel/teamadmin/oppdater/teamhistorie/{id}` | Teamleder;Admin |  |  |
| View todo list | `GET todo_list` | Teammedlem;Teamleder;Admin |  |  |
| Check off todo list item | `GET toggle_isCompleted` |  | Styret;Hovedstyret |  |
| Check off todo list item | `GET toggle_isCompleted` | Teamleder |  |  |
| Check off todo list item | `GET toggle_isCompleted` | Teammedlem |  |  |
| Check off todo list item | `POST toggle_isCompleted` | Teamleder |  |  |
| Check off todo list item | `POST toggle_isCompleted` |  | Styret;Hovedstyret |  |
| Check off todo list item | `POST toggle_isCompleted` | Teammedlem |  |  |
| Static Content Update | `GET /updatestaticcontent` |  | Hovedstyret |  |
| Create user group collection | `GET /kontrollpanel/brukergruppesamling/opprett` | Teammedlem;Teamleder;Admin | IT |  |
| Create user group collection | `POST /kontrollpanel/brukergruppesamling/opprett` | Teammedlem;Teamleder;Admin | IT |  |
| Delete user group collection | `DELETE /kontrollpanel/brukergruppesamling/slett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Delete user group collection | `POST /kontrollpanel/brukergruppesamling/slett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Create user group collection | `GET /kontrollpanel/brukergruppesamling/opprett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| Create user group collection | `POST /kontrollpanel/brukergruppesamling/opprett/{id}` | Teammedlem;Teamleder;Admin | IT |  |
| See user group collections | `GET /kontrollpanel/brukergruppesamling` | Teammedlem;Teamleder;Admin |  |  |
| Name | `Resource` | Roles | Teams | named user(s) [redacted] |
| Navigate to other departments | `all_departments` |  | Evaluering;Hovedstyret |  |
| Navigate to other departments | `all_departments` | Teamleder;Admin | IT |  |
| Admin can see confidential surveys | `survey_admin` | Admin |  |  |
| Can see confidential surveys | `survey_admin` | Teamleder;Admin | Styret;Evaluering;Rekruttering |  |
| Survey admin for evaluering | `survey_admin` |  | Evaluering;Hovedstyret |  |
