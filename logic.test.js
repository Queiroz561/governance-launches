/**
 * Governance Launches — Pure logic tests
 *
 * Simulates the full smart contract logic in JavaScript.
 * No Solana, Rust, or Anchor required.
 *
 * Run:  node tests/logic.test.js
 */

// ─── Mini test runner ─────────────────────────────────────────────────────────

let passed = 0, failed = 0, total = 0;
const results = [];

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    results.push({ ok: true, name });
    console.log(`  ✓  ${name}`);
  } catch (e) {
    failed++;
    results.push({ ok: false, name, err: e.message });
    console.log(`  ✗  ${name}`);
    console.log(`     → ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertThrows(fn, expectedMsg) {
  try { fn(); throw new Error('Expected error but none was thrown'); }
  catch (e) {
    if (e.message === 'Expected error but none was thrown') throw e;
    if (expectedMsg && !e.message.includes(expectedMsg))
      throw new Error(`Expected error containing "${expectedMsg}", got: "${e.message}"`);
  }
}

// ─── Protocol simulation ──────────────────────────────────────────────────────

const LAMPORTS = 1_000_000_000; // 1 SOL

class GovernanceLaunchesSimulator {
  constructor({ quorumBps = 500, votingPeriodSec = 3 * 24 * 3600, tokenSupply = 1_000_000_000 } = {}) {
    this.quorumBps        = quorumBps;
    this.votingPeriod     = votingPeriodSec;
    this.tokenSupply      = tokenSupply;
    this.treasury         = 0n;
    this.totalDeposited   = 0n;
    this.totalDistributed = 0n;
    this.proposals        = [];
    this.voteRecords      = new Map();
    this.tokenBalances    = new Map();
    this.now              = Date.now() / 1000;
  }

  _tick(seconds) { this.now += seconds; }

  _requireTokens(wallet) {
    const bal = this.tokenBalances.get(wallet) || 0;
    if (bal === 0) throw new Error('NoVotingPower: wallet holds no tokens');
    return bal;
  }

  deposit(amountLamports) {
    if (amountLamports <= 0n) throw new Error('ZeroAmount');
    this.treasury       += amountLamports;
    this.totalDeposited += amountLamports;
    return { treasury: this.treasury, totalDeposited: this.totalDeposited };
  }

  createProposal({ description, destinationLabel, destination, amountLamports }) {
    if (!description || description.length > 256) throw new Error('DescriptionTooLong');
    if (!destinationLabel || destinationLabel.length > 32) throw new Error('LabelTooLong');
    if (amountLamports <= 0n) throw new Error('ZeroAmount');
    if (this.treasury < amountLamports) throw new Error('InsufficientFunds: treasury has ' + this.treasury + ' lamports, requested ' + amountLamports);
    const id = this.proposals.length;
    const proposal = {
      id, description, destinationLabel, destination,
      amount: amountLamports,
      votesFor: 0n, votesAgainst: 0n,
      status: 'Active',
      createdAt: this.now,
      votingEndsAt: this.now + this.votingPeriod,
    };
    this.proposals.push(proposal);
    return proposal;
  }

  castVote({ proposalId, voter, approve }) {
    const p = this.proposals[proposalId];
    if (!p) throw new Error('ProposalNotFound');
    if (p.status !== 'Active') throw new Error('ProposalNotActive');
    if (this.now >= p.votingEndsAt) throw new Error('VotingClosed');
    const key = `${proposalId}:${voter}`;
    if (this.voteRecords.has(key)) throw new Error('AlreadyVoted: each wallet votes once per proposal');
    const weight = BigInt(this._requireTokens(voter));
    this.voteRecords.set(key, { voter, approve, weight });
    if (approve) p.votesFor += weight;
    else         p.votesAgainst += weight;
    return { proposalId, voter, approve, weight };
  }

  executeProposal(proposalId) {
    const p = this.proposals[proposalId];
    if (!p) throw new Error('ProposalNotFound');
    if (p.status !== 'Active') throw new Error('ProposalNotActive');
    if (this.now < p.votingEndsAt) throw new Error('VotingStillOpen');
    const quorumThreshold = BigInt(Math.floor(this.tokenSupply * this.quorumBps / 10_000));
    const totalVotes = p.votesFor + p.votesAgainst;
    if (totalVotes < quorumThreshold || p.votesFor <= p.votesAgainst) {
      p.status = 'Defeated';
      return { status: 'Defeated', totalVotes, quorumThreshold };
    }
    if (this.treasury < p.amount) throw new Error('InsufficientFunds at execution time');
    this.treasury -= p.amount;
    this.totalDistributed += p.amount;
    p.status = 'Executed';
    return { status: 'Executed', amountSent: p.amount, destination: p.destination };
  }
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Governance Launches — Pure logic tests');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('[ Treasury deposits ]\n');

test('Valid deposit increases the vault', () => {
  const dao = new GovernanceLaunchesSimulator();
  const res = dao.deposit(2n * BigInt(LAMPORTS));
  assert(res.treasury === 2n * BigInt(LAMPORTS), 'Vault should hold 2 SOL');
  assert(res.totalDeposited === 2n * BigInt(LAMPORTS));
});

test('Multiple deposits accumulate correctly', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(1n * BigInt(LAMPORTS));
  dao.deposit(BigInt(500_000_000));
  dao.deposit(BigInt(300_000_000));
  assert(dao.treasury === 1_800_000_000n, 'Vault should hold 1.8 SOL');
});

test('Zero deposit is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  assertThrows(() => dao.deposit(0n), 'ZeroAmount');
});

test('Negative deposit is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  assertThrows(() => dao.deposit(-1n), 'ZeroAmount');
});

console.log('\n[ Proposal creation ]\n');

test('Valid proposals are created with incremental IDs', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(5n * BigInt(LAMPORTS));
  const p1 = dao.createProposal({ description: 'Marketing', destinationLabel: 'Marketing', destination: 'wallet_A', amountLamports: 1n * BigInt(LAMPORTS) });
  const p2 = dao.createProposal({ description: 'Dev fund', destinationLabel: 'Dev', destination: 'wallet_B', amountLamports: 1n * BigInt(LAMPORTS) });
  assert(p1.id === 0 && p2.id === 1);
  assert(p1.status === 'Active' && p2.status === 'Active');
});

test('Proposal exceeding vault balance is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(1n * BigInt(LAMPORTS));
  assertThrows(() => dao.createProposal({ description: 'Too expensive', destinationLabel: 'Dev', destination: 'w', amountLamports: 10n * BigInt(LAMPORTS) }), 'InsufficientFunds');
});

test('Description over 256 chars is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(1n * BigInt(LAMPORTS));
  assertThrows(() => dao.createProposal({ description: 'x'.repeat(257), destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) }), 'DescriptionTooLong');
});

test('Label over 32 chars is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(1n * BigInt(LAMPORTS));
  assertThrows(() => dao.createProposal({ description: 'OK', destinationLabel: 'x'.repeat(33), destination: 'w', amountLamports: BigInt(LAMPORTS) }), 'LabelTooLong');
});

test('Zero amount proposal is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(1n * BigInt(LAMPORTS));
  assertThrows(() => dao.createProposal({ description: 'OK', destinationLabel: 'Dev', destination: 'w', amountLamports: 0n }), 'ZeroAmount');
});

console.log('\n[ Voting ]\n');

test('Vote for increases votesFor', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.tokenBalances.set('alice', 700_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  assert(dao.proposals[0].votesFor === 700_000n);
  assert(dao.proposals[0].votesAgainst === 0n);
});

test('Vote against increases votesAgainst', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.tokenBalances.set('bob', 300_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'bob', approve: false });
  assert(dao.proposals[0].votesAgainst === 300_000n);
});

test('Vote weight is proportional to token balance', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.tokenBalances.set('whale', 5_000_000);
  dao.tokenBalances.set('fish', 100);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'whale', approve: true });
  dao.castVote({ proposalId: 0, voter: 'fish', approve: false });
  assert(dao.proposals[0].votesFor > dao.proposals[0].votesAgainst, 'Whale should win');
});

test('Double vote is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.tokenBalances.set('alice', 700_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  assertThrows(() => dao.castVote({ proposalId: 0, voter: 'alice', approve: false }), 'AlreadyVoted');
});

test('Voting with no tokens is rejected', () => {
  const dao = new GovernanceLaunchesSimulator();
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  assertThrows(() => dao.castVote({ proposalId: 0, voter: 'nobody', approve: true }), 'NoVotingPower');
});

test('Voting after deadline is rejected', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 10 });
  dao.tokenBalances.set('alice', 100_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao._tick(11);
  assertThrows(() => dao.castVote({ proposalId: 0, voter: 'alice', approve: true }), 'VotingClosed');
});

test('Voting on an already-executed proposal is rejected', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 100 });
  dao.tokenBalances.set('alice', 100_000_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao._tick(6);
  dao.executeProposal(0);
  assertThrows(() => dao.castVote({ proposalId: 0, voter: 'alice', approve: true }), 'ProposalNotActive');
});

console.log('\n[ Proposal execution ]\n');

test('Approved proposal transfers SOL correctly', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 500 });
  dao.tokenBalances.set('alice', 700_000_000);
  dao.deposit(5n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Marketing', destinationLabel: 'Marketing', destination: 'marketing_wallet', amountLamports: 2n * BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao._tick(6);
  const res = dao.executeProposal(0);
  assert(res.status === 'Executed');
  assert(res.amountSent === 2n * BigInt(LAMPORTS));
  assert(dao.treasury === 3n * BigInt(LAMPORTS), 'Vault should hold 3 SOL remaining');
  assert(dao.totalDistributed === 2n * BigInt(LAMPORTS));
});

test('Proposal without quorum is defeated', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 5000 });
  dao.tokenBalances.set('alice', 1_000_000);
  dao.deposit(5n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao._tick(6);
  const res = dao.executeProposal(0);
  assert(res.status === 'Defeated', 'Should be Defeated — quorum not reached');
  assert(dao.treasury === 5n * BigInt(LAMPORTS), 'Vault should not lose SOL');
});

test('Proposal with majority against is defeated', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 100 });
  dao.tokenBalances.set('alice', 300_000_000);
  dao.tokenBalances.set('bob',   700_000_000);
  dao.deposit(5n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao.castVote({ proposalId: 0, voter: 'bob', approve: false });
  dao._tick(6);
  const res = dao.executeProposal(0);
  assert(res.status === 'Defeated');
});

test('Executing before voting ends is rejected', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 3600 });
  dao.tokenBalances.set('alice', 100_000_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  assertThrows(() => dao.executeProposal(0), 'VotingStillOpen');
});

test('Executing an already-executed proposal is rejected', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 100 });
  dao.tokenBalances.set('alice', 100_000_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao._tick(6);
  dao.executeProposal(0);
  assertThrows(() => dao.executeProposal(0), 'ProposalNotActive');
});

console.log('\n[ Full scenarios ]\n');

test('Full cycle: deposit → proposal → vote → execute', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 500 });
  dao.tokenBalances.set('holder1', 600_000_000);
  dao.tokenBalances.set('holder2', 200_000_000);
  dao.tokenBalances.set('holder3', 200_000_000);
  dao.deposit(10n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Hire backend dev', destinationLabel: 'Dev Fund', destination: 'dev_wallet', amountLamports: 3n * BigInt(LAMPORTS) });
  dao.createProposal({ description: 'Burn tokens for deflation', destinationLabel: 'Burn', destination: 'burn_address', amountLamports: 2n * BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'holder1', approve: true });
  dao.castVote({ proposalId: 0, voter: 'holder2', approve: true });
  dao.castVote({ proposalId: 0, voter: 'holder3', approve: false });
  dao.castVote({ proposalId: 1, voter: 'holder1', approve: true });
  dao.castVote({ proposalId: 1, voter: 'holder2', approve: false });
  dao.castVote({ proposalId: 1, voter: 'holder3', approve: true });
  dao._tick(6);
  const r0 = dao.executeProposal(0);
  const r1 = dao.executeProposal(1);
  assert(r0.status === 'Executed' && r1.status === 'Executed');
  assert(dao.treasury === 5n * BigInt(LAMPORTS), '5 SOL should remain in vault');
  assert(dao.totalDistributed === 5n * BigInt(LAMPORTS));
});

test('Multiple fee deposits accumulate over time', () => {
  const dao = new GovernanceLaunchesSimulator();
  for (let i = 0; i < 10; i++) {
    dao.deposit(BigInt(Math.floor(Math.random() * 500_000_000) + 100_000_000));
  }
  assert(dao.treasury > 0n);
  assert(dao.totalDeposited === dao.treasury);
});

test('Tied vote is defeated (strict majority required)', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 100 });
  dao.tokenBalances.set('alice', 500_000_000);
  dao.tokenBalances.set('bob',   500_000_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Tied test', destinationLabel: 'Dev', destination: 'w', amountLamports: BigInt(LAMPORTS) });
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao.castVote({ proposalId: 0, voter: 'bob', approve: false });
  dao._tick(6);
  const res = dao.executeProposal(0);
  assert(res.status === 'Defeated', 'Tie must be defeated — strict majority required');
});

test('New fee deposited after proposal does not affect locked amount', () => {
  const dao = new GovernanceLaunchesSimulator({ votingPeriodSec: 5, quorumBps: 100 });
  dao.tokenBalances.set('alice', 500_000_000);
  dao.deposit(3n * BigInt(LAMPORTS));
  dao.createProposal({ description: 'Dev', destinationLabel: 'Dev', destination: 'w', amountLamports: 3n * BigInt(LAMPORTS) });
  dao.deposit(2n * BigInt(LAMPORTS)); // new fee arrives AFTER proposal
  dao.castVote({ proposalId: 0, voter: 'alice', approve: true });
  dao._tick(6);
  const res = dao.executeProposal(0);
  assert(res.status === 'Executed');
  assert(dao.treasury === 2n * BigInt(LAMPORTS), 'The 2 new SOL should remain in vault');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Result: ${passed}/${total} tests passed`);
if (failed > 0) {
  console.log(`  Failures: ${failed}`);
  results.filter(r => !r.ok).forEach(r => console.log(`    ✗ ${r.name}: ${r.err}`));
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exit(failed > 0 ? 1 : 0);
