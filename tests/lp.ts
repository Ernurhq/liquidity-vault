import * as anchor from "@anchor-lang/core";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";

// В ESM-режиме ts-mocha `anchor.BN` бывает не конструктором: берём BN из того места, где он есть.
const a: any = anchor;
const BNCtor: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
  (x: any) => typeof x === "function"
);
const bn = (n: number) => new BNCtor(n);

// На localnet нет Raydium, поэтому открытие, сбор и закрытие позиции проверяются в devnet (скрипты raydium-clmm/).
// Здесь проверяем то, что можно проверить без Raydium: действия недоступны, пока пул не привязан.
describe("liquidity-vault: неделя 13 (позиция в пуле: защита)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.liquidityVault;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

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

  const expectError = async (fn: () => Promise<unknown>, ...needles: string[]) => {
    try {
      await fn();
    } catch (e: any) {
      const text = String(e) + JSON.stringify(e?.error ?? {}) + (e?.logs ?? []).join("\n");
      assert.isTrue(
        needles.some((n) => text.includes(n)),
        `ожидали одну из [${needles.join(", ")}], получили: ${text.slice(0, 400)}`
      );
      return;
    }
    assert.fail("ожидали ошибку, но вызов прошёл");
  };

  let depositMint: PublicKey;
  let mintB: PublicKey;
  let vaultState: PublicKey;
  let vaultAuthority: PublicKey;
  let shareMint: PublicKey;
  let tokenVault: PublicKey;
  let swapPool: PublicKey;
  let tokenVaultB: PublicKey;
  let lpPosition: PublicKey;

  before(async () => {
    depositMint = await retry(() => createMint(conn, admin, admin.publicKey, null, 6));
    mintB = await retry(() => createMint(conn, admin, admin.publicKey, null, 6));
    vaultState = pda([Buffer.from("vault"), depositMint.toBuffer()]);
    vaultAuthority = pda([Buffer.from("vault_authority"), vaultState.toBuffer()]);
    shareMint = pda([Buffer.from("share_mint"), vaultState.toBuffer()]);
    tokenVault = pda([Buffer.from("token_vault"), vaultState.toBuffer()]);
    swapPool = pda([Buffer.from("swap_pool"), vaultState.toBuffer()]);
    tokenVaultB = pda([Buffer.from("token_vault_b"), vaultState.toBuffer()]);
    lpPosition = pda([Buffer.from("lp_position"), vaultState.toBuffer()]);

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
  });

  it("запись о позиции нельзя создать, пока пул Raydium не привязан", async () => {
    await expectError(
      () =>
        retry(() =>
          program.methods
            .initLpPosition()
            .accountsStrict({
              vaultState,
              admin: admin.publicKey,
              swapPool,
              lpPosition,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        ),
      "AccountNotInitialized",
      "swap_pool"
    );
  });

  it("открыть позицию нельзя без записи о позиции", async () => {
    const someone = Keypair.generate().publicKey;
    const nftMint = Keypair.generate();
    await expectError(
      () =>
        retry(() =>
          program.methods
            .openLpPosition(-10, 10, -600, 0, bn(1), bn(1), bn(1))
            .accountsStrict({
              vaultState,
              admin: admin.publicKey,
              vaultAuthority,
              swapPool,
              lpPosition,
              tokenVaultA: tokenVault,
              tokenVaultB,
              mintA: depositMint,
              mintB,
              poolState: someone,
              clmmProgram: SystemProgram.programId,
              poolVaultA: someone,
              poolVaultB: someone,
              protocolPosition: someone,
              tickArrayLower: someone,
              tickArrayUpper: someone,
              personalPosition: someone,
              positionNftMint: nftMint.publicKey,
              positionNftAccount: someone,
              rent: SYSVAR_RENT_PUBKEY,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: someone,
              tokenProgram2022: someone,
            })
            .signers([nftMint])
            .rpc()
        ),
      "AccountNotInitialized",
      "swap_pool",
      "lp_position"
    );
  });

  it("собрать комиссии и закрыть позицию нельзя без позиции", async () => {
    const someone = Keypair.generate().publicKey;
    const common = {
      vaultState,
      admin: admin.publicKey,
      vaultAuthority,
      swapPool,
      lpPosition,
      tokenVaultA: tokenVault,
      tokenVaultB,
      mintA: depositMint,
      mintB,
      poolState: someone,
      clmmProgram: SystemProgram.programId,
      poolVaultA: someone,
      poolVaultB: someone,
      protocolPosition: someone,
      tickArrayLower: someone,
      tickArrayUpper: someone,
      personalPosition: someone,
      positionNftAccount: someone,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: someone,
      memoProgram: someone,
    };
    await expectError(
      () => retry(() => program.methods.collectLpFees().accountsStrict(common).rpc()),
      "AccountNotInitialized",
      "swap_pool",
      "lp_position"
    );
    await expectError(
      () =>
        retry(() =>
          program.methods
            .closeLpPosition(bn(0), bn(0))
            .accountsStrict({ ...common, positionNftMint: someone, systemProgram: SystemProgram.programId })
            .rpc()
        ),
      "AccountNotInitialized",
      "swap_pool",
      "lp_position"
    );
  });
});
