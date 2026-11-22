// Общие настройки скриптов Raydium. ТОЛЬКО devnet.
import { Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = process.env.KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");

// Приватный ключ читается из файла кошелька Solana CLI и никуда не печатается.
export const owner: Keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR, "utf8")))
);
export const connection = new Connection(RPC_URL, "confirmed");
export const txVersion = TxVersion.V0;

// Адрес Deposit mint из vault (неделя 8-10): он будет токеном A нашего пула.
export const DEPOSIT_MINT = new PublicKey("yu1GnkebxmXngwGNBXxYD4CHcxywoWChMndCXeX1GCZ");

export const link = (kind: "tx" | "address", v: string) =>
  `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;

// Адреса храним в файле, чтобы следующие скрипты (и неделя 12) их подхватывали.
const FILE = path.join(__dirname, "../addresses.json");
export const loadAddresses = (): Record<string, any> =>
  fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
export const saveAddresses = (patch: Record<string, any>) => {
  fs.writeFileSync(FILE, JSON.stringify({ ...loadAddresses(), ...patch }, null, 2) + "\n");
};

let raydium: Raydium | undefined;
export const initSdk = async () => {
  if (raydium) return raydium;
  raydium = await Raydium.load({
    owner,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "finalized",
  });
  return raydium;
};
