use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::VaultError;
use crate::raydium::parse_pool;
use crate::raydium_lp::{
    close_position_data, decrease_liquidity_data, open_position_data, parse_position, PositionView,
};
use crate::state::*;

// ---------------------------------------------------------------------------------------------
// Неделя 13: vault сам становится провайдером ликвидности в CLMM-пуле Raydium.
// NFT позиции принадлежит PDA `vault_authority`. Все действия только для администратора.
// Рядом с токенами A/B Raydium называет токены пула «0» и «1»: порядок задаёт адрес минта, поэтому
// программа сама определяет, какой из наших токенов в пуле нулевой (`a_is_0`).
// ---------------------------------------------------------------------------------------------

/// Выбирает пару по порядку токенов пула: если наш A это токен 0, то (a, b), иначе (b, a).
fn pick<T>(a_is_0: bool, a: T, b: T) -> (T, T) {
    if a_is_0 {
        (a, b)
    } else {
        (b, a)
    }
}

/// Сверяет хранилища пула с данными самого пула и возвращает `a_is_0`.
/// Нельзя подсунуть чужие аккаунты: адреса берём из PoolState, а не доверяем вызывающему.
fn read_pool_order(
    pool_state: &AccountInfo,
    mint_a: &Pubkey,
    pool_vault_a: &Pubkey,
    pool_vault_b: &Pubkey,
) -> Result<bool> {
    let data = pool_state.try_borrow_data()?;
    let pool = parse_pool(&**data).ok_or(VaultError::InvalidPool)?;
    let a = mint_a.to_bytes();
    let (want_a, want_b, a_is_0) = if pool.mint_0 == a {
        (pool.vault_0, pool.vault_1, true)
    } else if pool.mint_1 == a {
        (pool.vault_1, pool.vault_0, false)
    } else {
        return err!(VaultError::InvalidPool);
    };
    require!(pool_vault_a.to_bytes() == want_a, VaultError::InvalidPool);
    require!(pool_vault_b.to_bytes() == want_b, VaultError::InvalidPool);
    Ok(a_is_0)
}

/// Читает позицию Raydium и сверяет, что это именно наша позиция в нашем пуле.
fn read_position(
    personal_position: &AccountInfo,
    clmm_program: &Pubkey,
    nft_mint: &Pubkey,
    pool_state: &Pubkey,
) -> Result<PositionView> {
    require_keys_eq!(*personal_position.owner, *clmm_program, VaultError::InvalidPosition);
    let data = personal_position.try_borrow_data()?;
    let pos = parse_position(&**data).ok_or(VaultError::InvalidPosition)?;
    require!(pos.nft_mint == nft_mint.to_bytes(), VaultError::InvalidPosition);
    require!(pos.pool_id == pool_state.to_bytes(), VaultError::InvalidPosition);
    Ok(pos)
}

fn meta(info: &AccountInfo, writable: bool, signer: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(*info.key, signer)
    } else {
        AccountMeta::new_readonly(*info.key, signer)
    }
}

/// Порядок и права аккаунтов `decrease_liquidity_v2` (из IDL):
/// nft_owner(S), nft_account, personal_position(W), pool_state(W), protocol_position,
/// token_vault_0(W), token_vault_1(W), tick_array_lower(W), tick_array_upper(W),
/// recipient_token_account_0(W), recipient_token_account_1(W), token_program, token_program_2022,
/// memo_program, vault_0_mint, vault_1_mint.
/// protocol_position помечаем записываемым: это безопасный запас (внешняя транзакция тоже передаёт его как mut).
const DECREASE_FLAGS: [(bool, bool); 16] = [
    (false, true),
    (false, false),
    (true, false),
    (true, false),
    (true, false),
    (true, false),
    (true, false),
    (true, false),
    (true, false),
    (true, false),
    (true, false),
    (false, false),
    (false, false),
    (false, false),
    (false, false),
    (false, false),
];

