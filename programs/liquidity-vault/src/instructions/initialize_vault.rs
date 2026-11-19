use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::*;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// Администратор: платит за создание аккаунтов и записывается в настройки.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Токен, который vault принимает от пользователей.
    pub deposit_mint: Account<'info, Mint>,

    /// Настройки vault. Один vault на один deposit_mint.
    #[account(
        init,
        payer = admin,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [VAULT_SEED, deposit_mint.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// PDA-владелец: у него нет данных и нет приватного ключа.
    /// Он владеет хранилищем и является mint authority у share-токена.
    /// CHECK: адрес проверяется сидами, данные не читаются.
    #[account(
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Share-токен (квитанция). Выпускать его может только vault_authority.
    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED, vault_state.key().as_ref()],
        bump,
        mint::decimals = deposit_mint.decimals,
        mint::authority = vault_authority
    )]
    pub share_mint: Account<'info, Mint>,

    /// Хранилище, где физически лежат внесённые токены.
    #[account(
        init,
        payer = admin,
        seeds = [TOKEN_VAULT_SEED, vault_state.key().as_ref()],
        bump,
        token::mint = deposit_mint,
        token::authority = vault_authority
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
    let state = &mut ctx.accounts.vault_state;
    state.admin = ctx.accounts.admin.key();
    state.deposit_mint = ctx.accounts.deposit_mint.key();
    state.share_mint = ctx.accounts.share_mint.key();
    state.token_vault = ctx.accounts.token_vault.key();
    state.total_deposited = 0;
    state.bump = ctx.bumps.vault_state;
    state.authority_bump = ctx.bumps.vault_authority;
    Ok(())
}
