use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::VaultError;
use crate::raydium::{parse_pool, swap_v2_data};
use crate::state::*;

/// Неделя 12: vault меняет токены через пул Raydium CLMM. Только для администратора.
/// Крупные аккаунты лежат в Box: иначе структура не помещается в стек Solana (4096 байт).
#[derive(Accounts)]
pub struct SwapOnRaydium<'info> {
    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    /// Запускать обмен может только администратор.
    #[account(address = vault_state.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,

    /// PDA-владелец хранилищ: именно он «подписывает» обмен в Raydium.
    /// CHECK: адрес проверяется сидами, данные не читаются.
    #[account(
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump = vault_state.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [SWAP_POOL_SEED, vault_state.key().as_ref()],
        bump = swap_pool.bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    /// Хранилище токена A (основное хранилище vault).
    #[account(mut, address = vault_state.token_vault)]
    pub token_vault_a: Box<Account<'info, TokenAccount>>,

    /// Хранилище токена B (создано в init_swap_pool).
    #[account(mut, address = swap_pool.token_vault_b)]
    pub token_vault_b: Box<Account<'info, TokenAccount>>,

    #[account(address = vault_state.deposit_mint)]
    pub mint_a: Box<Account<'info, Mint>>,

    #[account(address = swap_pool.mint_b)]
    pub mint_b: Box<Account<'info, Mint>>,

    /// Пул Raydium, привязанный к vault.
    /// CHECK: адрес сверяется с записью swap_pool, содержимое читается и сверяется ниже.
    #[account(mut, address = swap_pool.pool_state)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью swap_pool.
    #[account(address = swap_pool.clmm_program)]
    pub clmm_program: UncheckedAccount<'info>,

    /// CHECK: сверяется с данными пула (поле amm_config).
    pub amm_config: UncheckedAccount<'info>,

    /// Хранилище токена A внутри пула Raydium.
    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_a: UncheckedAccount<'info>,

    /// Хранилище токена B внутри пула Raydium.
    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_b: UncheckedAccount<'info>,

    /// CHECK: сверяется с данными пула (поле observation_key).
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: нужен Raydium в списке аккаунтов; программа Raydium проверяет его сама.
    pub token_program_2022: UncheckedAccount<'info>,

    /// CHECK: нужен Raydium в списке аккаунтов; программа Raydium проверяет его сама.
    pub memo_program: UncheckedAccount<'info>,
    // Дальше, через remaining_accounts: tick-массивы пула в порядке обмена
    // (их считает SDK Raydium, функция computeAmountOutFormat).
}

