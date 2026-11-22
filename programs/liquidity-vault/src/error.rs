use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Вызывающий не является администратором vault")]
    Unauthorized,
    #[msg("Сумма должна быть больше нуля")]
    ZeroAmount,
    #[msg("Переполнение при вычислении")]
    MathOverflow,
    #[msg("Недостаточно share-токенов")]
    InsufficientShares,
    #[msg("Пул Raydium не подходит или переданы чужие аккаунты")]
    InvalidPool,
    #[msg("Обмен дал меньше минимума (slippage)")]
    SlippageExceeded,
    #[msg("В хранилище недостаточно токенов для обмена")]
    InsufficientFunds,
    #[msg("Позиция уже открыта: сначала закройте её")]
    PositionAlreadyOpen,
    #[msg("Нет открытой позиции")]
    NoOpenPosition,
    #[msg("Позиция Raydium не подходит или переданы чужие аккаунты")]
    InvalidPosition,
}
