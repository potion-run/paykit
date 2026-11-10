// Generates the module reference under `website/docs/reference` from the JSDoc
// in `packages/*/src`.
//
//   pnpm docs:reference        # write the pages
//   pnpm docs:reference:check  # fail when a page is stale
//
// A declaration is in the reference when its JSDoc carries `@primitive`,
// `@resource`, `@binding` or `@layer` and an entry in its package's `exports`
// map exposes it. A tag on a private symbol fails here instead of documenting
// an import a reader cannot make.
//
// One page is one source module. A module with one tagged declaration is named
// after that export, so `BillingApi.layer.ts` is `BillingApiLayer`. A module
// with several gets a `##` per declaration and the file stem as its page name,
// so `Admin.binding.ts` is `Admin` with `## GrantCredits` and the rest.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ts from "tsrs/ast";
import type { Node, SourceFile } from "tsrs/ast";
import { API, formatDiagnostics, ModifierFlags } from "tsrs/async";
import type { Program } from "tsrs/async";
import { filesUnder, workspacePackages, type WorkspacePackage } from "./package-manifest.ts";
import {
  parseReferenceDoc,
  referenceDescription,
  renderReferenceBody,
  slugOf,
  type ReferenceDoc,
  type ReferenceKind,
} from "./reference-docs.ts";

const DOCS_ROOT = "website/docs/reference";
const REPOSITORY = "https://github.com/potion-run/paykit/blob/main";
const PACKAGE_ORDER = ["paykit", "paykit-polar", "paykit-stripe", "paykit-admin"];

const KIND_LABEL: Record<ReferenceKind, string> = {
  binding: "Binding",
  layer: "Layer",
  primitive: "Primitive",
  resource: "Resource",
};

/** The suffix a file name carries when a module is split by role. */
const ROLE_SUFFIXES = [
  "binding",
  "layer",
  "operation",
  "command",
  "policy",
  "resource",
  "rejection",
  "view",
  "model",
  "api",
  "rpc",
];

class ReferenceSyntaxError extends Data.TaggedError("ReferenceSyntaxError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class ReferenceTagError extends Data.TaggedError("ReferenceTagError")<{
  readonly message: string;
  readonly problems: ReadonlyArray<string>;
}> {}

class ReferenceDrift extends Data.TaggedError("ReferenceDrift")<{
  readonly message: string;
  readonly problems: ReadonlyArray<string>;
}> {}

interface SourceFileInfo {
  readonly packageSlug: string;
  readonly packageName: string;
  /** Absolute path on disk. */
  readonly absolute: string;
  /** Path from the repository root, for the `Source` line and the GitHub link. */
  readonly repositoryPath: string;
  /** Directory under `src`, or the empty string for a module at the root. */
  readonly directory: string;
  /** File name without `.ts`, so `Check.binding`. */
  readonly base: string;
}

interface ScannedDeclaration {
  readonly name: string;
  readonly line: number;
  readonly doc: ReferenceDoc;
}

interface NamedExport {
  /** The module the export reads from; absent for a local declaration. */
  readonly target?: string | undefined;
  /** The name the target module declares. */
  readonly local: string;
}

interface FileExports {
  /** The names this file exports as a module, including star re-exports. */
  readonly names: ReadonlySet<string>;
  /** The declarations this file defines, exported or not. */
  readonly own: ReadonlySet<string>;
  /** Named re-exports, keyed by the name this file exports. */
  readonly named: ReadonlyMap<string, NamedExport>;
  /** Targets reached through `export * from`. */
  readonly stars: ReadonlyArray<string>;
  /** Namespace re-exports, keyed by the namespace name. */
  readonly namespaces: ReadonlyMap<string, string>;
}

interface ScannedFile {
  readonly info: SourceFileInfo;
  readonly declarations: ReadonlyArray<ScannedDeclaration>;
  readonly exports: FileExports;
}

interface EntryPoint {
  readonly specifier: string;
  readonly target: string;
}

