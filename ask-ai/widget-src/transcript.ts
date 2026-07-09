import { LIMITS, STORAGE_KEY } from "./config.js";
import type { ChatTurn, Source } from "./types.js";

/** One rendered message. Assistant messages accumulate text while streaming. */
export interface Message
{
  readonly role: "user" | "assistant";
  thinking: string;
  text: string;
  sources: readonly Source[];
}

export type TranscriptEvent =
  | { readonly kind: "append"; readonly index: number }
  | { readonly kind: "update"; readonly index: number }
  | { readonly kind: "reset" };

type Listener = (event: TranscriptEvent) => void;

/**
 * The conversation state. The UI renders *from* this class and never stores
 * state of its own; persistence is a side effect of mutation, so every code
 * path that changes the conversation is saved automatically.
 */
export class Transcript
{
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly storageKey: string;

  constructor(storageKey = STORAGE_KEY)
  {
    this.storageKey = storageKey;
    this.restore();
  }

  subscribe(listener: Listener): void
  {
    this.listeners.add(listener);
  }

  get all(): readonly Message[]
  {
    return this.messages;
  }

  /** Last N turns in the shape the worker expects. */
  history(): ChatTurn[]
  {
    return this.messages
      .slice(-LIMITS.historyTurns)
      .map(({ role, text }) => ({ role, content: text }));
  }

  addUser(text: string): void
  {
    this.push({ role: "user", thinking: "", text, sources: [] });
  }

  /** Start a streaming assistant message; returns its index for updates. */
  beginAssistant(): number
  {
    this.push({ role: "assistant", thinking: "", text: "", sources: [] });
    return this.messages.length - 1;
  }

  appendThinking(index: number, delta: string): void
  {
    const msg = this.messages[index];
    if (!msg)
    {
      return;
    }
    msg.thinking += delta;
    this.emit({ kind: "update", index });
    this.save();
  }

  appendText(index: number, delta: string): void
  {
    const msg = this.messages[index];
    if (!msg)
    {
      return;
    }
    msg.text += delta;
    this.emit({ kind: "update", index });
    this.save();
  }

  setText(index: number, text: string): void
  {
    const msg = this.messages[index];
    if (!msg)
    {
      return;
    }
    msg.text = text;
    this.emit({ kind: "update", index });
    this.save();
  }

  setSources(index: number, sources: readonly Source[]): void
  {
    const msg = this.messages[index];
    if (!msg)
    {
      return;
    }
    msg.sources = sources;
    this.emit({ kind: "update", index });
    this.save();
  }

  clear(): void
  {
    this.messages.length = 0;
    try
    {
      sessionStorage.removeItem(this.storageKey);
    }
    catch
    {
      /* storage unavailable (e.g. blocked); state is still cleared in memory */
    }
    this.emit({ kind: "reset" });
  }

  private push(message: Message): void
  {
    this.messages.push(message);
    if (this.messages.length > LIMITS.transcriptMessages)
    {
      this.messages.splice(0, this.messages.length - LIMITS.transcriptMessages);
      this.emit({ kind: "reset" });
    }
    else
    {
      this.emit({ kind: "append", index: this.messages.length - 1 });
    }
    this.save();
  }

  private emit(event: TranscriptEvent): void
  {
    for (const listener of this.listeners)
    {
      listener(event);
    }
  }

  private save(): void
  {
    try
    {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.messages));
    }
    catch
    {
      /* quota or privacy mode -- persistence is best-effort */
    }
  }

  private restore(): void
  {
    let parsed: unknown;
    try
    {
      parsed = JSON.parse(sessionStorage.getItem(this.storageKey) ?? "[]");
    }
    catch
    {
      return;
    }
    if (!Array.isArray(parsed))
    {
      return;
    }
    for (const item of parsed as Array<Partial<Message>>)
    {
      if ((item.role === "user" || item.role === "assistant") && typeof item.text === "string")
      {
        this.messages.push({
          role: item.role,
          thinking: typeof item.thinking === "string" ? item.thinking : "",
          text: item.text,
          sources: Array.isArray(item.sources) ? item.sources : [],
        });
      }
    }
  }
}
