import * as dotenv from 'dotenv';
import { createDashboardServer } from './server';
import { MultiAgentOrchestrator } from '../agents/MultiAgentOrchestrator';
import { AgentDecision } from '../agents/BaseAgent';

dotenv.config();

const ROLE_NAMES = ['Hedge', 'Trader', 'Raider'];
const ROLE_EMOJIS = ['🛡️', '📊', '⚡'];

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         SOLANA AGENTIC WALLET — AUTONOMOUS DEMO              ║
║         Superteam Nigeria Bounty Submission                  ║
║   Network: DEVNET | Hedge · Trader · Raider | Autonomous     ║
╚══════════════════════════════════════════════════════════════╝
  `);

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'sk-your-key-here') {
    console.error('❌ ERROR: Please set your ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  const agentCount = parseInt(process.env.MAX_AGENTS ?? '3');

  const orchestrator = new MultiAgentOrchestrator({
    agentCount,
    cycleIntervalMs: 90000,
    autoFund: false,
  });

  // Live decision feed with role names
  orchestrator.onDecision = (decision: AgentDecision) => {
    const emoji = ROLE_EMOJIS[(decision.agentId - 1) % 3];
    const role = decision.role ?? ROLE_NAMES[(decision.agentId - 1) % 3];
    console.log(`\n${emoji} ${role} #${decision.agentId} → ${decision.action}`);
    console.log(`   ${decision.result.slice(0, 120)}...`);
  };

  await orchestrator.initialize();
  createDashboardServer(orchestrator);
  await orchestrator.start();

  process.on('SIGINT', async () => {
    console.log('\n\n[Demo] Shutting down...');
    orchestrator.stop();

    const finalStats = await orchestrator.getStats();
    console.log('\n📋 FINAL STATS:');
    console.log(`   Total cycles completed: ${finalStats.totalCycles}`);
    console.log(`   Total decisions made: ${finalStats.totalDecisions}`);

    for (const agent of finalStats.agentStats) {
      if (agent.balanceSol !== undefined) {
        const emoji = ROLE_EMOJIS[(agent.agentId - 1) % 3];
        const role = agent.roleName ?? ROLE_NAMES[(agent.agentId - 1) % 3];
        console.log(`\n   ${emoji} ${role} #${agent.agentId}:`);
        console.log(`   └─ Balance     : ${agent.balanceSol?.toFixed(4)} SOL`);
        console.log(`   └─ Transactions: ${agent.guard?.transactionCount}`);
        console.log(`   └─ Total spent : ${agent.guard?.totalSpentSol?.toFixed(4)} SOL`);
        console.log(`   └─ Explorer    : ${agent.explorerUrl}`);
      }
    }

    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});