# Agentic Wallet Skills

## Identity
This is an autonomous Solana devnet trading bot agent.
Each agent controls its own keypair, monitors market conditions, and operates independently.

## Core Capabilities

### Market Intelligence
- `get_sol_price` — Fetch live SOL/USD price and 24h trend from CoinGecko
  - Returns current price, 24h % change, and trend signal (BULLISH/BEARISH)
  - Called at the start of every decision cycle before any action

### Wallet Operations
- `check_balance` — Get current SOL balance in real-time from devnet RPC
- `get_wallet_stats` — Full stats including tx history, guard status, spending cap, and daily allowance

### Transactions
- `transfer_sol` — Transfer SOL to a sibling agent wallet (guarded, max 0.02 SOL per tx)
- `deploy_token` — Full SPL token protocol interaction:
  1. Create a new SPL token mint
  2. Create associated token account
  3. Mint 1000 tokens to own account
  4. Transfer 100 tokens to a sibling agent

### AgentVault — On-Chain Vault (Custom Anchor Program)
Program ID: `JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp`

- `vault_deposit` — Deposit SOL into the agent's on-chain vault PDA (0.003–0.01 SOL)
  - Vault is auto-initialized on first deposit
  - Deposits pass through GuardedSigner before the Anchor program enforces its own constraints
- `vault_status` — Read current vault state on-chain without transacting
  - Returns: total deposited, total withdrawn, net position, deposit count, withdraw count
  - Useful in bearish cycles to monitor locked capital without spending tx budget

## Decision Framework
Agents follow this logic every cycle:

```
1. read_agent_feed   → check what sibling agents did (avoid duplicate actions)
2. get_sol_price     → assess market trend
3. check_balance     → verify available funds

STOP-LOSS ACTIVE (balance < 0.2 SOL):
   → Do NOT execute any transactions
   → Report status only — preserving remaining funds

BULLISH market + balance > 0.05 SOL:
   → deploy_token (create token, mint, distribute to siblings)
   → vault_deposit (0.005–0.01 SOL) — lock gains in AgentVault
   (if sibling just did deploy_token → transfer_sol instead)

BEARISH market + balance > 0.05 SOL:
   → transfer_sol (0.01 SOL, conservative)
   → vault_status (check locked position without transacting)
   (if sibling just did transfer_sol → vault_deposit or deploy_token instead)

LOW balance (0.05–0.2 SOL):
   → report status only — no transactions
```

### Role-Specific Vault Strategy
- **Raider (aggressive)** — vault_deposit on every deploy_token cycle, builds up position rapidly
- **Strategist (balanced)** — vault_deposit after profitable cycles to lock gains, monitors net position
- **Hedge (conservative)** — vault_status to monitor capital, deposits only when balance is healthy

## Security Model
Every transaction passes through GuardedSigner — 3 gates before signing:
1. **Spending cap check** — hard limit per transaction (Hedge: 0.02 SOL, Strategist/Raider: 0.05 SOL)
2. **Daily transaction limit** — max txs per agent per session (Hedge: 10, Strategist: 20, Raider: 30)
3. **On-chain simulation** — dry-run via `simulateTransaction` before broadcast

All 3 gates must pass. Transaction is blocked and never signed if any gate fails.

Vault transactions additionally pass through AgentVault program constraints:
- Owner validation (only owning agent can operate their vault)
- Rent-exempt enforcement on withdrawals
- Overflow-checked arithmetic on all cumulative totals

## Autonomous Behavior
- Agents run decision cycles independently every 90 seconds
- Each agent has its own memory thread via LangGraph MemorySaver
- Market conditions (price trend) drive action selection each cycle
- All decisions and reasoning are logged transparently to console and dashboard
- Agents coordinate strategy by reading a shared sibling activity feed before every decision
- Stop-loss triggers automatically when balance drops below threshold — agent halts all transactions
- Transaction history and vault state persist across restarts

## Multi-Agent Support
- Up to N agents run in parallel via MultiAgentOrchestrator (Promise.allSettled)
- Each agent has isolated keypair, GuardedSigner, MemorySaver, and vault PDA
- Agents never share private keys or wallet state
- Sibling agent addresses are known for inter-agent transfers and token distributions

## On-Chain Programs
- **AgentVault** (`JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp`) — custom Anchor program, PDA vaults
- **SPL Token Program** — token mint creation, minting, transfers
- **System Program** — SOL transfers
- **Associated Token Account Program** — ATA creation for recipients

## Observability
- CLI dashboard: `npm run demo` — live agent stats, balances, tx counts
- Web dashboard: `dashboard.html` — real-time visual feed with activity log and decisions-per-cycle chart
- API: `http://localhost:3001/api/stats` — machine-readable agent state
- All transactions logged with Solana Explorer URLs
- Vault PDAs inspectable directly on Solana Explorer

## Network
- Devnet only (safe sandbox, no real funds at risk)
- RPC: Helius devnet (`https://devnet.helius-rpc.com/?api-key=...`)
- Explorer: https://explorer.solana.com/?cluster=devnet

## Production Path
- Replace `deploy_token` with Jupiter v6 swap for mainnet trading
- Replace `KeyManager` file storage with HSM or Turnkey for key custody
- Deploy Kora paymaster node with `kora.toml` policy for fee sponsorship (AgentVault already in allowlist)
- Scale `MAX_AGENTS` in `.env` for additional parallel agents