/// CPI `decrease_liquidity_v2`. `accs`: 16 аккаунтов в порядке IDL. Подписывает PDA vault_authority.
fn cpi_decrease<'info>(
    clmm_program: &AccountInfo<'info>,
    accs: [&AccountInfo<'info>; 16],
    liquidity: u128,
    min_0: u64,
    min_1: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut metas = Vec::with_capacity(16);
    let mut infos = Vec::with_capacity(17);
    for (i, info) in accs.iter().enumerate() {
        let (w, s) = DECREASE_FLAGS[i];
        metas.push(meta(info, w, s));
        infos.push((*info).clone());
    }
    infos.push(clmm_program.clone());
    let ix = Instruction {
        program_id: *clmm_program.key,
        accounts: metas,
        data: decrease_liquidity_data(liquidity, min_0, min_1),
    };
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

// ============================ init_lp_position ============================

/// Создаёт запись о позиции vault (один раз). Пул должен быть уже привязан (`init_swap_pool`).
#[derive(Accounts)]
pub struct InitLpPosition<'info> {
    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(mut, address = vault_state.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [SWAP_POOL_SEED, vault_state.key().as_ref()],
        bump = swap_pool.bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    #[account(
        init,
        payer = admin,
        space = 8 + LpPosition::INIT_SPACE,
        seeds = [LP_POSITION_SEED, vault_state.key().as_ref()],
        bump
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_lp_position(ctx: Context<InitLpPosition>) -> Result<()> {
    let lp = &mut ctx.accounts.lp_position;
    lp.vault = ctx.accounts.vault_state.key();
    lp.nft_mint = Pubkey::default();
    lp.nft_account = Pubkey::default();
    lp.personal_position = Pubkey::default();
    lp.tick_lower = 0;
    lp.tick_upper = 0;
    lp.liquidity = 0;
    lp.is_open = false;
    lp.bump = ctx.bumps.lp_position;
    Ok(())
}

// ============================ open_lp_position ============================

#[derive(Accounts)]
pub struct OpenLpPosition<'info> {
    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    /// Открывать позицию может только администратор.
    #[account(address = vault_state.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,

    /// PDA-владелец хранилищ и NFT позиции. Он же «плательщик» в Raydium: подписывает перевод токенов
    /// из хранилищ и платит аренду за новые аккаунты (на нём должно лежать немного SOL).
    /// CHECK: адрес проверяется сидами, данные не читаются.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump = vault_state.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [SWAP_POOL_SEED, vault_state.key().as_ref()],
        bump = swap_pool.bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    #[account(
        mut,
        seeds = [LP_POSITION_SEED, vault_state.key().as_ref()],
        bump = lp_position.bump
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    #[account(mut, address = vault_state.token_vault)]
    pub token_vault_a: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = swap_pool.token_vault_b)]
    pub token_vault_b: Box<Account<'info, TokenAccount>>,

    #[account(address = vault_state.deposit_mint)]
    pub mint_a: Box<Account<'info, Mint>>,

    #[account(address = swap_pool.mint_b)]
    pub mint_b: Box<Account<'info, Mint>>,

    /// CHECK: адрес сверяется с записью swap_pool, содержимое сверяется в обработчике.
    #[account(mut, address = swap_pool.pool_state)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью swap_pool.
    #[account(address = swap_pool.clmm_program)]
    pub clmm_program: UncheckedAccount<'info>,

    /// Хранилище нашего токена A внутри пула Raydium.
    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_a: UncheckedAccount<'info>,

    /// Хранилище нашего токена B внутри пула Raydium.
    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_b: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется самой программой Raydium.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium (tick-массив с нижним тиком), проверяется Raydium.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium (tick-массив с верхним тиком), проверяется Raydium.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, создаётся Raydium; после вызова мы читаем и сверяем её содержимое.
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,

    /// Новый минт NFT позиции (свежий ключ, подписывает транзакцию).
    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// Токен-аккаунт (Token-2022) с NFT: ATA PDA vault_authority, создаётся Raydium.
    /// CHECK: создаётся и проверяется Raydium.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: программа ассоциированных токен-аккаунтов; нужна Raydium, проверяется им.
    pub associated_token_program: UncheckedAccount<'info>,

    /// CHECK: программа Token-2022 (NFT позиции); нужна Raydium, проверяется им.
    pub token_program_2022: UncheckedAccount<'info>,
}

