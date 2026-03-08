# Solana Agentic Wallet

Three autonomous AI agents running on Solana devnet — each managing its own wallet, making price-aware trading decisions, executing real on-chain transactions, and autonomously interacting with a custom deployed Anchor program.

---

## What This Is

A multi-agent system where each AI agent has its own Solana keypair, reasons about market conditions using live SOL price data, and autonomously executes transactions through a 3-gate security system. No human input required after startup.

Each agent:
- Checks the live SOL/USD price via CoinGecko
- Assesses market trend (bullish vs bearish)
- Decides whether to deploy liquidity (SPL token creation + transfer) or conserve it (SOL transfer)
- Deposits and withdraws SOL from its own on-chain vault via a custom Anchor program
- Signs and broadcasts all transactions independently
- Has its own spending cap and daily transaction limit enforced before every action

---


## Demo Video

[Watch the demo](https://www.loom.com/share/f03535d2d4f04be9bd697ba2d71def60)

---

## Demo

Start the system with `npm start`. Three agents initialize in parallel, each with its own Solana keypair and spending limits. Every 90 seconds a new cycle runs:

- **Hedge** reads the SOL price, assesses risk, and executes a small conservative SOL transfer to a sibling agent
- **Strategist** reads the market signal and either deploys liquidity (bullish) or conserves capital (bearish)
- **Raider** creates an SPL token mint, mints 1000 tokens, distributes 100 to a sibling, and deposits SOL into its AgentVault

All three run in parallel. Every transaction is signed autonomously, passes through the 3-gate GuardedSigner, and is broadcast to Solana devnet. All signatures are logged to the terminal with Solana Explorer links.

Live dashboard available at `dashboard.html` — shows real-time balances, decisions per cycle, and activity feed.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│           Multi-Agent Orchestrator           │
│         (Promise.allSettled — parallel)      │
├──────────────┬──────────────┬────────────────┤
│   Hedge #1   │  Trader #2   │   Raider #3    │
│  LangGraph   │  LangGraph   │   LangGraph    │
│  ReAct Loop  │  ReAct Loop  │   ReAct Loop   │
├──────────────┴──────────────┴────────────────┤
│              AgenticWallet Layer             │
│   KeyManager + GuardedSigner + VaultClient   │
├─────────────────────────────────────────────┤
│           Solana Devnet Programs             │
│  AgentVault · SPL Token · System Program     │
└─────────────────────────────────────────────┘
```

**Agent Layer** — Claude Haiku via LangGraph ReAct. Each agent has 8 tools: `check_balance`, `get_sol_price`, `transfer_sol`, `deploy_token`, `get_stats`, `vault_deposit`, `vault_withdraw`, `vault_status`. Agents reason step-by-step before every action and maintain memory across cycles via `MemorySaver`.

**Wallet Layer** — `AgenticWallet` wraps a `KeypairWallet` from Solana Agent Kit. `KeyManager` handles keypair generation and persistence. `AgentVaultClient` manages all interactions with the AgentVault Anchor program. `GuardedSigner` enforces the 3-gate security model before any transaction broadcasts.

**Security Layer** — Every transaction passes 3 gates in sequence:
1. Spending cap check (per-agent hard limit)
2. Daily transaction limit (per-agent session cap)
3. On-chain simulation via `simulateTransaction` — dry-run before broadcast

**On-Chain Programs:**
- `AgentVault` (`JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp`) — custom Anchor program, PDA vaults per agent
- `SPL Token Program` — token mint creation, minting, transfers
- `System Program` — SOL transfers

**Kora Layer** — `kora.toml` defines the paymaster policy: program allowlists (including AgentVault), token allowlists, fee caps, and rate limits. This is a policy definition, not a running node — it documents the production security posture for fee sponsorship.

---

## AgentVault — Custom Anchor Program

Deployed via Solana Playground (https://beta.solpg.io). The program is live on devnet — no local Anchor installation required to run the project.

Deployed on devnet at `JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp`.

Each agent has a PDA vault derived from its wallet address. The vault tracks:
- Lifetime deposits and withdrawals in lamports
- Deposit and withdrawal transaction counts
- Net SOL position at any point

Agents autonomously call `initialize_vault`, `deposit`, and `withdraw` as part of their decision cycles. Every vault transaction is verifiable on Solana Explorer. Vault state persists permanently on-chain.

See `programs/agentvault/src/lib.rs` for the full program source and `target/idl/agentvault.json` for the IDL.

---

## Project Structure

```
solana-agentic-wallet/
├── src/
│   ├── agents/
│   │   ├── BaseAgent.ts               # LangGraph ReAct agent with 8 tools
│   │   └── MultiAgentOrchestrator.ts  # Parallel multi-agent runner
│   ├── demo/
│   │   ├── observer.ts                # CLI dashboard
│   │   ├── run.ts                     # Main entry point
│   │   └── server.ts                  # Express API for web dashboard
│   ├── kora/
│   │   └── kora.toml                  # Paymaster security policy
│   └── wallet/
│       ├── AgenticWallet.ts           # Main wallet — SOL + SPL + vault operations
│       ├── AgentVaultClient.ts        # AgentVault Anchor program client
│       ├── GuardedSigner.ts           # 3-gate security authorization
│       └── KeyManager.ts             # Keypair generation and secure storage
├── programs/
│   └── agentvault/
│       ├── src/
│       │   └── lib.rs                 # Anchor program source
│       └── Cargo.toml
├── target/
│   └── idl/
│       └── agentvault.json            # Program IDL
├── .env.example
├── .gitignore
├── Anchor.toml                        # Program deployment config
├── dashboard.html                     # Live web dashboard
├── deep-dive.md                       # Security model and architecture deep dive
├── package.json
├── README.md
├── SKILLS.md                          # Agent-readable capabilities file
└── tsconfig.json

```

---

## Requirements

- Node.js v18+
- An Anthropic API key (Claude Haiku)
- A Helius API key (free tier — for devnet RPC)

---

## Setup

**1. Clone and install**

```bash
git clone https://github.com/YOUR_USERNAME/solana-agentic-wallet
cd solana-agentic-wallet
npm install
```

**2. Configure environment**

Copy `.env.example` to `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
SOLANA_RPC=https://devnet.helius-rpc.com/?api-key=your-helius-key
MAX_AGENTS=3
SPENDING_CAP_SOL=0.05
```

Get a free Helius API key at [dashboard.helius.dev](https://dashboard.helius.dev).

**3. Fund the agent wallets**

Run once to generate keypairs:

```bash
npm start
```

Copy the 3 public keys printed on startup and fund each with 2 SOL at [faucet.solana.com](https://faucet.solana.com).

**4. Run**

```bash
# Main autonomous demo
npm start

# Web dashboard — open dashboard.html in browser after npm start
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start 3 autonomous agents in parallel |
| `npm run demo` | CLI observer showing live agent stats |
| `npm run build` | Compile TypeScript |

---

## What Agents Do

Each cycle (every 90 seconds):

1. Read sibling activity feed — coordinate to avoid duplicate actions
2. Fetch live SOL/USD price from CoinGecko
3. Check balance
4. Decide based on market conditions:
   - **Stop-loss active** (balance < threshold) → report status only
   - **Bullish + sufficient balance** → `deploy_token` + `vault_deposit`
   - **Bearish + sufficient balance** → `transfer_sol` + `vault_status`
   - **Coordination active** → pivot to complementary action if sibling just acted
5. All transactions pass through GuardedSigner before broadcast

---

## Security Model

```typescript
// Gate 1 — Spending cap
if (amountLamports > this.spendingCapLamports) → BLOCKED

// Gate 2 — Daily limit  
if (this.transactionCount >= this.maxDailyTransactions) → BLOCKED

// Gate 3 — On-chain simulation
const sim = await connection.simulateTransaction(tx)
if (sim.err) → BLOCKED
```

All three gates must pass. The transaction is never signed or broadcast if any gate fails.

Vault transactions additionally pass through AgentVault's own on-chain constraints: owner validation, rent-exempt enforcement, overflow-checked arithmetic. Two independent security systems in sequence.

**Persistent counters:** Transaction counts and total spent survive restarts — written to disk after every authorized transaction and restored on startup.

---

## Tech Stack

- **Runtime** — Node.js + TypeScript
- **AI** — Claude Haiku (`claude-haiku-4-5-20251001`) via `@langchain/anthropic`
- **Agent Framework** — LangGraph ReAct (`@langchain/langgraph`)
- **Solana** — `@solana/web3.js`, `@solana/spl-token`, `solana-agent-kit@2.0.10`
- **Anchor Program** — Rust + Anchor framework (deployed via Solana Playground)
- **Borsh** — `@coral-xyz/borsh` for on-chain data deserialization
- **Paymaster Config** — Kora (`kora.toml`)
- **Dashboard API** — Express + CORS
- **Price Data** — CoinGecko public API

---

## License

MIT