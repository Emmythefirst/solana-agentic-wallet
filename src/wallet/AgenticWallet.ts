import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from '@solana/spl-token';
import { SolanaAgentKit, KeypairWallet } from 'solana-agent-kit';
import TokenPlugin from '@solana-agent-kit/plugin-token';
import DefiPlugin from '@solana-agent-kit/plugin-defi';
import { KeyManager } from './KeyManager';
import { GuardedSigner } from './GuardedSigner';
import { AgentRole, ROLE_CONFIGS } from '../agents/BaseAgent';
import { AgentVaultClient, VaultInfo } from './AgentVaultClient';
import * as dotenv from 'dotenv';

dotenv.config();

export interface WalletConfig {
  agentId: number;
  spendingCapSol?: number;
  rpcUrl?: string;
  role?: AgentRole;
}

export interface TransactionRecord {
  signature: string;
  type: string;
  amount?: number;
  timestamp: string;
  status: 'success' | 'failed';
}

interface HeliusAirdropResponse {
  signature?: string;
}

export class AgenticWallet {
  public readonly agentId: number;
  public readonly publicKey: string;
  public readonly role?: AgentRole;

  private keypair: Keypair;
  private connection: Connection;
  private kit: SolanaAgentKit;
  private guard: GuardedSigner;
  private txHistory: TransactionRecord[] = [];
  private vaultClient: AgentVaultClient;

  constructor(config: WalletConfig) {
    this.agentId = config.agentId;
    this.role = config.role;

    const rpcUrl = config.rpcUrl ?? process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';

    // Use role config if role provided, fallback to explicit spendingCapSol or env
    const roleConfig = config.role ? ROLE_CONFIGS[config.role] : null;
    const spendingCapSol = roleConfig?.spendingCapSol
      ?? config.spendingCapSol
      ?? parseFloat(process.env.SPENDING_CAP_SOL ?? '0.05');
    const maxDailyTransactions = roleConfig?.maxDailyTransactions ?? 20;
    const roleName = roleConfig?.name ?? `Agent #${config.agentId}`;
    const roleEmoji = roleConfig?.emoji ?? '🤖';

    this.keypair = KeyManager.loadOrCreate(config.agentId);
    this.publicKey = this.keypair.publicKey.toBase58();

    this.connection = new Connection(rpcUrl, 'confirmed');

    const wallet = new KeypairWallet(this.keypair, rpcUrl);
    this.kit = new SolanaAgentKit(wallet, rpcUrl, {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    })
      .use(TokenPlugin)
      .use(DefiPlugin);

    this.guard = new GuardedSigner({
      agentId: config.agentId,
      maxTransactionLamports: spendingCapSol * LAMPORTS_PER_SOL,
      maxDailyTransactions,
    });

    console.log(`\n[AgenticWallet] ${roleEmoji} ${roleName} initialized`);
    console.log(`[AgenticWallet] Public Key: ${this.publicKey}`);
    console.log(`[AgenticWallet] Spending Cap: ${spendingCapSol} SOL | Max Txs/Day: ${maxDailyTransactions}`);
    console.log(`[AgenticWallet] Explorer: https://explorer.solana.com/address/${this.publicKey}?cluster=devnet`);

    this.vaultClient = new AgentVaultClient(this.keypair, this.connection);
  }

