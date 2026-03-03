# Deep Dive — Solana Agentic Wallet

This document explains the architecture decisions, security model, and technical implementation of the Solana Agentic Wallet system.

---

## The Core Problem

AI agents need to transact on-chain autonomously. This creates an immediate security challenge: if the agent controls its own private key and can sign anything, a single bad decision — or a compromised reasoning step — could drain the wallet. The question isn't just "can an agent sign transactions?" but "how do we let an agent sign transactions safely?"

This is the problem this system is designed to solve.

---

## Architecture Overview

The system has four distinct layers, each with a single responsibility:

```
┌─────────────────────────────────────────────┐
│  1. Agent Layer — reasoning and decisions    │
│     Claude Haiku + LangGraph ReAct           │
├─────────────────────────────────────────────┤
│  2. Wallet Layer — transaction construction  │
│     AgenticWallet + AgentVaultClient         │
├─────────────────────────────────────────────┤
│  3. Security Layer — authorization gates     │
│     GuardedSigner (3-gate enforcement)       │
├─────────────────────────────────────────────┤
│  4. Network Layer — broadcast and confirm    │
│     Solana devnet RPC (Helius)               │
└─────────────────────────────────────────────┘
```

The agent never touches the private key directly. It calls methods on `AgenticWallet`, which routes every transaction through `GuardedSigner` before signing. The agent cannot bypass the security layer — it is architecturally impossible, not just a policy.

---

## The 3-Gate Security Model

`GuardedSigner` is the most important component in the system. Before any transaction is signed, it runs three sequential checks:

### Gate 1 — Spending Cap

```typescript
if (amountLamports > this.spendingCapLamports) {
  return { approved: false, reason: 'Exceeds spending cap' };
}
```

A hard per-transaction limit (default 0.05 SOL). No single action can exceed this amount regardless of what the AI reasoning produces. This is set at initialization and cannot be changed at runtime.

### Gate 2 — Daily Transaction Limit

```typescript
if (this.transactionCount >= this.maxDailyTransactions) {
  return { approved: false, reason: 'Daily transaction limit reached' };
}
```

Caps the total number of transactions per session (default 20). This prevents runaway loops — if the agent gets stuck in a bad reasoning cycle and keeps trying to transact, it hits a hard ceiling.

### Gate 3 — On-Chain Simulation

```typescript
const simulation = await connection.simulateTransaction(transaction);
if (simulation.value.err) {
  return { approved: false, reason: `Simulation failed: ${simulation.value.err}` };
}
```

Every transaction is dry-run against the current blockchain state before broadcast. If the simulation fails — insufficient funds, invalid account state, program error — the transaction is blocked before any SOL is spent on fees. This is the most technically significant gate: it applies real on-chain validation before committing.

All three gates must pass. The transaction is signed and broadcast only if all three return approved. This gives three independent failure modes, each catching a different class of error.

---

## AgentVault — Custom Anchor Program

Each agent autonomously interacts with AgentVault, a custom Anchor program deployed on Solana devnet:

**Program ID:** `JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp`  
**Source:** `programs/agentvault/src/lib.rs`  
**IDL:** `target/idl/agentvault.json`  
**Deployed via:** Solana Playground (`https://beta.solpg.io`)

### What It Does

AgentVault is an on-chain vault primitive. Each agent has its own vault account — a PDA derived from their wallet address — that tracks lifetime deposits, withdrawals, and transaction counts persistently on-chain.

```rust
#[account]
pub struct VaultState {
    pub owner: Pubkey,          // agent wallet address
    pub total_deposited: u64,   // lifetime deposits in lamports
    pub total_withdrawn: u64,   // lifetime withdrawals in lamports
    pub deposit_count: u32,     // number of deposit transactions
    pub withdraw_count: u32,    // number of withdrawal transactions
    pub bump: u8,               // PDA bump seed
}
```

The program exposes three instructions:
- `initialize_vault` — creates the vault PDA for an agent on first use
- `deposit` — transfers SOL from the agent wallet into the vault
- `withdraw` — returns SOL from the vault back to the agent wallet

### PDA Derivation

```typescript
const [vaultPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), keypair.publicKey.toBuffer()],
  AGENT_VAULT_PROGRAM_ID
);
```

Each agent's vault lives at a deterministic address derived from their keypair. No two agents share a vault. Judges can inspect any vault PDA directly on Solana Explorer to verify autonomous deposit history.

