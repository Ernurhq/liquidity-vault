// Создаёт на devnet тестовый токен, vault и твою карточку, печатает ссылки на Explorer.
// Запуск (после `anchor deploy --provider.cluster devnet`):
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-node scripts/init-devnet.ts
import * as anchor from "@anchor-lang/core";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const link = (kind: "address" | "tx", v: string) =>
  `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = (provider.wallet as anchor.Wallet).payer;

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../target/idl/liquidity_vault.json"), "utf8")
  );
  const program: any = new anchor.Program(idl, provider);

  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const depositMint = await createMint(provider.connection, wallet, wallet.publicKey, null, 6);
  const vaultState = pda([Buffer.from("vault"), depositMint.toBuffer()]);
  const vaultAuthority = pda([Buffer.from("vault_authority"), vaultState.toBuffer()]);
  const shareMint = pda([Buffer.from("share_mint"), vaultState.toBuffer()]);
  const tokenVault = pda([Buffer.from("token_vault"), vaultState.toBuffer()]);
  const userCard = pda([
    Buffer.from("user_card"),
    vaultState.toBuffer(),
    wallet.publicKey.toBuffer(),
  ]);

  const initSig = await program.methods
    .initializeVault()
    .accountsStrict({
      admin: wallet.publicKey,
      depositMint,
      vaultState,
      vaultAuthority,
      shareMint,
      tokenVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const cardSig = await program.methods
    .createUserCard()
    .accountsStrict({
      owner: wallet.publicKey,
      vaultState,
      userCard,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Программа      ", link("address", program.programId.toBase58()));
  console.log("Deposit mint   ", link("address", depositMint.toBase58()));
  console.log("VaultState     ", link("address", vaultState.toBase58()));
  console.log("vault_authority", link("address", vaultAuthority.toBase58()));
  console.log("Share mint     ", link("address", shareMint.toBase58()));
  console.log("Token vault    ", link("address", tokenVault.toBase58()));
  console.log("UserCard       ", link("address", userCard.toBase58()));
  console.log("Tx initialize  ", link("tx", initSig));
  console.log("Tx card        ", link("tx", cardSig));
})();
