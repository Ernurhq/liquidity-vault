// Вносит токены в vault в devnet и печатает ссылку на транзакцию депозита.
// Запуск (DEPOSIT_MINT — адрес Deposit mint из README):
//   DEPOSIT_MINT=<адрес> \
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=$HOME/.config/solana/id.json \
//   yarn ts-node scripts/deposit-devnet.ts
import * as anchor from "@anchor-lang/core";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const link = (kind: "address" | "tx", v: string) =>
  `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;

(async () => {
  if (!process.env.DEPOSIT_MINT) {
    throw new Error("Укажи DEPOSIT_MINT=<адрес Deposit mint из README>");
  }
  const depositMint = new PublicKey(process.env.DEPOSIT_MINT);
  const amount = Number(process.env.AMOUNT ?? 1_000_000); // 1 токен при 6 знаках

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const a: any = anchor;
  const BN: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
    (x) => typeof x === "function"
  );

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../target/idl/liquidity_vault.json"), "utf8")
  );
  const program: any = new anchor.Program(idl, provider);
  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const vaultState = pda([Buffer.from("vault"), depositMint.toBuffer()]);
  const vaultAuthority = pda([Buffer.from("vault_authority"), vaultState.toBuffer()]);
  const shareMint = pda([Buffer.from("share_mint"), vaultState.toBuffer()]);
  const tokenVault = pda([Buffer.from("token_vault"), vaultState.toBuffer()]);
  const userCard = pda([
    Buffer.from("user_card"),
    vaultState.toBuffer(),
    wallet.publicKey.toBuffer(),
  ]);

  const dep = await getOrCreateAssociatedTokenAccount(conn, wallet, depositMint, wallet.publicKey);
  const sh = await getOrCreateAssociatedTokenAccount(conn, wallet, shareMint, wallet.publicKey);

  // Deposit mint создан твоим кошельком, поэтому можно напечатать себе тестовые токены.
  await mintTo(conn, wallet, depositMint, dep.address, wallet, amount);

  const sig = await program.methods
    .deposit(new BN(amount))
    .accountsStrict({
      user: wallet.publicKey,
      vaultState,
      vaultAuthority,
      shareMint,
      tokenVault,
      userDepositAccount: dep.address,
      userShareAccount: sh.address,
      userCard,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const shares = (await getAccount(conn, sh.address)).amount;
  const vaultBal = (await getAccount(conn, tokenVault)).amount;
  console.log("Внесено токенов      ", amount);
  console.log("Получено share       ", shares.toString());
  console.log("Токенов в vault      ", vaultBal.toString());
  console.log("Tx deposit           ", link("tx", sig));
})();
