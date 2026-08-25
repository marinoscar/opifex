#!/usr/bin/env node
// =============================================================================
// Check every Prisma argument literal against the generated input types (#159)
// =============================================================================
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// `tsc` does not check the contents of `data:`, `where:`, `select:` or any
// other slot of a Prisma call. An invented field name compiles cleanly and
// Prisma then REJECTS the whole query at runtime with
// `PrismaClientValidationError: Unknown argument`. It does not drop the field
// quietly — it throws — so the write does not half-happen, it fails entirely.
//
// This is not theoretical. The audit that produced this script found
// `run.updateMany({ data: { ..., branch } })` in `run-events.service.ts`, on a
// model with no `branch` column, reached by every successful run of the
// built-in runner. It compiled, and the unit test asserted it, because Prisma
// is a double there.
//
// WHY THE COMPILER CANNOT SEE IT
// -----------------------------------------------------------------------------
// The generated delegate is:
//
//     update<T extends RoleUpdateArgs>(args: SelectSubset<T, RoleUpdateArgs>)
//     type SelectSubset<T, U> = { [key in keyof T]: key extends keyof U ? T[key] : never }
//
// `T` is inferred FROM the argument literal. For any key that exists on `U`
// — `where`, `data`, `create`, `update`, `select`, `include`, `orderBy` — the
// mapped type gives back `T[key]`, i.e. the literal's own inferred type. The
// real input type (`RoleUpdateInput` and friends) is therefore never the
// contextual type of the nested object, and excess-property checking has
// nothing to check against.
//
// Verified against the repo's own tsc and generated client, with a deliberate
// control error to prove the probe file was compiled:
//
//   silent: create, createMany, update, updateMany, upsert.create,
//           upsert.update, where, whereUnique, orderBy, select, include,
//           nested relation writes, field operators ({ set: ... })
//   caught: an unknown key at the TOP level of the args object, as
//           `TS2322: Type 'number' is not assignable to type 'never'`
//           (the `: never` arm above — one level deep only)
//   caught: the same literal under `satisfies Prisma.RoleUpdateInput`, or
//           with the args object annotated `: Prisma.RoleUpdateArgs`
//
// The union (`XOR<Checked, Unchecked>`) is NOT the cause: a hand-written
// `<T extends Prisma.RoleUpdateInput>(data: T)` wrapper leaks identically,
// while the same function with a non-generic `data: Prisma.RoleUpdateInput`
// parameter catches it. Generic inference is what defeats the check.
//
// WHY A SCRIPT AND NOT A `satisfies` CONVENTION OR A LINT RULE
// -----------------------------------------------------------------------------
// Because `satisfies` would not have caught the one real bug in the tree.
// TypeScript does not excess-property-check SPREAD-contributed properties, and
// the defect was `...(result?.branch ? { branch: result.branch } : {})`. A rule
// mandating `satisfies` on `data:` literals would have passed that line while
// creating the impression the class was covered — worse than nothing. This
// script resolves conditional spreads and named consts, so it sees it.
//
// WHAT IT DOES NOT COVER
// -----------------------------------------------------------------------------
// Values it cannot follow statically — a `data:` built by a helper function, a
// spread of a call result, a computed key. Those are listed in the output
// under "not statically checkable" and do NOT fail the run, so the number is
// visible rather than pretended away.
//
// Usage:  npm -w apps/api run check:prisma-fields
//         (needs the generated client: npm -w apps/api run prisma:generate)
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const API_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SRC_DIR = path.join(API_DIR, 'src');

/** The generated client's declarations — the only oracle that cannot drift. */
function locateClientTypes() {
  const candidates = [];
  for (let dir = API_DIR; ; dir = path.dirname(dir)) {
    candidates.push(
      path.join(dir, 'node_modules/.prisma/client/index.d.ts'),
      path.join(dir, 'node_modules/@prisma/client/index.d.ts'),
    );
    if (path.dirname(dir) === dir) break;
  }
  const found = candidates.find(
    (p) =>
      fs.existsSync(p) &&
      fs.readFileSync(p, 'utf8').includes('WhereUniqueInput'),
  );
  if (!found) {
    console.error(
      'Could not find the generated Prisma client declarations.\n' +
        'Run `npm -w apps/api run prisma:generate` first.',
    );
    process.exit(2);
  }
  return found;
}

const DTS_PATH = locateClientTypes();
const dts = ts.createSourceFile(
  DTS_PATH,
  fs.readFileSync(DTS_PATH, 'utf8'),
  ts.ScriptTarget.ESNext,
  true,
);

// ---------------------------------------------------------------- oracle ----

/** Every `type X = ...` / `interface X` in the generated client. */
const aliases = new Map();
(function collect(node) {
  if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
  if (ts.isInterfaceDeclaration(node)) aliases.set(node.name.text, node);
  ts.forEachChild(node, collect);
})(dts);

