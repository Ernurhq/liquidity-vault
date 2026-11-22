//! Вспомогательный код для вызова Raydium CLMM (`swap_v2`) через CPI.
//!
//! Библиотеку Raydium мы не подключаем (у неё свои требования к версии Anchor, а у нас 1.1.2),
//! а собираем инструкцию вручную по официальному IDL (raydium-io/raydium-idl, raydium_clmm.json).

/// Первые 8 байт данных инструкции `swap_v2` (discriminator из IDL).
pub const SWAP_V2_DISCRIMINATOR: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];

// Раскладка аккаунта PoolState в Raydium CLMM: 8 байт discriminator Anchor, затем поля подряд
// (структура `packed`, без выравнивания): bump [u8;1], amm_config, owner, token_mint_0, token_mint_1,
// token_vault_0, token_vault_1, observation_key.
const OFF_AMM_CONFIG: usize = 9;
const OFF_MINT_0: usize = 73;
const OFF_MINT_1: usize = 105;
const OFF_VAULT_0: usize = 137;
const OFF_VAULT_1: usize = 169;
const OFF_OBSERVATION: usize = 201;
/// Минимальная длина данных пула, чтобы прочитать все нужные поля.
pub const POOL_MIN_LEN: usize = OFF_OBSERVATION + 32;

/// Нужные нам поля пула Raydium (адреса в виде сырых байт).
#[derive(Debug, PartialEq, Eq)]
pub struct PoolView {
    pub amm_config: [u8; 32],
    pub mint_0: [u8; 32],
    pub mint_1: [u8; 32],
    pub vault_0: [u8; 32],
    pub vault_1: [u8; 32],
    pub observation: [u8; 32],
}

fn take32(data: &[u8], off: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[off..off + 32]);
    out
}

/// Читает адреса из данных аккаунта пула. `None`, если данных слишком мало.
pub fn parse_pool(data: &[u8]) -> Option<PoolView> {
    if data.len() < POOL_MIN_LEN {
        return None;
    }
    Some(PoolView {
        amm_config: take32(data, OFF_AMM_CONFIG),
        mint_0: take32(data, OFF_MINT_0),
        mint_1: take32(data, OFF_MINT_1),
        vault_0: take32(data, OFF_VAULT_0),
        vault_1: take32(data, OFF_VAULT_1),
        observation: take32(data, OFF_OBSERVATION),
    })
}

/// Данные инструкции `swap_v2`: discriminator + amount (u64) + other_amount_threshold (u64)
/// + sqrt_price_limit_x64 (u128) + is_base_input (bool). Числа в little-endian (формат Borsh).
pub fn swap_v2_data(
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit_x64: u128,
    is_base_input: bool,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(41);
    data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&other_amount_threshold.to_le_bytes());
    data.extend_from_slice(&sqrt_price_limit_x64.to_le_bytes());
    data.push(is_base_input as u8);
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_data_layout() {
        let d = swap_v2_data(1, 2, 3, true);
        assert_eq!(d.len(), 41);
        assert_eq!(&d[..8], &SWAP_V2_DISCRIMINATOR);
        assert_eq!(&d[8..16], &1u64.to_le_bytes());
        assert_eq!(&d[16..24], &2u64.to_le_bytes());
        assert_eq!(&d[24..40], &3u128.to_le_bytes());
        assert_eq!(d[40], 1);
        assert_eq!(swap_v2_data(0, 0, 0, false)[40], 0);
    }

    #[test]
    fn swap_data_big_numbers() {
        let d = swap_v2_data(u64::MAX, u64::MAX, u128::MAX, true);
        assert_eq!(&d[8..16], &[255u8; 8]);
        assert_eq!(&d[24..40], &[255u8; 16]);
    }

    #[test]
    fn parse_pool_reads_fields_at_offsets() {
        let mut data = vec![0u8; POOL_MIN_LEN + 100];
        for (off, v) in [
            (OFF_AMM_CONFIG, 1u8),
            (OFF_MINT_0, 2),
            (OFF_MINT_1, 3),
            (OFF_VAULT_0, 4),
            (OFF_VAULT_1, 5),
            (OFF_OBSERVATION, 6),
        ] {
            data[off..off + 32].fill(v);
        }
        let p = parse_pool(&data).unwrap();
        assert_eq!(p.amm_config, [1u8; 32]);
        assert_eq!(p.mint_0, [2u8; 32]);
        assert_eq!(p.mint_1, [3u8; 32]);
        assert_eq!(p.vault_0, [4u8; 32]);
        assert_eq!(p.vault_1, [5u8; 32]);
        assert_eq!(p.observation, [6u8; 32]);
    }

    #[test]
    fn offsets_do_not_overlap() {
        // Поля идут подряд по 32 байта; между amm_config и mint_0 лежит owner (32 байта).
        assert_eq!(OFF_MINT_0, OFF_AMM_CONFIG + 32 + 32);
        assert_eq!(OFF_MINT_1, OFF_MINT_0 + 32);
        assert_eq!(OFF_VAULT_0, OFF_MINT_1 + 32);
        assert_eq!(OFF_VAULT_1, OFF_VAULT_0 + 32);
        assert_eq!(OFF_OBSERVATION, OFF_VAULT_1 + 32);
    }

    #[test]
    fn short_data_is_rejected() {
        assert!(parse_pool(&[0u8; 100]).is_none());
        assert!(parse_pool(&vec![0u8; POOL_MIN_LEN - 1]).is_none());
        assert!(parse_pool(&vec![0u8; POOL_MIN_LEN]).is_some());
    }
}
