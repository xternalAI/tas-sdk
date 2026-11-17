/**
 * The serialized LangChain object: the one shape everything LangSmith stores for a prompt is made of.
 * Shared by the model encoding (`models.ts`) and the prompt codec (`manifest.ts`).
 */

/**
 * LangSmith stores a prompt as a serialized LangChain object ("manifest") in a commit of a repo.
 * Only the shapes built in `manifest.ts` and `models.ts` are written; `decode` also reads what the
 * LangSmith UI produces.
 */
export type Lc = { lc: 1; type: "constructor"; id: string[]; kwargs: Record<string, any> };

/** Build a serialized LangChain object from its class path and constructor arguments. */
export const lc = (id: string[], kwargs: Record<string, any>): Lc => ({ lc: 1, type: "constructor", id, kwargs });

/** The class name of a serialized object: the last segment of its id. */
export const cls = (node: Lc | undefined) => node?.id?.at(-1);