/// * `tick_lower`/`tick_upper` — границы диапазона (тики, кратные шагу пула);
/// * `tick_array_*_start` — начало tick-массивов, в которых лежат эти тики (считает клиент);
/// * `liquidity` — сколько ликвидности вносим (считает клиент по суммам токенов);
/// * `amount_a_max`/`amount_b_max` — максимум наших токенов A и B, который готовы отдать (защита от slippage).
pub fn handle_open_lp_position(
    ctx: Context<OpenLpPosition>,
    tick_lower: i32,
    tick_upper: i32,
    tick_array_lower_start: i32,
    tick_array_upper_start: i32,
    liquidity: u128,
    amount_a_max: u64,
    amount_b_max: u64,
) -> Result<()> {
    require!(!ctx.accounts.lp_position.is_open, VaultError::PositionAlreadyOpen);
    require!(liquidity > 0, VaultError::ZeroAmount);
    require!(tick_lower < tick_upper, VaultError::InvalidPosition);

    let a_is_0 = read_pool_order(
        &ctx.accounts.pool_state.to_account_info(),
        &ctx.accounts.mint_a.key(),
        &ctx.accounts.pool_vault_a.key(),
        &ctx.accounts.pool_vault_b.key(),
    )?;

    let bal_a = ctx.accounts.token_vault_a.amount;
    let bal_b = ctx.accounts.token_vault_b.amount;

    let (acc_0, acc_1) = pick(
        a_is_0,
        ctx.accounts.token_vault_a.to_account_info(),
        ctx.accounts.token_vault_b.to_account_info(),
    );
    let (pool_vault_0, pool_vault_1) = pick(
        a_is_0,
        ctx.accounts.pool_vault_a.to_account_info(),
        ctx.accounts.pool_vault_b.to_account_info(),
    );
    let (mint_0, mint_1) = pick(
        a_is_0,
        ctx.accounts.mint_a.to_account_info(),
        ctx.accounts.mint_b.to_account_info(),
    );
    let (max_0, max_1) = pick(a_is_0, amount_a_max, amount_b_max);

    // Порядок аккаунтов open_position_with_token22_nft из IDL:
    // payer(W,S), position_nft_owner, position_nft_mint(W,S), position_nft_account(W), pool_state(W),
    // protocol_position(W), tick_array_lower(W), tick_array_upper(W), personal_position(W),
    // token_account_0(W), token_account_1(W), token_vault_0(W), token_vault_1(W), rent, system_program,
    // token_program, associated_token_program, token_program_2022, vault_0_mint, vault_1_mint.
    let authority = ctx.accounts.vault_authority.to_account_info();
    let nft_mint = ctx.accounts.position_nft_mint.to_account_info();
    let nft_account = ctx.accounts.position_nft_account.to_account_info();
    let pool_state = ctx.accounts.pool_state.to_account_info();
    let protocol_position = ctx.accounts.protocol_position.to_account_info();
    let tick_lower_acc = ctx.accounts.tick_array_lower.to_account_info();
    let tick_upper_acc = ctx.accounts.tick_array_upper.to_account_info();
    let personal_position = ctx.accounts.personal_position.to_account_info();
    let rent = ctx.accounts.rent.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let token_program = ctx.accounts.token_program.to_account_info();
    let ata_program = ctx.accounts.associated_token_program.to_account_info();
    let token_program_2022 = ctx.accounts.token_program_2022.to_account_info();
    let clmm_program = ctx.accounts.clmm_program.to_account_info();

    let metas = vec![
        AccountMeta::new(*authority.key, true),
        AccountMeta::new_readonly(*authority.key, false),
        AccountMeta::new(*nft_mint.key, true),
        AccountMeta::new(*nft_account.key, false),
        AccountMeta::new(*pool_state.key, false),
        AccountMeta::new(*protocol_position.key, false),
        AccountMeta::new(*tick_lower_acc.key, false),
        AccountMeta::new(*tick_upper_acc.key, false),
        AccountMeta::new(*personal_position.key, false),
        AccountMeta::new(*acc_0.key, false),
        AccountMeta::new(*acc_1.key, false),
        AccountMeta::new(*pool_vault_0.key, false),
        AccountMeta::new(*pool_vault_1.key, false),
        AccountMeta::new_readonly(*rent.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*ata_program.key, false),
        AccountMeta::new_readonly(*token_program_2022.key, false),
        AccountMeta::new_readonly(*mint_0.key, false),
        AccountMeta::new_readonly(*mint_1.key, false),
    ];
    let infos = vec![
        authority,
        nft_mint,
        nft_account,
        pool_state,
        protocol_position,
        tick_lower_acc,
        tick_upper_acc,
        personal_position,
        acc_0,
        acc_1,
        pool_vault_0,
        pool_vault_1,
        rent,
        system_program,
        token_program,
        ata_program,
        token_program_2022,
        mint_0,
        mint_1,
        clmm_program,
    ];
    let ix = Instruction {
        program_id: ctx.accounts.swap_pool.clmm_program,
        accounts: metas,
        data: open_position_data(
            tick_lower,
            tick_upper,
            tick_array_lower_start,
            tick_array_upper_start,
            liquidity,
            max_0,
            max_1,
        ),
    };

    let vault_key = ctx.accounts.vault_state.key();
    let bump = [ctx.accounts.vault_state.authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, vault_key.as_ref(), &bump]];
    invoke_signed(&ix, &infos, signer_seeds)?;

    // Проверяем по балансам, сколько реально ушло в пул: не больше заданного максимума.
    ctx.accounts.token_vault_a.reload()?;
    ctx.accounts.token_vault_b.reload()?;
    let spent_a = bal_a.saturating_sub(ctx.accounts.token_vault_a.amount);
    let spent_b = bal_b.saturating_sub(ctx.accounts.token_vault_b.amount);
    require!(spent_a <= amount_a_max, VaultError::SlippageExceeded);
    require!(spent_b <= amount_b_max, VaultError::SlippageExceeded);

    // Читаем созданную Raydium позицию и убеждаемся, что это то, что мы просили.
    let nft_mint_key = ctx.accounts.position_nft_mint.key();
    let pos = read_position(
        &ctx.accounts.personal_position.to_account_info(),
        &ctx.accounts.swap_pool.clmm_program,
        &nft_mint_key,
        &ctx.accounts.pool_state.key(),
    )?;
    require!(pos.liquidity > 0, VaultError::InvalidPosition);
    require!(
        pos.tick_lower == tick_lower && pos.tick_upper == tick_upper,
        VaultError::InvalidPosition
    );

    let nft_account_key = ctx.accounts.position_nft_account.key();
    let personal_key = ctx.accounts.personal_position.key();
    let lp = &mut ctx.accounts.lp_position;
    lp.nft_mint = nft_mint_key;
    lp.nft_account = nft_account_key;
    lp.personal_position = personal_key;
    lp.tick_lower = tick_lower;
    lp.tick_upper = tick_upper;
    lp.liquidity = pos.liquidity;
    lp.is_open = true;
    msg!(
        "позиция открыта: тики {}..{}, ликвидность {}, отдано A={} B={}",
        tick_lower,
        tick_upper,
        pos.liquidity,
        spent_a,
        spent_b
    );
    Ok(())
}

