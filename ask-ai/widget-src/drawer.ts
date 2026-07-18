import { LIMITS } from "./config.js";
import type { SessionManager } from "./session.js";
import type { Transcript, TranscriptEvent } from "./transcript.js";
import type { AskConfig } from "./types.js";
import { DRAWER_CSS } from "./styles.js";

const HINT_TEXT = "Answers come only from this site's documentation, with sources.";

/**
 * The floating button + right-hand drawer. Renders exclusively from the
 * active Transcript (one element per message, patched in place while streaming);
 * user intent is reported through the onAsk callback.
 */
export class DrawerUI
{
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly drawer: HTMLElement;
  private readonly messagesEl: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private readonly submitEl: HTMLButtonElement;
  private readonly stopEl: HTMLButtonElement;
  private readonly scrollBottomEl: HTMLButtonElement;
  private readonly messageEls: HTMLElement[] = [];
  private activeTranscript: Transcript | null = null;
  private onStop: (() => void) | null = null;

  constructor(
    private readonly config: AskConfig,
    private readonly sessions: SessionManager,
    private readonly onAsk: (question: string) => void,
  )
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    this.host = host;
    this.root = host.attachShadow({ mode: "open" });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(DRAWER_CSS);
    this.root.adoptedStyleSheets = [sheet];

    this.root.appendChild(this.buildDom());
    this.drawer = this.query(".drawer");
    this.messagesEl = this.query(".messages");
    this.inputEl = this.query<HTMLInputElement>("input");
    this.submitEl = this.query<HTMLButtonElement>("button[type=submit]");
    this.stopEl = this.query<HTMLButtonElement>(".stop-btn");
    this.scrollBottomEl = this.query<HTMLButtonElement>(".scroll-bottom");

    // Restore saved drawer width
    const savedWidth = localStorage.getItem('ask-drawer-width');
    if (savedWidth)
    {
      this.drawer.style.setProperty('--ask-drawer-width', savedWidth);
      this.drawer.style.width = savedWidth;
    }

