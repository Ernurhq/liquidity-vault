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

// В ESM-режиме ts-mocha `anchor.BN` бывает не конструктором: берём BN из того места, где он есть.
const a: any = anchor;
const BNCtor: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
  (x: any) => typeof x === "function"
);
const bn = (n: number) => new BNCtor(n);


describe("liquidity-vault: неделя 10 (вывод, CPI)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.liquidityVault;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

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
        .deposit(bn(amount))
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

  const withdraw = (u: U, shares: number) =>
    retry(() =>
      program.methods
        .withdraw(bn(shares))
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

  const expectFail = async (fn: () => Promise<unknown>, msg: string) => {
    let failed = false;
    try {
      await fn();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, msg);
  };

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
    bob = await prepareUser(1000);
    await deposit(alice, 1000); // 1000 токенов -> 1000 долей
    await deposit(bob, 1000); //   1000 токенов -> 1000 долей (прибыли ещё нет)
  });

  it("обычный вывод: сожгли часть долей, получили токены обратно", async () => {
    await withdraw(alice, 400);

    assert.equal(await bal(alice.sh), 600, "осталось долей");
    assert.equal(await bal(alice.dep), 400, "получено токенов");
    assert.equal(await bal(tokenVault), 1600, "в vault осталось");
    assert.equal(await supply(), 1600, "долей выпущено");

    const state = await program.account.vaultState.fetch(vaultState);
    const card = await program.account.userCard.fetch(cardOf(alice.user.publicKey));
    assert.equal(state.totalDeposited.toNumber(), 1600);
    assert.equal(card.deposited.toNumber(), 600);
  });

  it("вывод после «заработка» vault: доля стоит дороже", async () => {
    // В vault 1600 токенов и 1600 долей. «Заработали» 160 -> 1760 токенов.
    await mintDeposit(tokenVault, 160);

    // Bob выводит 800 долей из 1600: 800 * 1760 / 1600 = 880 токенов.
    await withdraw(bob, 800);

    assert.equal(await bal(bob.dep), 880, "Bob получил больше, чем вложил за эти доли");
    assert.equal(await bal(bob.sh), 200);
    assert.equal(await bal(tokenVault), 880);
    assert.equal(await supply(), 800);

    // Учёт не уходит в минус: Bob вносил 1000, вывел 880.
    const card = await program.account.userCard.fetch(cardOf(bob.user.publicKey));
    assert.equal(card.deposited.toNumber(), 120);
  });

  it("нулевой вывод запрещён", async () => {
    await expectFail(() => withdraw(alice, 0), "вывод нуля должен упасть");
  });

  it("нельзя вывести больше долей, чем есть", async () => {
    await expectFail(() => withdraw(alice, 601), "вывод сверх баланса должен упасть");
  });

  it("нельзя сжечь доли на чужом share-аккаунте", async () => {
    const mixed: U = { user: bob.user, dep: bob.dep, sh: alice.sh };
    await expectFail(() => withdraw(mixed, 1), "чужой share-аккаунт должен быть отклонён");
  });

  it("нельзя получить токены на чужой токен-аккаунт", async () => {
    const mixed: U = { user: bob.user, dep: alice.dep, sh: bob.sh };
    await expectFail(() => withdraw(mixed, 1), "чужой токен-аккаунт должен быть отклонён");
  });

  it("полный выход: все доли сожжены, vault пустеет", async () => {
    await withdraw(alice, 600);
    await withdraw(bob, 200);

    assert.equal(await supply(), 0);
    assert.equal(await bal(tokenVault), 0);
  });
});