/**
 * Generic helpers whose members are those of their arguments. If a Prisma
 * upgrade renames one of these, `membersOf` returns nothing for the types that
 * use it and the run FAILS with "unresolved" rather than quietly checking
 * fewer literals — a silent audit is the failure mode this script exists to
 * prevent.
 */
const PASS_THROUGH_ALL = new Set(['XOR', 'Without', 'Subset', 'SelectSubset']);
const PASS_THROUGH_FIRST = new Set([
  'AtLeast',
  'Enumerable',
  'Array',
  'ReadonlyArray',
  'NonNullable',
  'GetSelect',
]);

/** Json columns accept arbitrary keys by definition; nothing to check. */
const OPEN_TYPES = new Set([
  'InputJsonValue',
  'InputJsonObject',
  'JsonValue',
  'JsonObject',
  'NullableJsonNullValueInput',
  'JsonNullValueInput',
]);

const OPEN = Symbol('open');

/**
 * The set of property names a type accepts, mapped to the type node of each,
 * or OPEN when the type accepts anything.
 */
function membersOf(typeNode, depth = 0, seen = new Set()) {
  const out = new Map();
  if (!typeNode || depth > 12) return out;

  if (ts.isParenthesizedTypeNode(typeNode))
    return membersOf(typeNode.type, depth + 1, seen);

  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const t of typeNode.types) {
      const m = membersOf(t, depth + 1, seen);
      if (m === OPEN) return OPEN;
      for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
    }
    return out;
  }

  if (ts.isArrayTypeNode(typeNode))
    return membersOf(typeNode.elementType, depth + 1, seen);

  if (ts.isTypeLiteralNode(typeNode) || ts.isInterfaceDeclaration(typeNode)) {
    for (const m of typeNode.members) {
      if (ts.isIndexSignatureDeclaration(m)) return OPEN;
      if ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.name) {
        const n =
          ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
            ? m.name.text
            : null;
        if (n) out.set(n, m.type ?? null);
      }
    }
    return out;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const q = typeNode.typeName;
    const name = ts.isQualifiedName(q) ? q.right.text : q.text;
    if (OPEN_TYPES.has(name)) return OPEN;
    const args = typeNode.typeArguments ?? [];
    if (PASS_THROUGH_ALL.has(name) || PASS_THROUGH_FIRST.has(name)) {
      const take = PASS_THROUGH_FIRST.has(name) ? args.slice(0, 1) : args;
      for (const a of take) {
        const m = membersOf(a, depth + 1, seen);
        if (m === OPEN) return OPEN;
        for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
      }
      return out;
    }
    if (seen.has(name)) return out;
    const alias = aliases.get(name);
    if (alias) return membersOf(alias, depth + 1, new Set([...seen, name]));
    return out;
  }

  return out;
}

/** Delegate names (`prisma.workOrder`), derived from the generated types. */
const modelNames = new Set();
for (const name of aliases.keys()) {
  const m = /^(.+)UncheckedCreateInput$/.exec(name);
  if (m) modelNames.add(m[1][0].toLowerCase() + m[1].slice(1));
}

// ------------------------------------------------------------ op -> slots ---

const CREATE = ['CreateInput', 'UncheckedCreateInput'];
const UPDATE = ['UpdateInput', 'UncheckedUpdateInput'];
const UPDATE_MANY = ['UpdateManyMutationInput', 'UncheckedUpdateManyInput'];
const CREATE_MANY = ['CreateManyInput'];
const WHERE_UNIQUE = ['WhereUniqueInput'];
const WHERE = ['WhereInput'];
const SELECT = ['Select'];
const INCLUDE = ['Include'];
const ORDER_BY = ['OrderByWithRelationInput', 'OrderByWithAggregationInput'];

// Both the checked and the `Unchecked` variant, because the declared type is
// `XOR<checked, unchecked>` and scalar foreign keys (`userId`) live only on the
// unchecked one. Checking against the checked variant alone reports every
// foreign key in the codebase as unknown.
const READ_SLOTS = {
  select: SELECT,
  include: INCLUDE,
  orderBy: ORDER_BY,
  cursor: WHERE_UNIQUE,
};

