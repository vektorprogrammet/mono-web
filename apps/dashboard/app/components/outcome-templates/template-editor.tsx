import {
  isSafeOutcomeLinkTarget,
  type OutcomePlaceholderName,
  type OutcomeTemplateSubjectToken,
} from "@vektorprogrammet/domain/admissions/template";
import { EditorProvider, useCurrentEditor, useEditorState } from "@tiptap/react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../ui/button";
import { bodyExtensions, subjectExtensions } from "./template-extensions";
import {
  fromTemplateBody,
  fromTemplateSubject,
  placeholderLabels,
  templateDraftOf,
  toTemplateBody,
  toTemplateSubject,
  type TemplateDraft,
} from "./template-document";

/**
 * The accessible Norwegian editor of one outcome-mail variant: a one-line subject and a rich body.
 *
 * Both are WYSIWYG views of the closed JSON model. The app owns every label and toolbar, and the
 * editor emits JSON through `onChange`, never HTML. The server decodes that JSON with its strict
 * schema and renders it with its own code, so nothing this component produces is trusted.
 */

export interface TemplateEditorProps {
  /** Distinguishes the ids of editors that share a page. */
  readonly id: string;
  readonly placeholders: ReadonlyArray<OutcomePlaceholderName>;
  readonly initialSubject: ReadonlyArray<OutcomeTemplateSubjectToken>;
  readonly initialBody: { readonly content: ReadonlyArray<object> };
  readonly onChange: (draft: TemplateDraft) => void;
}

const surface =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring " +
  "[&_.outcome-placeholder]:mx-0.5 [&_.outcome-placeholder]:rounded [&_.outcome-placeholder]:border [&_.outcome-placeholder]:bg-muted [&_.outcome-placeholder]:px-1 [&_.outcome-placeholder]:font-mono [&_.outcome-placeholder]:text-xs " +
  "[&_.outcome-button]:my-2 [&_.outcome-button]:inline-flex [&_.outcome-button]:flex-col [&_.outcome-button]:rounded-md [&_.outcome-button]:border [&_.outcome-button]:bg-primary [&_.outcome-button]:px-4 [&_.outcome-button]:py-2 [&_.outcome-button]:text-primary-foreground " +
  "[&_.outcome-button__label]:font-medium [&_.outcome-button__href]:break-all [&_.outcome-button__href]:text-xs " +
  "[&_.ProseMirror-selectednode]:outline [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-ring " +
  "[&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold " +
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:underline [&_p]:my-2";

interface ToolbarItem {
  readonly key: string;
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}

