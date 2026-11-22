use anchor_lang::prelude::*;

// Сиды PDA. Все адреса vault выводятся из них, поэтому список хранить не нужно.
pub const VAULT_SEED: &[u8] = b"vault";
pub const AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
pub const USER_CARD_SEED: &[u8] = b"user_card";

/// Настройки vault: кто админ, какой токен принимаем, какой share-токен,
/// где лежат токены и сколько всего внесено.
#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub admin: Pubkey,
    pub deposit_mint: Pubkey,
    pub share_mint: Pubkey,
    pub token_vault: Pubkey,
    pub total_deposited: u64,
    pub bump: u8,
    pub authority_bump: u8,
}

/// Карточка пользователя: сколько он внёс в этот vault.
#[account]
#[derive(InitSpace)]
pub struct UserCard {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub deposited: u64,
    pub bump: u8,
}

// Неделя 12: привязка пула Raydium и второе хранилище vault.
pub const SWAP_POOL_SEED: &[u8] = b"swap_pool";
pub const TOKEN_VAULT_B_SEED: &[u8] = b"token_vault_b";

/// Какой пул Raydium CLMM привязан к vault и где лежит токен B.
#[account]
#[derive(InitSpace)]
pub struct SwapPool {
    pub vault: Pubkey,
    pub clmm_program: Pubkey,
    pub pool_state: Pubkey,
    pub mint_b: Pubkey,
    pub token_vault_b: Pubkey,
    pub bump: u8,
}
