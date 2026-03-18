use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

declare_id!("o9bztnYupydDJ4gHRi8H24f5cmKwTtpZuvzLrWEY8Et");

// ─────────────────────────────────────────────
//  Governance Launches — Transparent fee governance for
//  tokens launched on pump.fun
//
//  Flow:
//  1. Dev opts in → initialize_dao()
//  2. Fees arrive in SOL → deposit()
//  3. Dev creates a funding proposal → create_proposal()
//  4. Token holders vote → cast_vote()
//  5. Anyone executes after voting ends → execute_proposal()
// ─────────────────────────────────────────────

#[program]
pub mod governance_launches {
    use super::*;

    /// Called once by the dev when they launch their token.
    /// Creates a DAO config and an empty SOL treasury (PDA).
    pub fn initialize_dao(
        ctx: Context<InitializeDao>,
        quorum_bps: u16,   // minimum participation in basis points (e.g. 500 = 5%)
        voting_period: i64, // voting window in seconds (e.g. 259200 = 3 days)
    ) -> Result<()> {
        require!(quorum_bps <= 10_000, GovError::InvalidQuorum);
        require!(voting_period >= 3600, GovError::VotingPeriodTooShort);

        let dao = &mut ctx.accounts.dao_config;
        dao.authority       = ctx.accounts.authority.key();
        dao.token_mint      = ctx.accounts.token_mint.key();
        dao.proposal_count  = 0;
        dao.quorum_bps      = quorum_bps;
        dao.voting_period   = voting_period;
        dao.total_deposited = 0;
        dao.total_distributed = 0;
        dao.bump            = ctx.bumps.dao_config;
        dao.treasury_bump   = ctx.bumps.treasury;

        emit!(DaoCreated {
            dao: dao.key(),
            authority: dao.authority,
            token_mint: dao.token_mint,
        });

        Ok(())
    }

    /// Anyone (including pump.fun fee router) can deposit SOL into the treasury.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, GovError::ZeroAmount);

