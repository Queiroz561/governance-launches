# Governance Launches — Testing Guide

## Level 1: Pure logic tests ✅ (no installation required)

These tests simulate 100% of the contract logic in plain JavaScript.
Run them right now — no Solana, Rust, or Anchor needed.

```bash
# Only requires Node.js v18+
node tests/logic.test.js
```

**What is tested:**
- SOL deposits into the vault (valid, zero, negative)
- Proposal creation (length limits, insufficient balance)
- Voting (proportional weight, double vote, deadline, no tokens)
- Execution (quorum, majority, timing, reuse)
- Full scenarios (complete cycle, multiple proposals, tie votes)

---

## Level 2: Anchor integration tests 🔧 (localnet)

These tests run the real Rust contract on a local blockchain.

### Prerequisites

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"

# 3. Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1

# 4. Node + Yarn
npm install -g yarn
```

### Run tests

```bash
yarn install
anchor build
anchor test
```

### What integration tests cover

| Test | Verifies |
|---|---|
| `initialize_dao` | DAO created with correct config on-chain |
| `deposit` | SOL arrives in real treasury PDA |
| `create_proposal` | Proposal saved on-chain with correct ID |
| `cast_vote (FOR)` | Vote recorded with correct weight |
| `cast_vote (AGAINST)` | Against vote recorded |
| `double vote fails` | VoteRecord PDA rejects second vote |
| `execute_proposal` | SOL transferred from PDA to real destination |

---

## Level 3: Devnet tests 🌐

Once local tests pass, deploy to devnet:

```bash
# Set up wallet
solana-keygen new --outfile ~/.config/solana/id.json
solana airdrop 2 --url devnet

# Deploy
anchor deploy --provider.cluster devnet

# Run tests against real network
anchor test --provider.cluster devnet
```

---

## Pre-mainnet checklist

- [ ] 25/25 logic tests passing
- [ ] All Anchor tests passing on localnet
- [ ] Deploy and tests passing on devnet
- [ ] Security audit completed (recommended: OtterSec or Sec3)
- [ ] Review quorum and voting period values for production
- [ ] Replace `declare_id!` with real Program ID after deploy

---

## Project structure

```
governance-launches/
├── programs/
│   └── pumpgov/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs        ← Main contract (Rust/Anchor)
├── tests/
│   ├── logic.test.js         ← Pure logic tests (Node.js) ← start here
│   └── pump_gov.ts           ← Integration tests (Anchor)
├── Anchor.toml
├── README.md
└── TESTING.md                ← This file
```
