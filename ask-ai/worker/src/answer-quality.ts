/** Detect final answers that contain an outline but omit details already found in reasoning. */

function listItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1]?.trim() || '')
    .filter(Boolean);
}

function isDetailedItem(item: string): boolean {
  const words = item.replace(/[*_`#]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  // The requested answer format is "Feature name: explanation". Accept
  // alternate dashes too, or a sufficiently complete standalone sentence.
  const hasExplanation = /(?:\*\*)?\s*(?::|[—–-])\s+\S+(?:\s+\S+){2,}/.test(item);
  return hasExplanation || words.length >= 12;
}

export function needsFinalAnswerRepair(
  question: string,
  finalText: string,
  reasoningText: string,
): boolean {
  const final = finalText.trim();
  const reasoning = reasoningText.trim();

  if (!final) return reasoning.length >= 200;
  if (reasoning.length < 200) return false;

  const finalHeadings = (final.match(/^\s{0,3}#{1,6}\s+\S.+$/gm) || []).length;
  const finalItems = listItems(final);
  const finalDetailedItems = finalItems.filter(isDetailedItem).length;
  const reasoningDetailedItems = listItems(reasoning).filter(isDetailedItem).length;
  const asksForEnumeration =
    /\b(features?|capabilit(?:y|ies)|components?|benefits?|requirements?|advantages?)\b/i.test(question);

  // Typical failure: reasoning enumerates the answer, while the final emits
  // category headings and feature names without explanations.
  if (
    asksForEnumeration &&
    reasoningDetailedItems >= 3 &&
    finalDetailedItems < Math.min(3, reasoningDetailedItems)
  ) {
    return true;
  }

  // Generic outline-only failure for non-enumeration questions.
  const bodyLines = final
    .split('\n')
    .filter(line => line.trim())
    .filter(line => !/^\s{0,3}#{1,6}\s+/.test(line))
    .filter(line => !/^\s*(?:[-*+]|\d+[.)])\s+/.test(line));
  const bodyWords = bodyLines.join(' ').match(/[\p{L}\p{N}]+/gu)?.length || 0;

  return finalHeadings >= 3 && finalDetailedItems === 0 && bodyWords < 45;
}