interface ModulePage {
  readonly info: SourceFileInfo;
  readonly title: string;
  readonly slug: string;
  readonly groupSlug: string;
  readonly href: string;
  readonly output: string;
  readonly declarations: ReadonlyArray<ScannedDeclaration>;
}

interface ModuleGroup {
  readonly slug: string;
  readonly title: string;
  readonly modules: ReadonlyArray<ModulePage>;
}

interface PackageReference {
  readonly pkg: WorkspacePackage;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly entries: ReadonlyArray<EntryPoint>;
  readonly modules: ReadonlyArray<ModulePage>;
  readonly groups: ReadonlyArray<ModuleGroup>;
  readonly outputDir: string;
}

interface PackagePlan {
  readonly reference: PackageReference;
  readonly problems: ReadonlyArray<string>;
}

interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

const packageSlugOf = (name: string): string => name.replace(/^@potion\.run\//, "");

const packageTitleOf = (slug: string): string =>
  slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const isSourcePath = (value: string): boolean =>
  value.startsWith("./src/") && value.endsWith(".ts");

/** The `exports` map's source targets, in declaration order. */
const entryPointsOf = (pkg: WorkspacePackage): ReadonlyArray<EntryPoint> => {
  // SAFETY: package.json is JSON; a value that is not a string is skipped below.
  const exportsField = pkg.raw["exports"] as Readonly<Record<string, unknown>> | undefined;

  if (exportsField === undefined) return [];

  const entries: Array<EntryPoint> = [];

  for (const [key, value] of Object.entries(exportsField)) {
    if (typeof value !== "string" || !isSourcePath(value)) continue;
    entries.push({
      specifier: key === "." ? pkg.manifest.name : `${pkg.manifest.name}/${key.slice(2)}`,
      target: value,
    });
  }

  return entries;
};

const declarationName = (node: Node): string => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations[0]?.name.getText() ?? "";
  }

  if (
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.getText() ?? "";
  }

  return "";
};

const isExported = (node: Node): boolean => {
  if (
    ts.isVariableStatement(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return (node.modifierFlags & ModifierFlags.Export) !== 0;
  }

  return false;
};

const stringLiteral = (node: Node | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;

const exportsOf = (sourceFile: SourceFile): FileExports => {
  const names = new Set<string>();
  const own = new Set<string>();
  const named = new Map<string, NamedExport>();
  const stars: Array<string> = [];
  const namespaces = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const target = stringLiteral(statement.moduleSpecifier);

      if (target === undefined) {
        if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
          for (const spec of statement.exportClause.elements) {
            const publicName = spec.name.getText();
            const local = spec.propertyName?.getText() ?? publicName;
            names.add(publicName);
            named.set(publicName, { local });
          }
        }

        continue;
      }

      if (statement.exportClause === undefined) {
        stars.push(target);
        continue;
      }

      if (ts.isNamespaceExport(statement.exportClause)) {
        const namespace = statement.exportClause.name.getText();
        names.add(namespace);
        namespaces.set(namespace, target);
        continue;
      }

      if (ts.isNamedExports(statement.exportClause)) {
        for (const spec of statement.exportClause.elements) {
          const publicName = spec.name.getText();
          const local = spec.propertyName?.getText() ?? publicName;
          names.add(publicName);
          named.set(publicName, { target, local });
        }
      }

      continue;
    }

    const name = declarationName(statement);

    if (name === "") continue;
    own.add(name);

    if (isExported(statement)) names.add(name);
  }

  return { names, own, named, stars, namespaces };
};

/** The declarations whose JSDoc carries one of the reference tags. */
const declarationsOf = (sourceFile: SourceFile): ReadonlyArray<ScannedDeclaration> => {
  const declarations: Array<ScannedDeclaration> = [];

  for (const statement of sourceFile.statements) {
    const docs = statement.jsDoc ?? [];

    if (docs.length === 0) continue;

    const doc = parseReferenceDoc(docs.map((comment) => comment.getText()).join("\n"));

    if (doc.kind === undefined) continue;

    const name = declarationName(statement);

    if (name === "") continue;

    const start = docs[0]?.getStart(sourceFile) ?? statement.getStart(sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;

    declarations.push({ name, line, doc });
  }

  return declarations;
};

const normalizeSeparators = (value: string): string => value.replaceAll("\\", "/");

const resolveTarget = (from: string, specifier: string, path: Path.Path): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;

  return path.resolve(path.dirname(from), specifier);
};

