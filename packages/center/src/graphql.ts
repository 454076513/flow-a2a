/**
 * Flow-A2A Center — GraphQL API
 *
 * Provides a flexible GraphQL query interface backed by Storage + PubSub.
 * Mounted at /graphql alongside existing REST routes.
 */

import { createSchema, createYoga } from "graphql-yoga";
import type { Storage } from "./storage/index.js";
import type { PubSub } from "./pubsub/index.js";
import { generateRecommendations } from "./recommendations/engine.js";

export interface GraphQLContext {
  storage: Storage;
  pubsub: PubSub;
}

const typeDefs = /* GraphQL */ `
  type Query {
    health: Health!
    summary(since: Float): CostSummary!
    agents: [AgentInfo!]!
    onlineAgents: [OnlineAgent!]!
    costsByAgent(since: Float): [CostByAgent!]!
    costsByModel(since: Float): [CostByModel!]!
    costsByTrigger(
      since: Float
      channel: String
      scope: String
      user: String
      agent: String
      model: String
    ): [CostByTriggerUser!]!
    costsByChannel(since: Float): [CostByChannel!]!
    costsByConversation(since: Float): [CostByConversation!]!
    hourlySpend(since: Float): [HourlySpend!]!
    yesterdaySpend: YesterdaySpend!
    dailyTrend(since: Float): [DailySpend!]!
    sessionBreakdown(limit: Int): [SessionBreakdown!]!
    triggerBreakdown(since: Float): [TriggerBreakdown!]!
    recommendations: [Recommendation!]!
  }

  type Health {
    status: String!
    ts: Float!
  }

  type CostSummary {
    totalCostUsd: Float!
    totalInputTokens: Float!
    totalOutputTokens: Float!
    totalCacheReadTokens: Float!
    totalCacheCreationTokens: Float!
    totalCalls: Int!
    modelCount: Int!
    agentCount: Int!
  }

  type AgentInfo {
    id: String!
    name: String!
    agentId: String
    lastSeenAt: Float!
  }

  type OnlineAgent {
    id: String!
    name: String!
    botOpenId: String
    groups: [String!]!
    connectedAt: Float!
    nodeId: String!
  }

  type CostByAgent {
    agentName: String!
    costUsd: Float!
    calls: Int!
    inputTokens: Float!
    outputTokens: Float!
  }

  type CostByModel {
    model: String!
    costUsd: Float!
    calls: Int!
    inputTokens: Float!
    outputTokens: Float!
  }

  type CostByTriggerUser {
    triggerUser: String!
    triggerSource: String
    channel: String
    scope: String
    conversationId: String
    conversationName: String
    costUsd: Float!
    calls: Int!
    inputTokens: Float!
    outputTokens: Float!
  }

  type CostByChannel {
    channel: String!
    scope: String
    costUsd: Float!
    calls: Int!
    inputTokens: Float!
    outputTokens: Float!
    userCount: Int!
  }

  type CostByConversation {
    conversationId: String!
    conversationName: String
    channel: String
    scope: String
    costUsd: Float!
    calls: Int!
    inputTokens: Float!
    outputTokens: Float!
    userCount: Int!
  }

  type HourlySpend {
    hour: String!
    costUsd: Float!
    tokens: Float!
  }

  type YesterdaySpend {
    totalUsd: Float!
    totalTokens: Float!
    eventCount: Int!
  }

  type DailySpend {
    date: String!
    costUsd: Float!
  }

  type SessionBreakdown {
    sessionKey: String!
    costUsd: Float!
    eventCount: Int!
    startTs: Float!
    endTs: Float!
  }

  type TriggerBreakdown {
    trigger: String!
    isSubagent: Int!
    costUsd: Float!
    tokens: Float!
    eventCount: Int!
  }

  type Recommendation {
    id: String!
    title: String!
    description: String!
    estimatedSavingsUsd: Float
    confidence: String!
  }
`;

const resolvers = {
  Query: {
    health: () => ({ status: "ok", ts: Date.now() }),

    summary: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getSummary(args.since || 0),

    agents: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      ctx.storage.listAgents(),

    onlineAgents: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      ctx.pubsub.listAllAgents(),

    costsByAgent: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getCostsByAgent(args.since || 0),

    costsByModel: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getCostsByModel(args.since || 0),

    costsByTrigger: (
      _: unknown,
      args: { since?: number; channel?: string; scope?: string; user?: string; agent?: string; model?: string },
      ctx: GraphQLContext,
    ) =>
      ctx.storage.getCostsByTriggerUser(args.since || 0, {
        channel: args.channel || undefined,
        scope: args.scope || undefined,
        user: args.user || undefined,
        agent: args.agent || undefined,
        model: args.model || undefined,
      }),

    costsByChannel: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getCostsByChannel(args.since || 0),

    costsByConversation: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getCostsByConversation(args.since || 0),

    hourlySpend: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getHourlySpend(args.since || 0),

    yesterdaySpend: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      ctx.storage.getYesterdaySpend(),

    dailyTrend: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getLast30DaysDailySpend(args.since || 0),

    sessionBreakdown: (_: unknown, args: { limit?: number }, ctx: GraphQLContext) =>
      ctx.storage.getSessionBreakdown(args.limit || 20),

    triggerBreakdown: (_: unknown, args: { since?: number }, ctx: GraphQLContext) =>
      ctx.storage.getTriggerBreakdown(args.since || 0),

    recommendations: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      generateRecommendations(ctx.storage),
  },
};

export function createGraphQLHandler(storage: Storage, pubsub: PubSub) {
  const schema = createSchema({ typeDefs, resolvers });

  return createYoga<GraphQLContext>({
    schema,
    graphqlEndpoint: "/graphql",
    context: () => ({ storage, pubsub }),
  });
}
