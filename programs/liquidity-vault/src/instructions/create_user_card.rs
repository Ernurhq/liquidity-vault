use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    /// Владелец карточки: подписывает и платит за аккаунт.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault_state.deposit_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Адрес карточки = PDA(["user_card", vault, owner]).
    /// Поэтому её всегда можно найти по адресу пользователя,
    /// и повторно создать её нельзя (init упадёт).
    #[account(
        init,
        payer = owner,
        space = 8 + UserCard::INIT_SPACE,
        seeds = [USER_CARD_SEED, vault_state.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub user_card: Account<'info, UserCard>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
    let card = &mut ctx.accounts.user_card;
    card.vault = ctx.accounts.vault_state.key();
    card.owner = ctx.accounts.owner.key();
    card.deposited = 0;
    card.bump = ctx.bumps.user_card;
    Ok(())
}
