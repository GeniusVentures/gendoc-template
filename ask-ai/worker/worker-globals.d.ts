interface RequestInit {
  cf?: { cacheTtl?: number; cacheEverything?: boolean };
}

interface Element {
  onEndTag(callback: () => void): void;
}

interface TextChunk {
  text: string;
}

declare class HTMLRewriter {
  on(selector: string, handlers: { element?: (element: Element) => void; text?: (text: TextChunk) => void }): HTMLRewriter;
  transform(response: Response): Response;
}
