import { Predicate, DateTime, Effect, Schema as S, Option, Match, Struct, flow } from "effect";

import { Command, Runtime, Update } from "foldkit";
import { taggedStruct } from "foldkit/schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import { AppointmentManagement, OrganizationLifecycleCommand, IdempotencyKey } from "@vektorprogrammet/http-api";
import { createEffectClient } from "@vektorprogrammet/sdk/effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";
import { nativeProblemFrom } from "../../lib/native-problem";
import "./styles.css";

const Field = S.Literals(["personId","unit","position","startAt","endAt","reason","boardName","accountPersonId","classifiedTeam","unitKind","teamScope","recognisedDepartment"]);

const Action = S.Literals(["Appoint","ReviseAppointment","EndAppointment","SuspendAppointment","ReinstateAppointment","CreateNationalBoard","DisableAccount","EnableAccount","ClassifyTeam","RecogniseDepartment","WithdrawRecognition"]);

const Operation = S.TaggedUnion({
  Ready: {},
  Loading: { command: S.NullOr(OrganizationLifecycleCommand) },
  Saving: { command: OrganizationLifecycleCommand },
  Uncertain: { command: OrganizationLifecycleCommand },
});

const Notice = S.TaggedUnion({ None: {}, Success: { message: S.String }, Failure: { message: S.String } });

const Model = S.Struct({
  snapshot:S.NullOr(AppointmentManagement), requestId:S.Int, operation:Operation, notice:Notice,
  commandId:S.String, selected:S.String, personId:S.String, unit:S.String, position:S.String,
  startAt:S.String,endAt:S.String,leadership:S.Boolean,reason:S.String,boardName:S.String,accountPersonId:S.String,
  classifiedTeam:S.String,unitKind:S.String,teamScope:S.String,recognisedDepartment:S.String,
});

type Model = typeof Model.Type;

const ChangedField=taggedStruct("ChangedAppointmentField",{field:Field,value:S.String});

const Selected=taggedStruct("SelectedAppointment",{id:S.String});

const Toggled=taggedStruct("ToggledAppointmentLeadership", {});

const Submitted=taggedStruct("SubmittedOrganizationCommand",{action:Action});

const Refreshed=taggedStruct("RefreshedAppointmentManagement", {});

const Loaded=taggedStruct("LoadedAppointmentManagement",{requestId:S.Int,snapshot:AppointmentManagement,commandId:S.String,now:S.String});

const LoadFailed=taggedStruct("FailedAppointmentLoad",{requestId:S.Int,message:S.String});

const Saved=taggedStruct("SavedOrganizationCommand",{requestId:S.Int,commandId:S.String});

const Failed=taggedStruct("FailedOrganizationCommand",{requestId:S.Int,message:S.String,definitive:S.Boolean,commandId:S.String});

const Retried=taggedStruct("RetriedOrganizationCommand", {});

const Message=S.Union([ChangedField,Selected,Toggled,Submitted,Refreshed,Loaded,LoadFailed,Saved,Failed,Retried]);

type Message=typeof Message.Type;

const failureMessage=flow(nativeProblemFrom, (decodedProblem): string => {
  const encoded=decodedProblem?.code;

  if (encoded?.includes("precondition.failed")) return "Oppføringen er endret av en annen bruker. Hent oppdatert oversikt før du prøver igjen.";

  if (encoded?.includes("authority.denied")) return "Du har ikke tilgang til denne handlingen. Du kan ikke deaktivere deg selv eller den siste administratoren.";

  if (encoded?.includes("credential.")) return "Økten er ikke lenger gyldig. Logg inn på nytt.";

  if (encoded?.includes("validation.failed")) return "Kontroller tidsrommet og handlingen. En avdeling har høyst ett styre, og et styre arbeider bare for sin avdeling.";

  if (encoded?.includes("idempotency.digest-conflict")) return "Kommandoen er allerede brukt med andre verdier. Hent oppdatert oversikt.";

  return "Handlingen kunne ikke fullføres. Prøv samme handling igjen, eller hent oppdatert oversikt.";
});

