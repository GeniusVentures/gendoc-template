import { LIMITS } from "./config.js";
import { DRAWER_CSS } from "./styles.js";
const HINT_TEXT = "Answers come only from this site's documentation, with sources.";
/**
 * The floating button + right-hand drawer. Renders exclusively from the
 * active Transcript (one element per message, patched in place while streaming);
 * user intent is reported through the onAsk callback.
 */
export class DrawerUI {
    constructor(config, sessions, onAsk) {
        this.config = config;
        this.sessions = sessions;
        this.onAsk = onAsk;
        this.messageEls = [];
        this.activeTranscript = null;
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
        this.inputEl = this.query("input");
        this.submitEl = this.query("button[type=submit]");
        // Restore saved drawer width
        const savedWidth = localStorage.getItem('ask-drawer-width');
        if (savedWidth) {
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
        new ResizeObserver(() => {
            const w = getComputedStyle(this.drawer).width;
            if (w && w !== '0px') {
                localStorage.setItem('ask-drawer-width', w);
            }
        }).observe(this.drawer);
        // Left-edge drag to resize
        let dragging = false;
        let startX = 0;
        let startW = 0;
        this.drawer.addEventListener('mousedown', (e) => {
            const rect = this.drawer.getBoundingClientRect();
            if (e.clientX - rect.left <= 8) {
                dragging = true;
                startX = e.clientX;
                startW = rect.width;
                e.preventDefault();
            }
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) {
                return;
            }
            const newW = Math.max(300, Math.min(window.innerWidth * 0.9, startW + (startX - e.clientX)));
            this.drawer.style.width = `${newW}px`;
        });
        document.addEventListener('mouseup', () => {
            dragging = false;
        });
        this.wireEvents();
        this.wireSessionEvents();
        this.switchTranscript(sessions.active);
    }
    /* -------------------------------- public API ------------------------------- */
    open() {
        this.drawer.classList.add("open");
        this.inputEl.focus();
    }
    close() {
        this.drawer.classList.remove("open");
    }
    setBusy(busy) {
        this.submitEl.disabled = busy;
    }
    /** Re-attach host to document body after Material navigation swaps DOM. */
    reattach() {
        if (!this.host.isConnected) {
            document.body.appendChild(this.host);
        }
    }
    /** Read Material's data-md-color-media and sync to the drawer element. */
    syncTheme() {
        const isDark = (document.body.getAttribute('data-md-color-media') || '').includes('dark');
        this.drawer.setAttribute('data-theme', isDark ? 'dark' : 'light');
    }
    /* ----------------------------- session wiring ----------------------------- */
    wireSessionEvents() {
        this.sessions.subscribe((event) => {
            if (event.kind === "switched") {
                this.switchTranscript(this.sessions.active);
            }
            else if (event.kind === "list-changed") {
                this.renderSessionList();
            }
        });
    }
    switchTranscript(transcript) {
        this.activeTranscript = transcript;
        if (transcript) {
            transcript.subscribe((event) => this.onTranscriptEvent(event));
        }
        this.renderAll();
    }
    /* --------------------------------- DOM setup -------------------------------- */
    buildDom() {
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
        </form>
      </section>`;
        const fragment = template.content;
        const title = this.config.title;
        fragment.querySelector(".fab").textContent = `✦ ${title}`;
        fragment.querySelector(".drawer").setAttribute("aria-label", title);
        fragment.querySelector(".head b").textContent = title;
        const input = fragment.querySelector("input");
        input.placeholder = this.config.placeholder;
        input.maxLength = LIMITS.questionChars;
        return fragment;
    }
    wireEvents() {
        this.query(".fab").addEventListener("click", () => {
            this.drawer.classList.contains("open") ? this.close() : this.open();
        });
        this.query(".close").addEventListener("click", () => this.close());
        this.query(".new-chat").addEventListener("click", () => this.sessions.newSession());
        this.query(".history-btn").addEventListener("click", () => this.toggleSessionList());
        this.root.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                this.close();
            }
        });
        this.query("form").addEventListener("submit", (event) => {
            event.preventDefault();
            const question = this.inputEl.value.trim();
            this.inputEl.value = "";
            if (question) {
                this.onAsk(question);
            }
        });
    }
    /* ----------------------------- session list UI ----------------------------- */
    toggleSessionList() {
        const list = this.query(".session-list");
        list.hidden = !list.hidden;
        if (!list.hidden) {
            this.renderSessionList();
        }
    }
    renderSessionList() {
        const list = this.query(".session-list");
        const sessions = this.sessions.list;
        const activeId = this.sessions.activeMeta?.id;
        list.innerHTML = sessions
            .map((s) => `<button class="session-item${s.id === activeId ? " active" : ""}" data-id="${s.id}">
            <span class="session-title">${this.escapeHtml(s.title)}</span>
            <span class="session-date">${this.formatDate(s.created)}</span>
            <span class="session-del" data-del="${s.id}" title="Delete chat">&times;</span>
          </button>`)
            .join("");
        // Wire click handlers
        list.querySelectorAll(".session-item").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                if (id) {
                    this.sessions.switchTo(id);
                }
                list.hidden = true;
            });
        });
        list.querySelectorAll(".session-del").forEach((del) => {
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                const id = del.dataset.del;
                if (id && this.confirmDelete()) {
                    this.sessions.deleteSession(id);
                }
            });
        });
    }
    formatDate(ts) {
        const d = new Date(ts);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        }
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    confirmDelete() {
        try {
            if (localStorage.getItem('ask-skip-delete-confirm') === 'true') {
                return true;
            }
        }
        catch {
            /* localStorage unavailable */
        }
        const ok = confirm('Delete this chat?');
        if (ok) {
            const skip = confirm("Don't ask again for this session?");
            if (skip) {
                try {
                    localStorage.setItem('ask-skip-delete-confirm', 'true');
                }
                catch {
                    /* localStorage unavailable */
                }
            }
        }
        return ok;
    }
    /* ----------------------------- transcript wiring ---------------------------- */
    onTranscriptEvent(event) {
        if (event.kind === "append") {
            this.appendMessage(event.index);
        }
        else if (event.kind === "update") {
            this.patchMessage(event.index);
        }
        else if (event.kind === "reset") {
            this.renderAll();
        }
    }
    renderAll() {
        const transcript = this.activeTranscript;
        this.messageEls.length = 0;
        this.messagesEl.innerHTML = "";
        if (!transcript || transcript.all.length === 0) {
            const hint = document.createElement("div");
            hint.className = "hint";
            hint.textContent = HINT_TEXT;
            this.messagesEl.appendChild(hint);
            return;
        }
        for (let i = 0; i < transcript.all.length; i++) {
            this.appendMessage(i);
        }
    }
    appendMessage(index) {
        this.messagesEl.querySelector(".hint")?.remove();
        const element = document.createElement("div");
        const body = document.createElement("span");
        body.className = "body";
        element.appendChild(body);
        this.messageEls[index] = element;
        this.messagesEl.appendChild(element);
        this.patchMessage(index);
    }
    patchMessage(index) {
        const transcript = this.activeTranscript;
        if (!transcript) {
            return;
        }
        const message = transcript.all[index];
        const element = this.messageEls[index];
        if (!message || !element) {
            return;
        }
        element.className = `message ${message.role}`;
        const body = element.querySelector(".body");
        if (message.role === "user") {
            body.textContent = message.text;
        }
        else {
            // Render "Thinking..." collapsible if the model streamed reasoning
            let thinkEl = element.querySelector(".thinking");
            if (message.thinking) {
                if (!thinkEl) {
                    thinkEl = document.createElement("details");
                    thinkEl.className = "thinking";
                    const summary = document.createElement("summary");
                    summary.textContent = "Thinking…";
                    thinkEl.appendChild(summary);
                    const pre = document.createElement("pre");
                    thinkEl.appendChild(pre);
                    element.insertBefore(thinkEl, body);
                }
                thinkEl.lastElementChild.textContent = message.thinking;
                thinkEl.open = false;
                // Animate "Thinking…" dots while answer hasn't started
                thinkEl.classList.toggle('streaming', !message.text || message.text === '…');
            }
            else if (thinkEl) {
                thinkEl.remove();
            }
            // Provider badge
            let providerEl = element.querySelector(".provider");
            if (message.provider) {
                if (!providerEl) {
                    providerEl = document.createElement("span");
                    providerEl.className = "provider";
                    element.insertBefore(providerEl, body);
                }
                providerEl.textContent = message.provider;
            }
            else if (providerEl) {
                providerEl.remove();
            }
            body.innerHTML = renderInlineMarkdown(message.text || "…");
        }
        element.querySelector(".sources")?.remove();
        if (message.sources.length > 0) {
            element.appendChild(buildSourceList(message.sources));
        }
    }
    query(selector) {
        const element = this.root.querySelector(selector);
        if (!element) {
            throw new Error(`DrawerUI: missing element ${selector}`);
        }
        return element;
    }
    escapeHtml(s) {
        return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
    }
}
/* ---------------------------------- helpers ---------------------------------- */
function buildSourceList(sources) {
    const details = document.createElement("details");
    details.className = "sources";
    const summary = document.createElement("summary");
    summary.textContent = `Sources (${sources.length})`;
    details.appendChild(summary);
    for (const source of sources) {
        const anchor = document.createElement("a");
        anchor.href = source.url;
        anchor.target = "_blank";
        anchor.rel = "noopener";
        anchor.textContent = source.title || source.url;
        details.appendChild(anchor);
    }
    return details;
}
/** Escape everything, then re-introduce a small safe inline subset. */
function renderInlineMarkdown(text) {
    return escapeHtml(text)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function escapeHtml(text) {
    const replacements = {
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    };
    return text.replace(/[&<>"']/g, (char) => replacements[char] ?? char);
}