const stemOf = (base: string): string => {
  for (const suffix of ROLE_SUFFIXES) {
    if (base.endsWith(`.${suffix}`)) return base.slice(0, -(suffix.length + 1));
  }

  return base;
};

const moduleTitleOf = (file: ScannedFile, bases: ReadonlySet<string>): string => {
  // One tagged declaration is the page: name it after the export a reader
  // imports, so `BillingApi.layer.ts` is `BillingApiLayer`, not `BillingApi`.
  if (file.declarations.length === 1) return file.declarations[0]?.name ?? file.info.base;

  if (file.info.base === "index") {
    return file.info.directory.split("/").at(-1) ?? file.info.base;
  }

  const stem = stemOf(file.info.base);

  return [...bases].filter((base) => stemOf(base) === stem).length > 1 ? file.info.base : stem;
};

const sourceLine = (info: SourceFileInfo, line: number): string =>
  `> **Source:** [\`${info.repositoryPath}\`](${REPOSITORY}/${info.repositoryPath}#L${line})`;

const kindLine = (doc: ReferenceDoc): string => {
  const parts = [
    doc.kind === undefined ? "**Kind:** Primitive" : `**Kind:** ${KIND_LABEL[doc.kind]}`,
  ];

  if (doc.product !== undefined) parts.push(`**Product:** ${doc.product}`);

  if (doc.provides.length > 0) {
    parts.push(`**Provides:** ${doc.provides.map((name) => `\`${name}\``).join(", ")}`);
  }

  if (doc.peers.length > 0) {
    parts.push(`**Peer dependencies:** ${doc.peers.map((name) => `\`${name}\``).join(", ")}`);
  }

  return `> ${parts.join(" · ")}`;
};

const frontmatter = (title: string, description: string): string =>
  `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---`;

const LINK_TAG = /\{@link\s+([^}]+)\}/g;

interface LinkTarget {
  readonly target: string;
  readonly label?: string | undefined;
}

const linkTargetOf = (inner: string): LinkTarget => {
  const trimmed = inner.trim();
  const pipe = trimmed.indexOf("|");

  if (pipe !== -1) {
    return {
      target: trimmed.slice(0, pipe).trim(),
      label: trimmed.slice(pipe + 1).trim() || undefined,
    };
  }

  const space = trimmed.search(/\s/);

  if (space !== -1) {
    return {
      target: trimmed.slice(0, space).trim(),
      label: trimmed.slice(space + 1).trim() || undefined,
    };
  }

  return { target: trimmed, label: undefined };
};

/** Replace `{@link Symbol}` with a link to its page, or code when it has none. */
const linkify = (markdown: string, hrefs: ReadonlyMap<string, string>, self: string): string => {
  const replaceChunk = (chunk: string): string =>
    chunk.replace(LINK_TAG, (_match: string, inner: string) => {
      const { target, label } = linkTargetOf(inner);

      if (target.startsWith("http://") || target.startsWith("https://")) {
        return `[${label ?? target}](${target})`;
      }

      const name = target.split("#")[0] ?? target;
      const href = hrefs.get(name);

      if (href !== undefined && href !== self) return `[${label ?? name}](${href})`;

      return label ?? `\`${name}\``;
    });

  const output: Array<string> = [];
  let chunk: Array<string> = [];
  let insideFence = false;

  const flush = (): void => {
    if (chunk.length === 0) return;
    output.push(replaceChunk(chunk.join("\n")));
    chunk = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (!insideFence) flush();
      insideFence = !insideFence;
      output.push(line);
      continue;
    }

    if (insideFence) output.push(line);
    else chunk.push(line);
  }

  flush();

  return output.join("\n");
};

