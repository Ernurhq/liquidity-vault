// Шаг 5 (неделя 12): vault обменивает токены через наш пул Raydium (CPI из программы).
//   npm run vault-swap                          обмен A -> B на AMOUNT (по умолчанию 100000 = 0.1 токена)
//   DIRECTION=b2a npm run vault-swap            обратный обмен B -> A
//   REJECT=1 npm run vault-swap                 демонстрация slippage: требуем вдвое больше ожидаемого
import { PoolUtils } from "@raydium-io/raydium-sdk-v2";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { connection, DEPOSIT_MINT, initSdk, link, loadAddresses, owner, saveAddresses } from "./config";
import { bn, loadPool, loadProgram, MEMO_PROGRAM, TOKEN_2022_PROGRAM, vaultPdas } from "./vault";

// Предельные корни цены (X64) из программы Raydium: MIN+1 и MAX-1 используются, когда ограничения цены нет.
const MIN_SQRT_PRICE_X64 = 4295048016n;
const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;

// Достаём целое число (BN/bigint/строка из цифр) из разных форматов ответа SDK.
const raw = (x: any): any => {
  for (const c of [x?.amount?.raw, x?.raw, x?.amount, x]) {
    if (c !== undefined && c !== null && typeof c.toString === "function" && /^\d+$/.test(c.toString())) return c;
  }
  return undefined;
};

