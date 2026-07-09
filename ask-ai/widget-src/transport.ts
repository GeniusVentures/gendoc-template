import { LIMITS } from "./config.js";
import type { AskConfig, AskRequest, ChatTurn, SseEvent } from "./types.js";

/**
 * A transport answers one question as a stream of {@link SseEvent}s.
 * Both implementations yield the same event grammar (sources, text*, done),
 * so the UI is transport-agnostic.
 */
export interface AskTransport {
  ask(question: string, history: readonly ChatTurn[]): AsyncGenerator<SseEvent>;
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

  async *ask(question: string, history: readonly ChatTurn[]): AsyncGenerator<SseEvent> {
    const body: AskRequest = { question, history };
    const res = await fetch(this.config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`ask endpoint returned HTTP ${res.status}`);
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

  async *ask(question: string, _history: readonly ChatTurn[]): AsyncGenerator<SseEvent> {
    yield { sources: [] };
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
        yield { text: chunk };
      }
      yield { done: true };
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