/** Resolve a target written relative to a source file into a repository path. */
const repositoryPathOf = (from: string, target: string): string => {
  const parts = from.split("/").slice(0, -1);

  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") parts.pop();
    else parts.push(segment);
  }

  return parts.join("/");
};

/**
 * A JSDoc link to `../docs/adr/...` is relative to the source file on GitHub,
 * not to the docs page. Rewrite it to the repository URL so the generated page
 * does not grow a broken link.
 */
const repositoryLinks = (markdown: string, repositoryPath: string): string => {
  const rewrite = (chunk: string): string =>
    chunk.replace(
      /\[([^\]]+)\]\((\.{1,2}\/[^)]+)\)/g,
      (_match: string, label: string, target: string) => {
        const [file, fragment] = target.split("#");
        const resolved = repositoryPathOf(repositoryPath, file ?? target);
        const href = `${REPOSITORY}/${resolved}${fragment === undefined ? "" : `#${fragment}`}`;

        return `[${label}](${href})`;
      },
    );

  const output: Array<string> = [];
  let chunk: Array<string> = [];
  let insideFence = false;

  const flush = (): void => {
    if (chunk.length === 0) return;
    output.push(rewrite(chunk.join("\n")));
    chunk = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (!insideFence) flush();
      insideFence = !insideFence;
      output.push(line);
      continue;
    }

    if (insideFence) output.push(line);
    else chunk.push(line);
  }

  flush();

  return output.join("\n");
};

/** A page's one-line description: the export's sentence, or the names it groups. */
const pageDescription = (module: ModulePage): string => {
  const first = module.declarations[0];

  if (first === undefined) return `${module.title} from ${module.info.packageName}.`;

  if (module.declarations.length === 1) {
    return referenceDescription(
      first.doc.summary,
      `${module.title} from ${module.info.packageName}.`,
    );
  }

  return `Exports ${module.declarations.map((declaration) => `\`${declaration.name}\``).join(", ")}.`;
};

const renderModule = (module: ModulePage, hrefs: ReadonlyMap<string, string>): string => {
  const first = module.declarations[0];

  if (first === undefined) return `${frontmatter(module.title, "")}\n`;

  const description = pageDescription(module);
  const single = module.declarations.length === 1;
  const lines = [frontmatter(module.title, description), ""];

  if (single) {
    lines.push(sourceLine(module.info, first.line));
    lines.push(kindLine(first.doc));
  } else {
    lines.push(sourceLine(module.info, first.line));
  }

  for (const declaration of module.declarations) {
    const body = repositoryLinks(
      linkify(renderReferenceBody(declaration.doc, single ? 2 : 3), hrefs, module.href),
      module.info.repositoryPath,
    );

    if (!single) {
      lines.push("", `## ${declaration.name}`, "", kindLine(declaration.doc));
    }

    if (body !== "") lines.push("", body);
  }

  return `${lines.join("\n")}\n`;
};

const renderMeta = (title: string, pages: ReadonlyArray<string>, icon?: string): string => {
  const inline = `  pages: [${pages.map((page) => JSON.stringify(page)).join(", ")}],`;

  const renderedPages =
    inline.length <= 100
      ? [inline]
      : ["  pages: [", ...pages.map((page) => `    ${JSON.stringify(page)},`), "  ],"];

  const lines = [
    'import { defineMeta } from "blume";',
    "",
    "export default defineMeta({",
    `  title: ${JSON.stringify(title)},`,
  ];

  if (icon !== undefined) lines.push(`  icon: ${JSON.stringify(icon)},`);
  lines.push(...renderedPages, "});");

  return `${lines.join("\n")}\n`;
};

const byTitle = (left: { readonly title: string }, right: { readonly title: string }): number =>
  left.title.localeCompare(right.title, "en", { sensitivity: "base" });

