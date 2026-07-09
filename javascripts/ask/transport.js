import { LIMITS } from "./config.js";
/** Pick the best available transport, or null if none can work. */
export function createTransport(config) {
    if (config.endpoint)
        return new RemoteTransport(config);
    if (typeof LanguageModel !== "undefined")
        return new LocalPromptTransport(config);
    return null;
}
/* ------------------------------ remote (worker) ----------------------------- */
class RemoteTransport {
    constructor(config) {
        this.config = config;
    }
    async *ask(question, history) {
        const body = { question, history };
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
async function* parseSseStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line.startsWith("data:"))
                    continue;
                const payload = line.slice("data:".length).trim();
                if (payload === "")
                    continue;
                try {
                    yield JSON.parse(payload);
                }
                catch {
                    /* torn frame across chunks -- superseded by the intact next line */
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
class LocalPromptTransport {
    constructor(config) {
        this.config = config;
        this.context = null;
    }
    async *ask(question, _history) {
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
                    content: `You are ${this.config.title}. Answer only from the provided context. ` +
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
        }
        finally {
            session.destroy();
        }
    }
    async loadContext() {
        if (this.context !== null)
            return this.context;
        try {
            const res = await fetch(this.config.llms_full_url);
            this.context = res.ok ? (await res.text()).slice(0, LIMITS.localContextChars) : "";
        }
        catch {
            this.context = "";
        }
        return this.context;
    }
}
