#!/usr/bin/env node

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error(`
Missing OPENROUTER_API_KEY.

Run:

  export OPENROUTER_API_KEY="sk-or-v1-..."
  node nemotron-stream-test.mjs
`);
  process.exit(1);
}

const model =
  process.env.MODEL ??
  "nvidia/nemotron-3-super-120b-a12b:free";

const prompt =
  process.argv.slice(2).join(" ") ||
  "Explain why the sky appears blue. Think carefully, then give a concise final answer.";

const debugStream = process.env.DEBUG_STREAM === "1";

let reasoningText = "";
let answerText = "";

let reasoningHeaderPrinted = false;
let answerHeaderPrinted = false;

// Used only when a provider puts <think> tags inside delta.content.
let fallbackBuffer = "";
let insideThinkTag = false;

// Once separate reasoning fields appear, content should be treated
// as the final answer rather than scanned for <think> tags.
let sawSeparateReasoning = false;

function printReasoning(text) {
  if (!text) return;

  if (!reasoningHeaderPrinted) {
    process.stdout.write("\n========== THINKING ==========\n");
    reasoningHeaderPrinted = true;
  }

  reasoningText += text;
  process.stdout.write(text);
}

function printAnswer(text) {
  if (!text) return;

  if (!answerHeaderPrinted) {
    process.stdout.write("\n\n========== ANSWER ==========\n");
    answerHeaderPrinted = true;
  }

  answerText += text;
  process.stdout.write(text);
}

/**
 * Extract readable text from OpenRouter reasoning_details entries.
 *
 * Different providers can normalize structured reasoning slightly
 * differently, so this intentionally accepts several likely fields.
 */
function extractReasoningDetailText(detail) {
  if (!detail || typeof detail !== "object") {
    return "";
  }

  if (typeof detail.text === "string") {
    return detail.text;
  }

  if (typeof detail.content === "string") {
    return detail.content;
  }

  if (typeof detail.summary === "string") {
    return detail.summary;
  }

  // Some normalized formats may contain content parts.
  if (Array.isArray(detail.content)) {
    return detail.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }

  return "";
}

/**
 * Parse content streams containing:
 *
 *   <think>reasoning...</think>final answer...
 *
 * Tags may be split across arbitrary network chunks, so the parser
 * keeps enough trailing characters to recognize partial tags.
 */
function processThinkTagFallback(text, flush = false) {
  fallbackBuffer += text;

  const openTag = "<think>";
  const closeTag = "</think>";
  const keepLength = Math.max(openTag.length, closeTag.length) - 1;

  while (fallbackBuffer.length > 0) {
    if (insideThinkTag) {
      const closeIndex = fallbackBuffer.indexOf(closeTag);

      if (closeIndex !== -1) {
        printReasoning(fallbackBuffer.slice(0, closeIndex));
        fallbackBuffer = fallbackBuffer.slice(
          closeIndex + closeTag.length,
        );
        insideThinkTag = false;
        continue;
      }

      if (flush) {
        printReasoning(fallbackBuffer);
        fallbackBuffer = "";
        return;
      }

      const safeLength = Math.max(
        0,
        fallbackBuffer.length - keepLength,
      );

      if (safeLength > 0) {
        printReasoning(fallbackBuffer.slice(0, safeLength));
        fallbackBuffer = fallbackBuffer.slice(safeLength);
      }

      return;
    }

    const openIndex = fallbackBuffer.indexOf(openTag);

    if (openIndex !== -1) {
      printAnswer(fallbackBuffer.slice(0, openIndex));
      fallbackBuffer = fallbackBuffer.slice(
        openIndex + openTag.length,
      );
      insideThinkTag = true;
      continue;
    }

    if (flush) {
      printAnswer(fallbackBuffer);
      fallbackBuffer = "";
      return;
    }

    const safeLength = Math.max(
      0,
      fallbackBuffer.length - keepLength,
    );

    if (safeLength > 0) {
      printAnswer(fallbackBuffer.slice(0, safeLength));
      fallbackBuffer = fallbackBuffer.slice(safeLength);
    }

    return;
  }
}