const renderPackageIndex = (reference: PackageReference): string => {
  const lines = [
    "---",
    `title: ${JSON.stringify(reference.title)}`,
    `description: ${JSON.stringify(reference.description)}`,
    "sidebar:",
    "  label: Overview",
    "---",
    "",
    reference.description,
    "",
    "## Entry points",
    "",
    "| Import | Source |",
    "| --- | --- |",
  ];

  for (const entry of reference.entries) {
    const source = entry.target.replace(/^\.\//, "");
    const target = normalizeSeparators(`${reference.pkg.dir}/${source}`);
    lines.push(`| \`${entry.specifier}\` | [\`${source}\`](${REPOSITORY}/${target}) |`);
  }

  lines.push("", "## Modules", "");

  const moduleLine = (module: ModulePage): string =>
    `- [${module.title}](${module.href}): ${pageDescription(module)}`;

  for (const module of reference.modules) lines.push(moduleLine(module));

  for (const group of reference.groups) {
    lines.push("", `### ${group.title}`, "");

    for (const module of group.modules) lines.push(moduleLine(module));
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

const tryApi = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ReferenceSyntaxError({ message, cause }),
  });

const readSource = Effect.fn("Reference.readSource")(function* (program: Program, file: string) {
  const source = yield* tryApi(`Failed to read ${file}`, () => program.getSourceFile(file));

  if (source === undefined) {
    return yield* new ReferenceSyntaxError({ message: `Missing source file ${file}` });
  }

  return source;
});

const openSyntaxProject = Effect.fn("Reference.openSyntaxProject")(function* (
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "paykit-reference-" });
  const configPath = path.join(directory, "tsconfig.json");

  yield* fs.writeFileString(
    configPath,
    JSON.stringify({
      files,
      compilerOptions: {
        noResolve: true,
        noLib: true,
        types: [],
        jsx: "preserve",
      },
    }),
  );

  const api = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new API(),
      catch: (cause) => new ReferenceSyntaxError({ message: "Failed to start tsrs", cause }),
    }),
    (instance) => tryApi("Failed to close tsrs", () => instance.close()).pipe(Effect.ignore),
  );

  const snapshot = yield* tryApi("Failed to open the syntax project", () =>
    api.createSnapshot({ openProjects: [configPath] }),
  );

  const project = snapshot.getConfiguredProject(configPath);

  if (project === undefined) {
    return yield* new ReferenceSyntaxError({ message: `Failed to open ${configPath}` });
  }

  const diagnostics = yield* tryApi("Failed to read syntax diagnostics", () =>
    project.program.getSyntacticDiagnostics(),
  );

  if (diagnostics.length > 0) {
    return yield* new ReferenceSyntaxError({ message: formatDiagnostics(diagnostics, api) });
  }

  return project.program;
});

const discoverSources = Effect.fn("Reference.discoverSources")(function* (root: string) {
  const path = yield* Path.Path;

  const packages = (yield* workspacePackages(root, "packages"))
    .filter((pkg) => pkg.manifest.name.startsWith("@potion.run/paykit"))
    .sort((left, right) => {
      const leftIndex = PACKAGE_ORDER.indexOf(packageSlugOf(left.manifest.name));
      const rightIndex = PACKAGE_ORDER.indexOf(packageSlugOf(right.manifest.name));

      return leftIndex - rightIndex;
    });

  const sources: Array<SourceFileInfo> = [];

  for (const pkg of packages) {
    const slug = packageSlugOf(pkg.manifest.name);
    const src = path.join(root, pkg.dir, "src");
    const files = yield* filesUnder(src);

    for (const file of files) {
      if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
      const repositoryPath = normalizeSeparators(path.join(pkg.dir, "src", file));
      sources.push({
        packageSlug: slug,
        packageName: pkg.manifest.name,
        absolute: path.join(src, file),
        repositoryPath,
        directory:
          normalizeSeparators(path.dirname(file)) === "."
            ? ""
            : normalizeSeparators(path.dirname(file)),
        base: path.basename(file, ".ts"),
      });
    }
  }

  sources.sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));

  return { packages, sources };
});

const scan = Effect.fn("Reference.scan")(function* (
  program: Program,
  sources: ReadonlyArray<SourceFileInfo>,
) {
  const scanned: Array<ScannedFile> = [];

  for (const info of sources) {
    const sourceFile = yield* readSource(program, info.absolute);
    scanned.push({
      info,
      declarations: declarationsOf(sourceFile),
      exports: exportsOf(sourceFile),
    });
  }

  return scanned;
});

