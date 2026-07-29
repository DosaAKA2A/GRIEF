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
import { tierName, agentName } from "./data.js";

const PHASE_LABELS = {
  core: "EN PARTIDA",
  pregame: "SELECCION DE AGENTES (solo tu equipo)",
};

// Senales de cheater/booster. Son heuristicas con falsos positivos (rachas,
// ex-altos volviendo de pausa): se presentan como "posible", nunca como
// veredicto. Requieren minimo 5 partidas para no disparar con ruido.
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
  if (r.level != null && r.level > 0 && r.level < 50 && kda >= 1.5) {
    out.push({
      tipo: "booster",
      texto: "Posible Booster",
      detalle: `cuenta nivel ${r.level} con KDA ${kda.toFixed(2)}: huele a smurf o cuenta de boosteo`,
    });
  } else if (kda >= 2 && r.tier >= 3 && r.tier <= 14) {
    out.push({
      tipo: "booster",
      texto: "Posible Booster",
      detalle: `KDA ${kda.toFixed(2)} demasiado alto para su rango (${r.tierLabel})`,
    });
  } else if (r.tier >= 18 && kda <= 0.7) {
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
      const { api, lock } = await this.#connectWhenReady();
      this.api = api;
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
    return { api: new RemoteApi({ ...regionShard, tokens, clientVersion }), lock };
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
    const rows = await this.#enrich(match.players);
    this.#sig = sig;
    this.emit("match", { phase: match.phase, label: PHASE_LABELS[match.phase], rows });
    // El KDA de las ultimas 10 competitivas es lento (match-details pesa);
    // se rellena en segundo plano y se re-emite. Con cache, casi siempre vuela.
    this.#fillKda(rows, sig, match.phase);
  }

  async #fillKda(rows, sig, phase) {
    const api = this.api;
    const kdas = await Promise.all(rows.map((r) => api.getKda(r.puuid).catch(() => null)));
    if (this.#sig !== sig) return; // la partida ya cambio, no pisamos nada
    rows.forEach((r, i) => {
      r.kda = kdas[i];
      r.alertas = alertas(r);
    });
    this.emit("match", { phase, label: PHASE_LABELS[phase], rows });
  }

  async #fetchMatch() {
    const core = await this.api.getCoreGame();
    if (core) return { phase: "core", players: core.Players ?? [] };
    const pre = await this.api.getPreGame();
    if (pre) {
      const players = (pre.AllyTeam?.Players ?? []).map((p) => ({
        ...p,
        TeamID: pre.AllyTeam?.TeamID,
      }));
      return { phase: "pregame", players };
    }
    return null;
  }

  async #enrich(players) {
    const puuids = players.map((p) => p.Subject);
    const [names, mmrs, agents] = await Promise.all([
      this.api.getNames(puuids).catch(() => new Map()),
      Promise.all(players.map((p) => this.api.getMmr(p.Subject))),
      Promise.all(players.map((p) => agentName(p.CharacterID))),
    ]);
    return players.map((p, i) => {
      const mmr = mmrs[i];
      const incognito = !!p.PlayerIdentity?.Incognito;
      const hideLevel = !!p.PlayerIdentity?.HideAccountLevel;
      const row = {
        puuid: p.Subject,
        team: p.TeamID ?? "-",
        incognito,
        name: incognito ? "(oculto)" : names.get(p.Subject) ?? p.Subject.slice(0, 8) + "...",
        agent: agents[i],
        tier: mmr.currentTier,
        tierLabel: tierName(mmr.currentTier),
        rr: mmr.rr,
        peak: mmr.peakTier,
        peakLabel: tierName(mmr.peakTier),
        level: hideLevel ? null : p.PlayerIdentity?.AccountLevel ?? null,
        levelHidden: hideLevel,
        kda: this.api.peekKda(p.Subject), // lo cacheado ya; el resto lo trae #fillKda
        me: p.Subject === this.api.puuid,
      };
      row.alertas = alertas(row);
      return row;
    });
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
