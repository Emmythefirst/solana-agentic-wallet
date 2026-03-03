import { AgenticWallet } from '../wallet/AgenticWallet';
import { BaseAgent, AgentDecision, AgentRole, ROLE_CONFIGS } from './BaseAgent';
import * as dotenv from 'dotenv';

dotenv.config();

// Fixed role assignment — Agent #1 = Hedge, #2 = Strategist, #3 = Raider
const AGENT_ROLES: AgentRole[] = ['hedge', 'strategist', 'raider'];

export interface OrchestratorConfig {
  agentCount: number;
  cycleIntervalMs?: number;
  autoFund?: boolean;
}

export interface OrchestratorStats {
  totalAgents: number;
  totalDecisions: number;
  totalCycles: number;
  agentStats: any[];
  isRunning: boolean;
  startedAt: string | null;
}

export class MultiAgentOrchestrator {
  private agents: BaseAgent[] = [];
  private wallets: AgenticWallet[] = [];
  private config: OrchestratorConfig;
  private isRunning: boolean = false;
  private cycleCount: number = 0;
  private intervalHandle: NodeJS.Timeout | null = null;
  private allDecisions: AgentDecision[] = [];
  private startedAt: string | null = null;
  private sharedEventLog: AgentDecision[] = [];

  public onDecision?: (decision: AgentDecision) => void;
  public onCycleComplete?: (cycleNumber: number, stats: OrchestratorStats) => void;