### Security at the Program Level

The Anchor program enforces its own constraints independently of `GuardedSigner`:
- Rent-exempt enforcement on withdrawals — agents cannot drain the vault below the rent exemption threshold
- Overflow-checked arithmetic on all cumulative totals
- Owner validation via `has_one = owner` — only the owning agent can operate their vault

This means vault transactions pass through **two independent security systems**: GuardedSigner gates at the application layer, then the Anchor program's own constraints on-chain.

### TypeScript Integration

`AgentVaultClient` uses raw `@solana/web3.js` instructions rather than the Anchor TypeScript client. This avoids Anchor SDK type compatibility issues while producing identical on-chain behavior. Instructions are built with hardcoded discriminators (first 8 bytes of `sha256("global:instruction_name")`) and Borsh-encoded u64 arguments.

```typescript
const amountBuf = Buffer.alloc(8);
amountBuf.writeBigUInt64LE(BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL)));
const data = Buffer.concat([DISCRIMINATORS.deposit, amountBuf]);
```

### Agent Vault Behavior

Two vault tools are available to all agents:
- `vault_deposit` — deposit SOL into the on-chain vault (0.003–0.01 SOL)
- `vault_status` — read current vault state without transacting

Agents in this prototype only deposit — vault balance grows monotonically across the session. The `withdraw` instruction exists in the Anchor program and the wallet layer as documented capability, but agents are not given access to it. This is a deliberate design choice: a growing vault position tells a cleaner story for the demo and eliminates any risk of agents accidentally draining their own vault.

Each role has distinct vault strategy by design:
- **Raider** — deposits on every protocol interaction cycle, building up on-chain position
- **Strategist** — deposits after profitable cycles to lock gains
- **Hedge** — uses vault status to monitor locked capital, deposits conservatively

This produces a verifiable on-chain record of each agent's capital management strategy across the entire session.

---

## Protocol Interaction Depth

The system demonstrates three distinct levels of Solana protocol interaction:

**Level 1 — System Program** (SOL transfers between agents)  
Direct lamport transfers. Used by all agents for capital redistribution in bearish conditions.

**Level 2 — SPL Token Program** (token creation and distribution)  
Agents create new token mints, mint supply, and transfer tokens to sibling agents. Full SPL token lifecycle.

**Level 3 — AgentVault** (custom Anchor program)  
Agents deposit SOL into their own on-chain vault PDAs. Each vault maintains persistent state tracking lifetime deposits and transaction counts. This is the deepest integration level — a custom deployed program with its own account model, PDA architecture, and on-chain security constraints.

---

## Why LangGraph ReAct

The ReAct (Reasoning + Acting) pattern is the right choice for autonomous agents because it makes the decision process observable and debuggable. Each cycle produces a chain of thought:

```
Thought: SOL price is down 2.57% — market is bearish
Action: check_balance
Observation: 2.48 SOL available
Thought: Balance is sufficient, bearish market means conservative action
Action: transfer_sol (0.01 SOL)
Observation: Transfer successful — signature 3GeWy...
```

This is not just good for debugging. It means judges (and operators) can read exactly why the agent made each decision. The reasoning is transparent by design.

`MemorySaver` gives each agent persistent memory across cycles within a session. Agent #1 remembers what it did in cycle 1 when cycle 2 starts. This enables more sophisticated multi-cycle strategies — an agent can learn from its previous actions.

---

## Why Claude Haiku

Three reasons:

1. **Cost** — Haiku is the most cost-efficient Claude model. Autonomous agents run continuously — inference cost compounds quickly. A submission that works for 10 hours without burning through API credits is more practical than one that runs for 2.

2. **Speed** — Each agent cycle requires multiple LLM calls (the ReAct loop iterates until the agent reaches a final answer). Haiku's lower latency means the 90-second cycle completes with time to spare.

3. **Tool calling** — Haiku handles structured tool calling reliably. The 7-tool schema (price check, balance, transfer, deploy token, stats, vault deposit, vault status) is well within its capability.

---

## Multi-Agent Parallelism

`MultiAgentOrchestrator` uses `Promise.allSettled` to run all agents simultaneously:

```typescript
const results = await Promise.allSettled(
  this.agents.map(agent => agent.think())
);
```

