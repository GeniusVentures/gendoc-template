import { Env } from './types.js';
import { fetchWithConnectTimeout, PROVIDER_CONNECT_MS } from './utils.js';

export interface ProviderResult {
  res: Response;
  extract: (chunk: any) => string;
}

export const PROVIDERS: Record<string, (env: Env, system: string, history: any[], question: string) => Promise<ProviderResult | null>> = {
  async gemini(env, system, history, question) {
    if (!env.GEMINI_API_KEY) return null;

    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
    const res = await fetchWithConnectTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [
            ...history.map(h => ({
              role: h.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: String(h.content).slice(0, 2000) }]
            })),
            { role: 'user', parts: [{ text: question }] }
          ],
          generationConfig: { temperature: 0.2 }
        })
      },
      PROVIDER_CONNECT_MS
    );

    if (!res.ok) {
      console.error('gemini', res.status, (await res.text()).slice(0, 200));
      return null;
    }

    return {
      res,
      extract: (c) => c.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || ''
    };
  },

  async openrouter(env, system, history, question) {
    if (!env.OPENROUTER_API_KEY) return null;

    const models = (env.OPENROUTER_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (models.length === 0) return null;

    // Nemotron 3's published generation config uses temperature 1.0 and
    // top_p 0.95.  The previous 0.2 temperature made its final channel prone
    // to collapsing into terse outline labels after otherwise good reasoning.
    const isNemotron3 = models[0].toLowerCase().includes('nemotron-3-');

    const body: any = {
      stream: true,
      temperature: isNemotron3 ? 1.0 : 0.2,
      ...(isNemotron3 ? { top_p: 0.95 } : {}),
      // Keep reasoning visible, but reserve ample completion space for a
      // self-contained final answer after the reasoning trace.
      reasoning: { enabled: true, exclude: false, max_tokens: 2048 },
      max_completion_tokens: 8192,
      messages: [
        { role: 'system', content: system },
        ...history.map(h => ({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: String(h.content).slice(0, 2000)
        })),
        { role: 'user', content: question }
      ]
    };

    if (models.length > 1) {
      body.models = models;
      body.route = 'fallback';
    } else {
      body.model = models[0];
    }

    const res = await fetchWithConnectTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': env.SITE_URL || '',
        'X-Title': env.BOT_NAME || 'gendoc-ask'
      },
      body: JSON.stringify(body)
    }, PROVIDER_CONNECT_MS);

    if (!res.ok) {
      console.error('openrouter', res.status, (await res.text()).slice(0, 200));
      return null;
    }

    return {
      res,
      extract: (c) =>
        c.choices?.[0]?.delta?.content ||
        c.choices?.[0]?.delta?.reasoning ||
        c.choices?.[0]?.message?.content ||
        ''
    };
  }
};
