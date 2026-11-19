use anchor_lang::prelude::*;

use crate::error::VaultError;

/// Сколько share-токенов положено за `amount` внесённых токенов.
///
/// * `total_assets` — сколько токенов лежит в vault ДО этого депозита;
/// * `total_shares` — сколько share-токенов уже выпущено.
///
/// Первый вкладчик получает долей столько же, сколько внёс.
/// Дальше: amount * total_shares / total_assets, с округлением вниз.
pub fn calc_shares(amount: u64, total_assets: u64, total_shares: u64) -> Result<u64> {
    // Первый вкладчик: долей выпущено 0, получает 1 к 1.
    if total_shares == 0 {
        return Ok(amount);
    }

    // Считаем в u128, чтобы произведение не переполнило u64.
    // Целочисленное деление округляет вниз.
    let result = (amount as u128) * (total_shares as u128) / (total_assets as u128);

    // Возвращаем в u64; если число не помещается, отдаём ошибку.
    u64::try_from(result).map_err(|_| VaultError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_gets_equal_shares() {
        assert_eq!(calc_shares(1000, 0, 0).unwrap(), 1000);
    }

    #[test]
    fn example_from_course() {
        // В vault 1100 токенов, выпущено 1000 share-токенов, вносим 110 -> 100 долей.
        assert_eq!(calc_shares(110, 1100, 1000).unwrap(), 100);
    }

    #[test]
    fn proportional_when_no_profit() {
        assert_eq!(calc_shares(500, 1000, 1000).unwrap(), 500);
    }

    #[test]
    fn rounds_down() {
        // 10 * 1000 / 1100 = 9.09... -> 9
        assert_eq!(calc_shares(10, 1100, 1000).unwrap(), 9);
    }

    #[test]
    fn no_overflow_on_big_numbers() {
        let half = u64::MAX / 2;
        assert_eq!(calc_shares(half, u64::MAX, u64::MAX).unwrap(), half);
    }
}
