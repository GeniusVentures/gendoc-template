import { LIMITS, STORAGE_KEY } from "./config.js";
/**
 * The conversation state. The UI renders *from* this class and never stores
 * state of its own; persistence is a side effect of mutation, so every code
 * path that changes the conversation is saved automatically.
 */
export class Transcript {
    constructor(storageKey = STORAGE_KEY) {
        this.messages = [];
        this.listeners = new Set();
        this.storageKey = storageKey;
        this.restore();
    }
    subscribe(listener) {
        this.listeners.add(listener);
    }
    get all() {
        return this.messages;
    }
    /** Last N turns in the shape the worker expects. */
    history() {
        return this.messages
            .slice(-LIMITS.historyTurns)
            .map(({ role, text }) => ({ role, content: text }));
    }
    addUser(text) {
        this.push({ role: "user", thinking: "", text, sources: [] });
    }
    /** Start a streaming assistant message; returns its index for updates. */
    beginAssistant() {
        this.push({ role: "assistant", thinking: "", text: "", sources: [] });
        return this.messages.length - 1;
    }
    appendThinking(index, delta) {
        const msg = this.messages[index];
        if (!msg) {
            return;
        }
        msg.thinking += delta;
        this.emit({ kind: "update", index });
        this.save();
    }
    appendText(index, delta) {
        const msg = this.messages[index];
        if (!msg) {
            return;
        }
        msg.text += delta;
        this.emit({ kind: "update", index });
        this.save();
    }
    setText(index, text) {
        const msg = this.messages[index];
        if (!msg) {
            return;
        }
        msg.text = text;
        this.emit({ kind: "update", index });
        this.save();
    }
    setSources(index, sources) {
        const msg = this.messages[index];
        if (!msg) {
            return;
        }
        msg.sources = sources;
        this.emit({ kind: "update", index });
        this.save();
    }
    clear() {
        this.messages.length = 0;
        try {
            sessionStorage.removeItem(this.storageKey);
        }
        catch {
            /* storage unavailable (e.g. blocked); state is still cleared in memory */
        }
        this.emit({ kind: "reset" });
    }
    push(message) {
        this.messages.push(message);
        if (this.messages.length > LIMITS.transcriptMessages) {
            this.messages.splice(0, this.messages.length - LIMITS.transcriptMessages);
            this.emit({ kind: "reset" });
        }
        else {
            this.emit({ kind: "append", index: this.messages.length - 1 });
        }
        this.save();
    }
    emit(event) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
    save() {
        try {
            sessionStorage.setItem(this.storageKey, JSON.stringify(this.messages));
        }
        catch {
            /* quota or privacy mode -- persistence is best-effort */
        }
    }
    restore() {
        let parsed;
        try {
            parsed = JSON.parse(sessionStorage.getItem(this.storageKey) ?? "[]");
        }
        catch {
            return;
        }
        if (!Array.isArray(parsed)) {
            return;
        }
        for (const item of parsed) {
            if ((item.role === "user" || item.role === "assistant") && typeof item.text === "string") {
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
