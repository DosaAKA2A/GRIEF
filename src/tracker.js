// Nucleo del tracker: conexion, deteccion de partida y enriquecimiento de
// jugadores. Lo consumen la consola (cli.js) y la UI (server.js) via eventos:
//   'status'    texto de estado para mostrar al usuario
//   'match'     { phase, label, rows } al entrar en partida o cambiar picks
//   'no-match'  fuera de partida
// Deteccion: websocket local del Riot Client (al instante) + sondeo de
// respaldo lento; sin websocket, sondeo cada 10 s como siempre.
import { EventEmitter } from "node:events";
import { readLockfile } from "./lockfile.js";
import { LocalApi, getRegionShard } from "./localapi.js";
import { RemoteApi } from "./remote.js";
import { RiotWs } from "./ws.js";
import { tierName, agentName, mapInfo } from "./data.js";

// Ciudad legible del GamePodID ("...eu-gp-madrid-1" -> "Madrid").
function podCiudad(pod) {
  const m = /-gp-([a-z-]+?)-\d+/.exec(pod ?? "");
  if (!m) return null;
  return m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const PHASE_LABELS = {
  core: "EN PARTIDA",
  pregame: "SELECCION DE AGENTES (solo tu equipo)",
};

// Senales de cheater/smurf/booster. Son heuristicas con falsos positivos
// (rachas, ex-altos volviendo de pausa): se presentan como "posible", nunca
// como veredicto. Requieren minimo 5 partidas para no disparar con ruido.
//
// El smurf se decide por PUNTAJE: ninguna senal sola acusa, la combinacion si.
// Umbral 5 sobre senales que suman 1-3 puntos cada una.
function alertas(r) {
  if (!r.kda || r.kda.games < 5) return [];
  const out = [];
  const { kda, hsRate, games } = r.kda;
  const hs = hsRate != null ? Math.round(hsRate * 100) : null;

  if (hs != null && (hs >= 40 || (hs >= 35 && kda >= 1.3))) {
    out.push({
      tipo: "cheater",
      texto: "Posible Cheater",
      detalle: `${hs}% de headshots con KDA ${kda.toFixed(2)} en sus ultimas ${games} competitivas`,
    });
  }

  let score = 0;
  const razones = [];
  if (r.level != null && r.level > 0) {
    if (r.level < 50) {
      score += 3;
      razones.push(`nivel ${r.level}`);
    } else if (r.level < 100) {
      score += 1;
      razones.push(`nivel ${r.level}`);
    }
  } else if (r.levelHidden) {
    score += 1;
    razones.push("nivel oculto");
  }
  if (kda >= 1.8) {
    score += 2;
    razones.push(`KDA ${kda.toFixed(2)}`);
  } else if (kda >= 1.4) {
    score += 1;
    razones.push(`KDA ${kda.toFixed(2)}`);
  }
  if (hs != null && hs >= 28 && hs < 35) {
    score += 1;
    razones.push(`HS ${hs}%`);
  }
  if (r.comp) {
    const total = r.comp.wins + r.comp.losses;
    if (total >= 6 && r.comp.wins / total >= 0.7) {
      score += 2;
      razones.push(`racha ${r.comp.wins}W-${r.comp.losses}L`);
    }
    if (r.comp.avgRrWin != null) {
      if (r.comp.avgRrWin >= 24) {
        score += 2;
        razones.push(`+${Math.round(r.comp.avgRrWin)} RR por victoria`);
      } else if (r.comp.avgRrWin >= 20) {
        score += 1;
        razones.push(`+${Math.round(r.comp.avgRrWin)} RR por victoria`);
      }
    }
  }
  if (r.seasonsPlayed != null && r.seasonsPlayed <= 2 && r.totalGames != null && r.totalGames <= 60) {
    score += 2;
    razones.push(`solo ${r.seasonsPlayed} temporada(s) y ${r.totalGames} competitivas en total`);
  }
  if (r.peak - r.tier >= 6 && kda >= 1.5) {
    score += 2;
    razones.push(`peak ${r.peakLabel} muy por encima de su rango actual`);
  }
  if (score >= 5) {
    out.push({ tipo: "smurf", texto: "Posible Smurf", detalle: razones.join(" · ") });
  }

  if (r.tier >= 18 && kda <= 0.7) {
    out.push({
      tipo: "booster",
      texto: "Posible Booster",
      detalle: `KDA ${kda.toFixed(2)} en ${r.tierLabel}: rinde muy por debajo de su rango (cuenta boosteada)`,
    });
  }
  return out;
}

const POLL_MS = 10000; // sin websocket
const POLL_BACKUP_MS = 45000; // con websocket (solo red de seguridad)
const KICK_DEBOUNCE_MS = 400; // deja que el servidor asiente antes de leer

export class Tracker extends EventEmitter {
  #wake = null;
  #kickTimer = null;
  #sig; // undefined = arranque; null = fuera de partida; string = firma de la partida

  constructor({ watch = false } = {}) {
    super();
    this.watch = watch;
  }

  async start() {
    for (;;) {
      const { api, lock, local } = await this.#connectWhenReady();
      this.api = api;
      this.local = local;
      const ws = this.watch ? await this.#openWs(lock) : null;
      try {
        await this.#loop(ws);
        return; // pasada unica completada
      } catch (err) {
        // 401/403: tokens caducados o cambio de cuenta -> re-auth completo
        const recoverable =
          err.status === 401 || err.status === 403 || err.code === "ECONNREFUSED";
        if (!this.watch || !recoverable) throw err;
        this.emit("status", "Sesion invalidada (tokens caducados o cambio de cuenta). Reconectando...");
      } finally {
        ws?.close();
      }
    }
  }

  async #connect() {
    const lock = await readLockfile();
    const local = new LocalApi(lock);
    const [tokens, clientVersion, regionShard] = await Promise.all([
      local.getEntitlements(),
      local.getClientVersion(),
      getRegionShard(),
    ]);
    this.emit("status", `Conectado. Region: ${regionShard.region} / shard: ${regionShard.shard}`);
    return { api: new RemoteApi({ ...regionShard, tokens, clientVersion }), lock, local };
  }

  // En watch: espera a que el cliente de Riot este vivo (lockfile valido y
  // puerto respondiendo). Cubre lockfile ausente, huerfano y sesion sin iniciar.
  async #connectWhenReady() {
    let waiting = false;
    for (;;) {
      try {
        return await this.#connect();
      } catch (err) {
        const recoverable =
          err.code === "ECONNREFUSED" ||
          err.code === "ENOENT" ||
          err.message.includes("lockfile") ||
          err.status === 400; // cliente vivo pero sin sesion iniciada
        if (!this.watch || !recoverable) throw err;
        if (!waiting) {
          waiting = true;
          this.emit("status", "Esperando al cliente de Riot... (abre Riot Client / VALORANT)");
        }
        await this.#sleep(5000);
      }
    }
  }

  // Suscribe al riot-messaging-service: sus mensajes ares-pregame/ares-core-game
  // avisan de cada cambio de partida sin tener que sondear.
  async #openWs(lock) {
    try {
      const ws = await RiotWs.connect(lock);
      ws.send([5, "OnJsonApiEvent_riot-messaging-service_v1_message"]);
      ws.on("message", (msg) => {
        if (!Array.isArray(msg) || msg[0] !== 8) return;
        const uri = msg[2]?.uri ?? "";
        if (uri.includes("/pregame/") || uri.includes("/core-game/")) this.#kick();
      });
      ws.on("close", () => this.#kick()); // que el bucle note el cierre y ajuste el ritmo
      this.emit("status", "Websocket local conectado: deteccion de partida al instante.");
      return ws;
    } catch {
      this.emit("status", "Websocket local no disponible; sondeo cada 10 s.");
      return null;
    }
  }

  async #loop(ws) {
    for (;;) {
      await this.#refresh();
      if (!this.watch) return;
      await this.#sleep(ws && !ws.closed ? POLL_BACKUP_MS : POLL_MS);
    }
  }

  async #refresh() {
    const match = await this.#fetchMatch();
    if (!match) {
      if (this.#sig !== null) {
        this.#sig = null;
        this.emit("no-match");
      }
      return;
    }
    // Firma de la partida: fase + jugadores + picks. Solo emitimos si cambia,
    // asi el pregame se refresca con cada pick sin repetir tablas identicas.
    const sig =
      match.phase +
      "|" +
      match.players.map((p) => `${p.Subject}:${p.CharacterID ?? ""}:${p.TeamID ?? ""}`).join(",");
    if (sig === this.#sig) return;
    const [rows, mapa] = await Promise.all([this.#enrich(match.players), mapInfo(match.mapId)]);
    const servidor = podCiudad(match.pod);
    this.#sig = sig;
    this.emit("match", { phase: match.phase, label: PHASE_LABELS[match.phase], rows, mapa, servidor });
    // El KDA de las ultimas 10 competitivas es lento (match-details pesa);
    // se rellena en segundo plano y se re-emite. Con cache, casi siempre vuela.
    this.#fillKda(rows, sig, match.phase, mapa, servidor);
  }

  async #fillKda(rows, sig, phase, mapa, servidor) {
    const api = this.api;
    const [kdas, comps] = await Promise.all([
      Promise.all(rows.map((r) => api.getKda(r.puuid).catch(() => null))),
      Promise.all(rows.map((r) => api.getRecentComp(r.puuid).catch(() => null))),
    ]);
    if (this.#sig !== sig) return; // la partida ya cambio, no pisamos nada
    rows.forEach((r, i) => {
      r.kda = kdas[i];
      r.comp = comps[i];
      r.alertas = alertas(r);
    });
    this.emit("match", { phase, label: PHASE_LABELS[phase], rows, mapa, servidor });
  }

  async #fetchMatch() {
    const core = await this.api.getCoreGame();
    if (core) return { phase: "core", players: core.Players ?? [], mapId: core.MapID, pod: core.GamePodID };
    const pre = await this.api.getPreGame();
    if (pre) {
      const players = (pre.AllyTeam?.Players ?? []).map((p) => ({
        ...p,
        TeamID: pre.AllyTeam?.TeamID,
      }));
      return { phase: "pregame", players, mapId: pre.MapID, pod: pre.GamePodID };
    }
    return null;
  }

  async #enrich(players) {
    const puuids = players.map((p) => p.Subject);
    const [names, mmrs, agents, presences] = await Promise.all([
      this.api.getNames(puuids).catch(() => new Map()),
      Promise.all(players.map((p) => this.api.getMmr(p.Subject))),
      Promise.all(players.map((p) => agentName(p.CharacterID))),
      this.local.getPresences().catch(() => new Map()),
    ]);
    const rows = players.map((p, i) => {
      const mmr = mmrs[i];
      const incognito = !!p.PlayerIdentity?.Incognito;
      const hideLevel = !!p.PlayerIdentity?.HideAccountLevel;
      const row = {
        puuid: p.Subject,
        team: p.TeamID ?? "-",
        incognito,
        name: incognito ? "(oculto)" : names.get(p.Subject) ?? p.Subject.slice(0, 8) + "...",
        agent: agents[i],
        agentId: (p.CharacterID ?? "").toLowerCase() || null,
        tier: mmr.currentTier,
        tierLabel: tierName(mmr.currentTier),
        rr: mmr.rr,
        peak: mmr.peakTier,
        peakLabel: tierName(mmr.peakTier),
        seasonsPlayed: mmr.seasonsPlayed ?? null,
        totalGames: mmr.totalGames ?? null,
        level: hideLevel ? null : p.PlayerIdentity?.AccountLevel ?? null,
        levelHidden: hideLevel,
        kda: this.api.peekKda(p.Subject), // lo cacheado ya; el resto lo trae #fillKda
        comp: this.api.peekComp(p.Subject),
        me: p.Subject === this.api.puuid,
      };
      row.alertas = alertas(row);
      return row;
    });

    // Parties: agrupa por partyId de las presencias; solo marca las de 2+
    // miembros dentro de la partida. Numeracion estable ordenando por ID.
    const porParty = new Map();
    for (const r of rows) {
      const pr = presences.get(r.puuid);
      if (pr?.partyId) {
        if (!porParty.has(pr.partyId)) porParty.set(pr.partyId, []);
        porParty.get(pr.partyId).push(r);
      }
    }
    let n = 0;
    for (const partyId of [...porParty.keys()].sort()) {
      const members = porParty.get(partyId);
      if (members.length < 2) continue;
      n++;
      for (const r of members) {
        r.party = n;
        r.partySize = members.length;
      }
    }
    return rows;
  }

  #kick() {
    clearTimeout(this.#kickTimer);
    this.#kickTimer = setTimeout(() => this.#wake?.(), KICK_DEBOUNCE_MS);
  }

  // Sueno interrumpible: un evento del websocket lo corta via #kick().
  #sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(t);
        this.#wake = null;
        resolve();
      };
    });
  }
}