/**
 * The declarations the package actually exposes, as `file#name` keys. An entry
 * exposes every name it exports; a named re-export exposes only the name it
 * names; `export *` and `export * as` expose everything their target exports.
 * Following the edge, not just the file, keeps a helper that a public file
 * happens to export out of the reference.
 */
const publicNamesOf = (
  entries: ReadonlyArray<string>,
  scanned: ReadonlyArray<ScannedFile>,
  path: Path.Path,
): ReadonlySet<string> => {
  const byFile = new Map(scanned.map((file) => [file.info.absolute, file]));
  const exportedNames = new Map<string, Set<string>>();

  for (const file of scanned) {
    exportedNames.set(file.info.absolute, new Set(file.exports.names));
  }

  let changed = true;

  while (changed) {
    changed = false;

    for (const file of scanned) {
      const names = exportedNames.get(file.info.absolute);

      if (names === undefined) continue;

      for (const specifier of file.exports.stars) {
        const target = resolveTarget(file.info.absolute, specifier, path);

        if (target === undefined) continue;

        for (const name of exportedNames.get(target) ?? []) {
          if (names.has(name)) continue;
          names.add(name);
          changed = true;
        }
      }
    }
  }

  const exposed = new Set<string>();
  const seen = new Set<string>();
  const pending: Array<{ readonly file: string; readonly name: string }> = [];

  const enqueue = (file: string, name: string): void => {
    const key = `${file}#${name}`;

    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ file, name });
  };

  for (const entry of entries) {
    for (const name of exportedNames.get(entry) ?? []) enqueue(entry, name);
  }

  while (pending.length > 0) {
    const item = pending.pop();

    if (item === undefined) continue;
    const file = byFile.get(item.file);

    if (file === undefined) continue;

    const named = file.exports.named.get(item.name);

    if (named !== undefined) {
      if (named.target === undefined) {
        enqueue(item.file, named.local);
      } else {
        const target = resolveTarget(item.file, named.target, path);

        if (target !== undefined) enqueue(target, named.local);
      }

      continue;
    }

    if (file.exports.own.has(item.name)) {
      exposed.add(`${item.file}#${item.name}`);
      continue;
    }

    const namespace = file.exports.namespaces.get(item.name);

    if (namespace !== undefined) {
      const target = resolveTarget(item.file, namespace, path);

      if (target === undefined) continue;

      for (const name of exportedNames.get(target) ?? []) enqueue(target, name);
      continue;
    }

    for (const specifier of file.exports.stars) {
      const target = resolveTarget(item.file, specifier, path);

      if (target === undefined) continue;

      if (exportedNames.get(target)?.has(item.name) ?? false) enqueue(target, item.name);
    }
  }

  return exposed;
};