const view=(model:Model,h:HtmlBuilder<Message>):Html => {
  const busy=Predicate.isTagged(model.operation, "Loading")||Predicate.isTagged(model.operation, "Saving");
  const blocked=!Predicate.isTagged(model.operation, "Ready");
  const button=(label:string,message:Message,disabled=blocked)=>h.button([h.Type("button"),h.Disabled(disabled),h.OnClick(message)],[label]);
  const field=(key:typeof Field.Type,label:string,type="text")=>h.label([h.Class("organization-management__field")],[label,h.input([h.Type(type),h.Value(model[key]),h.Disabled(blocked),h.Maxlength(250),h.OnInput(value=>ChangedField({field:key,value}))])]);
  const select=(key:typeof Field.Type,label:string,options:ReadonlyArray<{value:string;label:string}>)=>h.label([h.Class("organization-management__field")],[label,h.select([h.Value(model[key]),h.Disabled(blocked),h.OnChange(value=>ChangedField({field:key,value}))],[h.option([h.Value("")],["Velg"]),...options.map(option=>h.option([h.Value(option.value)],[option.label]))])]);
  const snapshot=model.snapshot;
  const current=snapshot?.appointments.find(row=>row.appointmentId===model.selected);
  const selectedUnit=snapshot?.units.find(unit=>`${unit.target.kind}:${unit.target.id}`===model.unit);
  const names=new Map(snapshot?.people.map(person=>[person.personId,person.name]));
  const unitName=(kind:string,id:string)=>snapshot?.units.find(unit=>unit.target.kind===kind&&unit.target.id===id)?.name ?? id;
  const stateNames={Current:"Gjeldende",Future:"Fremtidig",Ended:"Avsluttet",Suspended:"Suspendert"};

  return h.section([h.Class("organization-catalog organization-management"),h.AriaBusy(busy)],[
    h.h1([],["Verv og kontotilgang"]),
    h.p([],["Et verv gir ansvar i én enhet. Avslutning av verv endrer ikke kontotilgang, andre verv, frivilligtilknytning eller skoleplassering."]),
    h.p([h.Role(Predicate.isTagged(model.notice, "Failure")?"alert":"status"),h.AriaLive("polite")],[busy?"Arbeider …":Notice.guards.None(model.notice)?"":model.notice.message]),
    button("Hent oppdatert oversikt",Refreshed(),busy),
    Predicate.isTagged(model.operation, "Uncertain")?button("Prøv nøyaktig samme handling igjen",Retried(),false):h.empty,
    snapshot===null?h.empty:h.div([], [
      h.h2([],["Verv"]),
      h.div([h.Class("organization-catalog__table-scroll"),h.Tabindex(0),h.AriaLabel("Verv, bla sidelengs ved behov")],[h.table([h.Class("organization-catalog__table")],[
        h.caption([],["Gjeldende, fremtidige, avsluttede og suspenderte verv"]),
        h.thead([],[h.tr([],["Person","Enhet og omfang","Stilling","Tilstand","Tidsrom","Revisjon","Handling"].map(label=>h.th([h.Scope("col")],[label])))]),
        h.tbody([],snapshot.appointments.map(row=>h.tr([h.Key(row.appointmentId)], [
          h.th([h.Scope("row")],[names.get(row.personId)??row.personId]),
          h.td([],[`${unitName(row.target.kind,row.target.id)} · ${row.target.kind==="NationalBoard"?"Nasjonalt":"Lokalt"}`]),
          h.td([],[`${row.position??"Stilling ikke oppgitt"}${row.leadership?" · Lederansvar":""}`]),
          h.td([],[`${stateNames[row.state]??row.state}${row.suspended?" · Suspendert":""}`]),h.td([],[`${row.startAt} – ${row.endAt??"uten sluttdato"}`]),h.td([],[String(row.revision)]),
          h.td([],[button(`Endre verv for ${names.get(row.personId)??row.personId}`,Selected({id:row.appointmentId}))]),
        ]))),
      ])]),
      h.h2([],[current?"Endre valgt verv":"Opprett verv"]),
      current?h.p([],[`${names.get(current.personId)??current.personId} · ${unitName(current.target.kind,current.target.id)} · revisjon ${current.revision}. Person og enhet kan ikke endres.`]):h.empty,
      current?button("Nytt verv",Selected({id:""})):h.empty,
      h.div([h.Class("organization-management__grid")],[
        current?h.empty:select("personId","Person",snapshot.people.map(person=>({value:person.personId,label:person.name}))),
        current?h.empty:select("unit","Organisatorisk enhet",snapshot.units.map(unit=>({value:`${unit.target.kind}:${unit.target.id}`,label:`${unit.name} (${unit.target.kind==="NationalBoard"?"Nasjonalt styre":"Lokalt team"})`}))),
        field("position","Stilling (valgfritt)"),field("startAt","Start (UTC)","datetime-local"),field("endAt","Slutt (UTC, valgfritt)","datetime-local"),
        h.label([],[h.input([h.Type("checkbox"),h.Checked(model.leadership),h.Disabled(blocked),h.OnChange(()=>Toggled())]),selectedUnit?.target.kind==="NationalBoard"?"Leder av Hovedstyret":"Leder av enheten"]),
        h.p([],[selectedUnit?.target.kind==="NationalBoard"?"Lederen av Hovedstyret når alle avdelinger, men et verv gir aldri global administratortilgang.":"En teamleder handler innenfor teamet. Bare lederen av et selvstendig avdelingsstyre handler i hele avdelingen."]),
        field("reason","Begrunnelse for handlingen"),
      ]),
      h.div([h.Class("organization-management__actions")],[
        button(current?"Lagre verv":"Opprett verv",Submitted({action:current?"ReviseAppointment":"Appoint"})),
        current?button("Avslutt verv på angitt sluttdato",Submitted({action:"EndAppointment"})):h.empty,
        current?button(current.suspended?"Gjeninnsett verv":"Suspender verv",Submitted({action:current.suspended?"ReinstateAppointment":"SuspendAppointment"})):h.empty,
      ]),
      !snapshot.globalAdministrator?h.empty:h.section([], [
        h.h2([],["Nasjonale styrer"]),field("boardName","Navn på nasjonalt styre"),button("Opprett nasjonalt styre",Submitted({action:"CreateNationalBoard"})),
        h.h2([],["Native kontoer"]),h.p([],["Deaktivering sperrer innlogging og avslutter native økter og menneskelige OAuth-tilganger. Verv og tjenestehistorikk beholdes. Dette endrer ikke eksterne postkontoer eller tjenesteidentiteter."]),
        select("accountPersonId","Konto",snapshot.accounts.map(account=>({value:account.personId,label:`${names.get(account.personId)??account.personId} · ${account.disabled?"Deaktivert":"Aktiv"} · revisjon ${account.revision}`}))),
        h.div([h.Class("organization-management__actions")],[button("Deaktiver valgt konto",Submitted({action:"DisableAccount"})),button("Aktiver valgt konto",Submitted({action:"EnableAccount"}))]),
      ]),
      snapshot.governance===null?h.empty:h.section([], [
        h.h2([],["Organisasjonsstyring"]),
        h.p([],["Hovedstyret bestemmer hvilket team som er avdelingens styre, hvilke team som er nasjonale, og hvilke avdelinger som er selvstendige. Uten dette når ingen leder en avdeling."]),
        select("classifiedTeam","Team",snapshot.governance.teams.map(team=>({value:team.teamId,label:`${team.name} · ${team.unitKind==="DepartmentBoard"?"Avdelingsstyre":"Team"} · ${team.teamScope==="National"?"Nasjonalt":"Lokalt"} · revisjon ${team.revision}`}))),
        select("unitKind","Enhet",[{value:"Team",label:"Vanlig team"},{value:"DepartmentBoard",label:"Avdelingens styre"}]),
        select("teamScope","Omfang",[{value:"HomeDepartment",label:"Egen avdeling"},{value:"National",label:"Nasjonalt"}]),
        button("Lagre klassifisering",Submitted({action:"ClassifyTeam"})),
        select("recognisedDepartment","Avdeling",snapshot.governance.departments.map(department=>({value:department.departmentId,label:`${department.name} · ${department.independent?"Selvstendig":"Ikke selvstendig"} · revisjon ${department.revision}`}))),
        h.div([h.Class("organization-management__actions")],[button("Anerkjenn som selvstendig",Submitted({action:"RecogniseDepartment"})),button("Trekk tilbake selvstendighet",Submitted({action:"WithdrawRecognition"}))]),
      ]),
      h.h2([],["Historikk"]),h.ol([],snapshot.history.map(event=>h.li([], [
        `${event.occurredAt} · ${event.action} · ${names.get(event.actorPersonId)??event.actorPersonId} · ${event.reason} · ${event.subjectId}`,
      ]))),
    ]),
  ]);
};

