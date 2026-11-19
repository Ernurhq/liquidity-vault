import * as anchor from "@anchor-lang/core";
import { createMint, getAccount, getMint } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

describe("liquidity-vault: неделя 8 (каркас)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.liquidityVault;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  let depositMint: PublicKey;
  let vaultState: PublicKey;
  let vaultAuthority: PublicKey;
  let shareMint: PublicKey;
  let tokenVault: PublicKey;

  const cardOf = (owner: PublicKey) =>
    pda([Buffer.from("user_card"), vaultState.toBuffer(), owner.toBuffer()]);

  const fundedUser = async () => {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    return kp;
  };

  before(async () => {
    depositMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    vaultState = pda([Buffer.from("vault"), depositMint.toBuffer()]);
    vaultAuthority = pda([Buffer.from("vault_authority"), vaultState.toBuffer()]);
    shareMint = pda([Buffer.from("share_mint"), vaultState.toBuffer()]);
    tokenVault = pda([Buffer.from("token_vault"), vaultState.toBuffer()]);
  });

  it("создаёт vault: настройки, share-токен, хранилище", async () => {
    await program.methods
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
      .rpc();

    const state = await program.account.vaultState.fetch(vaultState);
    assert.equal(state.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(state.depositMint.toBase58(), depositMint.toBase58());
    assert.equal(state.shareMint.toBase58(), shareMint.toBase58());
    assert.equal(state.tokenVault.toBase58(), tokenVault.toBase58());
    assert.equal(state.totalDeposited.toNumber(), 0);

    // share-токен выпускает только PDA программы, а не админ
    const mint = await getMint(provider.connection, shareMint);
    assert.equal(mint.mintAuthority!.toBase58(), vaultAuthority.toBase58());
    assert.notEqual(mint.mintAuthority!.toBase58(), admin.publicKey.toBase58());
    assert.equal(mint.supply, 0n);

    // хранилищем владеет PDA программы
    const vaultTokens = await getAccount(provider.connection, tokenVault);
    assert.equal(vaultTokens.owner.toBase58(), vaultAuthority.toBase58());
    assert.equal(vaultTokens.mint.toBase58(), depositMint.toBase58());
    assert.equal(vaultTokens.amount, 0n);
  });

  it("повторная инициализация того же vault невозможна", async () => {
    let failed = false;
    try {
      await program.methods
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
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "второй initialize должен упасть");
  });

  it("у двух кошельков независимые карточки", async () => {
    const alice = await fundedUser();
    const bob = await fundedUser();

    for (const user of [alice, bob]) {
      await program.methods
        .createUserCard()
        .accountsStrict({
          owner: user.publicKey,
          vaultState,
          userCard: cardOf(user.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    }

    const a = await program.account.userCard.fetch(cardOf(alice.publicKey));
    const b = await program.account.userCard.fetch(cardOf(bob.publicKey));

    assert.notEqual(cardOf(alice.publicKey).toBase58(), cardOf(bob.publicKey).toBase58());
    assert.equal(a.owner.toBase58(), alice.publicKey.toBase58());
    assert.equal(b.owner.toBase58(), bob.publicKey.toBase58());
    assert.equal(a.vault.toBase58(), vaultState.toBase58());
    assert.equal(a.deposited.toNumber(), 0);
    assert.equal(b.deposited.toNumber(), 0);
  });

  it("карточку нельзя создать дважды", async () => {
    const carol = await fundedUser();
    const build = () =>
      program.methods
        .createUserCard()
        .accountsStrict({
          owner: carol.publicKey,
          vaultState,
          userCard: cardOf(carol.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([carol])
        .rpc();

    await build();
    let failed = false;
    try {
      await build();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "вторая карточка того же владельца должна упасть");
  });
});
