interface TokenPricing {
  input: number;
  output: number;
}

const PRICING: Record<string, Record<string, TokenPricing>> = {
  openai: {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "gpt-5.4": { input: 10, output: 30 },
    "o3-mini": { input: 1.1, output: 4.4 },
    "o4-mini": { input: 1.1, output: 4.4 },
  },
  anthropic: {
    "claude-sonnet-4-20250514": { input: 3, output: 15 },
    "claude-haiku-3.5-20241022": { input: 0.8, output: 4 },
    "claude-sonnet-4.6": { input: 3, output: 15 },
    "claude-haiku-4.5": { input: 0.8, output: 4 },
  },
  google: {
    "gemini-2.5-pro": { input: 1.25, output: 10 },
    "gemini-2.5-flash": { input: 0.15, output: 0.6 },
    "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  },
};

const DEFAULT_PRICING: TokenPricing = { input: 3, output: 15 };

export function getModelPricing(
  provider: string,
  model: string,
): TokenPricing {
  return PRICING[provider]?.[model] ?? DEFAULT_PRICING;
}
