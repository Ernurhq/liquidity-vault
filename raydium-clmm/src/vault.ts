// Общий код недели 12: программа vault (из IDL), адреса PDA и чтение пула Raydium.
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { connection, DEPOSIT_MINT, owner } from "./config";

// anchor.BN в разных режимах бывает не конструктором: берём из того места, где он есть.
const a: any = anchor;
const BNCtor: any = [a.BN, a.BN?.default, a.BN?.BN, a.default?.BN].find(
  (x: any) => typeof x === "function"
);
export const bn = (x: number | string | bigint) => new BNCtor(x.toString());

export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// IDL программы vault лежит в корне проекта (создаётся командой `anchor build`).
const idlPath = path.join(__dirname, "../../target/idl/liquidity_vault.json");
export const loadProgram = (): any => {
  if (!fs.existsSync(idlPath)) throw new Error("Нет target/idl/liquidity_vault.json: сначала `anchor build` в корне проекта");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  return new anchor.Program(JSON.parse(fs.readFileSync(idlPath, "utf8")), provider);
};

export const vaultPdas = (programId: PublicKey) => {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const vaultState = pda([Buffer.from("vault"), DEPOSIT_MINT.toBuffer()]);
  return {
    vaultState,
    vaultAuthority: pda([Buffer.from("vault_authority"), vaultState.toBuffer()]),
    tokenVault: pda([Buffer.from("token_vault"), vaultState.toBuffer()]),
    swapPool: pda([Buffer.from("swap_pool"), vaultState.toBuffer()]),
    tokenVaultB: pda([Buffer.from("token_vault_b"), vaultState.toBuffer()]),
  };
};

// Чтение пула через SDK. В SDK 0.2.85-alpha бывает падение на пуле без tick-массивов
// (Object.values(undefined)): на время вызова делаем Object.values безопасным.
export const loadPool = async (raydium: any, poolId: string) => {
  const orig = Object.values;
  (Object as any).values = (o: any) => (o == null ? [] : orig(o));
  try {
    return await raydium.clmm.getPoolInfoFromRpc(poolId);
  } finally {
    (Object as any).values = orig;
  }
};
