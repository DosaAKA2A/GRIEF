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
  pregame: "SELECCIÓN DE AGENTES (solo tu equipo)",
};

// Cola -> nombre legible del modo. Sin cola conocida no se muestra nada
// (mejor ausente que un nombre inventado en customs o modos nuevos).
const MODOS = {
  competitive: "Competitivo",
  unrated: "Normal",
  deathmatch: "Deathmatch",
  hurm: "Team Deathmatch",
  ggteam: "Escalada",
  spikerush: "Spike Rush",
  swiftplay: "Swiftplay",
  onefa: "Replicación",
  premier: "Premier",
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
  const { hsRate, games } = r.kda;
  // Se juzga por K/D (bajas/muertes), no por KDA: el KDA suma asistencias y
  // en Valorant deja a casi todo el mundo por encima de 1.5, con lo que los
  // umbrales saltaban con jugadores normales.
  const kd = r.kda.kd ?? r.kda.kills / Math.max(1, r.kda.deaths);
  const hs = hsRate != null ? Math.round(hsRate * 100) : null;

  if (hs != null && (hs >= 40 || (hs >= 35 && kd >= 1.1))) {
    out.push({
      tipo: "cheater",
      texto: "Posible Cheater",
      detalle: `${hs}% de headshots con K/D ${kd.toFixed(2)} en sus últimas ${games} partidas`,
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
  if (kd >= 1.35) {
    score += 2;
    razones.push(`K/D ${kd.toFixed(2)}`);
  } else if (kd >= 1.15) {
    score += 1;
    razones.push(`K/D ${kd.toFixed(2)}`);
  }
  if (hs != null && hs >= 28 && hs < 35) {
    score += 1;
    razones.push(`HS ${hs}%`);
  }
  if (r.comp) {
    const total = r.comp.wins + r.comp.losses;
    if (total >= 6 && r.comp.wins / total >= 0.7) {
      score += 2;
      razones.push(`balance ${r.comp.wins}W-${r.comp.losses}L`);
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
    razones.push(`solo ${r.seasonsPlayed} temporada${r.seasonsPlayed === 1 ? "" : "s"} y ${r.totalGames} partidas en total`);
  }
  if (r.peak - r.tier >= 6 && kd >= 1.2) {
    score += 2;
    razones.push(`peak ${r.peakLabel} muy por encima de su rango actual`);
  }
  if (score >= 5) {
    out.push({ tipo: "smurf", texto: "Posible Smurf", detalle: razones.join(" · ") });
  }

  if (r.tier >= 18 && kd <= 0.65) {
    out.push({
      tipo: "booster",
      texto: "Posible Booster",
      detalle: `K/D ${kd.toFixed(2)} en ${r.tierLabel}: rinde muy por debajo de su rango (cuenta boosteada)`,
    });
  }
  return out;
}

// Marca las parties sobre las filas. Hay dos fuentes y no dan lo mismo:
//
//   presencia  el chat local publica el partyId REAL, pero solo de los tuyos
//              y de tus amigos. De los rivales no llega nada.
//   historial  deducida: dos jugadores que reaparecen partida tras partida
//              y siempre en el mismo equipo van juntos. Es lo unico que se
//              puede hacer con los rivales, y por eso se marca como deducida.
//              Solo se acepta con pruebas de sobra: un unico indicio suelto
//              daba falsos positivos y se descarta (decision del usuario).
//
// `pares` es lo que devuelve RemoteApi.getCoQueue (puede ser null en la
// primera pasada, cuando todavia no hay historial descargado).
export function marcarParties(rows, presences, pares = null) {
  for (const r of rows) {
    r.party = null;
    r.partySize = null;
    r.partyFuente = null;
    r.partyPartidas = 0;
  }

  const padre = new Map(rows.map((r) => [r.puuid, r.puuid]));
  const buscar = (x) => {
    while (padre.get(x) !== x) x = padre.get(x);
    return x;
  };
  const tam = (raiz) => rows.filter((r) => buscar(r.puuid) === raiz).length;
  const unir = (a, b) => {
    const ra = buscar(a);
    const rb = buscar(b);
    if (ra === rb) return false;
    if (tam(ra) + tam(rb) > 5) return false; // una party no pasa de 5
    padre.set(ra, rb);
    return true;
  };

  const enlaces = [];

  // 1) Lo seguro primero: partyId real de las presencias.
  const porParty = new Map();
  for (const r of rows) {
    const pr = presences.get(r.puuid);
    if (!pr?.partyId) continue;
    if (!porParty.has(pr.partyId)) porParty.set(pr.partyId, []);
    porParty.get(pr.partyId).push(r);
  }
  for (const miembros of porParty.values()) {
    if (miembros.length < 2) continue;
    for (let i = 1; i < miembros.length; i++) {
      unir(miembros[0].puuid, miembros[i].puuid);
      enlaces.push({ a: miembros[0].puuid, b: miembros[i].puuid, fuente: "presencia", partidas: 0 });
    }
  }

  // 2) Lo deducido. Una party nunca cruza de equipo, asi que las parejas de
  //    equipos distintos ni se miran.
  if (pares) {
    const equipo = new Map(rows.map((r) => [r.puuid, r.team]));
    const candidatos = [];
    for (const [clave, e] of pares) {
      const [a, b] = clave.split("|");
      if (!equipo.has(a) || !equipo.has(b)) continue;
      if (equipo.get(a) !== equipo.get(b)) continue;
      // Dos partidas confirmadas en el mismo equipo, o tres juntos sin
      // haberse visto nunca en bandos contrarios. Con menos no se marca:
      // coincidir una vez es de lo mas normal en la misma franja de rango.
      if (e.mismo >= 2 || (e.juntas >= 3 && e.contra === 0)) candidatos.push({ a, b, e });
    }
    // La mejor prueba primero: si el tope de 5 obliga a descartar algo, que
    // sea lo mas flojo.
    candidatos.sort((x, y) => y.e.juntas - x.e.juntas);
    for (const c of candidatos) {
      if (!unir(c.a, c.b)) continue;
      enlaces.push({ a: c.a, b: c.b, fuente: "historial", partidas: c.e.juntas });
    }
  }

  // 3) Numeracion estable (por el puuid mas bajo del grupo) y etiquetas.
  const grupos = new Map();
  for (const r of rows) {
    const raiz = buscar(r.puuid);
    if (!grupos.has(raiz)) grupos.set(raiz, []);
    grupos.get(raiz).push(r);
  }
  const conParty = [...grupos.values()].filter((g) => g.length >= 2);
  conParty.sort((g1, g2) => {
    const a = g1.map((r) => r.puuid).sort()[0];
    const b = g2.map((r) => r.puuid).sort()[0];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  conParty.forEach((grupo, i) => {
    const dentro = new Set(grupo.map((r) => r.puuid));
    const suyos = enlaces.filter((l) => dentro.has(l.a) && dentro.has(l.b));
    const deducido = suyos.some((l) => l.fuente === "historial");
    const partidas = Math.max(0, ...suyos.map((l) => l.partidas));
    for (const r of grupo) {
      r.party = i + 1;
      r.partySize = grupo.length;
      r.partyFuente = deducido ? "historial" : "presencia";
      r.partyPartidas = partidas;
    }
  });
  return rows;
}

const POLL_MS = 10000; // sin websocket
const POLL_BACKUP_MS = 45000; // con websocket (solo red de seguridad)
const KICK_DEBOUNCE_MS = 400; // deja que el servidor asiente antes de leer

export class Tracker extends EventEmitter {
  #wake = null;
  #kickTimer = null;
  #sig; // undefined = arranque; null = fuera de partida; string = firma de la partida
  #perfilAt = 0; // ultima construccion del perfil propio
  #perfilBuilding = false;

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
        // Tokens caducados, cambio de cuenta, cortes de red o respuestas
        // inesperadas de la API: en watch todo se reintenta con re-auth.
        const recoverable = err.status != null || err.code != null;
        if (!this.watch || !recoverable) throw err;
        console.error("[valorant] reconectando:", err.message);
        this.emit("status", "Reconectando con el cliente de Riot...");
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
    let intentos = 0;
    for (;;) {
      try {
        return await this.#connect();
      } catch (err) {
        // Cliente apagado (red/lockfile) o vivo pero sin sesion lista (400,
        // 404 y similares): todo se reintenta. El detalle tecnico no le sirve
        // al usuario; queda en consola por si hay que depurar.
        const recoverable =
          err.code === "ECONNREFUSED" ||
          err.code === "ENOENT" ||
          err.message.includes("lockfile") ||
          err.status != null;
        if (!this.watch || !recoverable) throw err;
        if (!waiting) {
          waiting = true;
          console.error("[valorant] esperando al cliente:", err.message);
          this.emit("status", "Esperando al cliente de Riot... (abre Riot Client / VALORANT)");
        }
        // Backoff suave: tras medio minuto sin cliente, sondeo cada 15 s.
        intentos++;
        await this.#sleep(intentos > 6 ? 15000 : 5000);
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
        // Al salir de una partida las stats cambiaron: perfil a rehacer.
        if (this.#sig !== undefined) this.#perfilAt = 0;
        this.#sig = null;
        this.emit("no-match");
      }
      if (this.watch) this.#maybePerfil();
      return;
    }
    // Firma de la partida: fase + jugadores + picks. Solo emitimos si cambia,
    // asi el pregame se refresca con cada pick sin repetir tablas identicas.
    const sig =
      match.phase +
      "|" +
      match.players.map((p) => `${p.Subject}:${p.CharacterID ?? ""}:${p.TeamID ?? ""}`).join(",");
    if (sig === this.#sig) return;
    const [enriquecido, mapa] = await Promise.all([this.#enrich(match.players), mapInfo(match.mapId)]);
    const { rows, presences } = enriquecido;
    const servidor = podCiudad(match.pod);
    const modo = MODOS[match.queue] ?? null;
    this.#sig = sig;
    this.emit("match", { phase: match.phase, label: PHASE_LABELS[match.phase], rows, mapa, servidor, modo });
    // El KDA de las ultimas 10 competitivas es lento (match-details pesa);
    // se rellena en segundo plano y se re-emite. Con cache, casi siempre vuela.
    this.#fillKda(rows, presences, sig, match.phase, mapa, servidor, modo);
  }

  async #fillKda(rows, presences, sig, phase, mapa, servidor, modo) {
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
    // Con el historial ya en cache se pueden deducir las parties de rivales y
    // aliados; hasta aqui solo estaban las que publica el chat local.
    const pares = await api.getCoQueue(rows.map((r) => r.puuid)).catch(() => null);
    if (this.#sig !== sig) return;
    marcarParties(rows, presences, pares);
    this.emit("match", { phase, label: PHASE_LABELS[phase], rows, mapa, servidor, modo });
  }

  // Perfil propio para la pantalla de reposo: rango, nivel, stats agregadas
  // y ultimas competitivas. Cache de 5 min; se invalida al terminar partida.
  #maybePerfil() {
    if (this.#perfilBuilding || Date.now() - this.#perfilAt < 5 * 60e3) return;
    this.#perfilBuilding = true;
    this.#buildPerfil()
      .then((p) => {
        this.#perfilAt = Date.now();
        if (p) this.emit("profile", p);
      })
      .catch((err) => console.error("[valorant] perfil:", err.message))
      .finally(() => {
        this.#perfilBuilding = false;
      });
  }

  async #buildPerfil() {
    const api = this.api;
    const puuid = api.puuid;
    if (!puuid) return null;
    const [names, mmr, kda, comp, nivel, ids] = await Promise.all([
      api.getNames([puuid]).catch(() => new Map()),
      api.getMmr(puuid),
      api.getKda(puuid).catch(() => null),
      api.getRecentComp(puuid).catch(() => null),
      api.getAccountLevel(puuid).catch(() => null),
      api.getHistory(puuid, 10).catch(() => []),
    ]);
    const detalles = await Promise.all(ids.map((id) => api.getMatchStats(id).catch(() => null)));
    const partidas = [];
    const porAgente = new Map();
    for (const d of detalles) {
      const yo = d?.jugadores?.[puuid];
      if (!yo) continue;
      const [mapa, agente] = await Promise.all([mapInfo(d.info?.mapId), agentName(yo.character)]);
      const disparos = yo.head + yo.body + yo.legs;
      partidas.push({
        mapa: mapa?.nombre ?? null,
        slug: mapa?.slug ?? null,
        agente,
        agentId: yo.character,
        k: yo.k,
        d: yo.d,
        a: yo.a,
        acs: yo.rounds ? Math.round(yo.score / yo.rounds) : null,
        adr: yo.rounds ? Math.round(yo.dmg / yo.rounds) : null,
        hs: disparos ? Math.round((yo.head / disparos) * 100) : null,
        won: yo.won,
        modo: MODOS[d.info?.queue] ?? null,
        inicio: d.info?.inicio ?? null,
      });
      if (yo.character) {
        const ag = porAgente.get(yo.character) ?? { agentId: yo.character, agente, games: 0, wins: 0 };
        ag.games++;
        if (yo.won) ag.wins++;
        porAgente.set(yo.character, ag);
      }
    }
    const agenteTop = [...porAgente.values()].sort((a, b) => b.games - a.games)[0] ?? null;
    return {
      name: names.get(puuid) ?? "",
      level: nivel,
      tier: mmr.currentTier,
      tierLabel: tierName(mmr.currentTier),
      rr: mmr.rr,
      peak: mmr.peakTier,
      peakLabel: tierName(mmr.peakTier),
      seasons: mmr.seasonsPlayed ?? null,
      totalGames: mmr.totalGames ?? null,
      kda,
      comp,
      partidas,
      agenteTop,
    };
  }

  async #fetchMatch() {
    const core = await this.api.getCoreGame();
    if (core)
      return {
        phase: "core",
        players: core.Players ?? [],
        mapId: core.MapID,
        pod: core.GamePodID,
        queue: core.MatchmakingData?.QueueID ?? null,
      };
    const pre = await this.api.getPreGame();
    if (pre) {
      const players = (pre.AllyTeam?.Players ?? []).map((p) => ({
        ...p,
        TeamID: pre.AllyTeam?.TeamID,
      }));
      return { phase: "pregame", players, mapId: pre.MapID, pod: pre.GamePodID, queue: pre.QueueID ?? null };
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

    // Parties: de entrada solo las seguras (presencias). Las deducidas del
    // historial llegan con el KDA, cuando ya hay partidas descargadas.
    marcarParties(rows, presences);
    return { rows, presences };
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