function processDelta(delta) {
  if (!delta || typeof delta !== "object") {
    return;
  }

  /*
   * Prefer delta.reasoning.
   *
   * Some OpenRouter/provider combinations emit the same text in both
   * reasoning and reasoning_details, so never print both from one chunk.
   */
  if (
    typeof delta.reasoning === "string" &&
    delta.reasoning.length > 0
  ) {
    sawSeparateReasoning = true;
    printReasoning(delta.reasoning);
  } else if (Array.isArray(delta.reasoning_details)) {
    /*
     * Only inspect reasoning_details when delta.reasoning is absent.
     */
    for (const detail of delta.reasoning_details) {
      const text = extractReasoningDetailText(detail);

      if (text) {
        sawSeparateReasoning = true;
        printReasoning(text);
      }
    }
  }

  if (
    typeof delta.content === "string" &&
    delta.content.length > 0
  ) {
    if (sawSeparateReasoning) {
      printAnswer(delta.content);
    } else {
      processThinkTagFallback(delta.content);
    }
  }

  if (debugStream) {
    process.stderr.write(
      `\n[debug delta]\n${JSON.stringify(delta, null, 2)}\n`,
    );
  }
}

async function main() {
  console.log(`Model: ${model}`);
  console.log(`Prompt: ${prompt}`);
  console.log("Connecting to OpenRouter...");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",

      // Optional OpenRouter attribution headers.
      "HTTP-Referer": "http://localhost",
      "X-Title": "Nemotron Streaming Test",
    },
    body: JSON.stringify({
      model,

      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],

      stream: true,

      /*
       * Keep reasoning visible in the response.
       *
       * "effort" may not be interpreted identically by every provider,
       * but enabled + exclude:false requests exposed reasoning.
       */
      reasoning: {
        enabled: true,
        effort: "high",
        exclude: false,
      },

      temperature: 0.2,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();

    throw new Error(
      `OpenRouter returned HTTP ${response.status} ${response.statusText}\n\n${errorBody}`,
    );
  }

  if (!response.body) {
    throw new Error("OpenRouter returned no response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let sseBuffer = "";
  let receivedDone = false;

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    sseBuffer += decoder.decode(value, { stream: true });

    /*
     * SSE events are separated by a blank line.
     * Normalize CRLF to LF because either may be returned.
     */
    sseBuffer = sseBuffer.replaceAll("\r\n", "\n");

    const events = sseBuffer.split("\n\n");
    sseBuffer = events.pop() ?? "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length === 0) {
        continue;
      }

      const data = dataLines.join("\n").trim();

      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        receivedDone = true;
        continue;
      }

      let chunk;

      try {
        chunk = JSON.parse(data);
      } catch (error) {
        process.stderr.write(
          `\nCould not parse SSE JSON:\n${data}\n`,
        );
        continue;
      }

      if (debugStream) {
        process.stderr.write(
          `\n[debug chunk]\n${JSON.stringify(chunk, null, 2)}\n`,
        );
      }

      /*
       * OpenRouter may return an error as an SSE event after the HTTP
       * stream has already started successfully.
       */
      if (chunk.error) {
        const message =
          chunk.error.message ??
          JSON.stringify(chunk.error);

        throw new Error(`OpenRouter stream error: ${message}`);
      }

      for (const choice of chunk.choices ?? []) {
        processDelta(choice.delta);

        if (choice.finish_reason === "error") {
          throw new Error(
            "The provider terminated the stream with finish_reason=error.",
          );
        }
      }
    }
  }

  /*
   * Process any final bytes not followed by a blank SSE separator.
   */
  sseBuffer += decoder.decode();

  if (sseBuffer.trim()) {
    const remainingLines = sseBuffer
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => line.startsWith("data:"));

    for (const line of remainingLines) {
      const data = line.slice(5).trim();

      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        const chunk = JSON.parse(data);

        if (chunk.error) {
          throw new Error(
            chunk.error.message ??
              JSON.stringify(chunk.error),
          );
        }

        for (const choice of chunk.choices ?? []) {
          processDelta(choice.delta);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          process.stderr.write(
            `\nIgnored incomplete final SSE data:\n${data}\n`,
          );
        } else {
          throw error;
        }
      }
    }
  }

  // Flush text retained while checking for split <think> tags.
  if (!sawSeparateReasoning) {
    processThinkTagFallback("", true);
  }

  console.log("\n\n========== COMPLETE ==========");
  console.log(`Reasoning characters: ${reasoningText.length}`);
  console.log(`Answer characters:    ${answerText.length}`);
  console.log(`Received [DONE]:      ${receivedDone}`);

  if (!reasoningText) {
    console.log(`
No separate reasoning text was received.

Possible explanations:
1. The selected provider did not expose reasoning.
2. The model returned only its final answer.
3. Reasoning was encoded in a provider-specific field.
4. The free-model router selected a provider without reasoning streaming.

Run again with:

  DEBUG_STREAM=1 node nemotron-stream-test.mjs

That will print every raw chunk to stderr.
`);
  }
}

main().catch((error) => {
  console.error(`\n\nFatal error:\n${error.stack ?? error.message}`);
  process.exit(1);
});
