use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::error::VaultError;
use crate::math::calc_assets;
use crate::state::*;

// Крупные аккаунты лежат в Box: иначе структура не помещается в стек Solana (4096 байт).
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Тот, кто выводит: подписывает сжигание своих share-токенов.
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    /// PDA-владелец token_vault: от его имени программа отдаёт токены.
    /// CHECK: адрес проверяется сидами, данные не читаются.
    #[account(
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump = vault_state.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, address = vault_state.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = vault_state.token_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    /// Куда придут токены: токен-аккаунт самого пользователя.
    #[account(
        mut,
        token::mint = vault_state.deposit_mint,
        token::authority = user
    )]
    pub user_deposit_account: Box<Account<'info, TokenAccount>>,

    /// Откуда сжигаем доли: share-аккаунт самого пользователя.
    #[account(
        mut,
        token::mint = vault_state.share_mint,
        token::authority = user
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [USER_CARD_SEED, vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump
    )]
    pub user_card: Box<Account<'info, UserCard>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
    // 0. Ноль выводить нельзя; больше своих долей тоже.
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_share_account.amount >= shares,
        VaultError::InsufficientShares
    );

    // 1. Считаем, сколько токенов положено, ДО сжигания: нужна общая сумма долей.
    let amount = calc_assets(
        shares,
        ctx.accounts.token_vault.amount,
        ctx.accounts.share_mint.supply,
    )?;
    require!(amount > 0, VaultError::ZeroAmount);

    // 2. CPI №1: сжигаем доли пользователя. Подписывает сам пользователь.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // 3. CPI №2: отдаём токены из vault пользователю. Подписывает программа: seeds vault_authority.
    let vault_key = ctx.accounts.vault_state.key();
    let bump = [ctx.accounts.vault_state.authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, vault_key.as_ref(), &bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.user_deposit_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // 4. Учёт без ухода в минус (saturating_sub): если человеку достались «заработанные» токены
    //    или чужие доли, внесённое просто обнуляется, а не переполняется.
    let state = &mut ctx.accounts.vault_state;
    state.total_deposited = state.total_deposited.saturating_sub(amount);

    let card = &mut ctx.accounts.user_card;
    card.deposited = card.deposited.saturating_sub(amount);

    Ok(())
}
