import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as borsh from '@coral-xyz/borsh';

// ── Program ID (deployed on devnet) ──────────────────────────
export const AGENT_VAULT_PROGRAM_ID = new PublicKey(
  'JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp'
);

// ── Anchor instruction discriminators (sha256("global:<name>")[0..8]) ──────
// These are computed by Anchor automatically from the instruction name
const DISCRIMINATORS = {
  initializeVault: Buffer.from([48, 191, 163, 44, 71, 129, 63, 164]),
  deposit:         Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  withdraw:        Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
};

// ── VaultState account layout (matches Rust struct) ──────────
const VAULT_STATE_LAYOUT = borsh.struct([
  borsh.publicKey('owner'),
  borsh.u64('totalDeposited'),
  borsh.u64('totalWithdrawn'),
  borsh.u32('depositCount'),
  borsh.u32('withdrawCount'),
  borsh.u8('bump'),
]);

export interface VaultInfo {
  address: string;
  totalDeposited: number;   // SOL
  totalWithdrawn: number;   // SOL
  netDeposited: number;     // SOL
  depositCount: number;
  withdrawCount: number;
}

export class AgentVaultClient {
  private keypair: Keypair;
  private connection: Connection;
  private vaultPDA: PublicKey;
  private vaultBump: number;

  constructor(keypair: Keypair, connection: Connection) {
    this.keypair = keypair;
    this.connection = connection;

    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), keypair.publicKey.toBuffer()],
      AGENT_VAULT_PROGRAM_ID
    );
    this.vaultPDA = pda;
    this.vaultBump = bump;
  }

  getVaultPDA(): PublicKey {
    return this.vaultPDA;
  }

  // ── Check if vault exists ─────────────────────────────────────
  async vaultExists(): Promise<boolean> {
    const info = await this.connection.getAccountInfo(this.vaultPDA);
    return info !== null && info.data.length > 0;
  }

  // ── Initialize vault ─────────────────────────────────────────
  async initializeVault(): Promise<string> {
    const exists = await this.vaultExists();
    if (exists) {
      console.log(`[AgentVault] Vault already exists for this agent`);
      return 'already-initialized';
    }

    const ix = new TransactionInstruction({
      programId: AGENT_VAULT_PROGRAM_ID,
      keys: [
        { pubkey: this.vaultPDA,                  isSigner: false, isWritable: true  },
        { pubkey: this.keypair.publicKey,          isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
      ],
      data: DISCRIMINATORS.initializeVault,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.keypair]);

    console.log(`[AgentVault] ✅ Vault initialized | Sig: ${sig}`);
    console.log(`[AgentVault] Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    return sig;
  }

  // ── Deposit ───────────────────────────────────────────────────
  async deposit(amountSol: number): Promise<string> {
    const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // Encode u64 amount as little-endian 8 bytes
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(amountLamports);

    const data = Buffer.concat([DISCRIMINATORS.deposit, amountBuf]);

    const ix = new TransactionInstruction({
      programId: AGENT_VAULT_PROGRAM_ID,
      keys: [
        { pubkey: this.vaultPDA,              isSigner: false, isWritable: true  },
        { pubkey: this.keypair.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.keypair]);

    console.log(`[AgentVault] ✅ Deposited ${amountSol} SOL | Sig: ${sig}`);
    console.log(`[AgentVault] Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    return sig;
  }

  // ── Withdraw ──────────────────────────────────────────────────
  async withdraw(amountSol: number): Promise<string> {
    const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(amountLamports);

    const data = Buffer.concat([DISCRIMINATORS.withdraw, amountBuf]);

    const ix = new TransactionInstruction({
      programId: AGENT_VAULT_PROGRAM_ID,
      keys: [
        { pubkey: this.vaultPDA,              isSigner: false, isWritable: true  },
        { pubkey: this.keypair.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.keypair]);

    console.log(`[AgentVault] ✅ Withdrew ${amountSol} SOL | Sig: ${sig}`);
    console.log(`[AgentVault] Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    return sig;
  }

  // ── Read vault state ──────────────────────────────────────────
  async getVaultInfo(): Promise<VaultInfo | null> {
    try {
      const info = await this.connection.getAccountInfo(this.vaultPDA);
      if (!info || info.data.length < 8) return null;

      // Skip 8-byte Anchor account discriminator
      const data = info.data.slice(8);
      const state = VAULT_STATE_LAYOUT.decode(data);

      const totalDeposited = Number(state.totalDeposited) / LAMPORTS_PER_SOL;
      const totalWithdrawn = Number(state.totalWithdrawn) / LAMPORTS_PER_SOL;

      return {
        address: this.vaultPDA.toBase58(),
        totalDeposited,
        totalWithdrawn,
        netDeposited: totalDeposited - totalWithdrawn,
        depositCount: state.depositCount,
        withdrawCount: state.withdrawCount,
      };
    } catch {
      return null;
    }
  }
}