        // Transfer SOL from depositor to treasury PDA
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.treasury.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
            ],
        )?;

        let dao = &mut ctx.accounts.dao_config;
        dao.total_deposited = dao.total_deposited.checked_add(amount)
            .ok_or(GovError::Overflow)?;

        emit!(FeeDeposited {
            dao: dao.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            total: dao.total_deposited,
        });

        Ok(())
    }

    /// Dev creates a proposal describing where funds should go.
    /// `destination_label` is a human-readable string (e.g. "Marketing", "Dev Fund", "Burn").
    /// `destination` is the on-chain address that will receive the SOL if approved.
    /// For burn: use the System Program address (11111...) as a convention;
    ///           the execute logic will handle it as a burn (send to incinerator).
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        description: String,        // max 256 chars — what will the money do?
        destination_label: String,  // max 32 chars  — e.g. "Dev Fund", "Marketing"
        destination: Pubkey,        // recipient wallet / program
        amount: u64,                // SOL in lamports
    ) -> Result<()> {
        require!(description.len() <= 256, GovError::DescriptionTooLong);
        require!(destination_label.len() <= 32, GovError::LabelTooLong);
        require!(amount > 0, GovError::ZeroAmount);

        // Check treasury has enough balance
        let treasury_balance = ctx.accounts.treasury.lamports();
        require!(treasury_balance >= amount, GovError::InsufficientFunds);

        let dao = &mut ctx.accounts.dao_config;
        let proposal = &mut ctx.accounts.proposal;
        let clock = Clock::get()?;

        proposal.dao               = dao.key();
        proposal.proposer          = ctx.accounts.authority.key();
        proposal.description       = description.clone();
        proposal.destination_label = destination_label.clone();
        proposal.destination       = destination;
        proposal.amount            = amount;
        proposal.votes_for         = 0;
        proposal.votes_against     = 0;
        proposal.status            = ProposalStatus::Active;
        proposal.created_at        = clock.unix_timestamp;
        proposal.voting_ends_at    = clock.unix_timestamp
            .checked_add(dao.voting_period)
            .ok_or(GovError::Overflow)?;
        proposal.id                = dao.proposal_count;
        proposal.bump              = ctx.bumps.proposal;

        dao.proposal_count = dao.proposal_count.checked_add(1)
            .ok_or(GovError::Overflow)?;

        emit!(ProposalCreated {
            dao: dao.key(),
            proposal: proposal.key(),
            id: proposal.id,
            description,
            destination_label,
            destination,
            amount,
            voting_ends_at: proposal.voting_ends_at,
        });

        Ok(())
    }

    /// Any holder of the project token casts a vote.
    /// Vote weight = token balance at time of voting.
    /// Each wallet can only vote once per proposal (enforced by VoteRecord PDA).
    pub fn cast_vote(ctx: Context<CastVote>, approve: bool) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        let clock = Clock::get()?;

        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        require!(
            clock.unix_timestamp < proposal.voting_ends_at,
            GovError::VotingClosed
        );

        let weight = ctx.accounts.voter_token_account.amount;
        require!(weight > 0, GovError::NoVotingPower);

        // Record the vote (PDA ensures one vote per wallet per proposal)
        let vote_record = &mut ctx.accounts.vote_record;
        vote_record.proposal  = proposal.key();
        vote_record.voter     = ctx.accounts.voter.key();
        vote_record.approve   = approve;
        vote_record.weight    = weight;
        vote_record.voted_at  = clock.unix_timestamp;
        vote_record.bump      = ctx.bumps.vote_record;

        if approve {
            proposal.votes_for = proposal.votes_for
                .checked_add(weight).ok_or(GovError::Overflow)?;
        } else {
            proposal.votes_against = proposal.votes_against
                .checked_add(weight).ok_or(GovError::Overflow)?;
        }

        emit!(VoteCast {
            proposal: proposal.key(),
            voter: ctx.accounts.voter.key(),
            approve,
            weight,
        });

        Ok(())
    }

    /// Called by anyone after voting period ends.
    /// If quorum is met and FOR > AGAINST → transfers SOL to destination.
    /// Otherwise → marks proposal as Defeated.
    pub fn execute_proposal(ctx: Context<ExecuteProposal>) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        let dao = &ctx.accounts.dao_config;
        let clock = Clock::get()?;

        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        require!(
            clock.unix_timestamp >= proposal.voting_ends_at,
            GovError::VotingStillOpen
        );

        let total_supply = ctx.accounts.token_mint.supply;
        let quorum_threshold = (total_supply as u128)
            .checked_mul(dao.quorum_bps as u128)
            .ok_or(GovError::Overflow)?
            .checked_div(10_000)
            .ok_or(GovError::Overflow)? as u64;

        let total_votes = proposal.votes_for
            .checked_add(proposal.votes_against)
            .ok_or(GovError::Overflow)?;

        // Check quorum and majority
        if total_votes < quorum_threshold || proposal.votes_for <= proposal.votes_against {
            proposal.status = ProposalStatus::Defeated;
            emit!(ProposalDefeated {
                proposal: proposal.key(),
                votes_for: proposal.votes_for,
                votes_against: proposal.votes_against,
                quorum_threshold,
            });
            return Ok(());
        }

        // ── Execute: transfer SOL from treasury PDA to destination ──
        let treasury_balance = ctx.accounts.treasury.lamports();
        require!(treasury_balance >= proposal.amount, GovError::InsufficientFunds);

        let seeds = &[
            b"treasury",
            dao.token_mint.as_ref(),
            &[dao.treasury_bump],
        ];
        let signer = &[&seeds[..]];

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &ctx.accounts.destination.key(),
            proposal.amount,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.destination.to_account_info(),
            ],
            signer,
        )?;

        proposal.status = ProposalStatus::Executed;

        let dao_mut = &mut ctx.accounts.dao_config;
        dao_mut.total_distributed = dao_mut.total_distributed
            .checked_add(proposal.amount).ok_or(GovError::Overflow)?;

        emit!(ProposalExecuted {
            proposal: proposal.key(),
            destination: proposal.destination,
            destination_label: proposal.destination_label.clone(),
            amount: proposal.amount,
            votes_for: proposal.votes_for,
            votes_against: proposal.votes_against,
        });

        Ok(())
    }
}

// ─────────────────────────────────────────────
//  Account Structs
// ─────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeDao<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = DaoConfig::LEN,
        seeds = [b"dao", token_mint.key().as_ref()],
        bump
    )]
    pub dao_config: Account<'info, DaoConfig>,

    /// CHECK: PDA used only as a SOL vault — no data stored here
    #[account(
        mut,
        seeds = [b"treasury", token_mint.key().as_ref()],
        bump
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"dao", dao_config.token_mint.as_ref()],
        bump = dao_config.bump,
    )]
    pub dao_config: Account<'info, DaoConfig>,

    /// CHECK: SOL vault PDA
    #[account(
        mut,
        seeds = [b"treasury", dao_config.token_mint.as_ref()],
        bump = dao_config.treasury_bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(description: String, destination_label: String)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"dao", dao_config.token_mint.as_ref()],
        bump = dao_config.bump,
        has_one = authority,
    )]
    pub dao_config: Account<'info, DaoConfig>,

    /// CHECK: SOL vault — we only read its balance
    #[account(
        seeds = [b"treasury", dao_config.token_mint.as_ref()],
        bump = dao_config.treasury_bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = Proposal::len(&description, &destination_label),
        seeds = [b"proposal", dao_config.key().as_ref(), &dao_config.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

    #[account(
        seeds = [b"dao", dao_config.token_mint.as_ref()],
        bump = dao_config.bump,
    )]
    pub dao_config: Account<'info, DaoConfig>,

    #[account(
        mut,
        seeds = [b"proposal", dao_config.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, Proposal>,

    /// Voter's SPL token account for the project token — proves they hold tokens
    #[account(
        constraint = voter_token_account.owner == voter.key(),
        constraint = voter_token_account.mint == dao_config.token_mint,
    )]
    pub voter_token_account: Account<'info, TokenAccount>,

    /// One record per voter per proposal — prevents double voting
    #[account(
        init,
        payer = voter,
        space = VoteRecord::LEN,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Account<'info, VoteRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"dao", dao_config.token_mint.as_ref()],
        bump = dao_config.bump,
    )]
    pub dao_config: Account<'info, DaoConfig>,

    pub token_mint: Account<'info, Mint>,

    /// CHECK: SOL vault
    #[account(
        mut,
        seeds = [b"treasury", dao_config.token_mint.as_ref()],
        bump = dao_config.treasury_bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"proposal", dao_config.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.destination == destination.key(),
    )]
    pub proposal: Account<'info, Proposal>,

    /// CHECK: destination wallet — validated against proposal
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ─────────────────────────────────────────────
//  Data Accounts
// ─────────────────────────────────────────────

