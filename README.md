# Liquidity Vault: неделя 8 (каркас, РК1)

Учебный проект на Solana (Anchor). На этой неделе денег в vault ещё нет:
только структура аккаунтов и два действия.

## Что делает программа

| Действие | Что происходит |
|---|---|
| `initialize_vault` | Один раз создаёт настройки vault, share-токен и хранилище токенов |
| `create_user_card` | Пользователь создаёт свою карточку (PDA из адреса vault и адреса владельца) |

## Схема аккаунтов

```
deposit_mint (токен, который принимаем)
      │
      ▼
VaultState  PDA ["vault", deposit_mint]
  admin, deposit_mint, share_mint, token_vault, total_deposited
      │
      ├── vault_authority  PDA ["vault_authority", vault_state]
      │     нет данных и нет ключа; подписывает только программа
      │     ├── владеет token_vault
      │     └── mint authority у share_mint
      │
      ├── share_mint   PDA ["share_mint", vault_state]
      │     токен-квитанция, выпускает только vault_authority
      │
      ├── token_vault  PDA ["token_vault", vault_state]
      │     token account, здесь лежат внесённые токены
      │
      └── UserCard  PDA ["user_card", vault_state, owner]   (по одной на пользователя)
            vault, owner, deposited
```

| Аккаунт | Кто владеет | Что хранит |
|---|---|---|
| VaultState | наша программа | админ, токены vault, общая сумма |
| vault_authority | наша программа (PDA) | ничего, нужен как подписант |
| share_mint | Token Program; mint authority = vault_authority | выпущенные share-токены |
| token_vault | Token Program; owner = vault_authority | внесённые токены |
| UserCard | наша программа | сколько внёс конкретный пользователь |

Админ не может забрать токены своей подписью: токенами распоряжается vault_authority,
а подписать за него может только программа.

## Запуск

```bash
yarn install
anchor keys sync          # подставит твой адрес программы в Anchor.toml и lib.rs
anchor build
anchor test               # тесты на локальной сети
```

## Деплой в devnet

```bash
solana config set --url devnet
solana airdrop 2          # если лимит, повтори позже или через faucet.solana.com
anchor build
anchor deploy --provider.cluster devnet

ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
yarn init-devnet          # создаст токен, vault, карточку и напечатает ссылки
```

## Ссылки в Explorer (devnet)

Заполни после запуска `yarn init-devnet`:

- Программа: https://explorer.solana.com/address/BnrJebxJS5VcX9BQ8SyCsWKNRtioVPDpU9BfbsczTPQ6?cluster=devnet
- Deposit mint: https://explorer.solana.com/address/yu1GnkebxmXngwGNBXxYD4CHcxywoWChMndCXeX1GCZ?cluster=devnet
- VaultState: https://explorer.solana.com/address/6HE5w5YWX32gyhdZ1JXk8bgB3cPoPcRSunTvKwUhLFeh?cluster=devnet
- vault_authority: https://explorer.solana.com/address/8qRH113GydVPk2QhFm46wDpqeAMmRCAVhaTTukdV5mR5?cluster=devnet
- Share mint: https://explorer.solana.com/address/AKbw1yAQkYmNvuPuAdNH1VvhpdLGK7LaC9qhaFYmUitA?cluster=devnet
- Token vault: https://explorer.solana.com/address/DQnpdFcaQozDWeQZvb64VzMitEihmk7ruyhQbyieMC4e?cluster=devnet
- UserCard: https://explorer.solana.com/address/C1fHDu9Da2J2NL4LZdouRE3fyvNxMCmGBgeb467zQNdC?cluster=devnet
- Транзакция initialize: https://explorer.solana.com/tx/2GVemxxjdB9Y3b6nUvUJf9PxjNMXDcqNECqUpkPYtXoYJjzSyoKSPof179S3wxwf3tSnuTr5nG35TeKAPpEq3qzh?cluster=devnet
- Транзакция create_user_card: https://explorer.solana.com/tx/2NP8dgxMgVmbvv2WSKiYAez1YFJ1kvrcUpKne6fkWwFbmrntKLypcxHL8HzyzpdCFWRcdKtNYUBygoeCygzRFy1P?cluster=devnet

## Безопасность

В репозиторий не попадают ключи и seed-фразы (см. `.gitignore`). Работаем только в localnet и devnet.
