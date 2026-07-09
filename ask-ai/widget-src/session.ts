import { Transcript } from "./transcript.js";

const META_KEY = "ask-sessions";
const MSG_PREFIX = "ask-chat-";

export interface SessionMeta
{
  id: string;
  title: string;
  created: number;
}

export type SessionEvent =
  | { kind: "switched"; meta: SessionMeta }
  | { kind: "list-changed"; list: readonly SessionMeta[] };

type Listener = (event: SessionEvent) => void;

/**
 * Manages multiple chat sessions in sessionStorage.  Each session has its
 * own Transcript instance keyed by id.  The active session is tracked so
 * the UI can reconstruct state after a page reload.
 */
export class SessionManager
{
  private readonly listeners = new Set<Listener>();
  private sessions: SessionMeta[] = [];
  private activeId: string | null = null;
  private activeTranscript: Transcript | null = null;

  constructor()
  {
    this.loadMeta();
    // Restore last active session, or create one if none exist
    const lastActive = sessionStorage.getItem("ask-active");
    if (lastActive && this.sessions.find((s) => s.id === lastActive))
    {
      this.switchTo(lastActive);
    }
    else if (this.sessions.length > 0)
    {
      this.switchTo(this.sessions[0].id);
    }
    else
    {
      this.newSession();
    }
  }

  subscribe(listener: Listener): void
  {
    this.listeners.add(listener);
  }

  get list(): readonly SessionMeta[]
  {
    return this.sessions;
  }

  get active(): Transcript | null
  {
    return this.activeTranscript;
  }

  get activeMeta(): SessionMeta | null
  {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  newSession(): void
  {
    const id = crypto.randomUUID();
    const meta: SessionMeta = { id, title: "New Chat", created: Date.now() };
    this.sessions.unshift(meta);
    this.saveMeta();
    this.switchTo(id);
    this.emit({ kind: "list-changed", list: this.sessions });
  }

  switchTo(id: string): void
  {
    if (this.activeId === id)
    {
      return;
    }
    // Auto-title the previous session from its first user message
    this.autoTitle();

    this.activeId = id;
    sessionStorage.setItem("ask-active", id);
    this.activeTranscript = new Transcript(MSG_PREFIX + id);
    const meta = this.sessions.find((s) => s.id === id);
    if (meta)
    {
      this.emit({ kind: "switched", meta });
    }
  }

  deleteSession(id: string): void
  {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0)
    {
      return;
    }
    sessionStorage.removeItem(MSG_PREFIX + id);
    this.sessions.splice(idx, 1);
    this.saveMeta();
    if (id === this.activeId)
    {
      const next = this.sessions[0];
      if (next)
      {
        this.switchTo(next.id);
      }
      else
      {
        this.newSession();
      }
    }
    this.emit({ kind: "list-changed", list: this.sessions });
  }

  /** Set the title of the active session from its first user message. */
  private autoTitle(): void
  {
    if (!this.activeId || !this.activeTranscript)
    {
      return;
    }
    const meta = this.sessions.find((s) => s.id === this.activeId);
    if (!meta || meta.title !== "New Chat")
    {
      return;
    }
    const messages = this.activeTranscript.all;
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser)
    {
      meta.title = firstUser.text.slice(0, 60) || "Chat";
      this.saveMeta();
    }
  }

  private loadMeta(): void
  {
    try
    {
      this.sessions = JSON.parse(sessionStorage.getItem(META_KEY) ?? "[]");
    }
    catch
    {
      this.sessions = [];
    }
  }

  private saveMeta(): void
  {
    try
    {
      sessionStorage.setItem(META_KEY, JSON.stringify(this.sessions));
    }
    catch
    {
      /* quota */
    }
  }

  private emit(event: SessionEvent): void
  {
    for (const l of this.listeners)
    {
      l(event);
    }
  }
}
