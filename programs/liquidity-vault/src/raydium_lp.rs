//! Неделя 13: данные инструкций Raydium CLMM для позиции (открыть, снять ликвидность/комиссии, закрыть).
//! Как и в неделе 12, библиотеку Raydium не подключаем: инструкции собираются вручную по официальному IDL
//! (raydium-io/raydium-idl, raydium_clmm.json). Тут только чистые функции без Anchor, чтобы их можно было
//! проверить обычными юнит-тестами.

/// `open_position_with_token22_nft`: NFT позиции на Token-2022.
pub const OPEN_POSITION_DISCRIMINATOR: [u8; 8] = [77, 255, 174, 82, 125, 29, 201, 46];
/// `decrease_liquidity_v2`: снять ликвидность. С нулём ликвидности забирает только накопленные комиссии.
pub const DECREASE_LIQUIDITY_DISCRIMINATOR: [u8; 8] = [58, 127, 188, 62, 79, 82, 196, 96];
/// `close_position`: закрыть пустую позицию и сжечь NFT.
pub const CLOSE_POSITION_DISCRIMINATOR: [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];

/// Данные `open_position_with_token22_nft`: discriminator, четыре тика (i32), liquidity (u128),
/// amount_0_max и amount_1_max (u64), with_metadata (bool), base_flag (Option<bool> = None).
/// Всё в little-endian (формат Borsh).
pub fn open_position_data(
    tick_lower: i32,
    tick_upper: i32,
    tick_array_lower_start: i32,
    tick_array_upper_start: i32,
    liquidity: u128,
    amount_0_max: u64,
    amount_1_max: u64,
) -> Vec<u8> {
    let mut d = Vec::with_capacity(58);
    d.extend_from_slice(&OPEN_POSITION_DISCRIMINATOR);
    d.extend_from_slice(&tick_lower.to_le_bytes());
    d.extend_from_slice(&tick_upper.to_le_bytes());
    d.extend_from_slice(&tick_array_lower_start.to_le_bytes());
    d.extend_from_slice(&tick_array_upper_start.to_le_bytes());
    d.extend_from_slice(&liquidity.to_le_bytes());
    d.extend_from_slice(&amount_0_max.to_le_bytes());
    d.extend_from_slice(&amount_1_max.to_le_bytes());
    d.push(0); // with_metadata = false
    d.push(0); // base_flag = None
    d
}

/// Данные `decrease_liquidity_v2`: discriminator, liquidity (u128), amount_0_min и amount_1_min (u64).
pub fn decrease_liquidity_data(liquidity: u128, amount_0_min: u64, amount_1_min: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(40);
    d.extend_from_slice(&DECREASE_LIQUIDITY_DISCRIMINATOR);
    d.extend_from_slice(&liquidity.to_le_bytes());
    d.extend_from_slice(&amount_0_min.to_le_bytes());
    d.extend_from_slice(&amount_1_min.to_le_bytes());
    d
}

/// Данные `close_position`: только discriminator, аргументов нет.
pub fn close_position_data() -> Vec<u8> {
    CLOSE_POSITION_DISCRIMINATOR.to_vec()
}

// Раскладка PersonalPositionState (после 8 байт discriminator Anchor, поля подряд):
// bump [u8;1], nft_mint, pool_id, tick_lower_index i32, tick_upper_index i32, liquidity u128,
// fee_growth_inside_0_last_x64 u128, fee_growth_inside_1_last_x64 u128, token_fees_owed_0 u64, token_fees_owed_1 u64.
const OFF_NFT_MINT: usize = 9;
const OFF_POOL_ID: usize = 41;
const OFF_TICK_LOWER: usize = 73;
const OFF_TICK_UPPER: usize = 77;
const OFF_LIQUIDITY: usize = 81;
const OFF_FEES_OWED_0: usize = 129;
const OFF_FEES_OWED_1: usize = 137;
/// Минимальная длина данных позиции, чтобы прочитать все нужные поля.
pub const POSITION_MIN_LEN: usize = OFF_FEES_OWED_1 + 8;

/// Нужные нам поля позиции Raydium.
#[derive(Debug, PartialEq, Eq)]
pub struct PositionView {
    pub nft_mint: [u8; 32],
    pub pool_id: [u8; 32],
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub fees_owed_0: u64,
    pub fees_owed_1: u64,
}