  async getSOLBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  async getSPLBalance(mintAddress: string): Promise<number> {
    try {
      const mint = new PublicKey(mintAddress);
      const ata = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.keypair,
        mint,
        this.keypair.publicKey
      );
      const account = await getAccount(this.connection, ata.address);
      return Number(account.amount);
    } catch {
      return 0;
    }
  }

  async transferSOL(toAddress: string, amountSol: number): Promise<string> {
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const toPubkey = new PublicKey(toAddress);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey,
        lamports: amountLamports,
      })
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.keypair.publicKey;

    const authResult = await this.guard.authorize(this.connection, transaction, amountLamports);
    if (!authResult.approved) {
      throw new Error(`[AgenticWallet] Transaction blocked: ${authResult.reason}`);
    }

    const signature = await sendAndConfirmTransaction(this.connection, transaction, [this.keypair]);

    this.recordTransaction({
      signature,
      type: 'SOL Transfer',
      amount: amountSol,
      timestamp: new Date().toISOString(),
      status: 'success',
    });

    console.log(`[AgenticWallet] Agent #${this.agentId} transferred ${amountSol} SOL → ${toAddress}`);
    console.log(`[AgenticWallet] Signature: ${signature}`);
    console.log(`[AgenticWallet] Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    return signature;
  }

  async interactWithProtocol(): Promise<string> {
    console.log(`\n[AgenticWallet] Agent #${this.agentId} interacting with protocol...`);

    try {
      const dummyTx = new Transaction();
      const { blockhash } = await this.connection.getLatestBlockhash();
      dummyTx.recentBlockhash = blockhash;
      dummyTx.feePayer = this.keypair.publicKey;

      const authResult = await this.guard.authorize(this.connection, dummyTx, 0.005 * LAMPORTS_PER_SOL);
      if (!authResult.approved) {
        throw new Error(`Transaction blocked: ${authResult.reason}`);
      }

      const {
        createMint,
        getOrCreateAssociatedTokenAccount,
        mintTo,
        transfer: splTransfer,
      } = require('@solana/spl-token');

      console.log(`[AgenticWallet] Agent #${this.agentId} creating SPL token mint...`);
      const mint = await createMint(
        this.connection,
        this.keypair,
        this.keypair.publicKey,
        null,
        6
      );
      console.log(`[AgenticWallet] Agent #${this.agentId} mint created → ${mint.toBase58()}`);

      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.keypair,
        mint,
        this.keypair.publicKey
      );

      const mintSig = await mintTo(
        this.connection,
        this.keypair,
        mint,
        tokenAccount.address,
        this.keypair,
        1000 * 10 ** 6
      );
      console.log(`[AgenticWallet] Agent #${this.agentId} minted 1000 tokens ✓ → ${mintSig}`);

      const siblingAddresses = [
        'HiATWrR9pfrdkWK4Da98cTywWhJAeb7g7AZxNaXu9rqt',
        '4dAhnP81KaXYekGi4QepN1bhgBa9y3yKNrB8zZM7QNh3',
        'ESiuSrMbSPkQEZkUMAfd1oVDfKBj49mUkKSmKkTy5Dx8',
      ].filter(addr => addr !== this.publicKey);

      const targetAddress = siblingAddresses[Math.floor(Math.random() * siblingAddresses.length)];
      const { PublicKey: SolPublicKey } = require('@solana/web3.js');
      const targetPubkey = new SolPublicKey(targetAddress);

      const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.keypair,
        mint,
        targetPubkey
      );

      const transferSig = await splTransfer(
        this.connection,
        this.keypair,
        tokenAccount.address,
        recipientTokenAccount.address,
        this.keypair.publicKey,
        100 * 10 ** 6
      );

      this.recordTransaction({
        signature: transferSig,
        type: 'SPL Token Create + Transfer',
        amount: 100,
        timestamp: new Date().toISOString(),
        status: 'success',
      });

      console.log(`[AgenticWallet] Agent #${this.agentId} transferred 100 tokens → ${targetAddress.slice(0, 8)}...`);
      console.log(`[AgenticWallet] Explorer: https://explorer.solana.com/tx/${transferSig}?cluster=devnet`);

      return transferSig;
    } catch (err: any) {
      this.recordTransaction({
        signature: 'failed',
        type: 'SPL Token Create + Transfer',
        amount: 0,
        timestamp: new Date().toISOString(),
        status: 'failed',
      });
      throw new Error(`Protocol interaction failed: ${err.message}`);
    }
  }

  async requestAirdrop(amountSol: number = 1): Promise<string> {
    console.log(`[AgenticWallet] Agent #${this.agentId} requesting ${amountSol} SOL airdrop...`);

    try {
      const heliusKey = process.env.SOLANA_RPC?.split('api-key=')[1];
      if (heliusKey) {
        const response = await fetch(
          `https://api.helius.xyz/v0/addresses/${this.publicKey}/airdrop?api-key=${heliusKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: amountSol * 1e9 }),
          }
        );
        if (response.ok) {
          const data: HeliusAirdropResponse = await response.json() as HeliusAirdropResponse;
          const signature = data.signature ?? 'helius-airdrop';
          console.log(`[AgenticWallet] Agent #${this.agentId} Helius airdrop confirmed ✓`);
          return signature;
        }
      }
    } catch {
      console.log(`[AgenticWallet] Agent #${this.agentId} Helius faucet unavailable, trying native...`);
    }

    try {
      const signature = await this.connection.requestAirdrop(
        this.keypair.publicKey,
        amountSol * LAMPORTS_PER_SOL
      );
      await this.connection.confirmTransaction(signature);
      const newBalance = await this.getSOLBalance();
      console.log(`[AgenticWallet] Agent #${this.agentId} airdrop confirmed ✓ | New balance: ${newBalance} SOL`);
      return signature;
    } catch (err: any) {
      throw new Error(`Airdrop failed: ${err.message}`);
    }
  }

  private recordTransaction(record: TransactionRecord): void {
    this.txHistory.push(record);
  }

  async getOnChainHistory(limit: number = 5): Promise<string[]> {
    const signatures = await this.connection.getSignaturesForAddress(
      this.keypair.publicKey,
      { limit }
    );
    return signatures.map((s) => s.signature);
  }

  getLocalHistory(): TransactionRecord[] {
    return this.txHistory;
  }

  async getStats() {
    const balance = await this.getSOLBalance();
    const guardStats = this.guard.getStats();
    const onChainHistory = await this.getOnChainHistory();

    return {
      agentId: this.agentId,
      publicKey: this.publicKey,
      balanceSol: balance,
      explorerUrl: `https://explorer.solana.com/address/${this.publicKey}?cluster=devnet`,
      guard: guardStats,
      recentSignatures: onChainHistory,
      localTxCount: this.txHistory.length,
    };
  }

  // ── AgentVault Protocol Methods ──────────────────────────────────────────

  async initializeVault(): Promise<string> {
    console.log(`[AgenticWallet] Agent #${this.agentId} initializing on-chain vault...`);
    const sig = await this.vaultClient.initializeVault();
    if (sig !== 'already-initialized') {
      this.recordTransaction({
        signature: sig,
        type: 'AgentVault: Initialize',
        timestamp: new Date().toISOString(),
        status: 'success',
      });
    }
    return sig;
  }

  async depositToVault(amountSol: number): Promise<string> {
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    // Run through GuardedSigner gates
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: this.vaultClient.getVaultPDA(),
        lamports: amountLamports,
      })
    );
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.keypair.publicKey;

    const authResult = await this.guard.authorize(this.connection, transaction, amountLamports);
    if (!authResult.approved) {
      throw new Error(`[AgenticWallet] Vault deposit blocked: ${authResult.reason}`);
    }

    console.log(`[AgenticWallet] Agent #${this.agentId} depositing ${amountSol} SOL to vault...`);
    const sig = await this.vaultClient.deposit(amountSol);

    this.recordTransaction({
      signature: sig,
      type: 'AgentVault: Deposit',
      amount: amountSol,
      timestamp: new Date().toISOString(),
      status: 'success',
    });

    return sig;
  }

  async withdrawFromVault(amountSol: number): Promise<string> {
    console.log(`[AgenticWallet] Agent #${this.agentId} withdrawing ${amountSol} SOL from vault...`);
    const sig = await this.vaultClient.withdraw(amountSol);

    this.recordTransaction({
      signature: sig,
      type: 'AgentVault: Withdraw',
      amount: amountSol,
      timestamp: new Date().toISOString(),
      status: 'success',
    });

    return sig;
  }

  async getVaultInfo(): Promise<VaultInfo | null> {
    return this.vaultClient.getVaultInfo();
  }

  getVaultClient(): AgentVaultClient {
    return this.vaultClient;
  }

  getKit(): SolanaAgentKit {
    return this.kit;
  }

  getConnection(): Connection {
    return this.connection;
  }

  getKeypair(): Keypair {
    return this.keypair;
  }
}