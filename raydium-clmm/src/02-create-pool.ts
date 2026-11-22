// Шаг 2: создаём CLMM-пул Raydium в devnet из токенов A и B.
import { DEVNET_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { connection, initSdk, link, loadAddresses, saveAddresses, txVersion } from "./config";

// Описание токена в том виде, который ждёт SDK (для своих токенов в devnet задаём руками).
const token = (address: string, symbol: string, decimals: number) =>
  ({
    chainId: 103,
    address,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    logoURI: "",
    symbol,
    name: symbol,
    decimals,
    tags: [],
    extensions: {},
  }) as any;

// Адрес настройки комиссии (AmmConfig) считаем сами: в devnet id из API неверный.
// Сиды в программе Raydium CLMM: "amm_config" + номер конфигурации (u16, big-endian).
const ammConfigPda = (programId: PublicKey, index: number) => {
  const idx = Buffer.alloc(2);
  idx.writeUInt16BE(index);
  return PublicKey.findProgramAddressSync([Buffer.from("amm_config"), idx], programId)[0];
};

// Адрес пула тоже PDA: сиды "pool" + AmmConfig + mint с меньшим адресом + mint с большим.
const poolPda = (programId: PublicKey, config: PublicKey, m1: PublicKey, m2: PublicKey) => {
  const [lo, hi] = Buffer.compare(m1.toBuffer(), m2.toBuffer()) < 0 ? [m1, m2] : [m2, m1];
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), config.toBuffer(), lo.toBuffer(), hi.toBuffer()],
    programId
  )[0];
};

(async () => {
  const a = loadAddresses();
  if (!a.mintA || !a.mintB) throw new Error("Сначала запусти шаг 1: npm run tokens");
  if (a.poolId) {
    console.log("Пул уже создан:", a.poolId, link("address", a.poolId));
    return;
  }

  const raydium = await initSdk();
  const programId = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
  console.log("Программа CLMM (devnet):", programId.toBase58());

  // Берём из API список уровней комиссий и выбираем тот, чей AmmConfig реально есть в devnet.
  const configs: any[] = await raydium.api.getClmmConfigs();
  let chosen: { cfg: any; id: PublicKey } | undefined;
  for (const cfg of configs) {
    const id = ammConfigPda(programId, cfg.index);
    const info = await connection.getAccountInfo(id);
    console.log(`config index=${cfg.index} tickSpacing=${cfg.tickSpacing} fee=${cfg.tradeFeeRate} on-chain=${!!info}`);
    if (info && !chosen) chosen = { cfg, id };
  }
  if (!chosen) throw new Error("В devnet не найден ни один AmmConfig: пришли мне вывод этого скрипта");
  console.log("Выбран config index =", chosen.cfg.index, "tickSpacing =", chosen.cfg.tickSpacing);

  const poolId = poolPda(programId, chosen.id, new PublicKey(a.mintA), new PublicKey(a.mintB));
  const existing = await connection.getAccountInfo(poolId);
  if (existing) {
    // Пул уже создан (например, прошлый запуск упал уже после отправки транзакции).
    const sigs = await connection.getSignaturesForAddress(poolId, { limit: 1000 });
    const first = sigs[sigs.length - 1]?.signature;
    saveAddresses({ poolId: poolId.toBase58(), poolTx: first, ammConfig: chosen.id.toBase58(), tickSpacing: chosen.cfg.tickSpacing, initialPrice: 1 });
    console.log("Пул уже существует:", poolId.toBase58());
    console.log("Адрес пула   ", link("address", poolId.toBase58()));
    if (first) console.log("Tx createPool", link("tx", first));
    process.exit(0);
  }

  const { execute } = await raydium.clmm.createPool({
    programId,
    mint1: token(a.mintA, "TKA", 6),
    mint2: token(a.mintB, "TKB", 6),
    ammConfig: { ...chosen.cfg, id: chosen.id, fundOwner: "", description: "" },
    initialPrice: new Decimal(1), // 1 токен A = 1 токен B
    txVersion,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  saveAddresses({ poolId: poolId.toBase58(), poolTx: txId, ammConfig: chosen.id.toBase58(), tickSpacing: chosen.cfg.tickSpacing, initialPrice: 1 });
  console.log("Пул создан:", poolId.toBase58());
  console.log("Адрес пула   ", link("address", poolId.toBase58()));
  console.log("Tx createPool", link("tx", txId));
  process.exit(0);
})();
