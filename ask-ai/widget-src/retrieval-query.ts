/** Retrieval context only; prior messages never become system instructions. */
export interface RetrievalTurn {
    role: "user" | "assistant";
    content: string;
}

export function cleanHistory(value: unknown): RetrievalTurn[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-6).filter((turn): turn is RetrievalTurn =>
        turn !== null && typeof turn === "object" &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string",
    ).map(turn => ({ role: turn.role, content: turn.content.slice(0, 2000) }));
}

/** Carry forward user topics only for explicit references or terse follow-ups. */
export function retrievalQuery(question: string, history: unknown): string {
    const current = question.trim().slice(0, 1000);
    if (!current) return "";
    const refersBack = /\b(it|its|that|those|these|they|them|their|this|same|another|also)\b/i.test(current) ||
        /^(and|but|what about|how about)\b/i.test(current);
    if (!refersBack) return current;
    const topics = cleanHistory(history).filter(turn => turn.role === "user")
        .slice(-2).map(turn => turn.content.trim().slice(0, 400)).filter(Boolean);
    return [current, ...topics.reverse()].join("\n");
}
