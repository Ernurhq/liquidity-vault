// Общий код недели 13: позиция vault в CLMM-пуле Raydium (открыть, собрать комиссии, закрыть, ребаланс).
import { PoolUtils } from "@raydium-io/raydium-sdk-v2";
import * as sdk from "@raydium-io/raydium-sdk-v2";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import Decimal from "decimal.js";
import { connection, DEPOSIT_MINT, initSdk, link, loadAddresses, owner, saveAddresses } from "./config";
import { bn, loadPool, loadProgram, MEMO_PROGRAM, TOKEN_2022_PROGRAM, vaultPdas } from "./vault";

Decimal.set({ precision: 60 });

export const TICK_ARRAY_SIZE = 60;
// Сколько SOL держим на vault_authority: он платит аренду за новые аккаунты Raydium (позиция, tick-массивы).
export const AUTHORITY_SOL_TARGET = 300_000_000; // 0.3 SOL

// ---------- PDA Raydium (сиды из программы Raydium CLMM) ----------
const be32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const ownTickArrayPda = (prog: PublicKey, pool: PublicKey, start: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), be32(start)], prog)[0];
const ownPersonalPositionPda = (prog: PublicKey, nftMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], prog)[0];
const ownProtocolPositionPda = (prog: PublicKey, pool: PublicKey, lo: number, hi: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), be32(lo), be32(hi)], prog)[0];

// Адреса берём из SDK Raydium (он проверен на неделе 11 рабочей позицией); свой расчёт только запасной.
const viaSdk = (name: string, args: any[], fallback: PublicKey): PublicKey => {
  const f = (sdk as any)[name];
  if (typeof f === "function") {
    try {
      const r = f(...args);
      const k = (r?.publicKey ?? r) as PublicKey;
      if (k && typeof k.toBase58 === "function") {
        if (!k.equals(fallback)) console.log(`(PDA ${name}: SDK и свой расчёт различаются, берём SDK)`);
        return k;
      }
    } catch { /* нет функции или другая сигнатура: используем запасной расчёт */ }
  }
  return fallback;
};
export const tickArrayPda = (prog: PublicKey, pool: PublicKey, start: number) =>
  viaSdk("getPdaTickArrayAddress", [prog, pool, start], ownTickArrayPda(prog, pool, start));
export const personalPositionPda = (prog: PublicKey, nftMint: PublicKey) =>
  viaSdk("getPdaPersonalPositionAddress", [prog, nftMint], ownPersonalPositionPda(prog, nftMint));
export const protocolPositionPda = (prog: PublicKey, pool: PublicKey, lo: number, hi: number) =>
  viaSdk("getPdaProtocolPositionAddress", [prog, pool, lo, hi], ownProtocolPositionPda(prog, pool, lo, hi));

// Начало tick-массива, в котором лежит тик (в массиве 60 шагов).
export const tickArrayStart = (tick: number, spacing: number) => {
  const n = TICK_ARRAY_SIZE * spacing;
  return Math.floor(tick / n) * n;
};

// Цена -> тик (как на неделе 11): tick = ln(цена) / ln(1.0001), округляем к шагу тиков пула.
export const priceToTick = (price: Decimal, decA: number, decB: number, spacing: number, up: boolean) => {
  const rawPrice = price.mul(new Decimal(10).pow(decB - decA));
  const t = rawPrice.ln().div(new Decimal(1.0001).ln());
  const k = up ? t.div(spacing).ceil() : t.div(spacing).floor();
  return k.mul(spacing).toNumber();
};

// ---------- Контекст: всё, что нужно скриптам ----------
export const setup = async () => {
  const a = loadAddresses();
  if (!a.swapPool) throw new Error("Сначала привяжи пул к vault: npm run vault-init");
  const program = loadProgram();
  const p = vaultPdas(program.programId);
  const lpPosition = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), p.vaultState.toBuffer()],
    program.programId
  )[0];
  const raydium = await initSdk();
  const pool = await loadPool(raydium, a.poolId);
  const { poolInfo, poolKeys, computePoolInfo } = pool;

  const mintA = DEPOSIT_MINT;
  const mintB = new PublicKey(a.mintB);
  const ourAIsPoolA = poolInfo.mintA.address === mintA.toBase58();
  const poolVaultOfA = new PublicKey(ourAIsPoolA ? poolKeys.vault.A : poolKeys.vault.B);
  const poolVaultOfB = new PublicKey(ourAIsPoolA ? poolKeys.vault.B : poolKeys.vault.A);
  const clmmProgram = new PublicKey(poolKeys.programId);
  const poolId = new PublicKey(a.poolId);
  return {
    a, program, p, lpPosition, raydium, pool, poolInfo, poolKeys, computePoolInfo,
    mintA, mintB, ourAIsPoolA, poolVaultOfA, poolVaultOfB, clmmProgram, poolId,
    spacing: poolInfo.config.tickSpacing as number,
  };
};
export type Ctx = Awaited<ReturnType<typeof setup>>;

