import * as anchor from "@anchor-lang/core";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

// В ESM-режиме ts-mocha `anchor.BN` бывает не конструктором: берём BN из того места, где он есть.
const a: any = anchor;
const BNCtor: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
  (x: any) => typeof x === "function"
);
const bn = (n: number) => new BNCtor(n);

// На localnet нет Raydium, поэтому сам обмен проверяется в devnet (скрипты raydium-clmm/).
// Здесь проверяем то, что можно проверить без Raydium: права доступа и защиту от чужих аккаунтов.
describe("liquidity-vault: неделя 12 (swap через Raydium: защита)", () => {
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

  // Ожидаем ошибку, в тексте которой есть одно из имён (так тест не пройдёт «по ошибке не о том»).
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

  const initAccounts = (signer: PublicKey, poolState: PublicKey, clmmProgram: PublicKey) => ({
    vaultState,
    admin: signer,
    vaultAuthority,
    mintB,
    tokenVaultB,
    swapPool,
    poolState,
    clmmProgram,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  before(async () => {
    depositMint = await retry(() => createMint(conn, admin, admin.publicKey, null, 6));
    mintB = await retry(() => createMint(conn, admin, admin.publicKey, null, 6));
    vaultState = pda([Buffer.from("vault"), depositMint.toBuffer()]);
    vaultAuthority = pda([Buffer.from("vault_authority"), vaultState.toBuffer()]);
    shareMint = pda([Buffer.from("share_mint"), vaultState.toBuffer()]);
    tokenVault = pda([Buffer.from("token_vault"), vaultState.toBuffer()]);
    swapPool = pda([Buffer.from("swap_pool"), vaultState.toBuffer()]);
    tokenVaultB = pda([Buffer.from("token_vault_b"), vaultState.toBuffer()]);

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

  it("не администратор не может привязать пул", async () => {
    const stranger = Keypair.generate();
    const sig = await conn.requestAirdrop(stranger.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");

    await expectError(
      () =>
        retry(() =>
          program.methods
            .initSwapPool()
            .accountsStrict(initAccounts(stranger.publicKey, depositMint, SystemProgram.programId))
            .signers([stranger])
            .rpc()
        ),
      "Unauthorized",
      "не является администратором"
    );
  });

  it("нельзя привязать аккаунт, который не является пулом Raydium", async () => {
    // depositMint принадлежит Token Program, а не «программе Raydium» (в тесте это System Program).
    await expectError(
      () =>
        retry(() =>
          program.methods
            .initSwapPool()
            .accountsStrict(initAccounts(admin.publicKey, depositMint, SystemProgram.programId))
            .rpc()
        ),
      "InvalidPool",
      "Пул Raydium не подходит"
    );
  });

  it("обмен невозможен, пока пул не привязан", async () => {
    const someone = Keypair.generate().publicKey;
    await expectError(
      () =>
        retry(() =>
          program.methods
            .swap(true, bn(1), bn(0), bn(1))
            .accountsStrict({
              vaultState,
              admin: admin.publicKey,
              vaultAuthority,
              swapPool,
              tokenVaultA: tokenVault,
              tokenVaultB,
              mintA: depositMint,
              mintB,
              poolState: someone,
              clmmProgram: SystemProgram.programId,
              ammConfig: someone,
              poolVaultA: someone,
              poolVaultB: someone,
              observationState: someone,
              tokenProgram: TOKEN_PROGRAM_ID,
              tokenProgram2022: someone,
              memoProgram: someone,
            })
            .rpc()
        ),
      "AccountNotInitialized",
      "swap_pool"
    );
  });
});
