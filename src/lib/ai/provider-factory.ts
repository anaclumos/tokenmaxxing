import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const factories: Record<string, (apiKey: string) => unknown> = {
  openai: (apiKey) => createOpenAI({ apiKey }),
  anthropic: (apiKey) => createAnthropic({ apiKey }),
  google: (apiKey) => createGoogleGenerativeAI({ apiKey }),
};

export function createProviderForOrg(provider: string, apiKey: string) {
  const factory = factories[provider];
  if (!factory) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return factory(apiKey);
}
