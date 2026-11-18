import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ContentPart, MessageContent } from "./model.ts";

/**
 * Attachments. A message's content is plain text, or a list of parts when it carries images or
 * files. This file converts between our parts and the OpenAI chat format, which is what gateways
 * expect on the wire and also how Braintrust stores multimodal prompts.
 */

/** A content part in the OpenAI chat-completions format, plus the two URL forms gateways have added to it. */
export type OpenAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  /** `file_data` holds a data: URI; `file_id` a reference (the convention gateways such as LiteLLM use for URLs). */
  | { type: "file"; file: { file_data?: string; file_id?: string; filename?: string; format?: string } }
  /** OpenAI's own audio input: bare base64 (no `data:` prefix) and its format. */
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  /** Not in OpenAI's API: the form vLLM, LiteLLM and others accept for audio and video given by URL. */
  | { type: "audio_url"; audio_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

const isDataUri = (url: string) => url.startsWith("data:");
/** The base64 payload of a data: URI. */
const payload = (dataUri: string) => dataUri.slice(dataUri.indexOf(",") + 1);

export function toOpenAIContent(content: MessageContent): string | OpenAIPart[] {
  if (typeof content === "string") return content;
  return content.map((part): OpenAIPart => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return { type: "image_url", image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } };
      case "audio":
        // Inline audio has a standard form. Audio by URL does not; `audio_url` is the common extension.
        return isDataUri(part.url)
          ? { type: "input_audio", input_audio: { data: payload(part.url), format: part.format } }
          : { type: "audio_url", audio_url: { url: part.url } };
      case "video":
        return { type: "video_url", video_url: { url: part.url } };
    }
    // What is left is a file. Inline data goes as `file_data`; anything else (a URL, or a {{variable}} not yet filled) is a reference.
    const where = isDataUri(part.url) ? { file_data: part.url } : { file_id: part.url };
    return {
      type: "file",
      file: { ...where, ...(part.name ? { filename: part.name } : {}), ...(part.mediaType ? { format: part.mediaType } : {}) },
    };
  });
}

/** `data` of an `input_audio` part as a url: a variable, a data: URI or a link is kept; bare base64 is wrapped. */
function audioUrl(data: string, format: string): string {
  return /^(data:|https?:)|\{\{/.test(data) ? data : `data:audio/${format};base64,${data}`;
}

/** The reverse of `toOpenAIContent`. Throws, naming the part, for anything it does not know. */
export function fromOpenAIContent(content: unknown): MessageContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("message content is neither text nor a list of parts");
  return content.map((raw): ContentPart => {
    const part = raw as OpenAIPart & { type: string };
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url")
      return { type: "image", url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    if (part.type === "input_audio")
      return { type: "audio", url: audioUrl(part.input_audio.data, part.input_audio.format), format: part.input_audio.format };
    if (part.type === "video_url") return { type: "video", url: part.video_url.url };
    if (part.type === "file" && (part.file.file_data ?? part.file.file_id)) {
      return {
        type: "file",
        url: (part.file.file_data ?? part.file.file_id)!,
        ...(part.file.filename ? { name: part.file.filename } : {}),
        ...(part.file.format ? { mediaType: part.file.format } : {}),
      };
    }
    // `audio_url` cannot be read back: it carries no format, which an audio part requires.
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
    .map((part) => (part.type === "text" ? part.text : `[${part.type}: ${part.type === "file" ? (part.name ?? part.url) : part.url}]`))
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
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
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