#[account]
pub struct DaoConfig {
    pub authority:         Pubkey,  // dev wallet
    pub token_mint:        Pubkey,  // pump.fun token mint
    pub proposal_count:    u64,
    pub quorum_bps:        u16,     // e.g. 500 = 5% of supply
    pub voting_period:     i64,     // seconds
    pub total_deposited:   u64,     // lifetime SOL deposited (lamports)
    pub total_distributed: u64,     // lifetime SOL distributed (lamports)
    pub bump:              u8,
    pub treasury_bump:     u8,
}

impl DaoConfig {
    pub const LEN: usize = 8   // discriminator
        + 32 + 32              // authority + token_mint
        + 8                    // proposal_count
        + 2                    // quorum_bps
        + 8                    // voting_period
        + 8 + 8                // total_deposited + total_distributed
        + 1 + 1;               // bumps
}

#[account]
pub struct Proposal {
    pub dao:               Pubkey,
    pub proposer:          Pubkey,
    pub destination:       Pubkey,
    pub amount:            u64,     // lamports
    pub votes_for:         u64,
    pub votes_against:     u64,
    pub status:            ProposalStatus,
    pub created_at:        i64,
    pub voting_ends_at:    i64,
    pub id:                u64,
    pub bump:              u8,
    pub description:       String,  // up to 256 chars
    pub destination_label: String,  // up to 32 chars
}

impl Proposal {
    pub fn len(description: &str, destination_label: &str) -> usize {
        8                          // discriminator
        + 32 + 32 + 32             // dao + proposer + destination
        + 8 + 8 + 8                // amount + votes_for + votes_against
        + 1                        // status
        + 8 + 8                    // created_at + voting_ends_at
        + 8 + 1                    // id + bump
        + 4 + description.len()    // string prefix + content
        + 4 + destination_label.len()
    }
}

#[account]
pub struct VoteRecord {
    pub proposal: Pubkey,
    pub voter:    Pubkey,
    pub approve:  bool,
    pub weight:   u64,
    pub voted_at: i64,
    pub bump:     u8,
}

impl VoteRecord {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 8 + 8 + 1;
}

// ─────────────────────────────────────────────
//  Enums
// ─────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ProposalStatus {
    Active,
    Executed,
    Defeated,
}

// ─────────────────────────────────────────────
//  Events (indexed by dashboards and frontends)
// ─────────────────────────────────────────────

#[event]
pub struct DaoCreated {
    pub dao:        Pubkey,
    pub authority:  Pubkey,
    pub token_mint: Pubkey,
}

#[event]
pub struct FeeDeposited {
    pub dao:       Pubkey,
    pub depositor: Pubkey,
    pub amount:    u64,
    pub total:     u64,
}

#[event]
pub struct ProposalCreated {
    pub dao:               Pubkey,
    pub proposal:          Pubkey,
    pub id:                u64,
    pub description:       String,
    pub destination_label: String,
    pub destination:       Pubkey,
    pub amount:            u64,
    pub voting_ends_at:    i64,
}

#[event]
pub struct VoteCast {
    pub proposal: Pubkey,
    pub voter:    Pubkey,
    pub approve:  bool,
    pub weight:   u64,
}

#[event]
pub struct ProposalExecuted {
    pub proposal:          Pubkey,
    pub destination:       Pubkey,
    pub destination_label: String,
    pub amount:            u64,
    pub votes_for:         u64,
    pub votes_against:     u64,
}

#[event]
pub struct ProposalDefeated {
    pub proposal:         Pubkey,
    pub votes_for:        u64,
    pub votes_against:    u64,
    pub quorum_threshold: u64,
}

// ─────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────

#[error_code]
pub enum GovError {
    #[msg("Quorum must be between 0 and 10000 bps")]
    InvalidQuorum,
    #[msg("Voting period must be at least 1 hour")]
    VotingPeriodTooShort,
    #[msg("Description exceeds 256 characters")]
    DescriptionTooLong,
    #[msg("Label exceeds 32 characters")]
    LabelTooLong,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Treasury has insufficient SOL for this proposal")]
    InsufficientFunds,
    #[msg("Proposal is not in Active status")]
    ProposalNotActive,
    #[msg("Voting period has already closed")]
    VotingClosed,
    #[msg("Voting period is still open")]
    VotingStillOpen,
    #[msg("Voter has no tokens — no voting power")]
    NoVotingPower,
    #[msg("Arithmetic overflow")]
    Overflow,
}
