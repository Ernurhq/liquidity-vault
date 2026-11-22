use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod math;
pub mod raydium;
pub mod raydium_lp;
pub mod state;

pub use instructions::*;

// Заглушка. Замени своим адресом командой `anchor keys sync`.
declare_id!("BnrJebxJS5VcX9BQ8SyCsWKNRtioVPDpU9BfbsczTPQ6");

#[program]
pub mod liquidity_vault {
    use super::*;

    /// Один раз создаёт настройки vault, share-токен и хранилище токенов.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handle_initialize_vault(ctx)
    }

    /// Создаёт «карточку» пользователя (PDA из адреса vault и адреса владельца).
    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        instructions::create_user_card::handle_create_user_card(ctx)
    }

    /// Вносит токены в vault и выпускает share-токены пропорционально доле.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Сжигает share-токены пользователя и отдаёт ему его долю токенов из vault.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, shares)
    }

    /// Неделя 12: админ привязывает пул Raydium CLMM и создаёт второе хранилище (токен B).
    pub fn init_swap_pool(ctx: Context<InitSwapPool>) -> Result<()> {
        instructions::init_swap_pool::handle_init_swap_pool(ctx)
    }

    /// Неделя 12: админ меняет токены vault через пул Raydium (CPI, подписывает PDA).
    pub fn swap<'info>(
        ctx: Context<'info, SwapOnRaydium<'info>>,
        a_to_b: bool,
        amount_in: u64,
        min_amount_out: u64,
        sqrt_price_limit_x64: u128,
    ) -> Result<()> {
        instructions::swap_on_raydium::handle_swap(ctx, a_to_b, amount_in, min_amount_out, sqrt_price_limit_x64)
    }

    /// Неделя 13: админ создаёт запись о позиции vault (один раз).
    pub fn init_lp_position(ctx: Context<InitLpPosition>) -> Result<()> {
        instructions::lp_position::handle_init_lp_position(ctx)
    }

    /// Неделя 13: vault открывает позицию в CLMM-пуле Raydium (CPI, подписывает PDA).
    pub fn open_lp_position(
        ctx: Context<OpenLpPosition>,
        tick_lower: i32,
        tick_upper: i32,
        tick_array_lower_start: i32,
        tick_array_upper_start: i32,
        liquidity: u128,
        amount_a_max: u64,
        amount_b_max: u64,
    ) -> Result<()> {
        instructions::lp_position::handle_open_lp_position(
            ctx,
            tick_lower,
            tick_upper,
            tick_array_lower_start,
            tick_array_upper_start,
            liquidity,
            amount_a_max,
            amount_b_max,
        )
    }

    /// Неделя 13: vault забирает накопленные комиссии позиции.
    pub fn collect_lp_fees(ctx: Context<CollectLpFees>) -> Result<()> {
        instructions::lp_position::handle_collect_lp_fees(ctx)
    }

    /// Неделя 13: vault выводит всю ликвидность и закрывает позицию.
    pub fn close_lp_position(
        ctx: Context<CloseLpPosition>,
        min_amount_a: u64,
        min_amount_b: u64,
    ) -> Result<()> {
        instructions::lp_position::handle_close_lp_position(ctx, min_amount_a, min_amount_b)
    }
}
