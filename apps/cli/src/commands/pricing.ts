import { defineCommand } from "citty";
import pc from "picocolors";
import { loadPricing, findPricing } from "../pricing";
import type { ModelPricing } from "../pricing";

function perMillion(costPerToken: number | undefined): string {
  if (!costPerToken) return pc.dim("--");
  return `$${(costPerToken * 1_000_000).toFixed(2)}`;
}

export const pricing = defineCommand({
  meta: { name: "pricing", description: "Look up model pricing from LiteLLM" },
  args: {
    model: { type: "positional", description: "Model name (fuzzy match supported)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const pricingData = await loadPricing();
    const found = findPricing(pricingData, args.model);

    if (!found) {
      console.log(pc.red(`No pricing found for "${args.model}"`));
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(found, null, 2));
      return;
    }

    console.log(`\n  ${pc.bold(args.model)}\n`);
    console.log(`  Input:       ${perMillion(found.input_cost_per_token)} / 1M tokens`);
    console.log(`  Output:      ${perMillion(found.output_cost_per_token)} / 1M tokens`);
    console.log(`  Cache Read:  ${perMillion(found.cache_read_input_token_cost)} / 1M tokens`);
    console.log(`  Cache Write: ${perMillion(found.cache_creation_input_token_cost)} / 1M tokens`);
    console.log();
  },
});
