import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ContentPart, MessageContent } from "./model.ts";

/**
 * Attachments. A message's content is plain text, or a list of parts when it carries images or
 * files. This file converts between our parts and the OpenAI chat format, which is what gateways
 * expect on the wire and also how Braintrust stores multimodal prompts.
 */

/** A content part in the OpenAI chat-completions format. */
export type OpenAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  /** `file_data` holds a data: URI; `file_id` a reference (the convention gateways such as LiteLLM use for URLs). */
  | { type: "file"; file: { file_data?: string; file_id?: string; filename?: string; format?: string } };

const isDataUri = (url: string) => url.startsWith("data:");

export function toOpenAIContent(content: MessageContent): string | OpenAIPart[] {
  if (typeof content === "string") return content;
  return content.map((part): OpenAIPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") return { type: "image_url", image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } };
    // Inline data goes as `file_data`. Anything else (a URL, or a {{variable}} not yet filled) is a reference.
    const where = isDataUri(part.url) ? { file_data: part.url } : { file_id: part.url };
    return {
      type: "file",
      file: { ...where, ...(part.name ? { filename: part.name } : {}), ...(part.mediaType ? { format: part.mediaType } : {}) },
    };
  });
}

/** The reverse of `toOpenAIContent`. Throws, naming the part, for anything outside text, images and files. */
export function fromOpenAIContent(content: unknown): MessageContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("message content is neither text nor a list of parts");
  return content.map((raw): ContentPart => {
    const part = raw as OpenAIPart & { type: string };
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url")
      return { type: "image", url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    if (part.type === "file" && (part.file.file_data ?? part.file.file_id)) {
      return {
        type: "file",
        url: (part.file.file_data ?? part.file.file_id)!,
        ...(part.file.filename ? { name: part.file.filename } : {}),
        ...(part.file.format ? { mediaType: part.file.format } : {}),
      };
    }
    throw new Error(`message part of type "${part.type}" is not supported`);
  });
}

/**
 * A text-only rendition of a message, for platforms that can only store text. Attachments become
 * a visible marker, so someone reading the prompt in that platform's UI can see they exist.
 */
export function textOnly(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : part.type === "image" ? `[image: ${part.url}]` : `[file: ${part.name ?? part.url}]`))
    .join("\n");
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** A data: URI for bytes you already hold. */
export function dataUrl(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Read a local file into a data: URI, ready to pass as an image or file variable. */
export async function fileToDataUrl(path: string, mediaType?: string): Promise<string> {
  const type = mediaType ?? MEDIA_TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`cannot tell the media type of "${path}"; pass it as the second argument`);
  return dataUrl(await readFile(path), type);
}

/** `data:image/png;base64,iVBOR...` -> `[image/png attachment, 12 kB]`: what traces record instead of the bytes. */
export function summariseDataUrl(url: string): string {
  const mediaType = /^data:([^;,]*)/.exec(url)?.[1] || "unknown";
  const base64 = url.slice(url.indexOf(",") + 1);
  return `[${mediaType} attachment, ${Math.max(1, Math.round((base64.length * 3) / 4 / 1024))} kB]`;
}
