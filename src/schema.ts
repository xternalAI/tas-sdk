import { Value } from "typebox/value";

/**
 * Schemas users hand to the SDK (structured output, tool arguments) can be either:
 *  - a plain JSON Schema object, which is also what a TypeBox schema is, or
 *  - anything implementing Standard Schema (zod, Valibot, ArkType, ...).
 *
 * The Standard Schema interfaces below are copied from the spec (standardschema.dev), which
 * permits exactly that, so accepting those libraries costs no dependency.
 */
export interface StandardSchema<Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    /** The optional "Standard JSON Schema" extension: lets us tell the model what shape to produce. */
    readonly jsonSchema?: {
      readonly input: (options: { target: string }) => Record<string, unknown>;
      readonly output: (options: { target: string }) => Record<string, unknown>;
    };
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
}
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined }> };

export type JsonSchema = Record<string, unknown>;
export type SchemaInput<Output = unknown> = StandardSchema<Output> | JsonSchema;
/** The validated type of a schema: inferred for Standard Schema, `unknown` for plain JSON Schema. */
export type InferSchema<S> = S extends StandardSchema<infer Output> ? Output : unknown;

export function isStandardSchema(schema: unknown): schema is StandardSchema {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

/** The JSON Schema to send to a model, or undefined when a Standard Schema validator cannot produce one. */
export function toJsonSchema(schema: SchemaInput): JsonSchema | undefined {
  if (!isStandardSchema(schema)) return schema;
  return schema["~standard"].jsonSchema?.input({ target: "draft-2020-12" });
}

export type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export async function validateSchema<T>(schema: SchemaInput<T>, value: unknown): Promise<Validation<T>> {
  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(value);
    if (result.issues === undefined) return { ok: true, value: result.value as T };
    return {
      ok: false,
      issues: result.issues.map((issue) => {
        const path = (issue.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  if (Value.Check(schema as never, value)) return { ok: true, value: value as T };
  const issues = Value.Errors(schema as never, value).map((e) => `${e.instancePath.slice(1).replaceAll("/", ".") || "value"}: ${e.message}`);
  return { ok: false, issues: [...new Set(issues)] };
}
