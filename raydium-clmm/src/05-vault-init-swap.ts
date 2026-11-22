// Шаг 4 (неделя 12): привязываем пул Raydium к vault и создаём второе хранилище (токен B).
// Запускает администратор (его кошелёк ~/.config/solana/id.json).
import { DEVNET_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, initSdk, link, loadAddresses, owner, saveAddresses } from "./config";
import { loadPool, loadProgram, vaultPdas } from "./vault";

(async () => {
  const a = loadAddresses();
  if (!a.poolId || !a.mintB) throw new Error("Сначала шаги недели 11: npm run tokens / pool / position");

  const program = loadProgram();
  const p = vaultPdas(program.programId);
  const poolId = new PublicKey(a.poolId);
  const clmmProgram = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;

  if (await connection.getAccountInfo(p.swapPool)) {
    console.log("Пул уже привязан к vault:", p.swapPool.toBase58());
    saveAddresses({ vaultState: p.vaultState.toBase58(), swapPool: p.swapPool.toBase58(), tokenVaultB: p.tokenVaultB.toBase58() });
    return;
  }

  // Проверка перед отправкой: пул принадлежит программе Raydium CLMM, и раскладка данных совпадает с SDK.
  const info = await connection.getAccountInfo(poolId);
  if (!info) throw new Error("Аккаунт пула не найден в devnet");
  if (!info.owner.equals(clmmProgram)) throw new Error(`Владелец пула ${info.owner.toBase58()}, ожидали ${clmmProgram.toBase58()}`);
  const raydium = await initSdk();
  const { poolKeys } = await loadPool(raydium, a.poolId);
  const at = (off: number) => new PublicKey(info.data.subarray(off, off + 32)).toBase58();
  const checks: [string, string, string][] = [
    ["mint_0", at(73), "mintA"],
    ["mint_1", at(105), "mintB"],
    ["vault_0", at(137), "vault.A"],
    ["vault_1", at(169), "vault.B"],
    ["observation", at(201), "observationId"],
  ];
  const expected: Record<string, string> = {
    mintA: poolKeys.mintA?.address ?? poolKeys.mintA,
    mintB: poolKeys.mintB?.address ?? poolKeys.mintB,
    "vault.A": poolKeys.vault.A,
    "vault.B": poolKeys.vault.B,
    observationId: poolKeys.observationId,
  };
  for (const [name, got, key] of checks) {
    const ok = got === String(expected[key]);
    console.log(`проверка раскладки ${name.padEnd(11)} ${ok ? "OK" : "НЕ СОВПАЛО: " + got + " != " + expected[key]}`);
    if (!ok) throw new Error("Раскладка PoolState не совпала с SDK: пришли мне этот вывод, не отправляй транзакцию");
  }

  const sig = await program.methods
    .initSwapPool()
    .accountsStrict({
      vaultState: p.vaultState,
      admin: owner.publicKey,
      vaultAuthority: p.vaultAuthority,
      mintB: new PublicKey(a.mintB),
      tokenVaultB: p.tokenVaultB,
      swapPool: p.swapPool,
      poolState: poolId,
      clmmProgram,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .rpc();

  saveAddresses({
    vaultState: p.vaultState.toBase58(),
    swapPool: p.swapPool.toBase58(),
    tokenVaultB: p.tokenVaultB.toBase58(),
    initSwapPoolTx: sig,
  });
  console.log("SwapPool        ", link("address", p.swapPool.toBase58()));
  console.log("Хранилище токена B", link("address", p.tokenVaultB.toBase58()));
  console.log("Tx init_swap_pool", link("tx", sig));
  process.exit(0);
})();