// ============================ collect_lp_fees ============================

#[derive(Accounts)]
pub struct CollectLpFees<'info> {
    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(address = vault_state.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,

    /// CHECK: адрес проверяется сидами, данные не читаются.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump = vault_state.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [SWAP_POOL_SEED, vault_state.key().as_ref()],
        bump = swap_pool.bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    #[account(
        mut,
        seeds = [LP_POSITION_SEED, vault_state.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.is_open @ VaultError::NoOpenPosition
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    #[account(mut, address = vault_state.token_vault)]
    pub token_vault_a: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = swap_pool.token_vault_b)]
    pub token_vault_b: Box<Account<'info, TokenAccount>>,

    #[account(address = vault_state.deposit_mint)]
    pub mint_a: Box<Account<'info, Mint>>,

    #[account(address = swap_pool.mint_b)]
    pub mint_b: Box<Account<'info, Mint>>,

    /// CHECK: адрес сверяется с записью swap_pool.
    #[account(mut, address = swap_pool.pool_state)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью swap_pool.
    #[account(address = swap_pool.clmm_program)]
    pub clmm_program: UncheckedAccount<'info>,

    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_a: UncheckedAccount<'info>,

    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_b: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется самой программой Raydium.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется Raydium.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется Raydium.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью lp_position, содержимое читается и сверяется в обработчике.
    #[account(mut, address = lp_position.personal_position)]
    pub personal_position: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью lp_position.
    #[account(address = lp_position.nft_account)]
    pub position_nft_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: нужен Raydium; проверяется им.
    pub token_program_2022: UncheckedAccount<'info>,

    /// CHECK: нужен Raydium; проверяется им.
    pub memo_program: UncheckedAccount<'info>,
}

