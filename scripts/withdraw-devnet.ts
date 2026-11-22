// Выводит доли из vault в devnet и печатает ссылку на транзакцию вывода.
// Запуск (DEPOSIT_MINT — адрес Deposit mint из README; SHARES — сколько долей вернуть, по умолчанию 500000):
//   DEPOSIT_MINT=<адрес> SHARES=500000 \
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=$HOME/.config/solana/id.json \
//   yarn ts-node scripts/withdraw-devnet.ts
import * as anchor from "@anchor-lang/core";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// В ESM-режиме ts-mocha `anchor.BN` бывает не конструктором: берём BN из того места, где он есть.
const a: any = anchor;
const BNCtor: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
  (x: any) => typeof x === "function"
);
const bn = (n: number) => new BNCtor(n);


const link = (kind: "address" | "tx", v: string) =>
  `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;

(async () => {
  if (!process.env.DEPOSIT_MINT) {
    throw new Error("Укажи DEPOSIT_MINT=<адрес Deposit mint из README>");
  }
  const depositMint = new PublicKey(process.env.DEPOSIT_MINT);
  const shares = Number(process.env.SHARES ?? 500_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;

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

  const dep = getAssociatedTokenAddressSync(depositMint, wallet.publicKey);
  const sh = getAssociatedTokenAddressSync(shareMint, wallet.publicKey);

  const before = {
    dep: (await getAccount(conn, dep)).amount,
    sh: (await getAccount(conn, sh)).amount,
    vault: (await getAccount(conn, tokenVault)).amount,
  };

  const sig = await program.methods
    .withdraw(bn(shares))
    .accountsStrict({
      user: wallet.publicKey,
      vaultState,
      vaultAuthority,
      shareMint,
      tokenVault,
      userDepositAccount: dep,
      userShareAccount: sh,
      userCard,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const after = {
    dep: (await getAccount(conn, dep)).amount,
    sh: (await getAccount(conn, sh)).amount,
    vault: (await getAccount(conn, tokenVault)).amount,
  };
  console.log("Сожжено долей        ", shares);
  console.log("Получено токенов     ", (after.dep - before.dep).toString());
  console.log("Долей осталось       ", after.sh.toString());
  console.log("Токенов в vault      ", after.vault.toString());
  console.log("Tx withdraw          ", link("tx", sig));
})();
