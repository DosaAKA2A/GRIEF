// Sonda de diagnostico de LoL/TFT: vuelca lo que responden el LCU y la API en
// vivo con el cliente abierto. Sirve para comprobar en una cola concreta
// (reclutamiento, ARAM, Arena, TFT...) que estamos leyendo todo lo que hay.
//   node src/loldebug.js              resumen de cada endpoint
//   node src/loldebug.js --crudo      ademas, el JSON completo
//   node src/loldebug.js /ruta/lcu    consulta una ruta suelta del LCU
//   node src/loldebug.js --rutas tft  lista TODAS las rutas del LCU que
//                                     contengan ese texto (catalogo real del
//                                     cliente, util para ver que hay de TFT)
import { readLockfile } from "./lockfile.js";
import { request, requestOk } from "./http.js";

const CRUDO = process.argv.includes("--crudo");
const RUTAS_EXTRA = process.argv.slice(2).filter((a) => a.startsWith("/"));

const RUTAS_LCU = [
  "/lol-gameflow/v1/session",
  "/lol-gameflow/v1/gameflow-phase",
  "/lol-champ-select/v1/session",
  "/lol-lobby/v2/lobby",
  "/lol-matchmaking/v1/search",
  "/lol-summoner/v1/current-summoner",
  "/lol-end-of-game/v1/eog-stats-block",
  "/lol-tft/v1/tft/status",
];

const RUTAS_VIVO = [
  "/liveclientdata/gamestats",
  "/liveclientdata/allgamedata",
  "/liveclientdata/playerlist",
  "/liveclientdata/activeplayer",
  "/liveclientdata/eventdata",
];

function resumen(body) {
  if (body == null) return "(vacio)";
  if (typeof body !== "object") return String(body).slice(0, 200);
  if (Array.isArray(body)) return `array de ${body.length}; claves: ${Object.keys(body[0] ?? {}).join(", ")}`;
  return `claves: ${Object.keys(body).join(", ")}`;
}

async function credenciales() {
  const lock = await readLockfile();
  const auth = "Basic " + Buffer.from(`riot:${lock.password}`).toString("base64");
  const sessions = await requestOk(`https://127.0.0.1:${lock.port}/product-session/v1/external-sessions`, {
    headers: { Authorization: auth },
    insecure: true,
  });
  for (const s of Object.values(sessions)) {
    if (s?.productId !== "league_of_legends") continue;
    const args = s.launchConfiguration?.arguments ?? [];
    const port = args.find((a) => a.startsWith("--app-port="))?.split("=")[1];
    const token = args.find((a) => a.startsWith("--remoting-auth-token="))?.split("=")[1];
    if (port && token) {
      return { base: `https://127.0.0.1:${port}`, auth: "Basic " + Buffer.from(`riot:${token}`).toString("base64") };
    }
  }
  return null;
}

async function mirar(url, headers) {
  const res = await request(url, { headers, insecure: true }).catch((err) => ({ status: "sin respuesta", body: err.message }));
  console.log(`\n[${res.status}] ${url.replace(/^https:\/\/127\.0\.0\.1:\d+/, "")}`);
  console.log("   " + resumen(res.body));
  if (CRUDO && res.status === 200) console.log(JSON.stringify(res.body, null, 2));
  return res;
}

const creds = await credenciales().catch((err) => {
  console.log("Sin LCU:", err.message);
  return null;
});

if (!creds) {
  console.log("El cliente de League no esta abierto (o el Riot Client no lo publica todavia).");
} else if (process.argv.includes("--rutas")) {
  // Catalogo de endpoints del propio cliente: la unica forma fiable de saber
  // que expone esta version (las rutas cambian entre parches).
  const filtro = (process.argv[process.argv.indexOf("--rutas") + 1] ?? "tft").toLowerCase();
  const headers = { Authorization: creds.auth };
  const doc =
    (await request(`${creds.base}/swagger/v3/openapi.json`, { headers, insecure: true }).catch(() => null))?.body ??
    (await request(`${creds.base}/help?format=Full`, { headers, insecure: true }).catch(() => null))?.body;
  const rutas = Object.keys(doc?.paths ?? doc ?? {}).filter((r) => r.toLowerCase().includes(filtro));
  console.log(`${rutas.length} rutas con "${filtro}":`);
  for (const r of rutas.sort()) console.log("  " + r);
} else {
  console.log("LCU en " + creds.base);
  const headers = { Authorization: creds.auth };
  for (const ruta of [...RUTAS_LCU, ...RUTAS_EXTRA]) await mirar(creds.base + ruta, headers);

  // Rango del jugador actual: ensena TODAS las colas, incluidas las de TFT.
  const yo = await request(`${creds.base}/lol-summoner/v1/current-summoner`, { headers, insecure: true }).catch(() => null);
  if (yo?.body?.puuid) {
    const r = await mirar(`${creds.base}/lol-ranked/v1/ranked-stats/${yo.body.puuid}`, headers);
    const qm = r.body?.queueMap ?? {};
    for (const [cola, e] of Object.entries(qm)) {
      if (!e) continue;
      console.log(`   ${cola}: ${e.tier ?? e.ratedTier ?? "-"} ${e.division ?? ""} ${e.leaguePoints ?? e.ratedRating ?? ""} (${e.wins ?? 0}W-${e.losses ?? 0}L)`);
    }
  }
}

for (const ruta of RUTAS_VIVO) await mirar("https://127.0.0.1:2999" + ruta);
