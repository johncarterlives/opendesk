// The settings index, read from the code at build time: every settings page's title,
// sections, rows and the field labels inside them, as i18n keys. The app resolves the
// keys in the active language (src/lib/appSearch), so the index is the same for every
// locale and never holds copied text that could drift.
//
// What it reads (TypeScript's parser, no type checking):
//   - src/router.tsx: which page file serves which /settings route;
//   - each page file and the components it imports from files that use the settings
//     layout (@/components/layout): <SettingsPage title description>, <Section title
//     description>, <Row label description>, and <Field label hint> / <SettingsEmpty
//     title description> as extra words of the section or row around them;
//   - the `&&` and `?:` conditions around each element, also where its component is used,
//     as gates (admin, owner, collab, tickets, ai, cloud, selfHosted).
// A label must be a literal t("key") of a useTranslation("ns") in scope and exist in the
// English catalog; computed labels are left out.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { Gate, Ref, SettingsEntry, SettingsIndex } from "../src/lib/appSearch/types.ts";

export type { SettingsEntry, SettingsIndex };

type Catalog = Map<string, string>;

function flatten(o: unknown, prefix = "", out: Catalog = new Map()): Catalog {
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else if (typeof o === "string") out.set(prefix, o);
  return out;
}

function readCatalogs(web: string): Map<string, Catalog> {
  const dir = path.join(web, "src/i18n/locales/en");
  const out = new Map<string, Catalog>();
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) out.set(f.slice(0, -5), flatten(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
  return out;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    parsed.set(file, sf);
  }
  return sf;
}

function walk(n: ts.Node, fn: (n: ts.Node) => void) {
  fn(n);
  n.forEachChild((c) => walk(c, fn));
}

const str = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

interface Route {
  path: string;
  title?: string;
}

/** Page file (absolute, without extension) → its route, from src/router.tsx. */
function readRoutes(web: string): Map<string, Route> {
  const file = path.join(web, "src/router.tsx");
  const sf = parse(file);
  const out = new Map<string, Route>();
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || n.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
    const spec = str(n.arguments[0]);
    if (!spec?.startsWith("./pages/settings/")) return;
    let route: Route | undefined;
    for (let p: ts.Node | undefined = n.parent; p && !route; p = p.parent) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "settingsPage") {
        const sub = str(p.arguments[0]);
        if (sub) route = { path: sub, title: str(p.arguments[1]) };
      } else if (ts.isObjectLiteralExpression(p)) {
        const prop = (name: string) => p.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === name);
        const sub = str(prop("path")?.initializer);
        if (!sub) continue;
        const data = prop("staticData")?.initializer;
        const title = data && ts.isObjectLiteralExpression(data) ? str(data.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === "title")?.initializer) : undefined;
        route = { path: sub, title };
      }
    }
    if (route) out.set(path.resolve(path.dirname(file), spec), { ...route, path: `/settings${route.path}` });
  });
  return out;
}

function resolveImport(from: string, spec: string, web: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(web, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return undefined;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) if (fs.existsSync(base + ext)) return base + ext;
  return undefined;
}

/** A file builds settings UI when it uses the settings layout's parts. */
const usesLayout = (sf: ts.SourceFile) => /from "@\/components\/layout"/.test(sf.text);

/** The function a node is in, outermost first stops at the file. */
function enclosingFunctions(n: ts.Node): ts.FunctionLikeDeclaration[] {
  const out: ts.FunctionLikeDeclaration[] = [];
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) && "body" in p) out.push(p as ts.FunctionLikeDeclaration);
  return out;
}

/** The name a top-level component is used by in JSX: function X() or const X = () =>. */
function componentName(n: ts.Node): string | undefined {
  const fns = enclosingFunctions(n);
  const top = fns[fns.length - 1];
  if (!top) return undefined;
  if (ts.isFunctionDeclaration(top)) return top.name?.text;
  const decl = top.parent;
  if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
  // memo(function X() {}) / forwardRef(...)
  if (ts.isFunctionExpression(top) && top.name) return top.name.text;
  if (decl && ts.isCallExpression(decl) && decl.parent && ts.isVariableDeclaration(decl.parent) && ts.isIdentifier(decl.parent.name)) return decl.parent.name.text;
  return undefined;
}

/** t aliases → namespace, from `const { t: alias } = useTranslation("ns")` in fn (or the file). */
const translatorCache = new WeakMap<ts.Node, Map<string, string>>();
function translators(scope: ts.Node): Map<string, string> {
  const cached = translatorCache.get(scope);
  if (cached) return cached;
  const out = new Map<string, string>();
  translatorCache.set(scope, out);
  const visit = (n: ts.Node) => {
    if (n !== scope && ts.isFunctionLike(n)) return;
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === "useTranslation") {
      const ns = str(n.initializer.arguments[0]);
      if (ns && ts.isObjectBindingPattern(n.name))
        for (const el of n.name.elements) if (el.name && ts.isIdentifier(el.name) && (el.propertyName?.getText() ?? el.name.text) === "t") out.set(el.name.text, ns);
    }
    n.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return out;
}

