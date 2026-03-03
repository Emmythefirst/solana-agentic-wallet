use anchor_lang::prelude::*;

declare_id!("JCDFEsY5Jq22vJRsUiKY6X4xxKmmavwtdiD4unaQridp");

#[program]
pub mod agentvault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.total_deposited = 0;
        vault.total_withdrawn = 0;
        vault.deposit_count = 0;
        vault.withdraw_count = 0;
        vault.bump = ctx.bumps.vault;
        msg!("[AgentVault] Vault initialized for: {}", vault.owner);
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_deposited = vault.total_deposited.checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        vault.deposit_count += 1;

        msg!(
            "[AgentVault] Deposit: {} lamports | Total: {} | Count: {}",
            amount, vault.total_deposited, vault.deposit_count
        );
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault_lamports = ctx.accounts.vault.get_lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(VaultState::INIT_SPACE);

        require!(
            vault_lamports.saturating_sub(amount) >= min_rent,
            VaultError::InsufficientFunds
        );

        ctx.accounts.vault.sub_lamports(amount)?;
        ctx.accounts.owner.add_lamports(amount)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_withdrawn = vault.total_withdrawn.checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        vault.withdraw_count += 1;

        msg!(
            "[AgentVault] Withdraw: {} lamports | Total withdrawn: {} | Count: {}",
            amount, vault.total_withdrawn, vault.withdraw_count
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub owner: Pubkey,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub deposit_count: u32,
    pub withdraw_count: u32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient funds — vault must remain rent-exempt")]
    InsufficientFunds,
    #[msg("Arithmetic overflow")]
    Overflow,
}