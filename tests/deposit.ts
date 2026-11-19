import * as anchor from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";

describe("liquidity-vault: неделя 9 (депозит и share-токены)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.liquidityVault;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  // Конструктор BN: в новой версии библиотеки он может лежать по-разному, берём рабочий.
  const a: any = anchor;
  const BN: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
    (x) => typeof x === "function"
  );
  if (!BN) throw new Error("BN не найден в @anchor-lang/core");


  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  // Локальная сеть иногда не сразу видит свежий blockhash: повторяем несколько раз.
  const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e: any) {
        if (!String(e).includes("Blockhash not found") || i >= 6) throw e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  };

  // Все служебные транзакции подписывает админ (кошелёк провайдера).
  const send = (...ixs: TransactionInstruction[]) =>
    retry(() => provider.sendAndConfirm(new Transaction().add(...ixs)));

  let depositMint: PublicKey;
  let vaultState: PublicKey;
  let vaultAuthority: PublicKey;
  let shareMint: PublicKey;
  let tokenVault: PublicKey;

  const cardOf = (owner: PublicKey) =>
    pda([Buffer.from("user_card"), vaultState.toBuffer(), owner.toBuffer()]);

  const ensureAta = async (mint: PublicKey, owner: PublicKey): Promise<PublicKey> => {
    const address = getAssociatedTokenAddressSync(mint, owner);
    await send(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, address, owner, mint)
    );
    return address;
  };

  const mintDeposit = (dest: PublicKey, amount: number) =>
    send(createMintToInstruction(depositMint, dest, admin.publicKey, amount));

  type U = { user: Keypair; dep: PublicKey; sh: PublicKey };

  const prepareUser = async (tokens: number): Promise<U> => {
    const user = Keypair.generate();
    const sig = await conn.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");

    await retry(() =>
      program.methods
        .createUserCard()
        .accountsStrict({
          owner: user.publicKey,
          vaultState,
          userCard: cardOf(user.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc()
    );

    const dep = await ensureAta(depositMint, user.publicKey);
    const sh = await ensureAta(shareMint, user.publicKey);
    if (tokens > 0) await mintDeposit(dep, tokens);
    return { user, dep, sh };
  };

  const deposit = (u: U, amount: number) =>
    retry(() =>
      program.methods
        .deposit(new BN(amount))
        .accountsStrict({
          user: u.user.publicKey,
          vaultState,
          vaultAuthority,
          shareMint,
          tokenVault,
          userDepositAccount: u.dep,
          userShareAccount: u.sh,
          userCard: cardOf(u.user.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([u.user])
        .rpc()
    );

  const bal = async (a: PublicKey) => Number((await getAccount(conn, a)).amount);
  const supply = async () => Number((await getMint(conn, shareMint)).supply);

  let alice: U;
  let bob: U;

  before(async () => {
    depositMint = await retry(() => createMint(conn, admin, admin.publicKey, null, 6));
    vaultState = pda([Buffer.from("vault"), depositMint.toBuffer()]);
    vaultAuthority = pda([Buffer.from("vault_authority"), vaultState.toBuffer()]);
    shareMint = pda([Buffer.from("share_mint"), vaultState.toBuffer()]);
    tokenVault = pda([Buffer.from("token_vault"), vaultState.toBuffer()]);

    await retry(() =>
      program.methods
        .initializeVault()
        .accountsStrict({
          admin: admin.publicKey,
          depositMint,
          vaultState,
          vaultAuthority,
          shareMint,
          tokenVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    alice = await prepareUser(1000);
    bob = await prepareUser(110);
  });

  it("первый вкладчик получает долей столько же, сколько внёс", async () => {
    await deposit(alice, 1000);

    assert.equal(await bal(alice.sh), 1000, "доли Alice");
    assert.equal(await bal(alice.dep), 0, "токены Alice списаны");
    assert.equal(await bal(tokenVault), 1000, "токены в vault");
    assert.equal(await supply(), 1000, "выпущено долей");

    const state = await program.account.vaultState.fetch(vaultState);
    const card = await program.account.userCard.fetch(cardOf(alice.user.publicKey));
    assert.equal(state.totalDeposited.toNumber(), 1000);
    assert.equal(card.deposited.toNumber(), 1000);
  });

  it("поздний вкладчик получает меньше долей, чем внёс токенов (пример из методички)", async () => {
    // Vault «заработал»: в нём стало 1100 токенов при 1000 долей.
    await mintDeposit(tokenVault, 100);
    assert.equal(await bal(tokenVault), 1100);

    await deposit(bob, 110);

    assert.equal(await bal(bob.sh), 100, "доли Bob");
    assert.equal(await bal(tokenVault), 1210);
    assert.equal(await supply(), 1100);

    const state = await program.account.vaultState.fetch(vaultState);
    assert.equal(state.totalDeposited.toNumber(), 1110, "учитываются только депозиты");
  });

  it("нулевой депозит запрещён", async () => {
    let failed = false;
    try {
      await deposit(alice, 0);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "депозит нуля должен упасть");
  });

  it("нельзя получить доли на чужой share-аккаунт", async () => {
    const mixed: U = { user: bob.user, dep: bob.dep, sh: alice.sh };
    let failed = false;
    try {
      await deposit(mixed, 1);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "чужой share-аккаунт должен быть отклонён");
  });
});
