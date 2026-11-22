// Сохраняет историю транзакций позиции vault в lp-history.json (для README).
import * as fs from "fs";
import * as path from "path";
import { connection, run, setup } from "./lp";

run(async () => {
  const S = await setup();
  const sigs = (await connection.getSignaturesForAddress(S.lpPosition, { limit: 100 })).reverse();
  const out: any[] = [];
  for (const s of sigs) {
    const t = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = t?.meta?.logMessages ?? [];
    const kind = ["InitLpPosition", "OpenLpPosition", "CollectLpFees", "CloseLpPosition"].find((k) =>
      logs.some((l) => l.includes("Instruction: " + k))
    ) ?? "?";
    out.push({ kind, sig: s.signature, err: s.err ? JSON.stringify(s.err) : null, time: s.blockTime });
    console.log(kind.padEnd(16), s.err ? "ОШИБКА" : "ok");
    await new Promise((r) => setTimeout(r, 500));
  }
  fs.writeFileSync(path.join(__dirname, "../lp-history.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("Сохранено записей:", out.length);
});