/// Забирает накопленные комиссии позиции: `decrease_liquidity_v2` с нулевой ликвидностью.
/// Комиссии в обоих токенах приходят прямо в хранилища vault.
pub fn handle_collect_lp_fees(ctx: Context<CollectLpFees>) -> Result<()> {
    let a_is_0 = read_pool_order(
        &ctx.accounts.pool_state.to_account_info(),
        &ctx.accounts.mint_a.key(),
        &ctx.accounts.pool_vault_a.key(),
        &ctx.accounts.pool_vault_b.key(),
    )?;
    // Позиция должна быть нашей (то же сверяем при закрытии).
    read_position(
        &ctx.accounts.personal_position.to_account_info(),
        &ctx.accounts.swap_pool.clmm_program,
        &ctx.accounts.lp_position.nft_mint,
        &ctx.accounts.pool_state.key(),
    )?;

    let bal_a = ctx.accounts.token_vault_a.amount;
    let bal_b = ctx.accounts.token_vault_b.amount;

    let (recipient_0, recipient_1) = pick(
        a_is_0,
        ctx.accounts.token_vault_a.to_account_info(),
        ctx.accounts.token_vault_b.to_account_info(),
    );
    let (pool_vault_0, pool_vault_1) = pick(
        a_is_0,
        ctx.accounts.pool_vault_a.to_account_info(),
        ctx.accounts.pool_vault_b.to_account_info(),
    );
    let (mint_0, mint_1) = pick(
        a_is_0,
        ctx.accounts.mint_a.to_account_info(),
        ctx.accounts.mint_b.to_account_info(),
    );

    let authority = ctx.accounts.vault_authority.to_account_info();
    let nft_account = ctx.accounts.position_nft_account.to_account_info();
    let personal_position = ctx.accounts.personal_position.to_account_info();
    let pool_state = ctx.accounts.pool_state.to_account_info();
    let protocol_position = ctx.accounts.protocol_position.to_account_info();
    let tick_lower = ctx.accounts.tick_array_lower.to_account_info();
    let tick_upper = ctx.accounts.tick_array_upper.to_account_info();
    let token_program = ctx.accounts.token_program.to_account_info();
    let token_program_2022 = ctx.accounts.token_program_2022.to_account_info();
    let memo_program = ctx.accounts.memo_program.to_account_info();
    let clmm_program = ctx.accounts.clmm_program.to_account_info();

    let vault_key = ctx.accounts.vault_state.key();
    let bump = [ctx.accounts.vault_state.authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, vault_key.as_ref(), &bump]];

    cpi_decrease(
        &clmm_program,
        [
            &authority,
            &nft_account,
            &personal_position,
            &pool_state,
            &protocol_position,
            &pool_vault_0,
            &pool_vault_1,
            &tick_lower,
            &tick_upper,
            &recipient_0,
            &recipient_1,
            &token_program,
            &token_program_2022,
            &memo_program,
            &mint_0,
            &mint_1,
        ],
        0,
        0,
        0,
        signer_seeds,
    )?;

    ctx.accounts.token_vault_a.reload()?;
    ctx.accounts.token_vault_b.reload()?;
    let fees_a = ctx.accounts.token_vault_a.amount.saturating_sub(bal_a);
    let fees_b = ctx.accounts.token_vault_b.amount.saturating_sub(bal_b);
    msg!("комиссии собраны: A={} B={}", fees_a, fees_b);
    Ok(())
}

