
# Governance Launches 

> Transparent on-chain fee governance for tokens launched on pump.fun

## What is it?

Governance Launches is a Solana protocol that allows any developer launching a token on pump.fun to connect a DAO to their project. From that point on, every SOL generated in fees goes into a public on-chain treasury — and the **community democratically decides where it goes**.

No secrets. No "dev ran away with the money". Everything is verifiable.

---

## How it works

```
Token launched on pump.fun
        │
        ▼
  Fee Interceptor  ──► Treasury PDA (public on-chain vault)
                                │
                    ┌───────────┴────────────┐
                    │                        │
              Dev creates proposal    Community votes
           "0.5 SOL for Marketing"   (weight = token balance)
                    │                        │
                    └──────────── ► Automatic on-chain execution
                                        │
                              Destination chosen by the DAO:
                              • Burn tokens
                              • Add liquidity
                              • Fund development
                              • Marketing
                              • Anything the community votes for
```

---

## Program Instructions

| Instruction | Who calls it | What it does |
|---|---|---|
| `initialize_dao` | Dev (once) | Creates the DAO for the token |
| `deposit` | Anyone | Deposits SOL into the vault |
| `create_proposal` | Dev | Proposes where to use the funds |
| `cast_vote` | Token holders | Votes for or against |
| `execute_proposal` | Anyone | Executes if approved |

---

## Accounts (PDAs)

```
DaoConfig   → seeds: ["dao", token_mint]
Treasury    → seeds: ["treasury", token_mint]  ← SOL vault
Proposal    → seeds: ["proposal", dao, id]
VoteRecord  → seeds: ["vote", proposal, voter]  ← prevents double voting
```

---

## Governance Rules

- **Quorum**: configurable per project (e.g. 5% of supply must vote)
- **Voting period**: configurable (minimum 1 hour, recommended 3 days)
- **Vote weight**: proportional to token balance at time of voting
- **Double voting**: impossible — VoteRecord PDA blocks it on-chain
- **Execution**: automatic and permissionless — any wallet can trigger it

---

## Setup & Deploy

```bash
# Prerequisites: Rust + Anchor CLI 0.30.1 + Solana CLI + Node.js + Yarn

# Install dependencies
yarn install

# Build
anchor build

# Logic tests (no Solana required)
node tests/logic.test.js

# Integration tests (localnet)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

---

## On-chain Events

| Event | Triggered when |
|---|---|
| `DaoCreated` | A new DAO is connected to a token |
| `FeeDeposited` | SOL enters the vault |
| `ProposalCreated` | A new proposal is submitted |
| `VoteCast` | A vote is recorded |
| `ProposalExecuted` | Funds sent to the approved destination |
| `ProposalDefeated` | A proposal is rejected |

---

## Roadmap

- [ ] v1 — Core smart contract (this repo)
- [ ] v2 — pump.fun fee router integration
- [ ] v3 — Real-time web dashboard
- [ ] v4 — Multi-destination proposals (split funding)
- [ ] v5 — Recurring proposals (e.g. 10% monthly to dev fund)

---

## Why Governance Launches?

Most tokens launched on pump.fun collect fees with zero transparency. Holders have no idea where the money goes or how decisions are made. Governance Launches fixes this by putting every SOL under community control from day one.

Any developer can opt in. If they don't, their token works normally on pump.fun. If they do, their community gains full visibility and voting rights over the project's treasury.

---

## License

MIT

---

## Support the Project

If you find Governance Launches useful and want to support its development:

**Solana wallet:** `AuVNg19rpxAdB6i17CeqXacyF5PmfqNkmGRdjZyBMB2Y`

**Follow updates on X:** [MadDog_Louco](https://twitter.com/MadDog_Louco)

Every contribution helps fund development, security audits, and the pump.fun integration.
