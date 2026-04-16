/**
 * Flow-A2A Center — Recommendations Engine
 *
 * Ported from costclaw-telemetry. Generates cost-saving suggestions
 * based on LLM usage patterns.
 */

import { MODEL_PRICING } from "@flow-a2a/shared";
import type { Recommendation } from "@flow-a2a/shared";
import type { Storage } from "../storage/index.js";

// Cheaper alternatives for expensive models
const CHEAPER_ALTERNATIVES: Record<string, string> = {
  "claude-3-opus-20240229":     "claude-3-5-haiku-20241022",
  "claude-opus-4-6":            "claude-haiku-4-5",
  "claude-3-5-sonnet-20241022": "claude-3-5-haiku-20241022",
  "claude-sonnet-4-6":          "claude-haiku-4-5",
  "gpt-4":                      "gpt-4o-mini",
  "gpt-4-turbo":                "gpt-4o-mini",
  "gpt-4o":                     "gpt-4o-mini",
  "o1":                         "o3-mini",
  "grok-3":                     "grok-2-mini",
  "gemini-2.5-pro":             "gemini-2.5-flash",
};

export async function generateRecommendations(storage: Storage): Promise<Recommendation[]> {
  const recs: Recommendation[] = [];

  const data = await storage.getRecommendationData();

  // Rec 1: Model downgrade opportunity
  if (data.topModel) {
    const top = data.topModel;
    const alt = CHEAPER_ALTERNATIVES[top.model];
    if (alt && MODEL_PRICING[alt] && MODEL_PRICING[top.model]) {
      const currentPrice = MODEL_PRICING[top.model];
      const altPrice = MODEL_PRICING[alt];
      const avgInput = top.avgOutputTokens * 3; // rough estimate
      const currentPerCall =
        (avgInput / 1_000_000) * currentPrice.inputPer1M +
        (top.avgOutputTokens / 1_000_000) * currentPrice.outputPer1M;
      const altPerCall =
        (avgInput / 1_000_000) * altPrice.inputPer1M +
        (top.avgOutputTokens / 1_000_000) * altPrice.outputPer1M;
      const savingRatio = currentPerCall > 0 ? (currentPerCall - altPerCall) / currentPerCall : 0;
      const estimatedSavings = top.costUsd * savingRatio;

      if (estimatedSavings > 0.01) {
        recs.push({
          id: "model-downgrade",
          title: `Route tasks from ${top.model} to ${alt}`,
          description: `${top.model} accounts for $${top.costUsd.toFixed(2)} this month. For short-output tasks (avg ${Math.round(top.avgOutputTokens)} tokens out), ${alt} offers similar quality at lower cost.`,
          estimatedSavingsUsd: Math.round(estimatedSavings * 100) / 100,
          confidence: savingRatio > 0.5 ? "high" : "medium",
        });
      }
    }
  }

  // Rec 2: High failure rate
  if (data.totalTools > 10 && data.failedTools / data.totalTools > 0.15) {
    recs.push({
      id: "high-failure-rate",
      title: "High tool failure rate detected",
      description: `${Math.round((data.failedTools / data.totalTools) * 100)}% of tool calls are failing, causing expensive retries. Review your agent's tool usage patterns to reduce wasted tokens.`,
      estimatedSavingsUsd: null,
      confidence: "medium",
    });
  }

  // Rec 3: Generic tip if nothing else surfaced
  if (recs.length === 0) {
    recs.push({
      id: "keep-tracking",
      title: "Keep running agents to see insights",
      description: "Flow-A2A needs at least a few days of data to generate personalized recommendations. Check back soon!",
      estimatedSavingsUsd: null,
      confidence: "low",
    });
  }

  return recs.slice(0, 3);
}
