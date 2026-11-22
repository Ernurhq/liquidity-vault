// Шаг 1: у нас два тестовых токена.
//  - токен A = Deposit mint нашего vault (его создал наш кошелёк, мы можем печатать его себе);
//  - токен B = новый тестовый токен, создаём сейчас.
// Печатаем себе по 1 000 000 штук каждого (6 знаков после запятой).
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { connection, owner, DEPOSIT_MINT, loadAddresses, saveAddresses, link } from "./config";

const AMOUNT = 1_000_000n * 1_000_000n; // 1 000 000 токенов при 6 знаках

(async () => {
  const sol = await connection.getBalance(owner.publicKey);
  console.log("Кошелёк        ", owner.publicKey.toBase58(), "| SOL:", sol / 1e9);
  if (sol < 0.5e9) throw new Error("Мало devnet SOL (нужно хотя бы 0.5). Возьми на faucet.solana.com");

  // Токен B: создаём один раз, потом используем из addresses.json.
  let mintB = loadAddresses().mintB as string | undefined;
  if (!mintB) {
    const m = await createMint(connection, owner, owner.publicKey, null, 6);
    mintB = m.toBase58();
    saveAddresses({ mintB });
    console.log("Создан токен B ", mintB);
  } else {
    console.log("Токен B уже есть", mintB);
  }
  saveAddresses({ mintA: DEPOSIT_MINT.toBase58(), decimals: 6 });

  for (const [name, mint] of [["A", DEPOSIT_MINT.toBase58()], ["B", mintB]] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, owner, new PublicKey(mint), owner.publicKey);
    if (ata.amount < AMOUNT) {
      await mintTo(connection, owner, new PublicKey(mint), ata.address, owner, AMOUNT - ata.amount);
    }
    console.log(`Токен ${name}: ${mint}  ->  ${link("address", mint)}`);
  }
  console.log("Готово. Адреса сохранены в addresses.json");
})();
