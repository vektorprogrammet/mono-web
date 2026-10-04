import {
  Bold,
  BulletList,
  HardBreak,
  Heading,
  Italic,
  Link,
  ListItem,
  OrderedList,
  Paragraph,
  Text,
  TrailingNode,
} from "@react-email/editor/extensions";
import { Extension, mergeAttributes, Node, type Extensions } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Gapcursor, UndoRedo } from "@tiptap/extensions";
import { isSafeOutcomeLinkTarget } from "@vektorprogrammet/domain/admissions/template";

/**
 * The closed extension sets of the outcome-mail editors (spec 0027).
 *
 * Only these node and mark extensions exist in the editor schema, so the editor cannot produce
 * a node the server's strict schema would refuse. The package defaults are not used: no
 * StarterKit, no free-form Button, no class/style/alignment attributes, no image, no HTML import
 * and no email HTML export. The browser emits JSON only; the server decodes and renders it.
 *
 * Node and mark names match `@vektorprogrammet/domain/admissions/template`.
 */

const placeholderNames = ["firstName", "departmentName", "semesterName", "schoolName"] as const;

/** An atomic approved placeholder. Its only attribute is its name, one of the approved four. */
export const PlaceholderNode = Node.create({
  name: "placeholder",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: "firstName",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-placeholder"),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-placeholder]",
        getAttrs: (element: HTMLElement) => {
          const name = element.getAttribute("data-placeholder");

          return placeholderNames.some((candidate) => candidate === name) ? { name } : false;
        },
      },
    ];
  },

  renderHTML({ node }) {
    const name = String(node.attrs["name"]);

    return [
      "span",
      mergeAttributes({
        "data-placeholder": name,
        class: "outcome-placeholder",
        contenteditable: "false",
      }),
      `{${name}}`,
    ];
  },

  renderText({ node }) {
    return `{${String(node.attrs["name"])}}`;
  },
});

/**
 * The one allowlisted action: a labelled button with an `https:` or `mailto:` target. It is an
 * atom, so it has no content and no class, style or alignment attribute.
 */
export const ButtonNode = Node.create({
  name: "button",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      label: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-label") ?? "",
      },
      href: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-href") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-outcome-button]" }];
  },

  renderHTML({ node }) {
    const label = String(node.attrs["label"]);
    const href = String(node.attrs["href"]);

    return [
      "div",
      {
        "data-outcome-button": "",
        "data-label": label,
        "data-href": href,
        class: "outcome-button",
        role: "group",
        "aria-label": `Knapp: ${label}`,
      },
      ["span", { class: "outcome-button__label" }, label],
      ["span", { class: "outcome-button__href" }, href],
    ];
  },

  renderText({ node }) {
    return `${String(node.attrs["label"])} (${String(node.attrs["href"])})`;
  },
});

const BodyDocument = Node.create({ name: "doc", topNode: true, content: "block+" });

const SubjectDocument = Node.create({ name: "doc", topNode: true, content: "paragraph" });

/** Only an `https:` or `mailto:` target, href as the only attribute, no editor-owned shortcuts. */
const TemplateLink = Link.configure({
  openOnClick: false,
  autolink: false,
  linkOnPaste: false,
  defaultProtocol: "https",
  isAllowedUri: (uri) => isSafeOutcomeLinkTarget(uri),
}).extend({
  addAttributes() {
    return { href: { default: null } };
  },

  renderHTML({ HTMLAttributes }) {
    return ["a", mergeAttributes({ href: HTMLAttributes["href"] }), 0];
  },

  addKeyboardShortcuts() {
    return {};
  },
});

const withoutControlCharacters = (text: string) =>
  text
    .split("")
    .filter((unit) => {
      const code = unit.charCodeAt(0);

      return code >= 32 && code !== 127;
    })
    .join("");

/**
 * Paste and drop insert plain text only, never HTML. Pasted text is typed content: control
 * characters drop out, and the subject editor joins lines into one.
 */
const PlainTextOnly = Extension.create<{ readonly multiline: boolean }>({
  name: "plainTextOnly",

  addOptions() {
    return { multiline: false };
  },

  addProseMirrorPlugins() {
    const { editor, options } = this;

    return [
      new Plugin({
        key: new PluginKey("plainTextOnly"),
        props: {
          handleDrop: () => true,
          handlePaste: (_view, event) => {
            const text = event.clipboardData?.getData("text/plain") ?? "";

            const lines = (
              options.multiline ? text.split(/\r?\n/u) : [text.replace(/\s+/gu, " ")]
            ).map((line) => {
              const clean = withoutControlCharacters(line);

              return options.multiline ? clean : clean.trim();
            });

            if (lines.length === 1) {
              if (lines[0] !== "") editor.commands.insertContent({ type: "text", text: lines[0] });
            } else
              editor.commands.insertContent(
                lines.map((line) =>
                  line === ""
                    ? { type: "paragraph" }
                    : { type: "paragraph", content: [{ type: "text", text: line }] },
                ),
              );

            return true;
          },
        },
      }),
    ];
  },
});

/** The message body: blocks, bold, italic, links, placeholders and the one button. */
export const bodyExtensions: Extensions = [
  BodyDocument,
  Paragraph,
  Text,
  Heading.configure({ levels: [1, 2, 3] }),
  Bold,
  Italic,
  TemplateLink,
  BulletList,
  OrderedList,
  // The closed document allows a paragraph per item, not a nested list.
  ListItem.extend({ content: "paragraph+" }),
  HardBreak,
  PlaceholderNode,
  ButtonNode,
  TrailingNode.configure({ node: "paragraph", notAfter: ["paragraph"] }),
  Gapcursor,
  UndoRedo,
  PlainTextOnly.configure({ multiline: true }),
];

/** The subject: one line of text and placeholders, no marks, no breaks and no blocks. */
export const subjectExtensions: Extensions = [
  SubjectDocument,
  Paragraph.extend({ marks: "" }),
  Text,
  PlaceholderNode,
  UndoRedo,
  PlainTextOnly.configure({ multiline: false }),
  // A subject has one line: Enter is consumed instead of splitting the paragraph.
  Extension.create({
    name: "singleLine",
    addKeyboardShortcuts() {
      return { Enter: () => true };
    },
  }),
];