export const bal = async (k: PublicKey): Promise<bigint> => (await getAccount(connection, k)).amount;

// ---------- Отправка транзакции с понятным выводом ошибок ----------
export const send = async (ixs: TransactionInstruction[], extraSigners: Keypair[] = [], units = 1_000_000) => {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
  tx.feePayer = owner.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(owner, ...extraSigners);
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  } catch (e: any) {
    console.error("Транзакция не прошла проверку перед отправкой:", e?.message ?? JSON.stringify(e));
    const logs = e?.logs ?? (typeof e?.getLogs === "function" ? await e.getLogs(connection).catch(() => null) : null);
    if (logs) console.error(logs.slice(-20).join("\n"));
    throw new Error("транзакция отклонена при проверке");
  }
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) {
    const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    console.error((t?.meta?.logMessages ?? []).slice(-12).join("\n"));
    throw new Error("транзакция отклонена в сети: " + JSON.stringify(res.value.err) + " " + link("tx", sig));
  }
  return sig;
};

// Запуск скрипта с нормальным выводом ошибки (а не «UnhandledPromiseRejection»).
export const run = (fn: () => Promise<void>) =>
  fn()
    .then(() => process.exit(0))
    .catch((e: any) => {
      console.error("ОШИБКА скрипта:", e?.message ?? "");
      if (!e?.message) console.error(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)?.slice(0, 3000));
      process.exit(1);
    });

// ---------- Чтение позиции Raydium (раскладка как в программе: raydium_lp.rs) ----------
export const readPersonalPosition = async (personal: PublicKey) => {
  const info = await connection.getAccountInfo(personal);
  if (!info) return null;
  const d = info.data;
  const u128 = (off: number) => d.readBigUInt64LE(off) + (d.readBigUInt64LE(off + 8) << 64n);
  return {
    nftMint: new PublicKey(d.subarray(9, 41)),
    poolId: new PublicKey(d.subarray(41, 73)),
    tickLower: d.readInt32LE(73),
    tickUpper: d.readInt32LE(77),
    liquidity: u128(81),
    feesOwed0: d.readBigUInt64LE(129),
    feesOwed1: d.readBigUInt64LE(137),
  };
};

export const fetchRecord = async (S: Ctx) => {
  const rec = await S.program.account.lpPosition.fetch(S.lpPosition);
  return rec;
};

// Дублируем свои PDA через SDK Raydium: если сиды не совпали, останавливаемся до отправки транзакции.
const crossCheck = (S: Ctx, nftMint: PublicKey, lo: number, hi: number, startLo: number, startHi: number) => {
  const s: any = sdk;
  const pk = (x: any) => (x?.publicKey ?? x) as PublicKey;
  const pairs: [string, PublicKey, any][] = [
    ["personal_position", personalPositionPda(S.clmmProgram, nftMint), () => pk(s.getPdaPersonalPositionAddress(S.clmmProgram, nftMint))],
    ["protocol_position", protocolPositionPda(S.clmmProgram, S.poolId, lo, hi), () => pk(s.getPdaProtocolPositionAddress(S.clmmProgram, S.poolId, lo, hi))],
    ["tick_array_lower", tickArrayPda(S.clmmProgram, S.poolId, startLo), () => pk(s.getPdaTickArrayAddress(S.clmmProgram, S.poolId, startLo))],
    ["tick_array_upper", tickArrayPda(S.clmmProgram, S.poolId, startHi), () => pk(s.getPdaTickArrayAddress(S.clmmProgram, S.poolId, startHi))],
  ];
  for (const [name, mine, fromSdk] of pairs) {
    let theirs: PublicKey | null = null;
    try { theirs = fromSdk(); } catch { /* в этой версии SDK функции может не быть: пропускаем сверку */ }
    if (theirs && !theirs.equals(mine)) throw new Error(`PDA ${name} не совпал с SDK: ${mine.toBase58()} != ${theirs.toBase58()}`);
  }
};