/// * `a_to_b`  — направление: true = отдаём токен A, получаем токен B; false = наоборот;
/// * `amount_in` — сколько отдаём (точная сумма);
/// * `min_amount_out` — минимум, который согласны получить (защита от slippage);
/// * `sqrt_price_limit_x64` — предельная цена обмена (её считает клиент).
pub fn handle_swap<'info>(
    ctx: Context<'info, SwapOnRaydium<'info>>,
    a_to_b: bool,
    amount_in: u64,
    min_amount_out: u64,
    sqrt_price_limit_x64: u128,
) -> Result<()> {
    require!(amount_in > 0, VaultError::ZeroAmount);

    // 1. Читаем пул и сверяем все переданные аккаунты с его данными: нельзя подсунуть чужие.
    let pool = {
        let data = ctx.accounts.pool_state.try_borrow_data()?;
        parse_pool(&**data).ok_or(VaultError::InvalidPool)?
    };
    let mint_a = ctx.accounts.mint_a.key().to_bytes();
    let (want_vault_a, want_vault_b) = if pool.mint_0 == mint_a {
        (pool.vault_0, pool.vault_1)
    } else if pool.mint_1 == mint_a {
        (pool.vault_1, pool.vault_0)
    } else {
        return err!(VaultError::InvalidPool);
    };
    require!(
        ctx.accounts.amm_config.key().to_bytes() == pool.amm_config,
        VaultError::InvalidPool
    );
    require!(
        ctx.accounts.observation_state.key().to_bytes() == pool.observation,
        VaultError::InvalidPool
    );
    require!(
        ctx.accounts.pool_vault_a.key().to_bytes() == want_vault_a,
        VaultError::InvalidPool
    );
    require!(
        ctx.accounts.pool_vault_b.key().to_bytes() == want_vault_b,
        VaultError::InvalidPool
    );

    // 2. Выбираем, что чем является при обмене.
    let (in_token, out_token, in_vault, out_vault, in_mint, out_mint) = if a_to_b {
        (
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.pool_vault_a.to_account_info(),
            ctx.accounts.pool_vault_b.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
        )
    } else {
        (
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.pool_vault_b.to_account_info(),
            ctx.accounts.pool_vault_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
        )
    };
    let balance_in_before = if a_to_b {
        ctx.accounts.token_vault_a.amount
    } else {
        ctx.accounts.token_vault_b.amount
    };
    require!(balance_in_before >= amount_in, VaultError::InsufficientFunds);
    let balance_out_before = if a_to_b {
        ctx.accounts.token_vault_b.amount
    } else {
        ctx.accounts.token_vault_a.amount
    };

    // 3. Собираем инструкцию swap_v2 Raydium. Порядок аккаунтов из IDL:
    //    payer, amm_config, pool_state, input_token_account, output_token_account,
    //    input_vault, output_vault, observation_state, token_program, token_program_2022,
    //    memo_program, input_vault_mint, output_vault_mint, дальше tick-массивы.
    let authority = ctx.accounts.vault_authority.to_account_info();
    let mut metas = vec![
        AccountMeta::new_readonly(authority.key(), true), // payer: подписывает PDA
        AccountMeta::new_readonly(ctx.accounts.amm_config.key(), false),
        AccountMeta::new(ctx.accounts.pool_state.key(), false),
        AccountMeta::new(in_token.key(), false),
        AccountMeta::new(out_token.key(), false),
        AccountMeta::new(in_vault.key(), false),
        AccountMeta::new(out_vault.key(), false),
        AccountMeta::new(ctx.accounts.observation_state.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program_2022.key(), false),
        AccountMeta::new_readonly(ctx.accounts.memo_program.key(), false),
        AccountMeta::new_readonly(in_mint.key(), false),
        AccountMeta::new_readonly(out_mint.key(), false),
    ];
    let mut infos = vec![
        authority,
        ctx.accounts.amm_config.to_account_info(),
        ctx.accounts.pool_state.to_account_info(),
        in_token,
        out_token,
        in_vault,
        out_vault,
        ctx.accounts.observation_state.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.token_program_2022.to_account_info(),
        ctx.accounts.memo_program.to_account_info(),
        in_mint,
        out_mint,
        ctx.accounts.clmm_program.to_account_info(),
    ];
    // Tick-массивы: права доступа повторяем из внешней транзакции.
    for a in ctx.remaining_accounts.iter() {
        metas.push(if a.is_writable {
            AccountMeta::new(*a.key, false)
        } else {
            AccountMeta::new_readonly(*a.key, false)
        });
        infos.push(a.clone());
    }

    let ix = Instruction {
        program_id: ctx.accounts.swap_pool.clmm_program,
        accounts: metas,
        data: swap_v2_data(amount_in, min_amount_out, sqrt_price_limit_x64, true),
    };

    // 4. CPI: подписывает программа от имени PDA vault_authority.
    let vault_key = ctx.accounts.vault_state.key();
    let bump = [ctx.accounts.vault_state.authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, vault_key.as_ref(), &bump]];
    invoke_signed(&ix, &infos, signer_seeds)?;

    // 5. Своя проверка slippage поверх проверки Raydium: смотрим, сколько реально пришло.
    let (spent, received) = if a_to_b {
        ctx.accounts.token_vault_a.reload()?;
        ctx.accounts.token_vault_b.reload()?;
        (
            balance_in_before.saturating_sub(ctx.accounts.token_vault_a.amount),
            ctx.accounts.token_vault_b.amount.saturating_sub(balance_out_before),
        )
    } else {
        ctx.accounts.token_vault_a.reload()?;
        ctx.accounts.token_vault_b.reload()?;
        (
            balance_in_before.saturating_sub(ctx.accounts.token_vault_b.amount),
            ctx.accounts.token_vault_a.amount.saturating_sub(balance_out_before),
        )
    };
    require!(spent <= amount_in, VaultError::InvalidPool);
    require!(received >= min_amount_out, VaultError::SlippageExceeded);
    msg!("swap: отдали {}, получили {}", spent, received);
    Ok(())
}