  constructor(config: OrchestratorConfig) {
    this.config = {
      cycleIntervalMs: 90000,
      autoFund: false,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  MULTI-AGENT ORCHESTRATOR — Initializing ${this.config.agentCount} agents`);
    console.log(`${'═'.repeat(60)}\n`);

    for (let i = 0; i < this.config.agentCount; i++) {
      const agentId = i + 1;
      const role = AGENT_ROLES[i] ?? 'strategist';
      const roleConfig = ROLE_CONFIGS[role];

      const wallet = new AgenticWallet({
        agentId,
        spendingCapSol: roleConfig.spendingCapSol,
        role,
      });

      const agent = new BaseAgent(wallet, role);

      this.wallets.push(wallet);
      this.agents.push(agent);

      await this.sleep(500);
    }

    console.log(`\n[Orchestrator] ${this.config.agentCount} agents initialized ✓`);
    console.log(`[Orchestrator] Roles: Hedge (conservative) | Strategist (balanced) | Raider (aggressive)`);
    console.log(`[Orchestrator] Cycle interval: ${this.config.cycleIntervalMs! / 1000}s\n`);
  }

  async fundAllAgents(amountSol: number = 1): Promise<void> {
    console.log(`\n[Orchestrator] Funding ${this.agents.length} agents with ${amountSol} SOL each...`);
    for (const wallet of this.wallets) {
      try {
        const balance = await wallet.getSOLBalance();
        if (balance < 0.1) {
          await wallet.requestAirdrop(amountSol);
          await this.sleep(5000);
        } else {
          console.log(`[Orchestrator] Agent #${wallet.agentId} already funded (${balance.toFixed(4)} SOL) — skipping`);
        }
      } catch (err: any) {
        console.warn(`[Orchestrator] Agent #${wallet.agentId} airdrop failed: ${err.message}`);
      }
    }
    console.log(`[Orchestrator] Funding complete ✓\n`);
  }

  async runCycle(): Promise<void> {
    this.cycleCount++;
    const cycleStart = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  CYCLE #${this.cycleCount} — ${new Date().toLocaleTimeString()}`);
    console.log(`${'─'.repeat(60)}`);

    const promises = this.agents.map(async (agent) => {
      try {
        const decision = await agent.think();
        this.allDecisions.push(decision);

        this.sharedEventLog.push(decision);
        if (this.sharedEventLog.length > 20) this.sharedEventLog.shift();
        (global as any).__agentEventLog = [...this.sharedEventLog];

        if (this.onDecision) this.onDecision(decision);
        return decision;
      } catch (err: any) {
        console.error(`[Orchestrator] ${agent.roleName} #${agent.agentId} cycle error: ${err.message}`);
        const errorDecision: AgentDecision = {
          agentId: agent.agentId,
          role: agent.roleName,
          thought: 'Error during cycle',
          action: 'error',
          result: err.message,
          timestamp: new Date().toISOString(),
        };
        this.allDecisions.push(errorDecision);
        return errorDecision;
      }
    });

    await Promise.allSettled(promises);

    const cycleDuration = ((Date.now() - cycleStart) / 1000).toFixed(1);
    console.log(`\n[Orchestrator] Cycle #${this.cycleCount} complete in ${cycleDuration}s`);

    const stats = await this.getStats();
    console.log(`\n📊 Cycle #${this.cycleCount} Summary:`);
    console.log(`   Total decisions: ${stats.totalDecisions} | Agents: ${stats.totalAgents}`);
    stats.agentStats.forEach((s: any) => {
      if (s.agentId) {
        const role = AGENT_ROLES[s.agentId - 1];
        const config = ROLE_CONFIGS[role];
        const vaultStr = s.vaultPosition > 0 ? ` | Vault: ${s.vaultPosition.toFixed(4)} SOL` : '';
        console.log(`   ${config.emoji} ${config.name} #${s.agentId}: ${s.balanceSol?.toFixed(4)} SOL | Txs: ${s.guard?.transactionCount ?? 0}/${s.guard?.maxDailyTransactions ?? 20}${vaultStr}`);
      }
    });

    if (this.onCycleComplete) this.onCycleComplete(this.cycleCount, stats);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[Orchestrator] Already running');
      return;
    }

    this.isRunning = true;
    this.startedAt = new Date().toISOString();
    (global as any).__agentEventLog = [];

    console.log(`\n[Orchestrator] Starting autonomous mode...`);
    console.log(`[Orchestrator] 3 agents running every ${this.config.cycleIntervalMs! / 1000}s\n`);

    if (this.config.autoFund) await this.fundAllAgents(1);

    await this.runCycle();

    this.intervalHandle = setInterval(async () => {
      if (this.isRunning) await this.runCycle();
    }, this.config.cycleIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    console.log(`\n[Orchestrator] Stopped after ${this.cycleCount} cycles`);
  }

  async sendCommand(agentId: number, command: string): Promise<string> {
    const agent = this.agents.find((a) => a.agentId === agentId);
    if (!agent) throw new Error(`Agent #${agentId} not found`);
    console.log(`\n[Orchestrator] Manual command → ${agent.roleName} #${agentId}: "${command}"`);
    return await agent.execute(command);
  }

  async getStats(): Promise<OrchestratorStats> {
    const agentStats = await Promise.all(
      this.wallets.map(async (wallet) => {
        try {
          const stats = await wallet.getStats();
          const role = AGENT_ROLES[wallet.agentId - 1];
          const roleConfig = ROLE_CONFIGS[role];

          // Fetch vault position for dashboard display
          let vaultPosition = 0;
          try {
            const vaultInfo = await wallet.getVaultInfo();
            vaultPosition = vaultInfo?.netDeposited ?? 0;
          } catch {
            // vault not yet initialized — default to 0
          }

          return {
            ...stats,
            role,
            roleName: roleConfig.name,
            roleEmoji: roleConfig.emoji,
            roleDescription: roleConfig.description,
            vaultPosition,
          };
        } catch {
          return { agentId: wallet.agentId, error: 'Failed to fetch stats' };
        }
      })
    );

    return {
      totalAgents: this.agents.length,
      totalDecisions: this.allDecisions.length,
      totalCycles: this.cycleCount,
      agentStats,
      isRunning: this.isRunning,
      startedAt: this.startedAt,
    };
  }

  getSharedEventLog(): AgentDecision[] {
    return this.sharedEventLog.slice(-10);
  }

  getAllDecisions(): AgentDecision[] {
    return this.allDecisions;
  }

  getAgents(): BaseAgent[] {
    return this.agents;
  }

  getWallets(): AgenticWallet[] {
    return this.wallets;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}