    // Sync Material for MkDocs theme toggle.  We set data-theme on the
    // .drawer element itself rather than using :host() which has spotty
    // support in Constructed Stylesheets.
    this.syncTheme();
    const observer = new MutationObserver(() => this.syncTheme());
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-md-color-media'],
    });

    // Persist drawer width on resize
    new ResizeObserver(() =>
    {
      const w = getComputedStyle(this.drawer).width;
      if (w && w !== '0px')
      {
        localStorage.setItem('ask-drawer-width', w);
      }
    }).observe(this.drawer);

    // Left-edge drag to resize
    let dragging = false;
    let startX = 0;
    let startW = 0;
    this.drawer.addEventListener('mousedown', (e) =>
    {
      const rect = this.drawer.getBoundingClientRect();
      if (e.clientX - rect.left <= 8)
      {
        dragging = true;
        startX = e.clientX;
        startW = rect.width;
        e.preventDefault();
      }
    });
    document.addEventListener('mousemove', (e) =>
    {
      if (!dragging)
      {
        return;
      }
      const newW = Math.max(300, Math.min(window.innerWidth * 0.9, startW + (startX - e.clientX)));
      this.drawer.style.width = `${newW}px`;
    });
    document.addEventListener('mouseup', () =>
    {
      dragging = false;
    });

    this.wireEvents();
    this.wireSessionEvents();
    this.switchTranscript(sessions.active);
  }

  /* -------------------------------- public API ------------------------------- */

  open(): void
  {
    this.drawer.classList.add("open");
    // Opening a drawer should not immediately raise the software keyboard on
    // phones.  It also avoids iOS Safari scrolling a fixed panel to the input.
    if (!window.matchMedia("(max-width: 700px)").matches)
    {
      this.inputEl.focus();
    }
    // Scroll to bottom after the CSS transition starts so dimensions are settled.
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.syncScrollButton();
    });
  }

  close(): void
  {
    this.drawer.classList.remove("open");
  }

  setBusy(busy: boolean): void
  {
    this.submitEl.disabled = busy;
    this.submitEl.style.display = busy ? "none" : "";
    this.stopEl.style.display = busy ? "" : "none";
  }

  setOnStop(callback: (() => void) | null): void
  {
    this.onStop = callback;
  }

  /** Re-attach host to document body after Material navigation swaps DOM. */
  reattach(): void
  {
    if (!this.host.isConnected)
    {
      document.body.appendChild(this.host);
    }
  }

  /** Read Material's data-md-color-media and sync to the drawer element. */
  private syncTheme(): void
  {
    const isDark = (document.body.getAttribute('data-md-color-media') || '').includes('dark');
    this.drawer.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }

  /* ----------------------------- session wiring ----------------------------- */

  private wireSessionEvents(): void
  {
    this.sessions.subscribe((event) =>
    {
      if (event.kind === "switched")
      {
        this.switchTranscript(this.sessions.active);
      }
      else if (event.kind === "list-changed")
      {
        this.renderSessionList();
      }
    });
  }

  private switchTranscript(transcript: Transcript | null): void
  {
    this.activeTranscript = transcript;
    if (transcript)
    {
      transcript.subscribe((event) => this.onTranscriptEvent(event));
    }
    this.renderAll();
  }

  /* --------------------------------- DOM setup -------------------------------- */

  private buildDom(): DocumentFragment
  {
    const template = document.createElement("template");
    template.innerHTML = `
      <button class="fab" type="button"></button>
      <section class="drawer" role="dialog">
        <header class="head">
          <b></b>
          <span class="head-buttons">
            <button class="history-btn" type="button" title="Chat history">&#128339;</button>
            <button class="new-chat" type="button" title="Start a new conversation">+ New Chat</button>
            <button class="close" type="button" aria-label="Close">&rarr;</button>
          </span>
        </header>
        <aside class="session-list" hidden></aside>
        <div class="messages"></div>
        <button class="scroll-bottom" type="button" title="Jump to bottom" style="display:none">↓</button>
        <form>
          <input type="text" autocomplete="off">
          <button type="submit">Ask</button>
          <button type="button" class="stop-btn" style="display:none">Stop</button>
        </form>
      </section>`;
    const fragment = template.content;

    const title = this.config.title;
    const icon = getComputedStyle(document.documentElement).getPropertyValue('--ask-icon').trim() || '💬';
    fragment.querySelector(".fab")!.textContent = `${icon} ${title}`;
    fragment.querySelector(".drawer")!.setAttribute("aria-label", title);
    fragment.querySelector(".head b")!.textContent = title;
    const input = fragment.querySelector("input")!;
    input.placeholder = this.config.placeholder;
    input.maxLength = LIMITS.questionChars;
    return fragment;
  }

  private wireEvents(): void
  {
    this.query(".fab").addEventListener("click", () =>
    {
      this.drawer.classList.contains("open") ? this.close() : this.open();
    });
    this.query(".close").addEventListener("click", () => this.close());
    this.query(".new-chat").addEventListener("click", () => this.sessions.newSession());
    this.query(".history-btn").addEventListener("click", () => this.toggleSessionList());
    this.root.addEventListener("keydown", (event) =>
    {
      if ((event as KeyboardEvent).key === "Escape")
      {
        this.close();
      }
    });
    this.stopEl.addEventListener("click", () =>
    {
      if (this.onStop)
      {
        this.onStop();
      }
    });
    this.query("form").addEventListener("submit", (event) =>
    {
      event.preventDefault();
      const question = this.inputEl.value.trim();
      this.inputEl.value = "";
      if (question)
      {
        this.onAsk(question);
      }
    });

    // Scroll-to-bottom
    this.messagesEl.addEventListener("scroll", () => this.syncScrollButton());
    this.scrollBottomEl.addEventListener("click", () =>
    {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.scrollBottomEl.style.display = "none";
    });
  }

  /* ----------------------------- session list UI ----------------------------- */

  private toggleSessionList(): void
  {
    const list = this.query(".session-list");
    list.hidden = !list.hidden;
    if (!list.hidden)
    {
      this.renderSessionList();
    }
  }

  private renderSessionList(): void
  {
    const list = this.query(".session-list");
    const sessions = this.sessions.list;
    const activeId = this.sessions.activeMeta?.id;
    list.innerHTML = sessions
      .map(
        (s) =>
          `<button class="session-item${s.id === activeId ? " active" : ""}" data-id="${s.id}">
            <span class="session-title">${this.escapeHtml(s.title)}</span>
            <span class="session-date">${this.formatDate(s.created)}</span>
            <span class="session-del" data-del="${s.id}" title="Delete chat">&times;</span>
          </button>`,
      )
      .join("");
    // Wire click handlers
    list.querySelectorAll(".session-item").forEach((btn) =>
    {
      btn.addEventListener("click", () =>
      {
        const id = (btn as HTMLElement).dataset.id;
        if (id)
        {
          this.sessions.switchTo(id);
        }
        list.hidden = true;
      });
    });
    list.querySelectorAll(".session-del").forEach((del) =>
    {
      del.addEventListener("click", (e) =>
      {
        e.stopPropagation();
        const id = (del as HTMLElement).dataset.del;
        if (id && this.confirmDelete())
        {
          this.sessions.deleteSession(id);
        }
      });
    });
  }

  private formatDate(ts: number): string
  {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString())
    {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  private confirmDelete(): boolean
  {
    try
    {
      if (localStorage.getItem('ask-skip-delete-confirm') === 'true')
      {
        return true;
      }
    }
    catch
    {
      /* localStorage unavailable */
    }
    const ok = confirm('Delete this chat?');
    if (ok)
    {
      const skip = confirm("Don't ask again for this session?");
      if (skip)
      {
        try
        {
          localStorage.setItem('ask-skip-delete-confirm', 'true');
        }
        catch
        {
          /* localStorage unavailable */
        }
      }
    }
    return ok;
  }

  /* ----------------------------- transcript wiring ---------------------------- */

  private onTranscriptEvent(event: TranscriptEvent): void
  {
    if (event.kind === "append")
    {
      this.appendMessage(event.index);
    }
    else if (event.kind === "update")
    {
      this.patchMessage(event.index);
    }
    else if (event.kind === "reset")
    {
      this.renderAll();
    }
  }

  private renderAll(): void
  {
    const transcript = this.activeTranscript;
    this.messageEls.length = 0;
    this.messagesEl.innerHTML = "";

    if (!transcript || transcript.all.length === 0)
    {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = HINT_TEXT;
      this.messagesEl.appendChild(hint);
      return;
    }

    for (let i = 0; i < transcript.all.length; i++)
    {
      this.appendMessage(i);
    }
  }

  private appendMessage(index: number): void
  {
    this.messagesEl.querySelector(".hint")?.remove();
    const element = document.createElement("div");
    const body = document.createElement("div");
    body.className = "body";
    element.appendChild(body);
    this.messageEls[index] = element;
    this.messagesEl.appendChild(element);
    this.patchMessage(index);
  }

  private patchMessage(index: number): void
