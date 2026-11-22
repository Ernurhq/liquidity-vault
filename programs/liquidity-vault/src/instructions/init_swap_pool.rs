use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::VaultError;
use crate::raydium::parse_pool;
use crate::state::*;

/// Неделя 12: администратор привязывает к vault пул Raydium CLMM и создаёт второе хранилище
/// (для токена B). Вызывается один раз.
#[derive(Accounts)]
pub struct InitSwapPool<'info> {
    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    /// Только администратор vault.
    #[account(mut, address = vault_state.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,

    /// PDA-владелец: будет владеть и вторым хранилищем.
    /// CHECK: адрес проверяется сидами, данные не читаются.
    #[account(
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump = vault_state.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Второй токен пула (токен A это deposit_mint vault).
    pub mint_b: Box<Account<'info, Mint>>,

    /// Второе хранилище vault: сюда придёт токен B после обмена.
    #[account(
        init,
        payer = admin,
        seeds = [TOKEN_VAULT_B_SEED, vault_state.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = vault_authority
    )]
    pub token_vault_b: Box<Account<'info, TokenAccount>>,

    /// Запись «какой пул привязан к vault».
    #[account(
        init,
        payer = admin,
        space = 8 + SwapPool::INIT_SPACE,
        seeds = [SWAP_POOL_SEED, vault_state.key().as_ref()],
        bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    /// Аккаунт пула Raydium CLMM. Принадлежность программе и состав токенов проверяются в коде.
    /// CHECK: владелец и содержимое проверяются в handle_init_swap_pool.
    pub pool_state: UncheckedAccount<'info>,

    /// Программа Raydium CLMM (в devnet и в mainnet разные адреса).
    /// CHECK: проверяется, что это исполняемая программа и что она владеет pool_state.
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_swap_pool(ctx: Context<InitSwapPool>) -> Result<()> {
    let clmm_program = ctx.accounts.clmm_program.key();
    require!(ctx.accounts.clmm_program.executable, VaultError::InvalidPool);
    require!(
        *ctx.accounts.pool_state.owner == clmm_program,
        VaultError::InvalidPool
    );

    // В пуле должны лежать ровно наши два токена (в любом порядке).
    let deposit_mint = ctx.accounts.vault_state.deposit_mint.to_bytes();
    let mint_b = ctx.accounts.mint_b.key().to_bytes();
    require!(deposit_mint != mint_b, VaultError::InvalidPool);

    let pool = {
        let data = ctx.accounts.pool_state.try_borrow_data()?;
        parse_pool(&**data).ok_or(VaultError::InvalidPool)?
    };
    let ok = (pool.mint_0 == deposit_mint && pool.mint_1 == mint_b)
        || (pool.mint_0 == mint_b && pool.mint_1 == deposit_mint);
    require!(ok, VaultError::InvalidPool);

    let swap_pool = &mut ctx.accounts.swap_pool;
    swap_pool.vault = ctx.accounts.vault_state.key();
    swap_pool.clmm_program = clmm_program;
    swap_pool.pool_state = ctx.accounts.pool_state.key();
    swap_pool.mint_b = ctx.accounts.mint_b.key();
    swap_pool.token_vault_b = ctx.accounts.token_vault_b.key();
    swap_pool.bump = ctx.bumps.swap_pool;
    Ok(())
}