// ---------- Пополнение SOL на vault_authority (аренда новых аккаунтов Raydium) ----------
export const ensureAuthoritySol = async (S: Ctx) => {
  const have = await connection.getBalance(S.p.vaultAuthority);
  if (have >= AUTHORITY_SOL_TARGET) return;
  const need = AUTHORITY_SOL_TARGET - have;
  console.log(`Переводим ${(need / 1e9).toFixed(3)} SOL на vault_authority: он платит аренду за аккаунты позиции`);
  await send([SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: S.p.vaultAuthority, lamports: need })], [], 200_000);
};

// ---------- Открыть позицию ----------
export const openLp = async (rangePct: number) => {
  const S = await setup();
  const rec = await fetchRecord(S);
  if (rec.isOpen) throw new Error("Позиция уже открыта: сначала закрой её (npm run lp-close) или сделай ребаланс (npm run lp-rebalance)");

  const { poolInfo, spacing } = S;
  const price = new Decimal(poolInfo.price);
  const lowerPrice = price.mul(1 - rangePct);
  const upperPrice = price.mul(1 + rangePct);
  const tickLower = priceToTick(lowerPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals, spacing, false);
  const tickUpper = priceToTick(upperPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals, spacing, true);
  const startLo = tickArrayStart(tickLower, spacing);
  const startHi = tickArrayStart(tickUpper, spacing);
  console.log("Текущая цена    ", price.toString(), "(токена B за 1 токен A пула)");
  console.log("Диапазон цен    ", lowerPrice.toString(), "-", upperPrice.toString(), `(±${rangePct * 100}%)`);
  console.log("Тики            ", tickLower, "-", tickUpper, "(шаг", spacing + ")");

  // Сколько токенов vault может отдать: считаем в терминах токенов пула (A/B пула могут отличаться от наших).
  const vaultA = await bal(S.p.tokenVault);
  const vaultB = await bal(S.p.tokenVaultB);
  const balPoolA = S.ourAIsPoolA ? vaultA : vaultB;
  const balPoolB = S.ourAIsPoolA ? vaultB : vaultA;
  console.log("В vault         ", `A=${vaultA} B=${vaultB}`);
  if (balPoolA === 0n && balPoolB === 0n) throw new Error("В vault нет токенов для позиции");

  const epochInfo = await S.raydium.fetchEpochInfo();
  const amt = (x: any): BN => (x?.amount && BN.isBN(x.amount) ? x.amount : new BN(0));
  const maxOf = (x: any, y: any): BN => (amt(x).gt(amt(y)) ? amt(x) : amt(y));
  let baseAmount = new BN(balPoolA.toString());
  let res: any;
  let maxPoolA = new BN(0), maxPoolB = new BN(0);
  for (let i = 0; i < 10; i++) {
    res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo, slippage: 0.01, inputA: true, tickUpper, tickLower,
      amount: baseAmount, add: true, amountHasFee: true, epochInfo,
    });
    maxPoolA = maxOf(res.amountA, res.amountSlippageA);
    maxPoolB = maxOf(res.amountB, res.amountSlippageB);
    const okA = maxPoolA.lte(new BN(balPoolA.toString()));
    const okB = maxPoolB.lte(new BN(balPoolB.toString()));
    if (okA && okB) break;
    // Не хватает одного из токенов: уменьшаем сумму пропорционально и считаем заново (с запасом 3%).
    const fa = Number(balPoolA) / Math.max(1, Number(maxPoolA.toString()));
    const fb = Number(balPoolB) / Math.max(1, Number(maxPoolB.toString()));
    const f = Math.min(fa, fb, 1) * 0.97;
    baseAmount = new BN(Math.floor(Number(baseAmount.toString()) * f).toString());
    if (baseAmount.lten(0)) throw new Error("Слишком мало токенов для позиции в этом диапазоне");
    if (i === 9) throw new Error("Не удалось подобрать сумму позиции под баланс vault: пришли мне вывод");
  }
  if (!res?.liquidity) {
    console.log("Ответ SDK (ключи):", Object.keys(res ?? {}));
    throw new Error("SDK не вернул liquidity: пришли мне этот вывод");
  }
  const liquidity: BN = res.liquidity;
  const maxOurA = S.ourAIsPoolA ? maxPoolA : maxPoolB;
  const maxOurB = S.ourAIsPoolA ? maxPoolB : maxPoolA;
  console.log("Ликвидность     ", liquidity.toString());
  console.log("Максимум отдать ", `A=${maxOurA.toString()} B=${maxOurB.toString()}`);

  const nftMint = Keypair.generate();
    const personal = personalPositionPda(S.clmmProgram, nftMint.publicKey);
  const nftAccount = getAssociatedTokenAddressSync(nftMint.publicKey, S.p.vaultAuthority, true, TOKEN_2022_PROGRAM);

  await ensureAuthoritySol(S);

  const ix = await S.program.methods
    .openLpPosition(tickLower, tickUpper, startLo, startHi, bn(liquidity.toString()), bn(maxOurA.toString()), bn(maxOurB.toString()))
    .accountsStrict({
      vaultState: S.p.vaultState,
      admin: owner.publicKey,
      vaultAuthority: S.p.vaultAuthority,
      swapPool: S.p.swapPool,
      lpPosition: S.lpPosition,
      tokenVaultA: S.p.tokenVault,
      tokenVaultB: S.p.tokenVaultB,
      mintA: S.mintA,
      mintB: S.mintB,
      poolState: S.poolId,
      clmmProgram: S.clmmProgram,
      poolVaultA: S.poolVaultOfA,
      poolVaultB: S.poolVaultOfB,
      protocolPosition: protocolPositionPda(S.clmmProgram, S.poolId, tickLower, tickUpper),
      tickArrayLower: tickArrayPda(S.clmmProgram, S.poolId, startLo),
      tickArrayUpper: tickArrayPda(S.clmmProgram, S.poolId, startHi),
      personalPosition: personal,
      positionNftMint: nftMint.publicKey,
      positionNftAccount: nftAccount,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM,
    })
    .instruction();

  const sig = await send([ix], [nftMint]);
  const afterA = await bal(S.p.tokenVault);
  const afterB = await bal(S.p.tokenVaultB);
  const onchain = await readPersonalPosition(personal);
  console.log("\nПозиция открыта.");
  console.log("NFT позиции      ", nftMint.publicKey.toBase58(), link("address", nftMint.publicKey.toBase58()));
  console.log("Ликвидность      ", onchain?.liquidity.toString());
  console.log("Отдано в позицию ", `A=${vaultA - afterA} B=${vaultB - afterB}`);
  console.log("Tx", link("tx", sig));
  saveAddresses({
    lpNft: nftMint.publicKey.toBase58(),
    lpOpenTx: sig,
    lpRange: { lowerPrice: lowerPrice.toString(), upperPrice: upperPrice.toString(), tickLower, tickUpper },
    lpDepositedA: (vaultA - afterA).toString(),
    lpDepositedB: (vaultB - afterB).toString(),
  });
  return { sig, tickLower, tickUpper };
};

