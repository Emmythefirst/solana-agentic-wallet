const { createReactAgent } = require('@langchain/langgraph/prebuilt');
const { MemorySaver } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { tool } = require('@langchain/core/tools');
const { ChatAnthropic } = require('@langchain/anthropic');
const { z } = require('zod');
import { AgenticWallet } from '../wallet/AgenticWallet';
import * as dotenv from 'dotenv';

dotenv.config();

export type AgentRole = 'hedge' | 'strategist' | 'raider';

export interface AgentDecision {
  agentId: number;
  role: string;
  thought: string;
  action: string;
  result: string;
  timestamp: string;
}

// Role definitions — strategy, limits, personality
export const ROLE_CONFIGS: Record<AgentRole, {
  name: string;
  emoji: string;
  spendingCapSol: number;
  maxDailyTransactions: number;
  stopLossThreshold: number;
  description: string;
}> = {
  hedge: {
    name: 'Hedge',
    emoji: '🛡️',
    spendingCapSol: 0.02,
    maxDailyTransactions: 10,
    stopLossThreshold: 0.3,
    description: 'Capital preservation specialist',
  },
  strategist: {
    name: 'Strategist',
    emoji: '📊',
    spendingCapSol: 0.05,
    maxDailyTransactions: 20,
    stopLossThreshold: 0.2,
    description: 'Price-aware market strategist',
  },
  raider: {
    name: 'Raider',
    emoji: '⚡',
    spendingCapSol: 0.05,
    maxDailyTransactions: 30,
    stopLossThreshold: 0.1,
    description: 'Aggressive liquidity deployer',
  },
};

// ── Message history utilities ─────────────────────────────────────────────────

const MAX_HISTORY = 20; // keep last 20 messages (~10 exchanges) per agent

/**
 * Removes AIMessages whose tool_calls have no corresponding ToolMessage results,
 * and removes ToolMessages that reference non-existent tool_call_ids.
 * This prevents the "tool_use ids found without tool_result blocks" API error
 * that occurs when a tool fails mid-cycle and LangGraph writes an orphaned entry.
 */
function sanitizeMessages(messages: any[]): any[] {
  // Collect all tool_call_ids that have a ToolMessage result
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.tool_call_id) resolvedIds.add(msg.tool_call_id);
  }

  // Remove AI messages where any tool call is unresolved
  const withoutOrphanedUse = messages.filter((msg: any) => {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls.every((tc: any) => resolvedIds.has(tc.id));
    }
    return true;
  });

  // Rebuild valid tool_use id set after the filter above
  const validToolUseIds = new Set<string>();
  for (const msg of withoutOrphanedUse) {
    if (msg.tool_calls) {
      msg.tool_calls.forEach((tc: any) => validToolUseIds.add(tc.id));
    }
  }

  // Remove ToolMessages whose tool_use was also removed
  return withoutOrphanedUse.filter((msg: any) => {
    if (msg.tool_call_id) return validToolUseIds.has(msg.tool_call_id);
    return true;
  });
}

export class BaseAgent {
  public readonly agentId: number;
  public readonly role: AgentRole;
  public readonly roleName: string;
  private wallet: AgenticWallet;
  private reactAgent: any;
  private decisionHistory: AgentDecision[] = [];

  private readonly stopLossThreshold: number;

  constructor(wallet: AgenticWallet, role: AgentRole) {
    this.agentId = wallet.agentId;
    this.role = role;
    this.roleName = ROLE_CONFIGS[role].name;
    this.wallet = wallet;
    this.stopLossThreshold = ROLE_CONFIGS[role].stopLossThreshold;
    this.reactAgent = this.buildReactAgent();

    console.log(`[BaseAgent] ${ROLE_CONFIGS[role].emoji} ${this.roleName} (Agent #${this.agentId}) initialized — ${ROLE_CONFIGS[role].description}`);
  }

