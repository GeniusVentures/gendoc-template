import { LIMITS } from "./config.js";
import type { AskConfig, AskRequest, ChatTurn, SseEvent } from "./types.js";
import { searchHints } from "./site-search.js";

/**
 * A transport answers one question as a stream of {@link SseEvent}s.
 * Both implementations yield the same event grammar (sources, text*, done),
 * so the UI is transport-agnostic.
 */
export interface AskTransport {
  ask(question: string, history: readonly ChatTurn[], signal?: AbortSignal): AsyncGenerator<SseEvent>;
}

/** Pick the best available transport, or null if none can work. */
export function createTransport(config: AskConfig): AskTransport | null {
  if (config.endpoint) return new RemoteTransport(config);
  if (typeof LanguageModel !== "undefined") return new LocalPromptTransport(config);
  return null;
}

/* ------------------------------ remote (worker) ----------------------------- */

class RemoteTransport implements AskTransport {
  constructor(private readonly config: AskConfig) {}

  async *ask(question: string, history: readonly ChatTurn[], signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const corrected = (window as any).fuzzyCorrect ? (window as any).fuzzyCorrect(question) : question;
    const hints = await searchHints(corrected);
    const body: AskRequest = {
      question,
      history,
      search_hints: hints || undefined,
      // Send only the path. The worker validates it against the site's catalog
      // before using it to select a source document.
      page_url: window.location.pathname,
    };
    const res = await fetch(this.config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || res.body === null) {
      let message = `ask endpoint returned HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch { /* response may not be JSON */ }
      throw new Error(message);
    }
    yield* parseSseStream(res.body);
  }
}

/** Incrementally parse `data: <json>\n` lines from an SSE byte stream. */
async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload === "") continue;
        try {
          yield JSON.parse(payload) as SseEvent;
        } catch {
          /* torn frame across chunks -- superseded by the intact next line */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ---------------------- on-device (Chrome Prompt API) ----------------------- */

/** Minimal declarations for Chrome's built-in AI Prompt API. */
declare global {
  interface LanguageModelSession {
    promptStreaming(input: string): AsyncIterable<string>;
    destroy(): void;
  }
  const LanguageModel: {
    availability(): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
    create(options?: {
      initialPrompts?: ReadonlyArray<{ role: string; content: string }>;
    }): Promise<LanguageModelSession>;
  };
}

class LocalPromptTransport implements AskTransport {
  private context: string | null = null;

  constructor(private readonly config: AskConfig) {}

  async *ask(question: string, _history: readonly ChatTurn[], signal?: AbortSignal): AsyncGenerator<SseEvent> {
    yield { sources: [] };
    if (signal?.aborted) return;
    if ((await LanguageModel.availability()) === "unavailable") {
      yield { text: "On-device AI isn't available in this browser." };
      yield { done: true };
      return;
    }
    const context = await this.loadContext();
    const session = await LanguageModel.create({
      initialPrompts: [
        {
          role: "system",
          content:
            `You are ${this.config.title}. Answer only from the provided context. ` +
            `If the context lacks the answer, say you don't have that information.`,
        },
      ],
    });
    try {
      const stream = session.promptStreaming(`Context:\n${context}\n\nQuestion: ${question}`);
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        yield { text: chunk };
      }
      if (!signal?.aborted) yield { done: true };
    } finally {
      session.destroy();
    }
  }

  private async loadContext(): Promise<string> {
    if (this.context !== null) return this.context;
    try {
      const res = await fetch(this.config.llms_full_url);
      this.context = res.ok ? (await res.text()).slice(0, LIMITS.localContextChars) : "";
    } catch {
      this.context = "";
    }
    return this.context;
  }
}
