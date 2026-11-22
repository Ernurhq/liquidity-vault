use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod math;
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
}
