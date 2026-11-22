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

## Неделя 9: депозит и share-токены

Действие `deposit(amount)`:

1. посчитать долю: первый вкладчик получает share-токенов столько же, сколько внёс; дальше
   `amount × выпущено share ÷ токенов в vault` (округление вниз);
2. перевести токены пользователя в `token_vault` (подписывает сам пользователь);
3. выпустить share-токены на кошелёк пользователя (подписывает программа через PDA `vault_authority`);
4. обновить `VaultState.total_deposited` и `UserCard.deposited`. Депозит нуля запрещён.

Пример: в vault 1100 токенов и 1000 share-токенов, вносим 110 → получаем 100 share-токенов.

- Транзакция депозита: https://explorer.solana.com/tx/3avq3vYbUuvzhocq8DE2G7mB3B9L7NGNBtNJE9LRJDzfPKebzCy7on8s1e26rdMWyC6YGueN2YyHoKCMWGBAMQez?cluster=devnet

## Неделя 10: вывод из vault и CPI

Действие `withdraw(shares)`:

1. посчитать, сколько токенов положено: `shares × токенов в vault ÷ выпущено share` (u128, округление вниз);
2. **CPI №1 — `burn`**: Token Program сжигает share-токены пользователя. Подписывает сам пользователь;
3. **CPI №2 — `transfer`**: Token Program переводит токены из `token_vault` пользователю.
   Подписывает программа: она передаёт сиды `["vault_authority", vault_state, bump]`, и рантайм
   признаёт PDA `vault_authority` подписавшим (у PDA нет приватного ключа);
4. обновить учёт `total_deposited` и `card.deposited` (`saturating_sub`, в минус не уходит).
   Вывод нуля и вывод больше своих долей запрещены.

Почему администратор не может забрать токены своей подписью: `token_vault` принадлежит PDA
`vault_authority`, а подписать за PDA может только программа и только внутри своих инструкций.
Админской подписи Token Program не принимает, а инструкции «забрать всё» в программе нет.

### Какие CPI видны в транзакции вывода

В Explorer на странице транзакции в блоке *Instruction #1 → Inner Instructions* видны два вызова
Token Program, сделанные из нашей программы:

| # | Inner instruction | Кто подписал | Что происходит |
|---|-------------------|--------------|----------------|
| 1 | Token Program: Burn | пользователь | share-токены сожжены |
| 2 | Token Program: Transfer | PDA `vault_authority` (через сиды) | токены ушли из vault пользователю |

- Транзакция вывода: https://explorer.solana.com/tx/59DdDkGFr1n4FgfdQV9supF1nt5epaRoqJgNghE9UNSeL65S84nHuNeSQZQX3SMMDAKZNkwZx5jR6bVTTgJFcPdJ?cluster=devnet


## Неделя 11: свои токены и CLMM-пул Raydium (devnet)

Скрипты лежат в `raydium-clmm/` (SDK Raydium, запуск `npm run tokens`, `pool`, `position`).

