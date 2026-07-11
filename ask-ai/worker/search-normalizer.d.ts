export interface NormalizeResult {
  tokens: string[];
  corrected: boolean;
}

export class MkDocsSearchNormalizer {
  wordToMeta: Map<string, unknown>;
  static load(searchJsonUrl: string): Promise<MkDocsSearchNormalizer>;
  normalizeQuery(query: string): NormalizeResult;
}