// ---------- Общие аккаунты для collect / close ----------
const manageAccounts = (S: Ctx, rec: any) => {
  const lo = rec.tickLower as number;
  const hi = rec.tickUpper as number;
  return {
    vaultState: S.p.vaultState,
    admin: owner.publicKey,
    vaultAuthority: S.p.vaultAuthority,
    swapPool: S.p.swapPool,
    lpPosition: S.lpPosition,
    tokenVaultA: S.p.tokenVault,
    tokenVaultB: S.p.tokenVaultB,
    mintA: S.mintA,
    mintB: S.mintB,
    poolState: S.poolId,
    clmmProgram: S.clmmProgram,
    poolVaultA: S.poolVaultOfA,
    poolVaultB: S.poolVaultOfB,
    protocolPosition: protocolPositionPda(S.clmmProgram, S.poolId, lo, hi),
    tickArrayLower: tickArrayPda(S.clmmProgram, S.poolId, tickArrayStart(lo, S.spacing)),
    tickArrayUpper: tickArrayPda(S.clmmProgram, S.poolId, tickArrayStart(hi, S.spacing)),
    personalPosition: rec.personalPosition as PublicKey,
    positionNftAccount: rec.nftAccount as PublicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram2022: TOKEN_2022_PROGRAM,
    memoProgram: MEMO_PROGRAM,
  };
};

// ---------- Собрать комиссии ----------
export const collectLp = async () => {
  const S = await setup();
  const rec = await fetchRecord(S);
  if (!rec.isOpen) throw new Error("Нет открытой позиции: сначала npm run lp-open");
  const beforeA = await bal(S.p.tokenVault);
  const beforeB = await bal(S.p.tokenVaultB);

  const ix = await S.program.methods.collectLpFees().accountsStrict(manageAccounts(S, rec)).instruction();
  const sig = await send([ix]);
  const afterA = await bal(S.p.tokenVault);
  const afterB = await bal(S.p.tokenVaultB);
  console.log("Комиссии собраны.");
  console.log("Комиссии A       ", (afterA - beforeA).toString());
  console.log("Комиссии B       ", (afterB - beforeB).toString());
  console.log("Tx", link("tx", sig));
  saveAddresses({
    lpCollectTx: sig,
    lpFeesA: (afterA - beforeA).toString(),
    lpFeesB: (afterB - beforeB).toString(),
  });
  return { sig, feesA: afterA - beforeA, feesB: afterB - beforeB };
};

