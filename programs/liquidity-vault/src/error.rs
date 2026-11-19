use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Вызывающий не является администратором vault")]
    Unauthorized,
    #[msg("Сумма должна быть больше нуля")]
    ZeroAmount,
    #[msg("Переполнение при вычислении")]
    MathOverflow,
}
