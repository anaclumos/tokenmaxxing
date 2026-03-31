import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_DIR = join(homedir(), ".config", "tokenmaxxing");
const CACHE_FILE = join(CACHE_DIR, "pricing-cache.json");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type ModelPricing = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
};

let pricingCache: Map<string, ModelPricing> | null = null;

async function loadPricing(): Promise<Map<string, ModelPricing>> {
  if (pricingCache) return pricingCache;

  // Try disk cache (Bun.file for consistent API)
  const file = Bun.file(CACHE_FILE);
  if (await file.exists()) {
    const age = Date.now() - file.lastModified;
    if (age < CACHE_TTL_MS) {
      const data = await file.json();
      pricingCache = new Map(Object.entries(data));
      return pricingCache;
    }
  }

  // Fetch fresh
  const res = await fetch(LITELLM_URL);
  const data = await res.json() as Record<string, ModelPricing>;

  pricingCache = new Map(Object.entries(data));

  // Write to disk cache
  mkdirSync(CACHE_DIR, { recursive: true });
  await Bun.write(CACHE_FILE, JSON.stringify(data));

  return pricingCache;
}

// Try multiple name variations to find pricing
function findPricing(pricing: Map<string, ModelPricing>, model: string): ModelPricing | null {
  // Direct match
  const direct = pricing.get(model);
  if (direct) return direct;

  // Try with provider prefixes
  for (const prefix of ["anthropic/", "openai/", "google/", "azure/"]) {
    const prefixed = pricing.get(`${prefix}${model}`);
    if (prefixed) return prefixed;
  }

  // Fuzzy match: find a key that contains the model name
  const lower = model.toLowerCase();
  for (const [key, value] of pricing) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return value;
    }
  }

  return null;
}

export async function calculateCost(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Promise<number> {
  const pricing = await loadPricing();
  const p = findPricing(pricing, model);
  if (!p) return 0;

  let cost = 0;
  cost += tokens.input * (p.input_cost_per_token ?? 0);
  cost += tokens.output * (p.output_cost_per_token ?? 0);
  cost += tokens.cacheRead * (p.cache_read_input_token_cost ?? 0);
  cost += tokens.cacheWrite * (p.cache_creation_input_token_cost ?? 0);
  return cost;
}
