import type { PromptDefinition } from "./model.ts";
import { extractPlaceholders, extractVariables, type RenderedMessage } from "./template.ts";

/**
 * Typed prompts. `tas prompts types` turns the prompt files into a TypeScript interface, and
 * `createClient<Prompts>()` then checks prompt names, variables, placeholders and structured
 * output at compile time. Without the type parameter, everything stays loosely typed.
 */

/** A value that can fill a `{{variable}}`: text as it is, anything else as JSON. */
export type TemplateValue = string | number | boolean | object;

/** What the generated interface records about one prompt. */
export interface PromptShape {
  variables: Record<string, unknown>;
  /** Union of placeholder names, or `never` when the prompt has none. */
  placeholders: string;
  /** The type of the validated reply, or `unknown` when the prompt has no output schema. */
  output: unknown;
}
export type PromptMap = Record<string, PromptShape>;
/**
 * The constraint for a prompts type parameter. Written this way, rather than `extends PromptMap`,
 * so that an `interface` (which has no index signature) is accepted as well as a type alias.
 */
export type PromptShapes<P> = { [K in keyof P]: PromptShape };

/** `variables` is required exactly when the prompt has variables. */
type VariablesOption<V> = {} extends V ? { variables?: V } : { variables: V };
/** `placeholders` is required exactly when the prompt has placeholders; untyped clients may pass any. */
type PlaceholdersOption<Names extends string> = [Names] extends [never]
  ? { placeholders?: never }
  : string extends Names
    ? { placeholders?: Record<string, RenderedMessage[]> }
    : { placeholders: Record<Names, RenderedMessage[]> };

/** The inputs a prompt of shape `S` needs, replacing the loose `variables` / `placeholders` options. */
export type PromptInputs<S extends PromptShape> = VariablesOption<S["variables"]> & PlaceholdersOption<S["placeholders"]>;
/** Makes the options argument itself optional when nothing in it is required. */
export type OptionalWhenEmpty<Options> = {} extends Options ? [options?: Options] : [options: Options];

const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

/** A TypeScript type for a JSON Schema, covering what model output schemas use; anything else is `unknown`. */
export function jsonSchemaToType(schema: unknown, indent = ""): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const s = schema as Record<string, any>;
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") || "never";
  if ("const" in s) return JSON.stringify(s.const);
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return union.map((option: unknown) => jsonSchemaToType(option, indent)).join(" | ") || "unknown";
  if (Array.isArray(s.type)) return s.type.map((type: string) => jsonSchemaToType({ ...s, type }, indent)).join(" | ");
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = jsonSchemaToType(s.items, indent);
      return /[ |]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const properties = Object.entries<unknown>(s.properties ?? {});
      if (!properties.length) return "Record<string, unknown>";
      const required = new Set<string>(s.required ?? []);
      const inner = `${indent}  `;
      const lines = properties.map(([name, child]) => `${inner}${key(name)}${required.has(name) ? "" : "?"}: ${jsonSchemaToType(child, inner)};`);
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default:
      return "unknown";
  }
}

/** `{ a: { b: leaf } }` from the variable paths `["a.b"]`. A path used both whole and nested becomes an object. */
function variablesType(paths: string[], indent: string): string {
  type Node = Map<string, Node>;
  const root: Node = new Map();
  for (const path of paths) {
    let node = root;
    for (const part of path.split(".")) node = node.get(part) ?? node.set(part, new Map()).get(part)!;
  }
  const render = (node: Node, pad: string): string => {
    if (!node.size) return "TemplateValue";
    const lines = [...node].map(([name, child]) => `${pad}  ${key(name)}: ${render(child, `${pad}  `)};`);
    return `{\n${lines.join("\n")}\n${pad}}`;
  };
  return root.size ? render(root, indent) : "{}";
}

export interface GenerateTypesOptions {
  /** Module the generated file imports `TemplateValue` from. Default "@traceandscale/sdk". */
  sdk?: string;
  /** Name of the generated interface. Default "Prompts". */
  name?: string;
}

/** The source of a TypeScript file describing every prompt: its variables, placeholders and output. */
export function generatePromptTypes(definitions: PromptDefinition[], options: GenerateTypesOptions = {}): string {
  const entries = [...definitions]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((def) => {
      const placeholders = extractPlaceholders(def).map((p) => JSON.stringify(p)).join(" | ") || "never";
      const output = def.output ? jsonSchemaToType(def.output.schema, "    ") : "unknown";
      const doc = def.description ? `  /** ${def.description.replaceAll("*/", "* /")} */\n` : "";
      return `${doc}  ${JSON.stringify(def.name)}: {\n    variables: ${variablesType(extractVariables(def), "    ")};\n    placeholders: ${placeholders};\n    output: ${output};\n  };`;
    });
  return [
    "// Generated by `tas prompts types` from the prompt files. Do not edit: re-run the command instead.",
    `import type { TemplateValue } from ${JSON.stringify(options.sdk ?? "@traceandscale/sdk")};`,
    "",
    `export interface ${options.name ?? "Prompts"} {`,
    ...entries,
    "}",
    "",
  ].join("\n");
}