// ============================ close_lp_position ============================

#[derive(Accounts)]
pub struct CloseLpPosition<'info> {
    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(address = vault_state.admin @ VaultError::Unauthorized)]
    pub admin: Signer<'info>,

    /// CHECK: адрес проверяется сидами, данные не читаются. Получает назад аренду закрытых аккаунтов.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, vault_state.key().as_ref()],
        bump = vault_state.authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [SWAP_POOL_SEED, vault_state.key().as_ref()],
        bump = swap_pool.bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    #[account(
        mut,
        seeds = [LP_POSITION_SEED, vault_state.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.is_open @ VaultError::NoOpenPosition
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    #[account(mut, address = vault_state.token_vault)]
    pub token_vault_a: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = swap_pool.token_vault_b)]
    pub token_vault_b: Box<Account<'info, TokenAccount>>,

    #[account(address = vault_state.deposit_mint)]
    pub mint_a: Box<Account<'info, Mint>>,

    #[account(address = swap_pool.mint_b)]
    pub mint_b: Box<Account<'info, Mint>>,

    /// CHECK: адрес сверяется с записью swap_pool.
    #[account(mut, address = swap_pool.pool_state)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью swap_pool.
    #[account(address = swap_pool.clmm_program)]
    pub clmm_program: UncheckedAccount<'info>,

    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_a: UncheckedAccount<'info>,

    /// CHECK: сверяется с данными пула.
    #[account(mut)]
    pub pool_vault_b: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется самой программой Raydium.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется Raydium.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK: PDA Raydium, проверяется Raydium.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью lp_position, содержимое читается и сверяется в обработчике.
    #[account(mut, address = lp_position.personal_position)]
    pub personal_position: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью lp_position.
    #[account(mut, address = lp_position.nft_mint)]
    pub position_nft_mint: UncheckedAccount<'info>,

    /// CHECK: адрес сверяется с записью lp_position.
    #[account(mut, address = lp_position.nft_account)]
    pub position_nft_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: нужен Raydium; проверяется им.
    pub token_program_2022: UncheckedAccount<'info>,

    /// CHECK: нужен Raydium; проверяется им.
    pub memo_program: UncheckedAccount<'info>,
}