function nsOf(call: ts.CallExpression, name: string): string | undefined {
  for (const fn of enclosingFunctions(call)) {
    const ns = translators(fn.body ?? fn).get(name);
    if (ns) return ns;
  }
  return translators(call.getSourceFile()).get(name);
}

/** The first literal t("key") in an expression, as "ns:key". */
function refIn(expr: ts.Node | undefined, cats: Map<string, Catalog>): Ref | undefined {
  if (!expr) return undefined;
  let found: Ref | undefined;
  walk(expr, (n) => {
    if (found || !ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
    const key = str(n.arguments[0]);
    if (!key) return;
    let ns = nsOf(n, n.expression.text);
    const opts = n.arguments[1];
    if (opts && ts.isObjectLiteralExpression(opts)) {
      const o = opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "ns");
      ns = str(o?.initializer) ?? ns;
    }
    let k = key;
    if (key.includes(":")) [ns, k] = key.split(":", 2);
    const value = ns ? cats.get(ns)?.get(k) : undefined;
    // A label with a placeholder reads differently on the page: only its words are kept (as extra text).
    // One that is only placeholders ("{{a}} of {{b}}") says nothing to search for.
    if (value !== undefined && /\p{L}/u.test(value.replace(/\{\{[^}]*\}\}/g, ""))) found = `${ns}:${k}`;
  });
  return found;
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined {
  for (const p of el.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name || !p.initializer) continue;
    if (ts.isJsxExpression(p.initializer)) return p.initializer.expression;
    return p.initializer as ts.Expression;
  }
  return undefined;
}

const tagName = (el: ts.JsxOpeningLikeElement) => el.tagName.getText();

const GATES: [RegExp, Gate, boolean?][] = [
  [/\bowner\b|isOwner/i, "owner"],
  [/\badmin\b|isAdmin|canAdmin|"admin"/, "admin"],
  [/collab/i, "collab"],
  [/ticketsOn|tickets_enabled|\btickets\b/, "tickets"],
  [/\bai\??\.enabled|aiOn|aiEnabled/, "ai"],
  [/billing_enabled|showCollab|hasSubscription/, "cloud"],
];

