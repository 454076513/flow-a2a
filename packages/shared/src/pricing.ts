/**
 * Flow-A2A — Model Pricing Table & Cost Calculator
 *
 * Reused from costclaw-telemetry with no modifications.
 */

// ─── Pricing Table ──────────────────────────────────────────────────────────

export interface ModelPrice {
  inputPer1M: number;  // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
}

// Prices as of March 2026 — update entries as needed
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o":                      { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "gpt-4o-2024-11-20":           { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "gpt-4o-mini":                 { inputPer1M: 0.15,  outputPer1M: 0.60  },
  "gpt-4o-mini-2024-07-18":      { inputPer1M: 0.15,  outputPer1M: 0.60  },
  "gpt-4-turbo":                 { inputPer1M: 10.00, outputPer1M: 30.00 },
  "gpt-4":                       { inputPer1M: 30.00, outputPer1M: 60.00 },
  "gpt-3.5-turbo":               { inputPer1M: 0.50,  outputPer1M: 1.50  },
  "o1":                          { inputPer1M: 15.00, outputPer1M: 60.00 },
  "o1-mini":                     { inputPer1M: 3.00,  outputPer1M: 12.00 },
  "o3":                          { inputPer1M: 10.00, outputPer1M: 40.00 },
  "o3-mini":                     { inputPer1M: 1.10,  outputPer1M: 4.40  },
  "o4-mini":                     { inputPer1M: 1.10,  outputPer1M: 4.40  },

  // Anthropic Claude
  "claude-3-5-sonnet-20241022":  { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-3-5-sonnet-20240620":  { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-3-5-haiku-20241022":   { inputPer1M: 0.80,  outputPer1M: 4.00  },
  "claude-3-opus-20240229":      { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-3-sonnet-20240229":    { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-3-haiku-20240307":     { inputPer1M: 0.25,  outputPer1M: 1.25  },
  "claude-sonnet-4-6":           { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-opus-4-6":             { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-haiku-4-5":            { inputPer1M: 0.80,  outputPer1M: 4.00  },

  // Google Gemini
  "gemini-2.5-pro":              { inputPer1M: 1.25,  outputPer1M: 10.00 },
  "gemini-2.5-flash":            { inputPer1M: 0.30,  outputPer1M: 2.50  },
  "gemini-2.5-flash-lite":       { inputPer1M: 0.10,  outputPer1M: 0.40  },
  "gemini-2.0-flash":            { inputPer1M: 0.10,  outputPer1M: 0.40  },
  "gemini-1.5-pro":              { inputPer1M: 1.25,  outputPer1M: 5.00  },
  "gemini-1.5-flash":            { inputPer1M: 0.075, outputPer1M: 0.30  },

  // xAI Grok
  "grok-2":                      { inputPer1M: 2.00,  outputPer1M: 10.00 },
  "grok-2-mini":                 { inputPer1M: 0.20,  outputPer1M: 0.40  },
  "grok-3":                      { inputPer1M: 3.00,  outputPer1M: 15.00 },

  // Meta Llama (via API providers — prices vary, these are common averages)
  "llama-3.1-405b-instruct":     { inputPer1M: 3.00,  outputPer1M: 3.00  },
  "llama-3.1-70b-instruct":      { inputPer1M: 0.52,  outputPer1M: 0.75  },
  "llama-3.1-8b-instruct":       { inputPer1M: 0.05,  outputPer1M: 0.08  },
  "llama-3.3-70b-instruct":      { inputPer1M: 0.23,  outputPer1M: 0.40  },
};

// Canonical aliases for prefix matching (longest match wins)
export const MODEL_ALIASES: Array<[string, string]> = [
  ["claude-3-5-sonnet", "claude-3-5-sonnet-20241022"],
  ["claude-3-5-haiku",  "claude-3-5-haiku-20241022"],
  ["claude-3-opus",     "claude-3-opus-20240229"],
  ["claude-3-sonnet",   "claude-3-sonnet-20240229"],
  ["claude-3-haiku",    "claude-3-haiku-20240307"],
  ["gpt-4o-mini",       "gpt-4o-mini"],
  ["gpt-4o",            "gpt-4o"],
  ["gr-claude-opus",    "claude-opus-4-6"],
  ["gr-claude-sonnet",  "claude-sonnet-4-6"],
];

// ─── Cost Calculator ────────────────────────────────────────────────────────

export type CostSource = "telemetry" | "calculated" | "estimated";

export interface CostResult {
  costUsd: number;
  source: CostSource;
}

function resolveModel(raw: string): string | null {
  const lower = raw.toLowerCase().trim();

  if (MODEL_PRICING[lower]) return lower;

  for (const [alias, canonical] of MODEL_ALIASES) {
    if (lower.startsWith(alias)) return canonical;
  }

  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.startsWith(key) || key.startsWith(lower)) return key;
  }

  return null;
}

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  telemetryCostUsd?: number
): CostResult {
  if (telemetryCostUsd != null && telemetryCostUsd > 0) {
    return { costUsd: telemetryCostUsd, source: "telemetry" };
  }

  const resolved = resolveModel(model);
  if (!resolved) {
    return { costUsd: 0, source: "estimated" };
  }

  const price = MODEL_PRICING[resolved];
  const costUsd =
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M;

  return { costUsd, source: "calculated" };
}