const planPackage = (
  root: string,
  pkg: WorkspacePackage,
  scanned: ReadonlyArray<ScannedFile>,
  path: Path.Path,
): PackagePlan => {
  const slug = packageSlugOf(pkg.manifest.name);
  const entries = entryPointsOf(pkg);

  const entryRepositoryPaths = new Set(
    entries.map((entry) => normalizeSeparators(path.join(pkg.dir, entry.target))),
  );

  const entryFiles = scanned.flatMap((file) =>
    entryRepositoryPaths.has(file.info.repositoryPath) ? [file.info.absolute] : [],
  );

  const exposed = publicNamesOf(entryFiles, scanned, path);
  const problems: Array<string> = [];
  const tagged: Array<ScannedFile> = [];

  for (const file of scanned) {
    for (const declaration of file.declarations) {
      if (!exposed.has(`${file.info.absolute}#${declaration.name}`)) {
        problems.push(
          `${file.info.repositoryPath}:${declaration.line}: @${declaration.doc.kind ?? "primitive"} on "${declaration.name}" is not exported from a package entry; move the doc to the public declaration`,
        );
      }
    }

    if (file.declarations.length > 0) tagged.push(file);
  }

  if (problems.length > 0) {
    return {
      reference: {
        pkg,
        slug,
        title: "",
        description: "",
        entries,
        modules: [],
        groups: [],
        outputDir: "",
      },
      problems,
    };
  }

  const bases = new Set(tagged.map((file) => file.info.base));
  const titled = tagged.map((file) => ({ file, title: moduleTitleOf(file, bases) }));

  // A single-declaration page borrows its export name, which can collide with a
  // sibling module's stem. When it does, both keep the file name so the sidebar
  // has one row per page.
  const byPageSlug = new Map<string, Array<(typeof titled)[number]>>();

  for (const item of titled) {
    const key = `${item.file.info.directory}/${slugOf(item.title)}`;
    const group = byPageSlug.get(key) ?? [];
    group.push(item);
    byPageSlug.set(key, group);
  }

  for (const group of byPageSlug.values()) {
    if (group.length < 2) continue;

    for (const item of group) item.title = item.file.info.base;
  }

  const moduleByFile = new Map<string, ModulePage>();

  for (const { file, title } of titled) {
    const pageSlug = slugOf(title);
    const groupSlug = file.info.directory === "" ? "" : slugOf(file.info.directory);

    const output = path.join(
      root,
      DOCS_ROOT,
      slug,
      file.info.directory === "" ? "" : groupSlug,
      `${pageSlug}.md`,
    );

    const href = `/reference/${slug}/${file.info.directory === "" ? "" : `${groupSlug}/`}${pageSlug}`;
    moduleByFile.set(file.info.absolute, {
      info: file.info,
      title,
      slug: pageSlug,
      groupSlug,
      href,
      output,
      declarations: file.declarations,
    });
  }

  const modules = [...moduleByFile.values()].sort(byTitle);
  const groupsBySlug = new Map<string, Array<ModulePage>>();

  for (const module of modules) {
    if (module.groupSlug === "") continue;
    const group = groupsBySlug.get(module.groupSlug) ?? [];
    group.push(module);
    groupsBySlug.set(module.groupSlug, group);
  }

  const groups = [...groupsBySlug.entries()]
    .map(([groupSlug, groupModules]) => ({
      slug: groupSlug,
      title: groupModules[0]?.info.directory.split("/").at(-1) ?? groupSlug,
      modules: groupModules,
    }))
    .sort(byTitle);

  const description =
    typeof pkg.raw["description"] === "string"
      ? pkg.raw["description"]
      : `${pkg.manifest.name} modules.`;

  return {
    reference: {
      pkg,
      slug,
      title: packageTitleOf(slug),
      description,
      entries,
      modules: modules.filter((module) => module.groupSlug === ""),
      groups,
      outputDir: path.join(root, DOCS_ROOT, slug),
    },
    problems,
  };
};

const linkIndex = (references: ReadonlyArray<PackageReference>): ReadonlyMap<string, string> => {
  const links = new Map<string, string>();

  for (const reference of references) {
    for (const module of [
      ...reference.modules,
      ...reference.groups.flatMap((group) => group.modules),
    ]) {
      for (const declaration of module.declarations) {
        if (!links.has(declaration.name)) links.set(declaration.name, module.href);
      }
    }
  }

  return links;
};

const planFiles = (
  references: ReadonlyArray<PackageReference>,
  links: ReadonlyMap<string, string>,
  path: Path.Path,
): ReadonlyArray<PlannedFile> => {
  const files: Array<PlannedFile> = [];

  for (const reference of references) {
    files.push({
      path: path.join(reference.outputDir, "index.md"),
      content: renderPackageIndex(reference),
    });

    const rootPages = reference.modules.map((module) => module.slug);
    const groupPages = reference.groups.map((group) => group.slug);
    files.push({
      path: path.join(reference.outputDir, "meta.ts"),
      content: renderMeta(reference.title, ["index", ...rootPages, ...groupPages], "package"),
    });

    for (const module of [
      ...reference.modules,
      ...reference.groups.flatMap((group) => group.modules),
    ]) {
      files.push({ path: module.output, content: renderModule(module, links) });
    }

    for (const group of reference.groups) {
      files.push({
        path: path.join(reference.outputDir, group.slug, "meta.ts"),
        content: renderMeta(
          group.title,
          group.modules.map((module) => module.slug),
        ),
      });
    }
  }

  return files;
};