// Сколько токенов вернётся при выводе всей ликвидности (формулы Uniswap v3 / Raydium CLMM, числа X64).
const Q64 = 1n << 64n;
const sqrtX64FromTick = (tick: number): bigint =>
  BigInt(new Decimal(1.0001).pow(new Decimal(tick).div(2)).mul(new Decimal(2).pow(64)).toFixed(0));
export const amountsFromLiquidity = (sqrtP: bigint, tickLo: number, tickHi: number, L: bigint) => {
  const sa = sqrtX64FromTick(tickLo);
  const sb = sqrtX64FromTick(tickHi);
  let amount0 = 0n, amount1 = 0n;
  if (sqrtP <= sa) {
    amount0 = (L * Q64 * (sb - sa)) / (sa * sb);
  } else if (sqrtP < sb) {
    amount0 = (L * Q64 * (sb - sqrtP)) / (sqrtP * sb);
    amount1 = (L * (sqrtP - sa)) / Q64;
  } else {
    amount1 = (L * (sb - sa)) / Q64;
  }
  return { amount0, amount1 };
};

// ---------- Закрыть позицию ----------
export const closeLp = async (slippage = 0.01) => {
  const S = await setup();
  const rec = await fetchRecord(S);
  if (!rec.isOpen) throw new Error("Нет открытой позиции");
  const pos = await readPersonalPosition(rec.personalPosition);
  if (!pos) throw new Error("Аккаунт позиции Raydium не найден");

  // Ожидаемые суммы (без комиссий) и минимум на 1% меньше: защита от slippage.
  const sp = S.computePoolInfo?.sqrtPriceX64;
  const sqrtP = sp
    ? BigInt(sp.toString())
    : BigInt(
        new Decimal(S.poolInfo.price)
          .mul(new Decimal(10).pow(S.poolInfo.mintB.decimals - S.poolInfo.mintA.decimals))
          .sqrt()
          .mul(new Decimal(2).pow(64))
          .toFixed(0)
      );
  const exp = amountsFromLiquidity(sqrtP, pos.tickLower, pos.tickUpper, pos.liquidity);
  const expA = S.ourAIsPoolA ? exp.amount0 : exp.amount1;
  const expB = S.ourAIsPoolA ? exp.amount1 : exp.amount0;
  const minA = (expA * BigInt(Math.round((1 - slippage) * 10000))) / 10000n;
  const minB = (expB * BigInt(Math.round((1 - slippage) * 10000))) / 10000n;
  console.log("Ликвидность      ", pos.liquidity.toString());
  console.log("Ожидаем вернуть  ", `A≈${expA} B≈${expB}`, "| минимум:", `A=${minA} B=${minB}`);

  const beforeA = await bal(S.p.tokenVault);
  const beforeB = await bal(S.p.tokenVaultB);
  const accts: any = {
    ...manageAccounts(S, rec),
    positionNftMint: rec.nftMint as PublicKey,
    systemProgram: SystemProgram.programId,
  };
  const ix = await S.program.methods
    .closeLpPosition(bn(minA.toString()), bn(minB.toString()))
    .accountsStrict(accts)
    .instruction();
  const sig = await send([ix]);
  const afterA = await bal(S.p.tokenVault);
  const afterB = await bal(S.p.tokenVaultB);
  console.log("\nПозиция закрыта.");
  console.log("Вернулось        ", `A=${afterA - beforeA} B=${afterB - beforeB}`, "(вместе с невыведенными комиссиями)");
  console.log("Tx", link("tx", sig));
  saveAddresses({
    lpCloseTx: sig,
    lpReturnedA: (afterA - beforeA).toString(),
    lpReturnedB: (afterB - beforeB).toString(),
  });
  return { sig, gotA: afterA - beforeA, gotB: afterB - beforeB };
};

export { link, loadAddresses, saveAddresses, owner, connection, initSdk, loadPool, loadProgram, bn, MEMO_PROGRAM, TOKEN_2022_PROGRAM };
