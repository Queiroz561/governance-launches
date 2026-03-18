use anchor_lang::prelude::*;

declare_id!("48PiGx1hU4qEh5CMnmcasqm7LBeYCPkM9myytErpqv2j");

#[program]
pub mod governance_launches {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