  private buildReactAgent() {
    const llm = new ChatAnthropic({
      modelName: 'claude-haiku-4-5-20251001',
      temperature: 0.2,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    // ── Shared tools (all roles) ──────────────────────────────────────────

    const checkBalanceTool = tool(
      async () => {
        try {
          const balance = await this.wallet.getSOLBalance();
          const vaultInfo = await this.wallet.getVaultInfo();
          const vaultBalance = vaultInfo ? vaultInfo.netDeposited : 0;
          const totalPosition = balance + vaultBalance;
          return `${this.roleName} (Agent #${this.agentId}) — Liquid: ${balance.toFixed(4)} SOL | Vault (locked): ${vaultBalance.toFixed(4)} SOL | Total position: ${totalPosition.toFixed(4)} SOL`;
        } catch (err: any) {
          const balance = await this.wallet.getSOLBalance();
          return `${this.roleName} (Agent #${this.agentId}) SOL balance: ${balance.toFixed(4)} SOL | Vault: unavailable`;
        }
      },
      {
        name: 'check_balance',
        description: 'Check current SOL balance including liquid wallet and locked vault position',
        schema: z.object({}),
      }
    );

    const getPriceTool = tool(
      async () => {
        try {
          const response = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true'
          );
          const data = await response.json() as any;
          const price = data?.solana?.usd;
          const change24h = data?.solana?.usd_24h_change?.toFixed(2);
          const trend = change24h > 0 ? '📈 BULLISH' : '📉 BEARISH';
          return `SOL price: $${price} | 24h change: ${change24h}% | Trend: ${trend}`;
        } catch (err: any) {
          return `Price fetch failed: ${err.message}`;
        }
      },
      {
        name: 'get_sol_price',
        description: 'Get current SOL price and 24h trend from CoinGecko',
        schema: z.object({}),
      }
    );

    const readAgentFeedTool = tool(
      async () => {
        try {
          const log: AgentDecision[] = (global as any).__agentEventLog ?? [];
          if (log.length === 0) return 'No recent activity from sibling agents yet.';
          const feed = log
            .filter((e) => e.agentId !== this.agentId)
            .slice(-5)
            .map((e) => `${e.role} (Agent #${e.agentId}) at ${new Date(e.timestamp).toLocaleTimeString()}: ${e.action} — ${e.result.slice(0, 80)}`)
            .join('\n');
          return feed || 'No sibling activity yet.';
        } catch (err: any) {
          return `Feed unavailable: ${err.message}`;
        }
      },
      {
        name: 'read_agent_feed',
        description: 'Read recent decisions from sibling agents to coordinate strategy',
        schema: z.object({}),
      }
    );

    const getStatsTool = tool(
      async () => {
        try {
          const stats = await this.wallet.getStats();
          return JSON.stringify(stats, null, 2);
        } catch (err: any) {
          return `Stats unavailable: ${err.message}`;
        }
      },
      {
        name: 'get_wallet_stats',
        description: 'Get full wallet stats including balance, transaction history, and guard status',
        schema: z.object({}),
      }
    );

    // ── Role-specific tools ───────────────────────────────────────────────

    const transferSOLTool = tool(
      async ({ amountSol }) => {
        try {
          const siblingAddresses = [
            'HiATWrR9pfrdkWK4Da98cTywWhJAeb7g7AZxNaXu9rqt',
            '4dAhnP81KaXYekGi4QepN1bhgBa9y3yKNrB8zZM7QNh3',
            'ESiuSrMbSPkQEZkUMAfd1oVDfKBj49mUkKSmKkTy5Dx8',
          ].filter(addr => addr !== this.wallet.publicKey);
          const target = siblingAddresses[Math.floor(Math.random() * siblingAddresses.length)];
          const signature = await this.wallet.transferSOL(target, amountSol);
          return `Transfer successful. Sent ${amountSol} SOL to ${target.slice(0, 8)}... | Sig: ${signature} | Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`;
        } catch (err: any) {
          return `Transfer failed: ${err.message}`;
        }
      },
      {
        name: 'transfer_sol',
        description: 'Transfer SOL to a sibling agent. Target selected automatically.',
        schema: z.object({
          amountSol: z.number().describe('Amount of SOL to transfer'),
        }),
      }
    );

    const deployTokenTool = tool(
      async () => {
        try {
          const signature = await this.wallet.interactWithProtocol();
          return `Token deployed. Created SPL mint, minted 1000 tokens, transferred 100 to sibling. | Sig: ${signature} | Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`;
        } catch (err: any) {
          return `Token deployment failed: ${err.message}`;
        }
      },
      {
        name: 'deploy_token',
        description: 'Create a new SPL token mint, mint 1000 tokens, and transfer 100 to a sibling agent.',
        schema: z.object({}),
      }
    );

    const vaultDepositTool = tool(
      async ({ amountSol }) => {
        try {
          await this.wallet.initializeVault();
          const sig = await this.wallet.depositToVault(amountSol);
          const info = await this.wallet.getVaultInfo();
          return `[AgentVault] ✅ Deposited ${amountSol} SOL to on-chain vault | Net position: ${info?.netDeposited.toFixed(4)} SOL | Deposits: ${info?.depositCount} | Sig: ${sig} | Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`;
        } catch (err: any) {
          return `[AgentVault] Deposit failed: ${err.message}`;
        }
      },
      {
        name: 'vault_deposit',
        description: 'Deposit SOL into the AgentVault on-chain protocol. Use to lock capital in the autonomous vault.',
        schema: z.object({
          amountSol: z.number().describe('Amount of SOL to deposit into the vault'),
        }),
      }
    );

    const vaultStatusTool = tool(
      async () => {
        try {
          const info = await this.wallet.getVaultInfo();
          if (!info) return '[AgentVault] No vault found. Call vault_deposit to initialize.';
          return `[AgentVault] Status — Address: ${info.address.slice(0,12)}... | Total Deposited: ${info.totalDeposited.toFixed(4)} SOL | Total Withdrawn: ${info.totalWithdrawn.toFixed(4)} SOL | Net Position: ${info.netDeposited.toFixed(4)} SOL | Deposits: ${info.depositCount} | Withdrawals: ${info.withdrawCount}`;
        } catch (err: any) {
          return `[AgentVault] Status check failed: ${err.message}`;
        }
      },
      {
        name: 'vault_status',
        description: 'Check on-chain vault position — total deposited, withdrawn, and current net position.',
        schema: z.object({}),
      }
    );

    // ── Assemble tool list per role ───────────────────────────────────────
    const sharedTools = [checkBalanceTool, getPriceTool, readAgentFeedTool, getStatsTool];
    const vaultTools = [vaultDepositTool, vaultStatusTool];

    const tools = {
      hedge: [...sharedTools, transferSOLTool, ...vaultTools],
      strategist: [...sharedTools, transferSOLTool, deployTokenTool, ...vaultTools],
      raider: [...sharedTools, deployTokenTool, ...vaultTools],
    }[this.role];

    // ── Role-specific system prompts ──────────────────────────────────────
    const systemPrompts: Record<AgentRole, string> = {
      hedge: `You are Hedge — Agent #${this.agentId}, a capital preservation specialist on Solana devnet.

Your role: Protect funds. Minimize risk. Small, safe transfers only.

DECISION FRAMEWORK:
1. Call read_agent_feed — monitor what other agents are doing
2. Call get_sol_price — assess market risk
3. Call check_balance — verify capital position (liquid + vault)

RULES:
- STOP-LOSS ACTIVE (balance < ${this.stopLossThreshold} SOL): report status only, no transactions
- ANY market condition + balance > 0.05 SOL: transfer a small amount (0.005–0.01 SOL) to the lowest-balance sibling
- Occasionally use vault_deposit (0.003–0.005 SOL) to lock capital in the AgentVault protocol
- Check vault_status periodically to monitor locked position
- LOW balance (0.05 SOL or below): report status only

REPORTING VOICE — speak like a risk manager:
"Portfolio preservation mode active. Risk assessment: [market condition]. Executing minimal capital redistribution to maintain network health. Capital secured."
"Volatility detected. Reducing exposure. Small transfer executed as hedge against market uncertainty."

You do NOT create tokens — that's not your mandate.
Your job is steady, safe, consistent capital management.`,

      strategist: `You are Strategist — Agent #${this.agentId}, a price-aware market strategist on Solana devnet.

Your role: Read the market, act accordingly. Bullish = deploy tokens. Bearish = conserve.

DECISION FRAMEWORK:
1. Call read_agent_feed — coordinate with siblings, avoid duplicating their last action
2. Call get_sol_price — assess market conditions
3. Call check_balance — verify available capital (liquid + vault)

RULES:
- STOP-LOSS ACTIVE (balance < ${this.stopLossThreshold} SOL): report status only, no transactions
- BULLISH (price up > 1%) + balance > 0.1 SOL:
  → If Raider just did deploy_token: do vault_deposit (0.005 SOL) to lock gains
  → Otherwise: deploy_token
- BEARISH (price down) + balance > 0.05 SOL:
  → If Hedge just did transfer_sol: do deploy_token instead (diversify)
  → Otherwise: transfer_sol (0.01 SOL)
- Occasionally check vault_status to monitor locked position
- LOW balance (0.05–${this.stopLossThreshold} SOL): report status only

REPORTING VOICE — speak like a quantitative strategist:
"Signal: [BULLISH/BEARISH] | 24h Δ: [change]% | Action: [action] | Rationale: [reasoning]"
"Market analysis complete. Positioning adjusted based on momentum indicators."`,

      raider: `You are Raider — Agent #${this.agentId}, an aggressive liquidity deployer on Solana devnet.

Your role: Deploy capital. Create tokens. Move assets. High activity, high output.

DECISION FRAMEWORK:
1. Call read_agent_feed — check sibling activity for coordination
2. Call get_sol_price — note market conditions (but don't let them stop you)
3. Call check_balance — confirm sufficient capital (liquid + vault)

RULES:
- STOP-LOSS ACTIVE (balance < ${this.stopLossThreshold} SOL): report status only, no transactions
- balance > 0.1 SOL: ALWAYS deploy_token regardless of market trend
  → Create SPL token, mint 1000 tokens, distribute 100 to a sibling
- balance > 0.05 SOL (alternative): vault_deposit (0.005–0.01 SOL) to demonstrate protocol interaction
- Market being bearish is NOT a reason to hold back — you deploy in all conditions
- LOW balance (0.05 SOL or below): report status only

REPORTING VOICE — speak like an aggressive DeFi participant:
"⚡ Deploying capital. Market conditions: [condition] — irrelevant to strategy."
"Token created. Liquidity injected. On-chain footprint expanded."
"AgentVault position updated. Always be deploying."

You do NOT do conservative SOL transfers — that's Hedge's job. You create tokens and deploy to vault.`,
    };

    // ── Message modifier: trim history + sanitize orphaned tool blocks ────
    //
    // This runs before every LLM call. It does two things:
    // 1. Trims conversation history to MAX_HISTORY messages — prevents
    //    token bloat and slow responses across long sessions
    // 2. Removes orphaned tool_use/tool_result pairs — prevents the
    //    "tool_use ids found without tool_result blocks" API error that
    //    occurs when a tool throws mid-cycle and LangGraph writes an
    //    incomplete entry to memory
    const messageModifier = (messages: any[]) => {
      // Step 1 — trim to recent history only
      const recent = messages.length > MAX_HISTORY
        ? messages.slice(-MAX_HISTORY)
        : [...messages];

      // Step 2 — sanitize orphaned tool blocks
      const clean = sanitizeMessages(recent);

      // Step 3 — prepend system prompt
      return [new SystemMessage(systemPrompts[this.role]), ...clean];
    };

    const memory = new MemorySaver();

    return createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      messageModifier,
    });
  }

  async think(prompt?: string): Promise<AgentDecision> {
    const balance = await this.wallet.getSOLBalance();
    const stopLossActive = balance < this.stopLossThreshold;
    const config = ROLE_CONFIGS[this.role];

    const defaultPrompt = stopLossActive
      ? `⚠️ STOP-LOSS TRIGGERED — ${this.roleName} (Agent #${this.agentId})
         Balance: ${balance.toFixed(4)} SOL — below ${this.stopLossThreshold} SOL threshold.
         Do NOT execute transactions. Call get_wallet_stats and report status only.`
      : `${this.roleName} (Agent #${this.agentId}) — autonomous cycle.
         Balance: ${balance.toFixed(4)} SOL | Time: ${new Date().toISOString()}
         Follow your decision framework.`;

    const userPrompt = prompt ?? defaultPrompt;

    console.log(`\n[${this.roleName}] Agent #${this.agentId} ${config.emoji} thinking...`);
    if (stopLossActive) {
      console.log(`[${this.roleName}] ⚠️ STOP-LOSS ACTIVE — balance ${balance.toFixed(4)} SOL`);
    }

    try {
      const result = await this.reactAgent.invoke(
        { messages: [new HumanMessage(userPrompt)] },
        { configurable: { thread_id: `agent-${this.agentId}-${this.role}` } }
      );

      const messages = result.messages;
      const finalMessage = messages[messages.length - 1].content as string;

      const thoughts = messages
        .filter((m: any) => m.constructor.name === 'AIMessage')
        .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' → ');

      const decision: AgentDecision = {
        agentId: this.agentId,
        role: this.roleName,
        thought: thoughts.slice(0, 200),
        action: this.extractAction(messages),
        result: finalMessage,
        timestamp: new Date().toISOString(),
      };

      this.decisionHistory.push(decision);

      console.log(`[${this.roleName}] Agent #${this.agentId} decision: ${decision.action}`);
      console.log(`[${this.roleName}] Agent #${this.agentId} result: ${finalMessage.slice(0, 400)}...`);

      return decision;
    } catch (err: any) {
      const decision: AgentDecision = {
        agentId: this.agentId,
        role: this.roleName,
        thought: 'Error during reasoning',
        action: 'error',
        result: err.message,
        timestamp: new Date().toISOString(),
      };
      this.decisionHistory.push(decision);
      throw err;
    }
  }

  async execute(command: string): Promise<string> {
    console.log(`\n[${this.roleName}] Agent #${this.agentId} executing command: "${command}"`);
    const result = await this.reactAgent.invoke(
      { messages: [new HumanMessage(command)] },
      { configurable: { thread_id: `agent-${this.agentId}-manual` } }
    );
    return result.messages[result.messages.length - 1].content as string;
  }

  private extractAction(messages: any[]): string {
    let lastAction = 'observe';
    for (const msg of messages) {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        lastAction = msg.tool_calls[0].name;
      }
    }
    return lastAction;
  }

  getDecisionHistory(): AgentDecision[] {
    return this.decisionHistory;
  }

  getWallet(): AgenticWallet {
    return this.wallet;
  }
}