(async () => {
  const a = loadAddresses();
  if (!a.swapPool) throw new Error("Сначала привяжи пул к vault: npm run vault-init");
  const A2B = (process.env.DIRECTION ?? "a2b").toLowerCase() !== "b2a";
  const AMOUNT = BigInt(process.env.AMOUNT ?? "100000");
  const REJECT = process.env.REJECT === "1";

  const program = loadProgram();
  const p = vaultPdas(program.programId);
  const raydium = await initSdk();
  const { poolInfo, poolKeys, computePoolInfo, tickData } = await loadPool(raydium, a.poolId);

  // Обход бага SDK: у нашего пула нет расширения bitmap (exBitmapInfo), и расчёт обмена падает.
  // Расширение нужно только для цен далеко от текущей, а наша позиция рядом с ценой,
  // поэтому пустое расширение (все нули) по смыслу верно.
  if (!computePoolInfo.exBitmapInfo) {
    console.log("exBitmapInfo нет в ответе SDK, подставляем пустое расширение. Поля:", Object.keys(computePoolInfo).join(","));
    const zeros = () => Array.from({ length: 14 }, () => Array.from({ length: 8 }, () => bn(0)));
    computePoolInfo.exBitmapInfo = {
      poolId: new PublicKey(a.poolId),
      exBitmapAddress: new PublicKey(poolKeys.exBitmapAccount),
      positiveTickArrayBitmap: zeros(),
      negativeTickArrayBitmap: zeros(),
    };
  }

  const mintA = DEPOSIT_MINT.toBase58();
  const mintB: string = a.mintB;
  const inMint = A2B ? mintA : mintB;
  const outMint = A2B ? mintB : mintA;
  const outToken = poolInfo.mintA.address === outMint ? poolInfo.mintA : poolInfo.mintB;
  const zeroForOne = inMint === poolInfo.mintA.address;

  // Расчёт ожидаемой суммы и список tick-массивов для обмена (SDK Raydium считает офчейн).
  const quote = await PoolUtils.computeAmountOutFormat({
    poolInfo: computePoolInfo,
    tickArrayCache: tickData[a.poolId] ?? tickData[Object.keys(tickData)[0]],
    amountIn: bn(AMOUNT),
    tokenOut: outToken,
    tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
    slippage: 0.01, // минимум на 1% меньше ожидаемого
    epochInfo: await raydium.fetchEpochInfo(),
  });
  const expected = raw(quote.amountOut ?? quote.expectedAmountOut);
  const minOutSdk = raw(quote.minAmountOut);
  const remaining: PublicKey[] = quote.remainingAccounts;
  if (!expected || !minOutSdk || !remaining?.length) {
    console.log("Ответ SDK (ключи):", Object.keys(quote));
    throw new Error("Не удалось получить расчёт обмена из SDK: пришли мне этот вывод");
  }
  const minOut = REJECT ? bn(expected.toString()).muln(2) : bn(minOutSdk.toString());
  const sqrtLimit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;

  // Хранилища токенов внутри пула: A -> vault.A или vault.B по порядку токенов в пуле.
  const poolMintAIsOurA = poolInfo.mintA.address === mintA;
  const poolVaultOfA = new PublicKey(poolMintAIsOurA ? poolKeys.vault.A : poolKeys.vault.B);
  const poolVaultOfB = new PublicKey(poolMintAIsOurA ? poolKeys.vault.B : poolKeys.vault.A);

  const bal = async (k: PublicKey) => (await getAccount(connection, k)).amount;
  const priceNow = async () => (await raydium.clmm.getRpcClmmPoolInfo({ poolId: a.poolId })).currentPrice;
  const before = { A: await bal(p.tokenVault), B: await bal(p.tokenVaultB), price: await priceNow() };

  console.log(`Направление      ${A2B ? "A -> B" : "B -> A"}`);
  console.log("Отдаём           ", AMOUNT.toString());
  console.log("Ожидаем получить ", expected.toString(), "| минимум:", minOut.toString(), REJECT ? "(специально завышен)" : "");
  console.log("Цена пула до     ", before.price);
  console.log("tick-массивов    ", remaining.length);

  const ix = await program.methods
    .swap(A2B, bn(AMOUNT), minOut, bn(sqrtLimit))
    .accountsStrict({
      vaultState: p.vaultState,
      admin: owner.publicKey,
      vaultAuthority: p.vaultAuthority,
      swapPool: p.swapPool,
      tokenVaultA: p.tokenVault,
      tokenVaultB: p.tokenVaultB,
      mintA: DEPOSIT_MINT,
      mintB: new PublicKey(mintB),
      poolState: new PublicKey(a.poolId),
      clmmProgram: new PublicKey(poolKeys.programId),
      ammConfig: new PublicKey(poolKeys.config.id),
      poolVaultA: poolVaultOfA,
      poolVaultB: poolVaultOfB,
      observationState: new PublicKey(poolKeys.observationId),
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM,
      memoProgram: MEMO_PROGRAM,
    })
    .remainingAccounts(remaining.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
    .instruction();

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix);
  tx.feePayer = owner.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(owner);

  // skipPreflight: даже отклонённая транзакция попадёт в сеть, и у неё будет ссылка в Explorer.
  const bs58m: any = await import("bs58");
  const sig: string = (bs58m.default ?? bs58m).encode(tx.signature as Uint8Array);
  let err: any = null;
  try {
    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    err = res.value.err;
  } catch (e: any) {
    err = e?.InstructionError ? e : (e?.message ?? e);
  }
  await new Promise((r) => setTimeout(r, 4000));
  const kind = REJECT ? "swapRejectedTx" : A2B ? "swapTx" : "swapBackTx";

  if (err) {
    const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    console.log("\nТранзакция ОТКЛОНЕНА:", JSON.stringify(err));
    console.log((t?.meta?.logMessages ?? []).slice(-8).join("\n"));
    if (REJECT) saveAddresses({ [kind]: sig, swapRejectedError: JSON.stringify(err) });
    console.log("Tx", link("tx", sig));
    process.exit(REJECT ? 0 : 1); // для REJECT=1 отклонение и есть ожидаемый результат
  }

  const after = { A: await bal(p.tokenVault), B: await bal(p.tokenVaultB), price: await priceNow() };
  console.log("\nОбмен выполнен.");
  console.log("Токен A в vault  ", before.A.toString(), "->", after.A.toString());
  console.log("Токен B в vault  ", before.B.toString(), "->", after.B.toString());
  console.log("Цена пула        ", before.price, "->", after.price);
  console.log("Tx", link("tx", sig));
  if (REJECT) {
    console.log("ВНИМАНИЕ: с завышенным минимумом обмен должен был отклониться, а он прошёл: пришли мне вывод");
    process.exit(1);
  }
  if (A2B) {
    saveAddresses({
      swapTx: sig,
      swapAmountIn: AMOUNT.toString(),
      swapAmountOut: (after.B - before.B).toString(),
      priceBefore: String(before.price),
      priceAfter: String(after.price),
    });
  } else {
    saveAddresses({ swapBackTx: sig });
  }
  process.exit(0);
})().catch((e: any) => {
  console.error("ОШИБКА скрипта:", e?.message ?? "");
  console.error(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)?.slice(0, 3000));
  if (e?.logs) console.error(e.logs);
  process.exit(1);
});