/** The gates one condition puts on what it shows; `negated` when the element is its else branch. */
function gatesOf(cond: ts.Expression, negated: boolean): Gate[] {
  const text = cond.getText();
  const out: Gate[] = [];
  // isSelfHosted(b) ? <self-hosted> : <cloud>
  if (/isSelfHosted\(/.test(text)) {
    const not = /!\s*isSelfHosted\(/.test(text);
    out.push(not !== negated ? "cloud" : "selfHosted");
  }
  if (negated) return out;
  // `!admin && …` shows to everyone else: only plain conditions gate.
  for (const [re, gate] of GATES) {
    const m = text.match(re);
    if (!m) continue;
    const before = text.slice(0, m.index);
    if (/!\s*\(?\s*[\w.?]*$/.test(before)) continue;
    out.push(gate);
  }
  return out;
}

interface Context {
  gates: Set<Gate>;
  section?: Ref;
  row?: Ref;
}

type Usage = { file: string; node: ts.Node };

class Indexer {
  entries: SettingsEntry[] = [];
  private seen = new Set<string>();
  // component name in a file → where it is used (same file, or the file that imported it)
  private usages = new Map<string, Usage[]>();

  private web: string;
  private cats: Map<string, Catalog>;

  constructor(web: string, cats: Map<string, Catalog>) {
    this.web = web;
    this.cats = cats;
  }

  /** Records the JSX uses of each component a file defines, in that file and in files that import it. */
  private noteUsages(file: string, sf: ts.SourceFile, imported: Map<string, string>) {
    walk(sf, (n) => {
      if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
      const name = tagName(n);
      const target = imported.get(name) ?? file;
      const k = `${target}#${name}`;
      const list = this.usages.get(k) ?? [];
      if (!list.some((u) => u.node === n)) list.push({ file, node: n });
      this.usages.set(k, list);
    });
  }

  /** The gates and the section around a node, following its component to where it is used. */
  private context(node: ts.Node, files: string[], depth = 0): Context {
    const ctx: Context = { gates: new Set() };
    let p: ts.Node = node;
    for (let up = node.parent; up; p = up, up = up.parent) {
      if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && up.right === p) gatesOf(up.left, false).forEach((g) => ctx.gates.add(g));
      if (ts.isConditionalExpression(up) && (up.whenTrue === p || up.whenFalse === p)) gatesOf(up.condition, up.whenFalse === p).forEach((g) => ctx.gates.add(g));
      if (ts.isJsxElement(up) && p !== up.openingElement) {
        const tag = tagName(up.openingElement);
        if (tag === "Section" && !ctx.section) ctx.section = refIn(attr(up.openingElement, "title"), this.cats);
        if (tag === "Row" && !ctx.row) ctx.row = refIn(attr(up.openingElement, "label"), this.cats);
      }
    }
    const name = componentName(node);
    if (!name || depth > 4) return ctx;
    // Where this page uses it: a component shared by two pages sits in different sections of each.
    const uses = (this.usages.get(`${path.resolve(node.getSourceFile().fileName)}#${name}`) ?? []).filter((u) => files.includes(u.file));
    if (!uses.length) return ctx;
    const outer = uses.map((u) => this.context(u.node, files, depth + 1));
    // A gate holds when every use has it.
    for (const g of outer[0].gates) if (outer.every((o) => o.gates.has(g))) ctx.gates.add(g);
    ctx.section ??= outer[0].section;
    ctx.row ??= outer[0].row;
    return ctx;
  }

  private add(e: SettingsEntry) {
    const id = `${e.r}|${e.n ?? ""}|${e.k}|${e.t}`;
    if (this.seen.has(id)) {
      // The same label twice on a page (a loading and a loaded state): one entry, the words of both.
      const prev = this.entries.find((x) => `${x.r}|${x.n ?? ""}|${x.k}|${x.t}` === id)!;
      for (const x of e.x ?? []) if (!prev.x?.includes(x)) (prev.x ??= []).push(x);
      if (prev.g && !e.g) delete prev.g;
      return;
    }
    this.seen.add(id);
    this.entries.push(e);
  }

  /** Indexes a page file and the settings components it imports. */
  page(file: string, route: string, detail: string | undefined) {
    const files: string[] = [];
    const visit = (f: string) => {
      if (files.includes(f)) return;
      const sf = parse(f);
      if (f !== file && !usesLayout(sf)) return;
      files.push(f);
      const imported = new Map<string, string>();
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
        const target = resolveImport(f, (st.moduleSpecifier as ts.StringLiteral).text, this.web);
        if (!target || !target.startsWith(path.join(this.web, "src"))) continue;
        const named = st.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) for (const el of named.elements) imported.set(el.name.text, target);
        if (st.importClause?.name) imported.set(st.importClause.name.text, target);
        if (usesLayout(parse(target))) visit(target);
      }
      this.noteUsages(f, sf, imported);
    };
    visit(file);
    const extras = new Map<string, Ref[]>(); // owner entry key → refs
    for (const f of files) {
      walk(parse(f), (n) => {
        if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
        const tag = tagName(n);
        const at = ts.isJsxOpeningElement(n) ? n.parent : n;
        if (tag === "SettingsPage" || tag === "Section" || tag === "Row") {
          const title = refIn(attr(n, tag === "Row" ? "label" : "title"), this.cats);
          if (!title) return;
          if (tag === "SettingsPage" && f !== file) return;
          const ctx = this.context(at, files);
          const d = refIn(attr(n, "description"), this.cats);
          const g = [...ctx.gates].sort();
          this.add({
            r: route,
            k: tag === "SettingsPage" ? "p" : tag === "Section" ? "s" : "r",
            t: title,
            ...(d && d !== title ? { d } : {}),
            ...(tag === "Row" && ctx.section ? { s: ctx.section } : {}),
            ...(g.length ? { g } : {}),
            ...(detail ? { n: detail } : {}),
          });
        } else if (tag === "Field" || tag === "SettingsEmpty") {
          const refs = [refIn(attr(n, tag === "Field" ? "label" : "title"), this.cats), refIn(attr(n, tag === "Field" ? "hint" : "description"), this.cats)].filter((x): x is Ref => !!x);
          if (!refs.length) return;
          const ctx = this.context(at, files);
          const owner = ctx.row ? `r|${ctx.row}` : ctx.section ? `s|${ctx.section}` : "p";
          extras.set(owner, [...(extras.get(owner) ?? []), ...refs]);
        }
      });
    }
    for (const e of this.entries) {
      if (e.r !== route || e.n !== detail) continue;
      const x = [...new Set([...(e.x ?? []), ...(extras.get(e.k === "p" ? "p" : `${e.k}|${e.t}`) ?? [])])].filter((r) => r !== e.t && r !== e.d);
      if (x.length) e.x = x;
    }
  }
}

/** Builds the index from the web app's source. */
export function buildSettingsIndex(web: string): SettingsIndex {
  parsed.clear();
  const cats = readCatalogs(web);
  const routes = readRoutes(web);
  const ix = new Indexer(web, cats);
  const pages: Record<string, Ref> = {};
  // List pages first, so a detail page's entries join a list that has its title.
  const ordered = [...routes].sort(([, a], [, b]) => Number(a.path.includes("$")) - Number(b.path.includes("$")) || a.path.localeCompare(b.path));
  for (const [base, route] of ordered) {
    const file = resolveImport(base, base, web) ?? [".tsx", ".ts"].map((x) => base + x).find((x) => fs.existsSync(x));
    // The layout around every page has no settings of its own.
    if (!file || route.path === "/settings/settings") continue;
    const detail = route.path.includes("$");
    // A page behind an id (a mailbox, a brand) opens from its list.
    const at = detail ? route.path.slice(0, route.path.indexOf("/$")) : route.path;
    if (!detail && route.title && cats.get("navigation")?.has(`titles.${route.title}`)) pages[at] = `navigation:titles.${route.title}`;
    if (detail && !Object.keys(pages).includes(at) && ![...routes.values()].some((r) => r.path === at)) continue;
    ix.page(file, at, detail ? route.path : undefined);
  }
  return { pages, entries: ix.entries };
}