| Что | Адрес |
|-----|-------|
| Токен A (он же Deposit mint нашего vault) | [yu1GnkebxmXngwGNBXxYD4CHcxywoWChMndCXeX1GCZ](https://explorer.solana.com/address/yu1GnkebxmXngwGNBXxYD4CHcxywoWChMndCXeX1GCZ?cluster=devnet) |
| Токен B (новый тестовый токен) | [2zhNASnpKVHZDj5thrTEbexkutxApz5oU86jVnHx1fK4](https://explorer.solana.com/address/2zhNASnpKVHZDj5thrTEbexkutxApz5oU86jVnHx1fK4?cluster=devnet) |
| CLMM-пул | [E2wznWtwnUd4BvQuEMWSYaqqA4YVGRPt47eXTbcDwuEh](https://explorer.solana.com/address/E2wznWtwnUd4BvQuEMWSYaqqA4YVGRPt47eXTbcDwuEh?cluster=devnet) |
| Транзакция создания пула | [tx](https://explorer.solana.com/tx/5xogZjXFzVSS5wyydNorvmFsnoQB7G8eBJPsR1hEfRVDW3AwweYZmmfpoSwn4153k6ULBxq57MeapAwQuLjw3z6q?cluster=devnet) |
| Позиция (NFT) | [AZGhsPzKmWVWzNwbce1DMZRWmrpBrkggqW8XUPm4qAyH](https://explorer.solana.com/address/AZGhsPzKmWVWzNwbce1DMZRWmrpBrkggqW8XUPm4qAyH?cluster=devnet) |
| Транзакция открытия позиции | [tx](https://explorer.solana.com/tx/kNmnzfvWVwxcaGqfc4F4YisCWMnJiVqsw1cYez7VsyjYtxw9x9apx9fKqasvV4VBJPMwJUhKcFZUGmjXZqV7ecs?cluster=devnet) |

- **Уровень комиссии:** AmmConfig №0, шаг тиков 60, комиссия 0,25%.
- **Текущая цена пула:** 1 токен A = 1 токен B (задана при создании).
- **Выбранный диапазон:** 0.9 - 1.1 (тики -1080 ... 960), то есть ±10% вокруг текущей цены.
- **Внесено в позицию:** 100 токенов A и около 112,17 токена B.

**Почему именно такой диапазон.** По правилу из методички берём текущую цену и отступаем на обычное колебание вверх и вниз,
5-10%. Выбран верхний край, ±10%: пара тестовая, цену двигаем только мы, а широкий коридор реже выходит из диапазона,
и позиции не придётся часто переставлять. Узкий диапазон (например ±1%) дал бы больше комиссий на те же деньги, но цена чаще
выходила бы за границы, и позиция переставала бы зарабатывать, пока её не передвинут.

**Почему B внесено больше, чем A.** Пока цена внутри диапазона, позиция состоит из двух частей: участок ниже текущей цены
заполняется токеном B, участок выше неё заполняется токеном A. Количество токенов считается через корень цены:
для A это `L × (1/√P − 1/√Pверх)`, для B это `L × (√P − √Pниз)`. При диапазоне ±10% нижний участок получается чуть
«длиннее» верхнего, поэтому B нужно примерно на 12% больше (около 112,17 против 100). Небольшую добавку даёт и округление
границ к шагу тиков (-1080 и 960). Если цена уйдёт выше верхней границы, вся позиция станет токеном B, если ниже нижней,
вся станет токеном A.

## Неделя 12: swap через Raydium

Vault сам обменивает токены через наш CLMM-пул из недели 11. Это тот же CPI, что на неделе 10,
только вызывается не Token Program, а программа Raydium CLMM, и подписывает обмен PDA `vault_authority`.

**Новые аккаунты.** `SwapPool` (PDA `["swap_pool", vault_state]`) хранит адрес пула, программу Raydium и
токен B. Второе хранилище `token_vault_b` (PDA `["token_vault_b", vault_state]`) принадлежит `vault_authority`.
Старый `VaultState` не менялся, поэтому уже созданный vault продолжает работать.

**Действия:**
- `init_swap_pool` (только админ): проверяет, что пул принадлежит программе Raydium и состоит ровно из наших двух
  токенов, создаёт `token_vault_b` и записывает `SwapPool`.
- `swap(a_to_b, amount_in, min_amount_out, sqrt_price_limit_x64)` (только админ): отдаёт `amount_in` одного токена
  в пул и получает другой. `min_amount_out` это минимум, который согласны получить (в скриптах на 1% меньше
  расчётного). Если пул даст меньше, обмен отменяется.

**Как устроен вызов Raydium (`swap_v2`).** Библиотеку Raydium мы не подключали (у неё свои требования к версии
Anchor), инструкция собирается вручную по официальному IDL (`raydium-io/raydium-idl`): 13 аккаунтов в порядке
`payer, amm_config, pool_state, input_token_account, output_token_account, input_vault, output_vault,
observation_state, token_program, token_program_2022, memo_program, input_vault_mint, output_vault_mint`, далее
tick-массивы пула как remaining accounts; данные: discriminator + `amount` + `other_amount_threshold` +
`sqrt_price_limit_x64` + `is_base_input`. Перед вызовом программа сверяет переданные аккаунты (vault'ы пула,
`amm_config`, observation) с данными самого пула, а после вызова ещё раз проверяет по балансам, что получено не
меньше `min_amount_out`.

**Почему обмен подписывает программа, а не администратор.** Токены лежат на хранилищах, которыми владеет PDA
`vault_authority`. Подписать за PDA может только наша программа и только внутри своих инструкций. Администратор
лишь разрешает обмен своей подписью (без неё `swap` не проходит), а переводом распоряжается программа.

**Упрощение учебной версии.** Пока часть токенов лежит в токене B, расчёт долей при депозите и выводе смотрит только
на баланс токена A. Поэтому после обмена админ должен вернуть токены обратно (`a_to_b = false`), прежде чем
пользователи вносят или выводят. Автоматический учёт обоих токенов это тема недель 13-14.

- Успешный обмен A → B: https://explorer.solana.com/tx/3BG9FEuHmFhKCfJM2tNMeCLjtwybTtbRFDDmoSY4SX9nsyftmbCGkqbqgrpha3D8DyGFk8Gw9YVkFyj4hV8XuWM8?cluster=devnet (отдали 100000, получили 99745 токена B)
- Обмен, отклонённый из-за slippage: https://explorer.solana.com/tx/8ZtZpen6xfVduaScoDjzVSdQzQL1yZyDPtcASssFWZMHfizFpNw4W25RwUUVas53NjA6idxcfziRJAdDpf2AAHr?cluster=devnet (минимум 199490 при ожидаемых 99745, Raydium вернул TooLittleOutputReceived, код 6018)
- Как изменилась цена пула: 1 → 0.9999065130238574 после A → B; обратный обмен B → A (https://explorer.solana.com/tx/2NKJN6BAHZVX3E3iDfvQCS5a919C246jwVwRxburSxubdBozUkQr4SfHjdNU94uLrWpo4mCNmFmLY1DWGLEU8sX8?cluster=devnet) вернул цену к 0.9999997653643092. Потери ≈ 0.25% комиссии пула на каждый обмен.
