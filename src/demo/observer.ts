import * as dotenv from 'dotenv';
import { MultiAgentOrchestrator } from '../agents/MultiAgentOrchestrator';

dotenv.config();

const ROLE_NAMES = ['Hedge', 'Trader', 'Raider'];
const ROLE_EMOJIS = ['🛡️', '📊', '⚡'];
const ROLE_DESCS = ['Capital preservation', 'Price-aware trading', 'Aggressive deployer'];

async function observer() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         SOLANA AGENTIC WALLET — LIVE OBSERVER                ║
║         Hedge · Trader · Raider on devnet                    ║
╚══════════════════════════════════════════════════════════════╝
  `);

  const orchestrator = new MultiAgentOrchestrator({
    agentCount: parseInt(process.env.MAX_AGENTS ?? '3'),
    autoFund: false,
    cycleIntervalMs: 90000,
  });

  await orchestrator.initialize();

  const printDashboard = async () => {
    const stats = await orchestrator.getStats();
    const time = new Date().toLocaleTimeString();

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  OBSERVER DASHBOARD — ${time}`);
    console.log(`${'═'.repeat(60)}`);

    for (const agent of stats.agentStats) {
      if (!agent.agentId) continue;
      const i = agent.agentId - 1;
      const emoji = ROLE_EMOJIS[i % 3];
      const role = agent.roleName ?? ROLE_NAMES[i % 3];
      const desc = ROLE_DESCS[i % 3];
      const maxTxs = agent.guard?.maxDailyTransactions ?? 20;

      console.log(`
  ${emoji} ${role} — ${desc}
  ├─ Public Key : ${agent.publicKey?.slice(0, 20)}...
  ├─ Balance    : ${agent.balanceSol?.toFixed(6) ?? '...'} SOL
  ├─ Txs signed : ${agent.guard?.transactionCount ?? 0} / ${maxTxs} daily
  ├─ Total spent: ${agent.guard?.totalSpentSol?.toFixed(6) ?? 0} SOL
  ├─ Remaining  : ${agent.guard?.remainingTxAllowance ?? 0} txs left today
  └─ Explorer   : ${agent.explorerUrl}`
      );
    }

    console.log(`\n  Total decisions: ${stats.totalDecisions} | Cycles: ${stats.totalCycles}`);
    console.log(`${'═'.repeat(60)}\n`);
  };

  await printDashboard();
  setInterval(printDashboard, 15000);

  process.on('SIGINT', () => {
    console.log('\n[Observer] Stopped.');
    process.exit(0);
  });
}

observer().catch(console.error);