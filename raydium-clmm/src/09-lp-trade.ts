// Шаг 9 (неделя 13): обмены с КОШЕЛЬКА ТРЕЙДЕРА (не из vault), чтобы позиция vault заработала комиссии.
//   npm run lp-trade                                 6 обменов туда-обратно по AMOUNT (по умолчанию 2 токена)
//   TIMES=10 AMOUNT=3000000 npm run lp-trade         10 обменов по 3 токена
//   DIRECTION=a2b TIMES=1 AMOUNT=40000000 npm run lp-trade   одна большая сделка в одну сторону: сдвигает цену
// Трейдер: кошелёк из KEYPAIR (по умолчанию ~/.config/solana/id.json). Можно взять другой файл ключа:
//   KEYPAIR=/путь/к/другому.json npm run lp-trade   (на нём должны быть оба токена и немного SOL)
import { PoolUtils } from "@raydium-io/raydium-sdk-v2";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { bal, bn, link, MEMO_PROGRAM, owner, run, send, setup, TOKEN_2022_PROGRAM, Ctx } from "./lp";

const MIN_SQRT_PRICE_X64 = 4295048016n;
const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;
const raw = (x: any): any => x?.amount?.raw ?? x?.raw ?? x?.amount ?? x;
const SWAP_V2_DISC = Buffer.from([43, 4, 237, 11, 26, 201, 30, 98]);

const swapData = (amount: bigint, threshold: bigint, limit: bigint) => {
  const b = Buffer.alloc(41);
  SWAP_V2_DISC.copy(b, 0);
  b.writeBigUInt64LE(amount, 8);
  b.writeBigUInt64LE(threshold, 16);
  b.writeBigUInt64LE(limit & ((1n << 64n) - 1n), 24);
  b.writeBigUInt64LE(limit >> 64n, 32);
  b[40] = 1; // is_base_input = true
  return b;
};

const walletSwap = async (S: Ctx, a2b: boolean, amountIn: bigint) => {
  const { poolInfo, poolKeys, computePoolInfo, pool } = S;
  // Обход бага SDK (как в vault-swap): у нашего пула нет расширения bitmap, подставляем пустое.
  if (!computePoolInfo.exBitmapInfo) {
    const zeros = () => Array.from({ length: 14 }, () => Array.from({ length: 8 }, () => bn(0)));
    computePoolInfo.exBitmapInfo = {
      poolId: S.poolId,
      exBitmapAddress: new PublicKey(poolKeys.exBitmapAccount),
      positiveTickArrayBitmap: zeros(),
      negativeTickArrayBitmap: zeros(),
    };
  }
  const inMint = a2b ? S.mintA : S.mintB;
  const outMint = a2b ? S.mintB : S.mintA;
  const outToken = poolInfo.mintA.address === outMint.toBase58() ? poolInfo.mintA : poolInfo.mintB;
  const zeroForOne = inMint.toBase58() === poolInfo.mintA.address;

  const quote = await PoolUtils.computeAmountOutFormat({
    poolInfo: computePoolInfo,
    tickArrayCache: pool.tickData[S.a.poolId] ?? pool.tickData[Object.keys(pool.tickData)[0]],
    amountIn: bn(amountIn),
    tokenOut: outToken,
    tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
    slippage: 0.01,
    epochInfo: await S.raydium.fetchEpochInfo(),
  });
  const expected = raw(quote.amountOut ?? quote.expectedAmountOut);
  const minOut = raw(quote.minAmountOut);
  const remaining: PublicKey[] = quote.remainingAccounts;
  if (!expected || !minOut || !remaining?.length) {
    console.log("Ответ SDK (ключи):", Object.keys(quote));
    throw new Error("SDK не вернул расчёт обмена: пришли мне этот вывод");
  }

  const walletIn = getAssociatedTokenAddressSync(inMint, owner.publicKey);
  const walletOut = getAssociatedTokenAddressSync(outMint, owner.publicKey);
  if ((await bal(walletIn)) < amountIn) throw new Error(`На кошельке трейдера не хватает токена для обмена (нужно ${amountIn})`);

  const inVault = new PublicKey(zeroForOne ? poolKeys.vault.A : poolKeys.vault.B);
  const outVault = new PublicKey(zeroForOne ? poolKeys.vault.B : poolKeys.vault.A);
  const k = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isSigner, isWritable });
  const keys = [
    k(owner.publicKey, false, true),
    k(new PublicKey(poolKeys.config.id), false),
    k(S.poolId, true),
    k(walletIn, true),
    k(walletOut, true),
    k(inVault, true),
    k(outVault, true),
    k(new PublicKey(poolKeys.observationId), true),
    k(TOKEN_PROGRAM_ID, false),
    k(TOKEN_2022_PROGRAM, false),
    k(MEMO_PROGRAM, false),
    k(inMint, false),
    k(outMint, false),
    ...remaining.map((x) => k(x, true)),
  ];
  const limit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
  const ix = new TransactionInstruction({
    programId: S.clmmProgram,
    keys,
    data: swapData(amountIn, BigInt(minOut.toString()), limit),
  });
  const outBefore = await bal(walletOut);
  const sig = await send([ix], [], 600_000);
  const got = (await bal(walletOut)) - outBefore;
  return { sig, got };
};

run(async () => {
  const TIMES = Number(process.env.TIMES ?? "6");
  const AMOUNT = BigInt(process.env.AMOUNT ?? "2000000");
  const forced = process.env.DIRECTION?.toLowerCase();
  let lastOut = 0n;
  let volume = 0n; // в токене A (грубо: считаем только вход в A и выход из B как ≈ равные суммы)
  for (let i = 0; i < TIMES; i++) {
    const S = await setup(); // свежие данные пула перед каждым обменом
    const a2b = forced ? forced !== "b2a" : i % 2 === 0;
    const amount = forced || i % 2 === 0 ? AMOUNT : lastOut;
    const priceBefore = S.poolInfo.price;
    const { sig, got } = await walletSwap(S, a2b, amount);
    lastOut = got;
    volume += amount;
    const priceAfter = (await S.raydium.clmm.getRpcClmmPoolInfo({ poolId: S.a.poolId })).currentPrice;
    console.log(`#${i + 1} ${a2b ? "A->B" : "B->A"} отдали ${amount} получили ${got} | цена ${priceBefore} -> ${priceAfter}`);
    console.log("    Tx", link("tx", sig));
  }
  console.log(`\nГотово: ${TIMES} обменов, суммарный объём ≈ ${volume} (в минимальных единицах).`);
  console.log(`Комиссия пула 0.25% от объёма: ≈ ${(Number(volume) * 0.0025).toFixed(0)}; vault получает долю по размеру своей ликвидности.`);
});