const parseAppoint = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.Appoint.mapFields(Struct.omit(["_tag"])));

const parseReviseAppointment = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.ReviseAppointment.mapFields(Struct.omit(["_tag"])));

const parseEndAppointment = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.EndAppointment.mapFields(Struct.omit(["_tag"])));

const parseSuspendAppointment = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.SuspendAppointment.mapFields(Struct.omit(["_tag"])));

const parseReinstateAppointment = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.ReinstateAppointment.mapFields(Struct.omit(["_tag"])));

const parseCreateNationalBoard = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.CreateNationalBoard.mapFields(Struct.omit(["_tag"])));

const parseChangeAccountAccess = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.ChangeAccountAccess.mapFields(Struct.omit(["_tag"])));

const parseClassifyTeam = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.ClassifyTeam.mapFields(Struct.omit(["_tag"])));

const parseRecogniseDepartment = S.decodeUnknownOption(OrganizationLifecycleCommand.cases.RecogniseDepartment.mapFields(Struct.omit(["_tag"])));

export const embedAppointmentManagement=(container:HTMLElement):(()=>void)=>{
  const client=createEffectClient(resolveBrowserApiUrl(import.meta.env.VITE_API_URL,globalThis.location.origin));

  const Load=Command.define("LoadAppointmentManagement",{args:{requestId:S.Int},messages:[Loaded,LoadFailed],execute:({requestId})=>Effect.gen(function* () {
    const {body}=yield* client.organization.readAppointmentManagement();
    const now=DateTime.formatIso(yield* DateTime.now);

    return Loaded({requestId,snapshot:body,commandId:crypto.randomUUID(),now});
  }).pipe(Effect.catch(error=>Effect.succeed(LoadFailed({requestId,message:failureMessage(error)}))))});

  // The pinned HttpApi client distributes a union payload over whole requests.
  // Narrow only at this transport boundary; the domain owns all transitions.
  const execute=Effect.fn("organization.executeLifecycle")(function* (command:OrganizationLifecycleCommand) {
    const headers={"idempotency-key":IdempotencyKey.make(command.commandId)};

    return yield* Match.value(command).pipe(
Match.tag("Appoint", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("ReviseAppointment", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("EndAppointment", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("SuspendAppointment", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("ReinstateAppointment", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("CreateNationalBoard", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("ChangeAccountAccess", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("ClassifyTeam", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.tag("RecogniseDepartment", (command) => {return client.organization.executeLifecycle({headers,payload:command});}),
Match.exhaustive
);
  });

  const Save=Command.define("SaveOrganizationLifecycle",{args:{requestId:S.Int,command:OrganizationLifecycleCommand},messages:[Saved,Failed],execute:({requestId,command})=>execute(command).pipe(
    Effect.map(()=>Saved({requestId,commandId:crypto.randomUUID()})),
    Effect.catch(error=>{
      const problem=nativeProblemFrom(error);

      return Effect.succeed(Failed({requestId,message:failureMessage(error),definitive:(problem?.status??500)<500&&problem?.code!=="idempotency.in-flight",commandId:crypto.randomUUID()}));
    }),
  )});

  const update=(model:Model,message:Message):Update.Return<Model, Message>=>{
    return Match.value(message).pipe(
Match.tag("ChangedAppointmentField", (message) => {return !Predicate.isTagged(model.operation, "Ready")?({ model: model, commands: [] }):({ model: {...model,[message.field]:message.value,leadership:message.field==="unit"?false:model.leadership}, commands: [] });}),
Match.tag("ToggledAppointmentLeadership", () => {return !Predicate.isTagged(model.operation, "Ready")?({ model: model, commands: [] }):({ model: {...model,leadership:!model.leadership}, commands: [] });}),
Match.tag("SelectedAppointment", (message) => {if(!Predicate.isTagged(model.operation, "Ready"))return ({ model: model, commands: [] });
const row=model.snapshot?.appointments.find(row=>row.appointmentId===message.id);

return ({ model: {...model,selected:message.id,personId:row?.personId??"",unit:row?row.target.kind+":"+row.target.id:"",position:row?.position??"",startAt:row?.startAt.slice(0,-1)??model.startAt,endAt:row?.endAt?.slice(0,-1)??"",leadership:row?.leadership??false}, commands: [] });}),
Match.tag("RefreshedAppointmentManagement", () => {if(Predicate.isTagged(model.operation, "Loading")||Predicate.isTagged(model.operation, "Saving"))return ({ model: model, commands: [] });
const command=Predicate.isTagged(model.operation, "Uncertain")?model.operation.command:null;

return ({ model: {...model,operation:Operation.cases.Loading.make({command}),requestId:model.requestId+1}, commands: [Load({requestId:model.requestId+1})] });}),
Match.tag("LoadedAppointmentManagement", (message) => {if(message.requestId!==model.requestId||!Predicate.isTagged(model.operation, "Loading"))return ({ model: model, commands: [] });
const command=model.operation.command;
const recorded=command!==null&&message.snapshot.history.some(event=>event.commandId===command.commandId);
const uncertain=recorded?null:command;
const row=message.snapshot.appointments.find(row=>row.appointmentId===model.selected);
const fields=uncertain!==null?{}:row?{personId:row.personId,unit:row.target.kind+":"+row.target.id,position:row.position??"",startAt:row.startAt.slice(0,-1),endAt:row.endAt?.slice(0,-1)??"",leadership:row.leadership}:{selected:"",startAt:model.startAt||message.now.slice(0,16)};

return ({ model: {...model,...fields,snapshot:message.snapshot,operation:uncertain?Operation.cases.Uncertain.make({command:uncertain}):Operation.cases.Ready.make({}),commandId:uncertain?.commandId??message.commandId,notice:uncertain?Notice.cases.Failure.make({message:"Resultatet er fortsatt ukjent. Prøv nøyaktig samme handling igjen."}):Notice.cases.Success.make({message:recorded?"Handlingen er lagret. Historikken bekrefter resultatet.":"Oversikten og valgt verv er oppdatert."})}, commands: [] });}),
Match.tag("FailedAppointmentLoad", (message) => {if(message.requestId!==model.requestId||!Predicate.isTagged(model.operation, "Loading"))return ({ model: model, commands: [] });
const command=model.operation.command;

return ({ model: {...model,operation:command?Operation.cases.Uncertain.make({command}):Operation.cases.Ready.make({}),notice:Notice.cases.Failure.make({message:message.message})}, commands: [] });}),
Match.tag("FailedOrganizationCommand", (message) => {if(message.requestId!==model.requestId||!Predicate.isTagged(model.operation, "Saving"))return ({ model: model, commands: [] });

return ({ model: {...model,operation:message.definitive?Operation.cases.Ready.make({}):Operation.cases.Uncertain.make({command:model.operation.command}),commandId:message.definitive?message.commandId:model.commandId,notice:Notice.cases.Failure.make({message:message.message})}, commands: [] });}),
Match.tag("SavedOrganizationCommand", (message) => {if(message.requestId!==model.requestId||!Predicate.isTagged(model.operation, "Saving"))return ({ model: model, commands: [] });

return ({ model: {...model,operation:Operation.cases.Loading.make({command:null}),commandId:message.commandId,notice:Notice.cases.Success.make({message:"Handlingen er lagret. Historikken er oppdateres."}),requestId:model.requestId+1}, commands: [Load({requestId:model.requestId+1})] });}),
Match.tag("RetriedOrganizationCommand", () => {if(!Predicate.isTagged(model.operation, "Uncertain"))return ({ model: model, commands: [] });
const requestId=model.requestId+1;

return ({ model: {...model,operation:Operation.cases.Saving.make({command:model.operation.command}),requestId}, commands: [Save({requestId,command:model.operation.command})] });}),
Match.tag("SubmittedOrganizationCommand", (message) => {if(!Predicate.isTagged(model.operation, "Ready")||!model.snapshot)return ({ model: model, commands: [] });
const common={commandId:model.commandId,reason:model.reason.trim()};
const row=model.snapshot.appointments.find(row=>row.appointmentId===model.selected);
const unit=model.snapshot.units.find(unit=>unit.target.kind+":"+unit.target.id===model.unit);
const account=model.snapshot.accounts.find(account=>account.personId===model.accountPersonId);
const classified=model.snapshot.governance?.teams.find(team=>team.teamId===model.classifiedTeam);
const recognised=model.snapshot.governance?.departments.find(department=>department.departmentId===model.recognisedDepartment);
const existing={...common,appointmentId:row?.appointmentId,expectedRevision:row?.revision};
const interval={position:model.position.trim()||null,leadership:model.leadership,startAt:model.startAt?model.startAt+(model.startAt.length===16?":00.000":"")+"Z":"",endAt:model.endAt?model.endAt+(model.endAt.length===16?":00.000":"")+"Z":null};

const parsed = Match.value(message.action).pipe(
Match.when("Appoint",()=>parseAppoint({...common,...interval,personId:model.personId,target:unit?.target}).pipe(Option.map(OrganizationLifecycleCommand.cases.Appoint.make))),
Match.when("ReviseAppointment",()=>parseReviseAppointment({...existing,...interval}).pipe(Option.map(OrganizationLifecycleCommand.cases.ReviseAppointment.make))),
Match.when("EndAppointment",()=>parseEndAppointment({...existing,endAt:interval.endAt}).pipe(Option.map(OrganizationLifecycleCommand.cases.EndAppointment.make))),
Match.when("SuspendAppointment",()=>parseSuspendAppointment(existing).pipe(Option.map(OrganizationLifecycleCommand.cases.SuspendAppointment.make))),
Match.when("ReinstateAppointment",()=>parseReinstateAppointment(existing).pipe(Option.map(OrganizationLifecycleCommand.cases.ReinstateAppointment.make))),
Match.when("CreateNationalBoard",()=>parseCreateNationalBoard({...common,name:model.boardName.trim()}).pipe(Option.map(OrganizationLifecycleCommand.cases.CreateNationalBoard.make))),
Match.whenOr("DisableAccount", "EnableAccount",()=>parseChangeAccountAccess({...common,personId:account?.personId,expectedRevision:account?.revision,disabled:message.action==="DisableAccount"}).pipe(Option.map(OrganizationLifecycleCommand.cases.ChangeAccountAccess.make))),
Match.when("ClassifyTeam",()=>parseClassifyTeam({...common,teamId:classified?.teamId,unitKind:model.unitKind,teamScope:model.teamScope,expectedRevision:classified?.revision}).pipe(Option.map(OrganizationLifecycleCommand.cases.ClassifyTeam.make))),
Match.whenOr("RecogniseDepartment", "WithdrawRecognition",()=>parseRecogniseDepartment({...common,departmentId:recognised?.departmentId,independent:message.action==="RecogniseDepartment",expectedRevision:recognised?.revision}).pipe(Option.map(OrganizationLifecycleCommand.cases.RecogniseDepartment.make))),
Match.exhaustive);

if(Option.isNone(parsed))return ({ model: {...model,notice:Notice.cases.Failure.make({message:"Fyll ut person, enhet, tidsrom og begrunnelse for valgt handling."})}, commands: [] });
const requestId=model.requestId+1;

return ({ model: {...model,operation:Operation.cases.Saving.make({command:parsed.value}),notice:Notice.cases.None.make({}),requestId}, commands: [Save({requestId,command:parsed.value})] });}),
Match.exhaustive
);
  };

  const program=Runtime.makeElement({Model,container,init:():Update.Return<Model, Message>=>({ model: {snapshot:null,operation:Operation.cases.Loading.make({command:null}),requestId:1,notice:Notice.cases.None.make({}),commandId:"",selected:"",personId:"",unit:"",position:"",startAt:"",endAt:"",leadership:false,reason:"",boardName:"",accountPersonId:"",classifiedTeam:"",unitKind:"Team",teamScope:"HomeDepartment",recognisedDepartment:""}, commands: [Load({requestId:1})] }),update,view,devTools:false,slow:false,
    crash:{view:(_context,h)=>h.section([h.Role("alert")],[h.h1([],["Vervoversikten kunne ikke startes"]),h.p([],["Last siden på nytt."])])},
  });

  const handle=Runtime.embed(program);

return ()=>handle.dispose();
};