/** A toolbar with one tab stop: arrow keys, Home and End move between its buttons. */
function Toolbar({ label, items }: { label: string; items: ReadonlyArray<ToolbarItem> }) {
  const [current, setCurrent] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const first = items.findIndex((item) => item.disabled !== true);
  const tabbable = items[current]?.disabled === true ? first : current;

  const move = (from: number, step: 1 | -1) => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const next = (from + step * offset + items.length * offset) % items.length;

      if (items[next]?.disabled !== true) {
        setCurrent(next);
        buttons.current[next]?.focus();

        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = buttons.current.findIndex((button) => button === document.activeElement);

    if (index === -1) return;

    if (event.key === "ArrowRight") move(index, 1);
    else if (event.key === "ArrowLeft") move(index, -1);
    else if (event.key === "Home") move(-1, 1);
    else if (event.key === "End") move(items.length, -1);
    else return;

    event.preventDefault();
  };

  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      className="flex flex-wrap gap-2"
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => (
        <Button
          key={item.key}
          ref={(element: HTMLButtonElement | null) => {
            buttons.current[index] = element;
          }}
          type="button"
          variant="outline"
          className="min-h-11"
          aria-pressed={item.pressed}
          disabled={item.disabled}
          tabIndex={index === tabbable ? 0 : -1}
          onFocus={() => setCurrent(index)}
          onClick={item.onPress}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

const inputClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

type Panel = "link" | "button" | null;

const noneActive = {
  bold: false,
  italic: false,
  heading: false,
  bulletList: false,
  orderedList: false,
  link: false,
  button: false,
  canUndo: false,
  canRedo: false,
};

function BodyToolbar({ placeholders }: { placeholders: ReadonlyArray<OutcomePlaceholderName> }) {
  const { editor } = useCurrentEditor();
  const [panel, setPanel] = useState<Panel>(null);
  const [href, setHref] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState("");

  const active =
    useEditorState({
      editor,
      selector: ({ editor: current }) =>
        current === null
          ? noneActive
          : {
              bold: current.isActive("bold"),
              italic: current.isActive("italic"),
              heading: current.isActive("heading"),
              bulletList: current.isActive("bulletList"),
              orderedList: current.isActive("orderedList"),
              link: current.isActive("link"),
              button: current.isActive("button"),
              canUndo: current.can().undo(),
              canRedo: current.can().redo(),
            },
    }) ?? noneActive;

  if (editor === null) return null;

  const close = () => {
    setPanel(null);
    setProblem("");
    editor.commands.focus();
  };

  const openLink = () => {
    setHref(String(editor.getAttributes("link")["href"] ?? ""));
    setProblem("");
    setPanel("link");
  };

  const openButton = () => {
    const attributes = editor.getAttributes("button");

    setLabel(String(attributes["label"] ?? ""));
    setHref(String(attributes["href"] ?? ""));
    setProblem("");
    setPanel("button");
  };

  const applyLink = () => {
    const target = href.trim();

    if (!isSafeOutcomeLinkTarget(target))
      setProblem("Lenken må være en gyldig https:- eller mailto:-adresse.");
    else if (editor.state.selection.empty && !editor.isActive("link"))
      setProblem("Marker teksten du vil lenke først.");
    else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: target }).run();
      close();
    }
  };

  const applyButton = () => {
    const text = label.trim();
    const target = href.trim();

    if (text.length === 0 || text.length > 80)
      setProblem("Knappeteksten må være mellom 1 og 80 tegn.");
    else if (!isSafeOutcomeLinkTarget(target))
      setProblem("Lenken må være en gyldig https:- eller mailto:-adresse.");
    else {
      if (active.button) editor.chain().focus().updateAttributes("button", { label: text, href: target }).run();
      else
        editor
          .chain()
          .focus()
          .insertContent({ type: "button", attrs: { label: text, href: target } })
          .run();

      close();
    }
  };

  const onPanelKeyDown = (apply: () => void) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const items: ReadonlyArray<ToolbarItem> = [
    {
      key: "bold",
      label: "Fet",
      pressed: active.bold,
      onPress: () => void editor.chain().focus().toggleBold().run(),
    },
    {
      key: "italic",
      label: "Kursiv",
      pressed: active.italic,
      onPress: () => void editor.chain().focus().toggleItalic().run(),
    },
    {
      key: "heading",
      label: "Overskrift",
      pressed: active.heading,
      onPress: () => void editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      key: "bulletList",
      label: "Punktliste",
      pressed: active.bulletList,
      onPress: () => void editor.chain().focus().toggleBulletList().run(),
    },
    {
      key: "orderedList",
      label: "Nummerert liste",
      pressed: active.orderedList,
      onPress: () => void editor.chain().focus().toggleOrderedList().run(),
    },
    { key: "link", label: "Lenke", pressed: active.link, onPress: openLink },
    {
      key: "unlink",
      label: "Fjern lenke",
      disabled: !active.link,
      onPress: () => void editor.chain().focus().extendMarkRange("link").unsetMark("link").run(),
    },
    { key: "button", label: "Knapp", pressed: active.button, onPress: openButton },
    {
      key: "removeButton",
      label: "Fjern knapp",
      disabled: !active.button,
      onPress: () => void editor.chain().focus().deleteSelection().run(),
    },
    {
      key: "undo",
      label: "Angre",
      disabled: !active.canUndo,
      onPress: () => void editor.chain().focus().undo().run(),
    },
    {
      key: "redo",
      label: "Gjør om",
      disabled: !active.canRedo,
      onPress: () => void editor.chain().focus().redo().run(),
    },
  ];

  const insertItems: ReadonlyArray<ToolbarItem> = placeholders.map((name) => ({
    key: name,
    label: `Sett inn ${placeholderLabels[name]}`,
    onPress: () =>
      void editor
        .chain()
        .focus()
        .insertContent({ type: "placeholder", attrs: { name } })
        .run(),
  }));

  return (
    <div className="space-y-3 pb-3">
      <Toolbar label="Formatering" items={items} />
      <Toolbar label="Plassholdere i teksten" items={insertItems} />
      {panel === "link" && (
        <div role="group" aria-label="Lenke" className="space-y-2 rounded-md border p-3">
          <label className="block space-y-1 text-sm">
            Lenkeadresse (https: eller mailto:)
            <input
              className={inputClass}
              type="text"
              inputMode="url"
              autoComplete="off"
              value={href}
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={onPanelKeyDown(applyLink)}
            />
          </label>
          {problem && <p role="alert">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" onClick={applyLink}>
              Bruk lenke
            </Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={close}>
              Avbryt
            </Button>
          </div>
        </div>
      )}
      {panel === "button" && (
        <div role="group" aria-label="Knapp" className="space-y-2 rounded-md border p-3">
          <label className="block space-y-1 text-sm">
            Knappetekst
            <input
              className={inputClass}
              type="text"
              maxLength={80}
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={onPanelKeyDown(applyButton)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            Knappens lenke (https: eller mailto:)
            <input
              className={inputClass}
              type="text"
              inputMode="url"
              autoComplete="off"
              value={href}
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={onPanelKeyDown(applyButton)}
            />
          </label>
          {problem && <p role="alert">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" onClick={applyButton}>
              {active.button ? "Oppdater knapp" : "Sett inn knapp"}
            </Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={close}>
              Avbryt
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SubjectPlaceholders({ placeholders }: { placeholders: ReadonlyArray<OutcomePlaceholderName> }) {
  const { editor } = useCurrentEditor();

  if (editor === null) return null;

  return (
    <div className="pt-2">
      <Toolbar
        label="Plassholdere i emnet"
        items={placeholders.map((name) => ({
          key: name,
          label: `${placeholderLabels[name]} i emnet`,
          onPress: () =>
            void editor
              .chain()
              .focus()
              .insertContent({ type: "placeholder", attrs: { name } })
              .run(),
        }))}
      />
    </div>
  );
}

export function TemplateEditor({
  id,
  placeholders,
  initialSubject,
  initialBody,
  onChange,
}: TemplateEditorProps) {
  // The editors own their content after mount; a new template remounts them under a new key.
  const [initial] = useState(() => ({
    subject: fromTemplateSubject(initialSubject),
    body: fromTemplateBody(initialBody),
  }));

  // The two editors report separately; the latest of each makes the draft.
  const draft = useRef<TemplateDraft>(
    templateDraftOf({ subject: initialSubject, body: initialBody }),
  );

  const report = (next: Partial<TemplateDraft>) => {
    draft.current = { ...draft.current, ...next };
    onChange(draft.current);
  };

  const subjectLabel = `${id}-subject-label`;
  const bodyLabel = `${id}-body-label`;
  const bodyHelp = `${id}-body-help`;

  const [subjectProps] = useState(() => ({
    attributes: {
      role: "textbox",
      "aria-labelledby": subjectLabel,
      "aria-multiline": "false",
      class: surface,
    },
  }));

  const [bodyProps] = useState(() => ({
    attributes: {
      role: "textbox",
      "aria-labelledby": bodyLabel,
      "aria-describedby": bodyHelp,
      "aria-multiline": "true",
      class: `${surface} min-h-48`,
    },
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p id={subjectLabel} className="text-sm font-medium">
          Emne
        </p>
        <EditorProvider
          extensions={subjectExtensions}
          content={initial.subject}
          immediatelyRender={false}
          editorProps={subjectProps}
          onUpdate={({ editor }) =>
            report({ subject: toTemplateSubject(editor.getJSON()) })
          }
          slotAfter={<SubjectPlaceholders placeholders={placeholders} />}
        />
      </div>
      <div className="space-y-1">
        <p id={bodyLabel} className="text-sm font-medium">
          Meldingstekst
        </p>
        <p id={bodyHelp} className="text-sm text-muted-foreground">
          Bruk verktøylinjen til å formatere teksten. Ctrl+B gir fet tekst, Ctrl+I kursiv og
          Ctrl+Z angrer. Fornavn, avdeling, semester og skole settes inn som faste plassholdere.
        </p>
        <EditorProvider
          extensions={bodyExtensions}
          content={initial.body}
          immediatelyRender={false}
          editorProps={bodyProps}
          onUpdate={({ editor }) =>
            report({ body: toTemplateBody(editor.getJSON()) })
          }
          slotBefore={<BodyToolbar placeholders={placeholders} />}
        />
      </div>
    </div>
  );
}
