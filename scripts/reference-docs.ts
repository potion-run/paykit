// The text half of the module reference: parse a JSDoc block into its summary,
// sections and tags, then render it as markdown for the docs site.
//
// `scripts/generate-reference.ts` owns discovery and file output. This module
// stays pure so the rules are readable without a compiler API around them.

/** The tags that make a declaration part of the reference. */
export type ReferenceKind = "binding" | "layer" | "primitive" | "resource";

export interface ReferenceExample {
  readonly title: string;
  readonly body: string;
}

export interface ReferenceSection {
  readonly title: string;
  readonly description: string;
  readonly examples: ReadonlyArray<ReferenceExample>;
}

export interface ReferenceDoc {
  /** The prose before the first `###` heading or tag. */
  readonly summary: string;
  readonly sections: ReadonlyArray<ReferenceSection>;
  readonly kind: ReferenceKind | undefined;
  readonly product: string | undefined;
  readonly provides: ReadonlyArray<string>;
  readonly peers: ReadonlyArray<string>;
}

interface DraftExample {
  title: string;
  body: Array<string>;
}

interface DraftSection {
  title: string;
  description: Array<string>;
  examples: Array<DraftExample>;
}

const KIND_ORDER: ReadonlyArray<ReferenceKind> = ["resource", "binding", "layer", "primitive"];

const isReferenceKind = (value: string): value is ReferenceKind =>
  KIND_ORDER.some((kind) => kind === value);

/** The ` * ` prefix and the comment markers, removed. */
const commentLines = (raw: string): ReadonlyArray<string> =>
  raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""));

const kindOf = (kinds: ReadonlySet<ReferenceKind>): ReferenceKind | undefined =>
  KIND_ORDER.find((kind) => kinds.has(kind));

/**
 * Parse one JSDoc block. `### Heading` starts a section, `**Example:** title`
 * starts an example, and `@tag value` carries the metadata the page shows.
 * Lines inside a fenced code block are never treated as markers.
 */
export const parseReferenceDoc = (raw: string): ReferenceDoc => {
  const lines = commentLines(raw);
  const summary: Array<string> = [];
  const sections: Array<DraftSection> = [];
  const kinds = new Set<ReferenceKind>();
  const provides: Array<string> = [];
  const peers: Array<string> = [];
  let product: string | undefined;

  let sawTag = false;
  let insideFence = false;
  let section: DraftSection | undefined;
  let example: DraftExample | undefined;
  let collectingDescription = false;

  const flushExample = (): void => {
    if (example === undefined) return;
    example.body = [example.body.join("\n").trim()];
    section?.examples.push(example);
    example = undefined;
  };

  const openSection = (title: string): void => {
    flushExample();
    section = { title, description: [], examples: [] };
    sections.push(section);
    collectingDescription = true;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) insideFence = !insideFence;

    if (!insideFence) {
      const sectionMatch = /^###\s+(.+)$/.exec(line.trim());

      if (sectionMatch !== null) {
        sawTag = true;
        openSection(sectionMatch[1]!.trim());
        continue;
      }

      const exampleMatch = /^\*\*Example:\*\*\s*(.*)$/.exec(line.trim());

      if (exampleMatch !== null) {
        sawTag = true;
        flushExample();
        collectingDescription = false;
        example = { title: exampleMatch[1]!.trim() || "Example", body: [] };

        if (section === undefined) openSection("Examples");
        continue;
      }

      const tagMatch = /^@(\w+)\s*(.*)$/.exec(line.trim());

      if (tagMatch !== null) {
        sawTag = true;
        flushExample();
        collectingDescription = false;

        const [, tag, rest] = tagMatch;
        const value = rest?.trim() ?? "";

        if (tag !== undefined && isReferenceKind(tag)) {
          kinds.add(tag);
        } else if (tag === "product") {
          product = value || undefined;
        } else if (tag === "provides") {
          for (const part of value.split(",")) {
            const name = part.trim();

            if (name !== "") provides.push(name);
          }
        } else if (tag === "peer") {
          if (value !== "") peers.push(value);
        } else if (tag === "section") {
          openSection(value || "Examples");
        } else if (tag === "example") {
          example = { title: value || "Example", body: [] };

          if (section === undefined) openSection("Examples");
        }

        continue;
      }
    }

    if (example !== undefined) {
      example.body.push(line);
    } else if (collectingDescription && section !== undefined) {
      section.description.push(line);
    } else if (!sawTag) {
      summary.push(line);
    }
  }

  flushExample();

  return {
    summary: summary.join("\n").trim(),
    sections: sections.flatMap((draft) => {
      const rendered = {
        title: draft.title,
        description: draft.description.join("\n").trim(),
        examples: draft.examples.map((block) => ({
          title: block.title,
          body: block.body.join("\n").trim(),
        })),
      };

      const empty =
        rendered.description === "" && rendered.examples.every((block) => block.body === "");

      return empty ? [] : [rendered];
    }),
    kind: kindOf(kinds),
    product,
    provides,
    peers,
  };
};

/**
 * Render the parsed document below a page title. `level` is the heading level
 * for the JSDoc's `###` sections: 2 on a page about one declaration, 3 below a
 * `##` per declaration on a page about a module.
 */
export const renderReferenceBody = (doc: ReferenceDoc, level: 2 | 3): string => {
  const parts: Array<string> = [];

  if (doc.summary !== "") parts.push(doc.summary);

  const hashes = "#".repeat(level);

  for (const section of doc.sections) {
    parts.push(`${hashes} ${section.title}`);

    if (section.description !== "") parts.push(section.description);

    if (section.examples.length === 1) {
      const only = section.examples[0];

      if (only !== undefined && only.body !== "") parts.push(only.body);
    } else {
      for (const block of section.examples) {
        if (block.body === "") continue;
        parts.push(`**${block.title}**`);
        parts.push(block.body);
      }
    }
  }

  return parts.join("\n\n").trim();
};

/** One sentence for the page description, with markdown and code fences removed. */
export const referenceDescription = (summary: string, fallback: string): string => {
  const plain = summary
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (plain === "") return fallback;

  const end = plain.search(/\.(\s|$)/);

  if (end !== -1) return plain.slice(0, end + 1);

  if (plain.length <= 160) return plain;

  const cut = plain.lastIndexOf(" ", 160);

  return `${plain.slice(0, cut === -1 ? 160 : cut)}.`;
};

/** `FromResolver` becomes `from-resolver`, and `List.operation` becomes `list-operation`. */
export const slugOf = (value: string): string =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
