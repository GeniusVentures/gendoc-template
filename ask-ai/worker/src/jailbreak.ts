import { Env } from './types.js';

const JAILBREAK_KEYWORDS = [
  'ignore', 'disregard', 'forget', 'bypass', 'override', 'jailbreak', 'dan',
  'uncensored', 'unrestricted', 'developer mode', 'act as', 'from now on',
  'reveal system', 'hidden instructions', 'pretend you are'
];

// Common misspellings of jailbreak keywords that attackers use to evade
// simple string matching (e.g. "igonre" → "ignore").
const JAILBREAK_MISSPELLINGS: Record<string, string> = {
  'igonre': 'ignore', 'ignor': 'ignore', 'ingore': 'ignore',
  'disregard': 'disregard', 'disreguard': 'disregard',
  'forget': 'forget', 'forgit': 'forget',
  'bypass': 'bypass', 'bypas': 'bypass', 'bipass': 'bypass',
  'overide': 'override',
  'jailbrake': 'jailbreak', 'jailbrak': 'jailbreak',
  'devloper': 'developer', 'developr': 'developer',
  'uncensored': 'uncensored', 'uncensor': 'uncensored',
};

function correctMisspellings(text: string): string {
  return text.split(/\s+/).map(w => JAILBREAK_MISSPELLINGS[w] || w).join(' ');
}

export async function isJailbreakAttempt(
  question: string,
  _env: Env,
  _origin: string
): Promise<boolean> {
  if (!question || question.length < 5) return false;

  const lower = question.toLowerCase();

  // Direct keyword match
  if (JAILBREAK_KEYWORDS.some(kw => lower.includes(kw))) {
    console.warn(`[ask] jailbreak keyword match: ${question.slice(0, 100)}`);
    return true;
  }

  // Misspelling-corrected check (O(1) map lookup, no 3 MB JSON load)
  const corrected = correctMisspellings(lower);
  if (JAILBREAK_KEYWORDS.some(kw => corrected.includes(kw))) {
    console.warn(`[ask] jailbreak via spelling correction: "${question}" → "${corrected}"`);
    return true;
  }

  return false;
}