/// Закрывает позицию: выводит всю ликвидность (вместе с комиссиями) и сжигает NFT.
/// * `min_amount_a`/`min_amount_b` — минимум наших токенов A и B, который согласны получить.
pub fn handle_close_lp_position(
    ctx: Context<CloseLpPosition>,
    min_amount_a: u64,
    min_amount_b: u64,
) -> Result<()> {
    let a_is_0 = read_pool_order(
        &ctx.accounts.pool_state.to_account_info(),
        &ctx.accounts.mint_a.key(),
        &ctx.accounts.pool_vault_a.key(),
        &ctx.accounts.pool_vault_b.key(),
    )?;
    let pos = read_position(
        &ctx.accounts.personal_position.to_account_info(),
        &ctx.accounts.swap_pool.clmm_program,
        &ctx.accounts.lp_position.nft_mint,
        &ctx.accounts.pool_state.key(),
    )?;

    let bal_a = ctx.accounts.token_vault_a.amount;
    let bal_b = ctx.accounts.token_vault_b.amount;

    let (recipient_0, recipient_1) = pick(
        a_is_0,
        ctx.accounts.token_vault_a.to_account_info(),
        ctx.accounts.token_vault_b.to_account_info(),
    );
    let (pool_vault_0, pool_vault_1) = pick(
        a_is_0,
        ctx.accounts.pool_vault_a.to_account_info(),
        ctx.accounts.pool_vault_b.to_account_info(),
    );
    let (mint_0, mint_1) = pick(
        a_is_0,
        ctx.accounts.mint_a.to_account_info(),
        ctx.accounts.mint_b.to_account_info(),
    );
    let (min_0, min_1) = pick(a_is_0, min_amount_a, min_amount_b);

    let authority = ctx.accounts.vault_authority.to_account_info();
    let nft_account = ctx.accounts.position_nft_account.to_account_info();
    let nft_mint = ctx.accounts.position_nft_mint.to_account_info();
    let personal_position = ctx.accounts.personal_position.to_account_info();
    let pool_state = ctx.accounts.pool_state.to_account_info();
    let protocol_position = ctx.accounts.protocol_position.to_account_info();
    let tick_lower = ctx.accounts.tick_array_lower.to_account_info();
    let tick_upper = ctx.accounts.tick_array_upper.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let token_program = ctx.accounts.token_program.to_account_info();
    let token_program_2022 = ctx.accounts.token_program_2022.to_account_info();
    let memo_program = ctx.accounts.memo_program.to_account_info();
    let clmm_program = ctx.accounts.clmm_program.to_account_info();

    let vault_key = ctx.accounts.vault_state.key();
    let bump = [ctx.accounts.vault_state.authority_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, vault_key.as_ref(), &bump]];

    // 1. Выводим всю ликвидность (и накопленные комиссии) в хранилища vault.
    cpi_decrease(
        &clmm_program,
        [
            &authority,
            &nft_account,
            &personal_position,
            &pool_state,
            &protocol_position,
            &pool_vault_0,
            &pool_vault_1,
            &tick_lower,
            &tick_upper,
            &recipient_0,
            &recipient_1,
            &token_program,
            &token_program_2022,
            &memo_program,
            &mint_0,
            &mint_1,
        ],
        pos.liquidity,
        min_0,
        min_1,
        signer_seeds,
    )?;

    // Своя проверка минимума поверх проверки Raydium: смотрим, сколько реально пришло.
    ctx.accounts.token_vault_a.reload()?;
    ctx.accounts.token_vault_b.reload()?;
    let got_a = ctx.accounts.token_vault_a.amount.saturating_sub(bal_a);
    let got_b = ctx.accounts.token_vault_b.amount.saturating_sub(bal_b);
    require!(got_a >= min_amount_a, VaultError::SlippageExceeded);
    require!(got_b >= min_amount_b, VaultError::SlippageExceeded);

    // 2. Закрываем пустую позицию: сжигается NFT, аренда возвращается на vault_authority.
    // Порядок аккаунтов close_position: nft_owner(W,S), position_nft_mint(W), position_nft_account(W),
    // personal_position(W), system_program, token_program (для NFT на Token-2022 это Token-2022).
    let metas = vec![
        AccountMeta::new(*authority.key, true),
        AccountMeta::new(*nft_mint.key, false),
        AccountMeta::new(*nft_account.key, false),
        AccountMeta::new(*personal_position.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*token_program_2022.key, false),
    ];
    let infos = vec![
        authority,
        nft_mint,
        nft_account,
        personal_position,
        system_program,
        token_program_2022,
        clmm_program,
    ];
    let ix = Instruction {
        program_id: ctx.accounts.swap_pool.clmm_program,
        accounts: metas,
        data: close_position_data(),
    };
    invoke_signed(&ix, &infos, signer_seeds)?;

    let lp = &mut ctx.accounts.lp_position;
    lp.is_open = false;
    lp.liquidity = 0;
    msg!("позиция закрыта: вернулось A={} B={}", got_a, got_b);
    Ok(())
}
