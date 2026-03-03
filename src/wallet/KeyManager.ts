import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
const bs58 = require('bs58').default ?? require('bs58');
import * as dotenv from 'dotenv';

dotenv.config();

export interface WalletInfo {
  publicKey: string;
  privateKeyBase58: string;
  createdAt: string;
  agentId: number;
  totalSpentLamports?: number; // lifetime spend — persisted across restarts
  lastUpdated?: string;
}

export class KeyManager {
  private static readonly KEYS_DIR = path.join(process.cwd(), '.keys');

  static generateKeypair(agentId: number): { keypair: Keypair; info: WalletInfo } {
    const keypair = Keypair.generate();
    const privateKeyBase58 = bs58.encode(keypair.secretKey);

    const info: WalletInfo = {
      publicKey: keypair.publicKey.toBase58(),
      privateKeyBase58,
      createdAt: new Date().toISOString(),
      agentId,
      totalSpentLamports: 0,
    };

    return { keypair, info };
  }

  static saveKeypair(info: WalletInfo): void {
    if (!fs.existsSync(this.KEYS_DIR)) {
      fs.mkdirSync(this.KEYS_DIR, { recursive: true });
    }
    const filePath = path.join(this.KEYS_DIR, `agent-${info.agentId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf-8');
    console.log(`[KeyManager] Agent #${info.agentId} keypair saved → ${filePath}`);
  }

  /**
   * Persist lifetime spend only.
   * txCount is intentionally excluded — resets every session.
   */
  static saveStats(agentId: number, stats: { totalSpentLamports: number }): void {
    const filePath = path.join(this.KEYS_DIR, `agent-${agentId}.json`);
    if (!fs.existsSync(filePath)) return;

    const data: WalletInfo = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.totalSpentLamports = stats.totalSpentLamports;
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load lifetime spend on startup.
   * txCount always starts at 0 — not loaded from disk.
   */
  static loadStats(agentId: number): { totalSpentLamports: number } {
    const filePath = path.join(this.KEYS_DIR, `agent-${agentId}.json`);
    if (!fs.existsSync(filePath)) return { totalSpentLamports: 0 };

    const data: WalletInfo = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      totalSpentLamports: data.totalSpentLamports ?? 0,
    };
  }

  static loadOrCreate(agentId: number): Keypair {
    const filePath = path.join(this.KEYS_DIR, `agent-${agentId}.json`);

    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const info: WalletInfo = JSON.parse(raw);
      const secretKey = bs58.decode(info.privateKeyBase58);
      console.log(`[KeyManager] Agent #${agentId} loaded → ${info.publicKey}`);
      return Keypair.fromSecretKey(secretKey);
    }

    const { keypair, info } = this.generateKeypair(agentId);
    this.saveKeypair(info);
    console.log(`[KeyManager] Agent #${agentId} created → ${info.publicKey}`);
    return keypair;
  }

  static fromBase58(privateKeyBase58: string): Keypair {
    const secretKey = bs58.decode(privateKeyBase58);
    return Keypair.fromSecretKey(secretKey);
  }

  static listSavedWallets(): WalletInfo[] {
    if (!fs.existsSync(this.KEYS_DIR)) return [];

    return fs
      .readdirSync(this.KEYS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(this.KEYS_DIR, f), 'utf-8');
        const info: WalletInfo = JSON.parse(raw);
        return { ...info, privateKeyBase58: '***REDACTED***' };
      });
  }

  static deleteKeypair(agentId: number): void {
    const filePath = path.join(this.KEYS_DIR, `agent-${agentId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[KeyManager] Agent #${agentId} keypair deleted`);
    }
  }
}