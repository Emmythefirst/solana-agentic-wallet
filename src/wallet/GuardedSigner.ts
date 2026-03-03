import {
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  Connection,
} from '@solana/web3.js';
import * as dotenv from 'dotenv';

dotenv.config();

const ALLOWED_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp', // AgentVault
]);

export interface GuardConfig {
  maxTransactionLamports: number;
  agentId: number;
  maxDailyTransactions?: number;
  allowedPrograms?: Set<string>;
}

export interface GuardCheckResult {
  approved: boolean;
  reason: string;
  estimatedLamports?: number;
}

export class GuardedSigner {
  private config: GuardConfig;
  private transactionCount: number = 0;       // resets to 0 on every npm start
  private totalSpentLamports: number = 0;      // lifetime — persisted across restarts
  private readonly maxDailyTransactions: number;

  constructor(config: GuardConfig) {
    this.maxDailyTransactions = config.maxDailyTransactions ?? 20;
    this.config = {
      ...config,
      allowedPrograms: config.allowedPrograms ?? ALLOWED_PROGRAMS,
    };

    // Only restore lifetime spend — tx count always starts fresh each session
    const { KeyManager } = require('./KeyManager');
    const saved = KeyManager.loadStats(config.agentId);
    this.totalSpentLamports = saved.totalSpentLamports;

    console.log(
      `[GuardedSigner] Agent #${config.agentId} initialized | ` +
      `Spending cap: ${config.maxTransactionLamports / LAMPORTS_PER_SOL} SOL | ` +
      `Max daily txs: ${this.maxDailyTransactions}`
    );

    if (saved.totalSpentLamports > 0) {
      console.log(
        `[GuardedSigner] Agent #${config.agentId} lifetime spend: ` +
        `${(saved.totalSpentLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`
      );
    }
  }

  private checkSpendingCap(estimatedLamports: number): GuardCheckResult {
    if (estimatedLamports > this.config.maxTransactionLamports) {
      return {
        approved: false,
        reason: `Spending cap exceeded: ${estimatedLamports / LAMPORTS_PER_SOL} SOL requested, ` +
                `cap is ${this.config.maxTransactionLamports / LAMPORTS_PER_SOL} SOL`,
        estimatedLamports,
      };
    }
    return { approved: true, reason: 'Spending cap OK', estimatedLamports };
  }

  private checkTransactionLimit(): GuardCheckResult {
    if (this.transactionCount >= this.maxDailyTransactions) {
      return {
        approved: false,
        reason: `Daily transaction limit reached: ${this.transactionCount}/${this.maxDailyTransactions}`,
      };
    }
    return { approved: true, reason: 'Transaction limit OK' };
  }

  async simulateTransaction(
    connection: Connection,
    transaction: Transaction | VersionedTransaction
  ): Promise<GuardCheckResult> {
    try {
      let result;
      if (transaction instanceof VersionedTransaction) {
        result = await connection.simulateTransaction(transaction);
      } else {
        result = await connection.simulateTransaction(transaction as Transaction);
      }

      if (result.value.err) {
        return { approved: false, reason: `Simulation failed: ${JSON.stringify(result.value.err)}` };
      }

      const logs = result.value.logs ?? [];
      console.log(`[GuardedSigner] Agent #${this.config.agentId} simulation passed ✓`);
      console.log(`[GuardedSigner] Sim logs: ${logs.slice(0, 3).join(' | ')}`);
      return { approved: true, reason: 'Simulation passed' };
    } catch (err: any) {
      return { approved: false, reason: `Simulation error: ${err.message}` };
    }
  }

  async authorize(
    connection: Connection,
    transaction: Transaction | VersionedTransaction,
    estimatedLamports: number = 0
  ): Promise<GuardCheckResult> {
    console.log(`\n[GuardedSigner] Agent #${this.config.agentId} — running authorization gates...`);

    const capCheck = this.checkSpendingCap(estimatedLamports);
    if (!capCheck.approved) {
      console.warn(`[GuardedSigner] ❌ Gate 1 FAILED — ${capCheck.reason}`);
      return capCheck;
    }
    console.log(`[GuardedSigner] ✅ Gate 1 passed — ${capCheck.reason}`);

    const limitCheck = this.checkTransactionLimit();
    if (!limitCheck.approved) {
      console.warn(`[GuardedSigner] ❌ Gate 2 FAILED — ${limitCheck.reason}`);
      return limitCheck;
    }
    console.log(`[GuardedSigner] ✅ Gate 2 passed — ${limitCheck.reason}`);

    const simCheck = await this.simulateTransaction(connection, transaction);
    if (!simCheck.approved) {
      console.warn(`[GuardedSigner] ❌ Gate 3 FAILED — ${simCheck.reason}`);
      return simCheck;
    }
    console.log(`[GuardedSigner] ✅ Gate 3 passed — ${simCheck.reason}`);

    this.transactionCount++;
    this.totalSpentLamports += estimatedLamports;

    // Only persist lifetime spend — not tx count
    const { KeyManager } = require('./KeyManager');
    KeyManager.saveStats(this.config.agentId, {
      totalSpentLamports: this.totalSpentLamports,
    });

    console.log(
      `[GuardedSigner] ✅ Agent #${this.config.agentId} AUTHORIZED | ` +
      `Tx #${this.transactionCount} | Total spent: ${this.totalSpentLamports / LAMPORTS_PER_SOL} SOL`
    );

    return { approved: true, reason: 'All gates passed' };
  }

  isProgramAllowed(programId: string): boolean {
    return this.config.allowedPrograms!.has(programId);
  }

  getStats() {
    return {
      agentId: this.config.agentId,
      transactionCount: this.transactionCount,
      totalSpentSol: this.totalSpentLamports / LAMPORTS_PER_SOL,
      spendingCapSol: this.config.maxTransactionLamports / LAMPORTS_PER_SOL,
      maxDailyTransactions: this.maxDailyTransactions,
      remainingTxAllowance: this.maxDailyTransactions - this.transactionCount,
    };
  }

  resetDailyLimits() {
    this.transactionCount = 0;
    console.log(`[GuardedSigner] Agent #${this.config.agentId} session limits reset`);
  }
}