`Promise.allSettled` (not `Promise.all`) is deliberate. If Agent #2 throws an error, Agents #1 and #3 continue running. The orchestrator logs failures and moves on. This is the correct pattern for fault-tolerant parallel systems — a single agent failure should never stop the others.

Each agent is fully isolated: separate keypair, separate `GuardedSigner` instance, separate `MemorySaver` thread, separate vault PDA. There is no shared mutable state between agents.

---

## Key Management

`KeyManager` generates keypairs using `Keypair.generate()` from `@solana/web3.js` and stores them as JSON files in `.keys/agent-{id}.json`. The files are gitignored.

This is suitable for a devnet prototype. In production:

- **Turnkey** — MPC-based key custody with policy enforcement at the key level
- **HashiCorp Vault** — enterprise secret management with audit logs
- **HSM (Hardware Security Module)** — physical key isolation for institutional deployments

The `KeyManager` interface (`loadOrCreate`, `generateKeypair`) is designed so the storage backend can be swapped without changing the agent or wallet layers.

---

## Kora Paymaster Integration

`kora.toml` defines the security policy for a Kora paymaster node. **This file is not connected to a running Kora node in the current prototype** — it is a policy-as-code definition that documents what the production security posture would look like. In a production deployment, a Kora node would read this config and enforce it at the infrastructure level.

```toml
[program_allowlist]
programs = [
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",          # Jupiter v6
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",           # SPL Token
  "11111111111111111111111111111111",                       # System Program
  "JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp",         # AgentVault
]
```

In a production deployment, the Kora paymaster reads this config and enforces it at the infrastructure level — an additional security boundary on top of `GuardedSigner`. Spending policy is enforced in two independent places: application code and network level.

---

## Trading Bot Simulation

Each agent implements price-aware decision making:

1. Fetches SOL/USD price and 24h change from CoinGecko
2. Classifies market as BULLISH or BEARISH
3. Selects action based on market signal, available balance, and sibling activity

**Bullish strategy:** Deploy liquidity — create an SPL token mint, mint 1000 tokens, transfer 100 to a sibling agent, deposit to AgentVault.

**Bearish strategy:** Conserve liquidity — small SOL transfer to a sibling, optionally check vault status.

**Coordination:** Agents read a shared sibling feed before acting. If a sibling just executed a protocol interaction, the current agent pivots to a complementary action — avoiding duplicate strategy in the same cycle.

---

## Why Not Jupiter Swaps

Jupiter's quote API is mainnet-only. Orca devnet pools have no liquidity. This is a known Solana ecosystem constraint that every devnet submission faces. Our response:

1. Deploy a custom Anchor program (AgentVault) to demonstrate deeper protocol integration
2. Implement direct SPL Token Program interactions as devnet-compatible protocol demonstration
3. Document the Jupiter integration path explicitly — the architecture accepts a Jupiter quote response as a drop-in replacement on mainnet

---

## Dashboard

The live dashboard (`dashboard.html`) connects to an Express API server on port 3001. It polls `/api/stats` and `/api/events` every 3 seconds.

The "Decisions per Cycle" chart tracks actual decision events — not transaction counts. This is an important distinction: an agent that hits its daily transaction limit still makes decisions every cycle (reasoning about the market, choosing an action, getting blocked by GuardedSigner). The chart shows full decision activity including blocked attempts, giving an accurate picture of agent reasoning volume vs. on-chain execution volume.

---

## What We Would Add With More Time

1. **Mainnet mode** — configuration flag to switch RPC and enable real Jupiter swaps
2. **Portfolio tracking** — agents track token holdings across cycles and adjust strategy based on composition
3. **Kora node deployment** — actually run the Kora paymaster and demonstrate sponsored transactions
4. **Cross-agent vault coordination** — agents read sibling vault positions as part of the coordination feed, adjusting their own vault strategy based on group-level locked capital

---

## Summary

The system demonstrates four things:

1. **Autonomous wallet management** — agents create, fund, and operate wallets without human input
2. **Safe transaction signing** — 3-gate GuardedSigner prevents unauthorized or excessive spending
3. **Market-aware reasoning** — agents make price-driven decisions using real external data
4. **Deep protocol integration** — three levels of on-chain interaction including a custom deployed Anchor program with PDA-based vault accounts

The design prioritizes correctness and safety over feature count. Every architectural decision — the agent/wallet separation, the 3-gate model, the `Promise.allSettled` parallelism, the Kora policy-as-code, the AgentVault on-chain state — reflects this priority.