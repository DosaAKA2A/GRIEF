// Maqueta del tracker: lockfile -> auth -> partida actual -> stats de los jugadores.
// Uso:  node src/cli.js          (una pasada)
//       node src/cli.js --watch  (espera hasta detectar partida, sondea cada 10 s)
import { readLockfile } from "./lockfile.js";
import { LocalApi, getRegionShard } from "./localapi.js";
import { RemoteApi } from "./remote.js";
import { tierName, agentName } from "./data.js";

const WATCH = process.argv.includes("--watch");
const POLL_MS = 10000;

async function connect() {
  const lock = await readLockfile();
  const local = new LocalApi(lock);
  const [tokens, clientVersion, regionShard] = await Promise.all([
    local.getEntitlements(),
    local.getClientVersion(),
    getRegionShard(),
  ]);
  console.log(`Conectado. Region: ${regionShard.region} / shard: ${regionShard.shard}`);
  console.log(`PUUID propio: ${tokens.puuid}`);
  return new RemoteApi({ ...regionShard, tokens, clientVersion });
}

async function fetchMatch(api) {
  const core = await api.getCoreGame();
  if (core) return { phase: "EN PARTIDA", players: core.Players ?? [] };
  const pre = await api.getPreGame();
  if (pre) {
    const players = (pre.AllyTeam?.Players ?? []).map((p) => ({ ...p, TeamID: pre.AllyTeam?.TeamID }));
    return { phase: "SELECCION DE AGENTES (solo tu equipo)", players };
  }
  return null;
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function printMatch(api, match) {
  console.log(`\nFase: ${match.phase} — ${match.players.length} jugadores\n`);
  const puuids = match.players.map((p) => p.Subject);
  const names = await api.getNames(puuids).catch(() => new Map());

  // MMR de todos en paralelo (aqui ira la cache cuando crezca la app)
  const mmrs = await Promise.all(match.players.map((p) => api.getMmr(p.Subject)));

  console.log(
    pad("EQUIPO", 8) + pad("JUGADOR", 26) + pad("AGENTE", 14) + pad("RANGO", 16) + pad("RR", 5) + "PEAK"
  );
  console.log("-".repeat(75));
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    const mmr = mmrs[i];
    const name = p.PlayerIdentity?.Incognito
      ? "(oculto)"
      : names.get(p.Subject) ?? p.Subject.slice(0, 8) + "...";
    const me = p.Subject === api.puuid ? " *" : "";
    console.log(
      pad(p.TeamID ?? "-", 8) +
        pad(name + me, 26) +
        pad(await agentName(p.CharacterID), 14) +
        pad(tierName(mmr.currentTier), 16) +
        pad(mmr.rr, 5) +
        tierName(mmr.peakTier)
    );
  }
  console.log();
}

async function main() {
  const api = await connect();
  for (;;) {
    const match = await fetchMatch(api);
    if (match) {
      await printMatch(api, match);
      if (!WATCH) return;
      // En watch seguimos: si estabamos en pregame, al pasar a partida salen los 10
    } else {
      console.log("No estas en ninguna partida ahora mismo.");
      if (!WATCH) return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
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
