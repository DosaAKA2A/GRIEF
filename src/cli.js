// Consola del tracker: pinta lo que emite el Tracker.
// Uso:  node src/cli.js          (una pasada)
//       node src/cli.js --watch  (sigue la partida; en pregame refresca con cada pick)
import { Tracker } from "./tracker.js";

const WATCH = process.argv.includes("--watch");

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printMatch({ label, rows }) {
  console.log(`\nFase: ${label} — ${rows.length} jugadores\n`);
  console.log(
    pad("EQUIPO", 8) + pad("PARTY", 7) + pad("JUGADOR", 26) + pad("AGENTE", 14) + pad("RANGO", 16) + pad("RR", 5) + pad("KDA", 6) + pad("PEAK", 16) + "SENAL"
  );
  console.log("-".repeat(104));
  for (const r of rows) {
    console.log(
      pad(r.team, 8) +
        pad(r.party ? "P" + r.party : "", 7) +
        pad(r.name + (r.me ? " *" : ""), 26) +
        pad(r.agent, 14) +
        pad(r.tierLabel, 16) +
        pad(r.rr, 5) +
        pad(r.kda ? r.kda.kda.toFixed(2) : "-", 6) +
        pad(r.peakLabel, 16) +
        (r.alertas?.map((a) => a.texto).join(", ") || "")
    );
  }
  console.log();
}

const tracker = new Tracker({ watch: WATCH });
tracker.on("status", (s) => console.log(s));
tracker.on("match", printMatch);
tracker.on("no-match", () => console.log("No estas en ninguna partida ahora mismo."));

tracker.start().catch((err) => {
  if (err.code === "ECONNREFUSED") {
    console.error(
      "El lockfile existe pero el cliente no responde: es un lockfile huerfano.\n" +
        "Abre el cliente de Riot (y VALORANT) y vuelve a ejecutar."
    );
    process.exit(2);
  }
  console.error("Error:", err.message);
  if (err.status) console.error("Respuesta:", JSON.stringify(err.body)?.slice(0, 300));
  process.exit(1);
});