const writeIfChanged = Effect.fn("Reference.writeIfChanged")(function* (file: PlannedFile) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const current = yield* fs
    .readFileString(file.path)
    .pipe(Effect.orElseSucceed((): string | undefined => undefined));

  if (current === file.content) return false;
  yield* fs.makeDirectory(path.dirname(file.path), { recursive: true });
  yield* fs.writeFileString(file.path, file.content);

  return true;
});

const prune = Effect.fn("Reference.prune")(function* (
  directory: string,
  keep: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const visit: (current: string) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fn(
    "Reference.pruneDirectory",
  )(function* (current: string) {
    if (!(yield* fs.exists(current))) return;

    for (const entry of yield* fs.readDirectory(current)) {
      const full = path.join(current, entry);

      if ((yield* fs.stat(full)).type === "Directory") {
        yield* visit(full);

        if ((yield* fs.readDirectory(full)).length === 0) {
          yield* fs.remove(full, { recursive: true }).pipe(Effect.ignore);
        }
      } else if (!keep.has(path.resolve(full))) {
        yield* fs.remove(full, { force: true });
      }
    }
  });

  yield* visit(directory);
});

const verifyPlan = Effect.fn("Reference.verifyPlan")(function* (
  files: ReadonlyArray<PlannedFile>,
  references: ReadonlyArray<PackageReference>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const planned = new Set(files.map((file) => path.resolve(file.path)));
  const problems: Array<string> = [];

  for (const file of files) {
    const current = yield* fs
      .readFileString(file.path)
      .pipe(Effect.orElseSucceed((): string | undefined => undefined));

    if (current === undefined) problems.push(`missing ${file.path}`);
    else if (current !== file.content) problems.push(`stale ${file.path}`);
  }

  for (const reference of references) {
    if (!(yield* fs.exists(reference.outputDir))) continue;
    const existing = yield* filesUnder(reference.outputDir);

    for (const file of existing) {
      const full = path.resolve(path.join(reference.outputDir, file));

      if (planned.has(full)) continue;

      if (!file.endsWith(".md") && file !== "meta.ts") continue;
      problems.push(`stale ${path.join(reference.outputDir, file)}`);
    }
  }

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new ReferenceDrift({
      message: `The module reference is out of date; run \`pnpm docs:reference\``,
      problems,
    });
  }

  yield* Console.log(`The module reference is current (${files.length} files).`);
});

const generate = Effect.fn("Reference.generate")(function* (check: boolean) {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");

  const { packages, sources } = yield* discoverSources(root);

  const plans = yield* Effect.scoped(
    Effect.gen(function* () {
      const program = yield* openSyntaxProject(sources.map((source) => source.absolute));
      const scanned = yield* scan(program, sources);

      return packages.map((pkg) => {
        const slug = packageSlugOf(pkg.manifest.name);

        return planPackage(
          root,
          pkg,
          scanned.filter((file) => file.info.packageSlug === slug),
          path,
        );
      });
    }),
  );

  const problems = plans.flatMap((plan) => plan.problems);

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new ReferenceTagError({
      message: `${problems.length} reference tag(s) do not point at a public declaration`,
      problems,
    });
  }

  const references = plans.map((plan) => plan.reference);
  const links = linkIndex(references);
  const files = planFiles(references, links, path);

  if (check) {
    yield* verifyPlan(files, references);

    return;
  }

  const keep = new Set(files.map((file) => path.resolve(file.path)));
  let written = 0;

  for (const file of files) {
    if (yield* writeIfChanged(file)) written += 1;
  }

  for (const reference of references) {
    yield* prune(reference.outputDir, keep);
  }

  const unchanged = files.length - written;
  yield* Console.log(
    `Generated ${files.length} reference files in ${DOCS_ROOT} (${written} written, ${unchanged} unchanged).`,
  );
});

const check = process.argv.includes("--check");

generate(check).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
