import { Env } from './types.js';
import { getNormalizer } from './catalog.js'; // we'll create this

const JAILBREAK_KEYWORDS = [
  'ignore', 'disregard', 'forget', 'bypass', 'override', 'jailbreak', 'dan',
  'uncensored', 'unrestricted', 'developer mode', 'act as', 'from now on',
  'reveal system', 'hidden instructions', 'pretend you are'
];

export async function isJailbreakAttempt(
  question: string,
  env: Env,
  origin: string
): Promise<boolean> {
  if (!question || question.length < 5) return false;

  const lower = question.toLowerCase();

  // Fast keyword check
  if (JAILBREAK_KEYWORDS.some(kw => lower.includes(kw))) {
    console.warn(`[ask] jailbreak keyword match: ${question.slice(0, 100)}`);
    return true;
  }

  // Use existing normalizer for misspelling detection (e.g. "igonre")
  try {
    const normalizer = await getNormalizer(env, origin);
    const result = normalizer.normalizeQuery(question);
    const corrected = result.tokens.join(' ').toLowerCase();

    if (JAILBREAK_KEYWORDS.some(kw => corrected.includes(kw))) {
      console.warn(`[ask] jailbreak via spelling correction: "${question}" → "${corrected}"`);
      return true;
    }
  } catch (e: any) {
    console.warn('[ask] normalizer failed for jailbreak check:', e.message);
  }

  return false;
}
