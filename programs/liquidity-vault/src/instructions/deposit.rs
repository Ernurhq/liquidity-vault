use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::error::VaultError;
use crate::math::calc_shares;
use crate::state::*;

// Крупные аккаунты лежат в Box: иначе структура не помещается в стек Solana (4096 байт).
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Вкладчик: подписывает перевод своих токенов.
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    /// PDA-владелец: от его имени программа выпускает share-токены.
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

    /// Откуда списываем: токен-аккаунт самого пользователя.
    #[account(
        mut,
        token::mint = vault_state.deposit_mint,
        token::authority = user
    )]
    pub user_deposit_account: Box<Account<'info, TokenAccount>>,

    /// Куда выдаём доли: share-аккаунт самого пользователя.
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

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    // 0. Ноль вносить нельзя.
    require!(amount > 0, VaultError::ZeroAmount);

    // 1. Считаем доли ДО перевода: нужен баланс vault и число долей до депозита.
    let shares = calc_shares(
        amount,
        ctx.accounts.token_vault.amount,
        ctx.accounts.share_mint.supply,
    )?;
    require!(shares > 0, VaultError::ZeroAmount);

    // 2. Перевод токенов пользователя в vault. Подписывает сам пользователь.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.user_deposit_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 3. Выпуск долей. Подписывает программа: seeds vault_authority.
    let vault_key = ctx.accounts.vault_state.key();
    let bump = [ctx.accounts.vault_state.authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, vault_key.as_ref(), &bump]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    // 4. Учёт: общая сумма в vault и сумма в карточке пользователя.
    let state = &mut ctx.accounts.vault_state;
    state.total_deposited = state
        .total_deposited
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    let card = &mut ctx.accounts.user_card;
    card.deposited = card
        .deposited
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    Ok(())
}