const OPS = {
  create: { data: CREATE, ...READ_SLOTS },
  createMany: { data: CREATE_MANY },
  createManyAndReturn: { data: CREATE_MANY, ...READ_SLOTS },
  update: { data: UPDATE, where: WHERE_UNIQUE, ...READ_SLOTS },
  updateMany: { data: UPDATE_MANY, where: WHERE },
  upsert: {
    create: CREATE,
    update: UPDATE,
    where: WHERE_UNIQUE,
    ...READ_SLOTS,
  },
  delete: { where: WHERE_UNIQUE, ...READ_SLOTS },
  deleteMany: { where: WHERE },
  findUnique: { where: WHERE_UNIQUE, ...READ_SLOTS },
  findUniqueOrThrow: { where: WHERE_UNIQUE, ...READ_SLOTS },
  findFirst: { where: WHERE, ...READ_SLOTS },
  findFirstOrThrow: { where: WHERE, ...READ_SLOTS },
  findMany: { where: WHERE, ...READ_SLOTS },
  count: { where: WHERE, ...READ_SLOTS },
  aggregate: { where: WHERE, ...READ_SLOTS },
  groupBy: { where: WHERE, orderBy: ORDER_BY },
};

// ------------------------------------------------------- static resolution --

/** `const x = { ... }` in one file. Ambiguous names are dropped, not guessed. */
function constLiterals(sf) {
  const found = new Map();
  const duplicated = new Set();
  (function visit(n) {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer
    ) {
      const init = unwrap(n.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        if (found.has(n.name.text)) duplicated.add(n.name.text);
        found.set(n.name.text, init);
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
  for (const name of duplicated) found.delete(name);
  return found;
}

function unwrap(expr) {
  while (
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

/**
 * Every object literal a value expression can evaluate to.
 *
 * Follows named consts, `cond ? {…} : {…}` (both arms — an unknown key in the
 * branch not taken is still a bug waiting for its input), and
 * `xs.map((x) => ({…}))`, which is how `createMany` rows are built. Returns an
 * empty array when the value cannot be followed, and the caller records that
 * rather than assuming the value is fine.
 */
function objectLiteralsIn(expr, consts, depth = 0) {
  if (!expr || depth > 6) return [];
  const e = unwrap(expr);

  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isIdentifier(e)) {
    const c = consts.get(e.text);
    return c ? [c] : [];
  }
  if (ts.isConditionalExpression(e)) {
    return [
      ...objectLiteralsIn(e.whenTrue, consts, depth + 1),
      ...objectLiteralsIn(e.whenFalse, consts, depth + 1),
    ];
  }
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'map' &&
    e.arguments.length > 0
  ) {
    const cb = unwrap(e.arguments[0]);
    if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
      if (cb.body && !ts.isBlock(cb.body)) {
        return objectLiteralsIn(cb.body, consts, depth + 1);
      }
      if (cb.body && ts.isBlock(cb.body)) {
        const out = [];
        for (const stmt of cb.body.statements) {
          if (ts.isReturnStatement(stmt) && stmt.expression) {
            out.push(...objectLiteralsIn(stmt.expression, consts, depth + 1));
          }
        }
        return out;
      }
    }
    return [];
  }
  return [];
}

/** True for a value that means "this slot is absent", which needs no check. */
function isAbsent(expr) {
  const e = unwrap(expr);
  return (
    e.kind === ts.SyntaxKind.UndefinedKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined')
  );
}

/** Object literals a spread can contribute — including `...(c ? {a} : {})`. */
function spreadSources(expr, consts, depth = 0) {
  if (!expr || depth > 6) return [];
  const e = unwrap(expr);
  if (
    ts.isBinaryExpression(e) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(e.operatorToken.kind)
  ) {
    return [
      ...spreadSources(e.left, consts, depth + 1),
      ...spreadSources(e.right, consts, depth + 1),
    ];
  }
  return objectLiteralsIn(e, consts, depth);
}

// ------------------------------------------------------------------ scan ----

const unknownKeys = [];
const unresolved = [];
const uncheckable = [];
let literalsChecked = 0;
let callsMatched = 0;

const lineOf = (sf, node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function checkLiteral(objLit, typeNodes, sf, trail, consts) {
  const nodes = (Array.isArray(typeNodes) ? typeNodes : [typeNodes]).filter(
    Boolean,
  );
  if (nodes.length === 0) return;

  const allowed = new Map();
  for (const node of nodes) {
    const m = membersOf(node);
    if (m === OPEN) return;
    for (const [k, v] of m) if (!allowed.has(k)) allowed.set(k, v);
  }
  if (allowed.size === 0) {
    unresolved.push({ file: sf.fileName, line: lineOf(sf, objLit), trail });
    return;
  }
  literalsChecked++;

  for (const prop of objLit.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const sources = spreadSources(prop.expression, consts);
      if (sources.length === 0) {
        uncheckable.push({
          file: sf.fileName,
          line: lineOf(sf, prop),
          trail,
          reason: 'spread of a value that cannot be followed',
        });
      } else {
        for (const src of sources)
          checkLiteral(src, nodes, sf, `${trail}{...}`, consts);
      }
      continue;
    }
    if (!prop.name) continue;

    const key =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (key === null) {
      uncheckable.push({
        file: sf.fileName,
        line: lineOf(sf, prop),
        trail,
        reason: 'computed key',
      });
      continue;
    }
    if (!allowed.has(key)) {
      unknownKeys.push({
        file: sf.fileName,
        line: lineOf(sf, prop),
        trail,
        key,
      });
      continue;
    }

    const raw = ts.isPropertyAssignment(prop) ? prop.initializer : null;
    if (!raw) continue;
    if (ts.isArrayLiteralExpression(raw)) {
      for (const el of raw.elements) {
        for (const o of objectLiteralsIn(el, consts)) {
          checkLiteral(o, allowed.get(key), sf, `${trail}.${key}[]`, consts);
        }
      }
    } else {
      for (const o of objectLiteralsIn(raw, consts)) {
        checkLiteral(o, allowed.get(key), sf, `${trail}.${key}`, consts);
      }
    }
  }
}

function scanFile(file) {
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const consts = constLiterals(sf);

  (function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const op = node.expression.name.text;
      const receiver = node.expression.expression;
      if (OPS[op] && ts.isPropertyAccessExpression(receiver)) {
        const model = receiver.name.text;
        if (modelNames.has(model)) {
          callsMatched++;
          const Model = model[0].toUpperCase() + model.slice(1);
          const args = node.arguments[0];
          if (args && ts.isObjectLiteralExpression(args)) {
            for (const prop of args.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              if (!prop.name || !ts.isIdentifier(prop.name)) continue;
              const suffixes = OPS[op][prop.name.text];
              if (!suffixes) continue;

              const types = suffixes
                .map((s) => aliases.get(Model + s))
                .filter(Boolean);
              const trail = `${model}.${op}.${prop.name.text}`;
              if (types.length === 0) {
                unresolved.push({ file, line: lineOf(sf, prop), trail });
                continue;
              }

              const raw = prop.initializer;
              if (isAbsent(raw)) continue;
              if (ts.isArrayLiteralExpression(raw)) {
                for (const el of raw.elements) {
                  const found = objectLiteralsIn(el, consts);
                  if (found.length === 0) {
                    uncheckable.push({
                      file,
                      line: lineOf(sf, el),
                      trail: `${trail}[]`,
                      reason: 'element cannot be followed',
                    });
                  }
                  for (const o of found)
                    checkLiteral(o, types, sf, `${trail}[]`, consts);
                }
              } else {
                const found = objectLiteralsIn(raw, consts);
                if (found.length === 0) {
                  uncheckable.push({
                    file,
                    line: lineOf(sf, raw),
                    trail,
                    reason: 'value cannot be followed',
                  });
                }
                for (const o of found)
                  checkLiteral(o, types, sf, trail, consts);
              }
            }
          } else if (args) {
            uncheckable.push({
              file,
              line: lineOf(sf, args),
              trail: `${model}.${op}(args)`,
              reason: 'arguments are not a literal',
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
}

function typescriptFilesIn(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) typescriptFilesIn(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const files = typescriptFilesIn(SRC_DIR);
for (const file of files) scanFile(file);

// ---------------------------------------------------------------- report ----

const rel = (f) => path.relative(API_DIR, f);

console.log(
  `Checked ${literalsChecked} argument literal(s) across ${callsMatched} Prisma ` +
    `call(s) in ${files.length} file(s).`,
);

if (uncheckable.length > 0) {
  console.log(
    `\n${uncheckable.length} literal(s) could not be followed statically:`,
  );
  for (const u of uncheckable) {
    console.log(`  ${rel(u.file)}:${u.line}  ${u.trail}  (${u.reason})`);
  }
  console.log(
    '  These are not failures. They are the part this check cannot see.',
  );
}

if (unresolved.length > 0) {
  console.error(
    `\n${unresolved.length} Prisma input type(s) could not be resolved:`,
  );
  for (const u of unresolved)
    console.error(`  ${rel(u.file)}:${u.line}  ${u.trail}`);
  console.error(
    '\nThe generated client probably changed shape — a new generic wrapper needs\n' +
      'adding to PASS_THROUGH_ALL / PASS_THROUGH_FIRST in this script. Failing\n' +
      'rather than checking fewer literals, because a silent audit is worthless.',
  );
  process.exit(1);
}

if (unknownKeys.length > 0) {
  console.error(`\n${unknownKeys.length} unknown field(s) passed to Prisma:`);
  for (const f of unknownKeys) {
    console.error(`  ${rel(f.file)}:${f.line}  ${f.trail}  ->  '${f.key}'`);
  }
  console.error(
    '\nPrisma rejects the whole query with `Unknown argument` at runtime. The\n' +
      'compiler cannot see this (#159) and neither can a test using a Prisma\n' +
      'double. Check the field against apps/api/prisma/schema.prisma.',
  );
  process.exit(1);
}

console.log('\nNo unknown fields.');