fn take32(data: &[u8], off: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[off..off + 32]);
    out
}
fn take_i32(data: &[u8], off: usize) -> i32 {
    i32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}
fn take_u64(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}
fn take_u128(data: &[u8], off: usize) -> u128 {
    u128::from_le_bytes(data[off..off + 16].try_into().unwrap())
}

/// Читает позицию из данных аккаунта `personal_position`. `None`, если данных слишком мало.
pub fn parse_position(data: &[u8]) -> Option<PositionView> {
    if data.len() < POSITION_MIN_LEN {
        return None;
    }
    Some(PositionView {
        nft_mint: take32(data, OFF_NFT_MINT),
        pool_id: take32(data, OFF_POOL_ID),
        tick_lower: take_i32(data, OFF_TICK_LOWER),
        tick_upper: take_i32(data, OFF_TICK_UPPER),
        liquidity: take_u128(data, OFF_LIQUIDITY),
        fees_owed_0: take_u64(data, OFF_FEES_OWED_0),
        fees_owed_1: take_u64(data, OFF_FEES_OWED_1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_data_layout() {
        let d = open_position_data(-100, 200, -3600, 0, 7, 8, 9);
        assert_eq!(d.len(), 58);
        assert_eq!(&d[..8], &OPEN_POSITION_DISCRIMINATOR);
        assert_eq!(&d[8..12], &(-100i32).to_le_bytes());
        assert_eq!(&d[12..16], &200i32.to_le_bytes());
        assert_eq!(&d[16..20], &(-3600i32).to_le_bytes());
        assert_eq!(&d[20..24], &0i32.to_le_bytes());
        assert_eq!(&d[24..40], &7u128.to_le_bytes());
        assert_eq!(&d[40..48], &8u64.to_le_bytes());
        assert_eq!(&d[48..56], &9u64.to_le_bytes());
        assert_eq!(d[56], 0);
        assert_eq!(d[57], 0);
    }

    #[test]
    fn decrease_and_close_layout() {
        let d = decrease_liquidity_data(5, 6, 7);
        assert_eq!(d.len(), 40);
        assert_eq!(&d[..8], &DECREASE_LIQUIDITY_DISCRIMINATOR);
        assert_eq!(&d[8..24], &5u128.to_le_bytes());
        assert_eq!(&d[24..32], &6u64.to_le_bytes());
        assert_eq!(&d[32..40], &7u64.to_le_bytes());
        assert_eq!(close_position_data(), CLOSE_POSITION_DISCRIMINATOR.to_vec());
    }

    #[test]
    fn parse_position_reads_fields() {
        let mut data = vec![0u8; 200];
        data[OFF_NFT_MINT..OFF_NFT_MINT + 32].copy_from_slice(&[1u8; 32]);
        data[OFF_POOL_ID..OFF_POOL_ID + 32].copy_from_slice(&[2u8; 32]);
        data[OFF_TICK_LOWER..OFF_TICK_LOWER + 4].copy_from_slice(&(-480i32).to_le_bytes());
        data[OFF_TICK_UPPER..OFF_TICK_UPPER + 4].copy_from_slice(&480i32.to_le_bytes());
        data[OFF_LIQUIDITY..OFF_LIQUIDITY + 16].copy_from_slice(&123456789u128.to_le_bytes());
        data[OFF_FEES_OWED_0..OFF_FEES_OWED_0 + 8].copy_from_slice(&11u64.to_le_bytes());
        data[OFF_FEES_OWED_1..OFF_FEES_OWED_1 + 8].copy_from_slice(&22u64.to_le_bytes());
        let p = parse_position(&data).unwrap();
        assert_eq!(p.nft_mint, [1u8; 32]);
        assert_eq!(p.pool_id, [2u8; 32]);
        assert_eq!((p.tick_lower, p.tick_upper), (-480, 480));
        assert_eq!(p.liquidity, 123456789);
        assert_eq!((p.fees_owed_0, p.fees_owed_1), (11, 22));
    }

    #[test]
    fn parse_position_short_data() {
        assert!(parse_position(&[0u8; 100]).is_none());
    }
}
