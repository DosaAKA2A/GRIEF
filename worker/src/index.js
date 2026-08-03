// grief-tft: calcula las mejores composiciones del parche a partir de partidas
// reales de Challenger con la API oficial de Riot, y las sirve como JSON para
// la app. Ni copia tier lists ajenas ni pide nada a la app: el dato es propio.
//
// Como trabaja: por RONDAS. Cada ronda mira una tanda distinta de jugadores
// (cursor rotatorio), baja unas pocas partidas nuevas y las suma a lo que ya
// habia en KV. Asi cada ejecucion se queda muy por debajo del limite de
// subpeticiones de un Worker y del limite de peticiones de una clave de Riot,
// y la muestra crece sola. Al cambiar de parche se tira todo y se empieza de
// cero, que es justo lo que se quiere en una tier list.
//
// Rutas:
//   GET /comps    lista de comps ordenada (lo que consume GRIEF)
//   GET /estado   como va la muestra
//   GET /refresca corre una ronda ahora (cabecera X-Clave con el secreto ADMIN)
//
// Secretos: RIOT_KEY (developer.riotgames.com), ADMIN (para /refresca)
// KV: set:v1 (mapa compacto del set, lo sube tools/set.mjs), datos:v1 (muestra)

const K_DATOS = "datos:v1";
const K_SET = "set:v1";
const K_ERROR = "error:v1"; // ultimo fallo de ronda, para verlo sin mirar logs
const TOPE_PARTIDAS = 1200; // muestra maxima que se guarda por parche

const cabeceras = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=900",
};
const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: cabeceras });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/comps" || url.pathname === "/") {
      const [datos, set, fallo] = await Promise.all([
        env.COMPS.get(K_DATOS, "json"),
        env.COMPS.get(K_SET, "json"),
        env.COMPS.get(K_ERROR, "json"),
      ]);
      if (!datos?.partidas) {
        return json({
          comps: [],
          error: !env.RIOT_KEY
            ? "falta la clave de Riot"
            : fallo?.mensaje?.includes("401")
              ? "la clave de Riot no vale (caducó o es de otra cuenta)"
              : fallo?.mensaje
                ? `no se pudo calcular: ${fallo.mensaje}`
                : "todavía no hay muestra suficiente; vuelve en un rato",
        }, 503);
      }
      return json(salida(datos, set));
    }
    if (url.pathname === "/estado") {
      const [datos, set, fallo] = await Promise.all([
        env.COMPS.get(K_DATOS, "json"),
        env.COMPS.get(K_SET, "json"),
        env.COMPS.get(K_ERROR, "json"),
      ]);
      return json({
        ultimoError: fallo ?? null,
        hayClave: !!env.RIOT_KEY,
        haySet: !!set,
        set: set?.numero ?? null,
        parche: datos?.parche ?? null,
        partidas: datos?.partidas ?? 0,
        comps: Object.keys(datos?.comps ?? {}).length,
        rondas: datos?.rondas ?? 0,
        ultima: datos?.calculado ?? null,
      });
    }
    if (url.pathname === "/refresca") {
      if (!env.ADMIN || request.headers.get("X-Clave") !== env.ADMIN) return json({ error: "no autorizado" }, 401);
      try {
        const resumen = await ronda(env);
        await env.COMPS.delete(K_ERROR);
        return json(resumen);
      } catch (err) {
        const mensaje = String(err.message ?? err);
        await env.COMPS.put(K_ERROR, JSON.stringify({ at: new Date().toISOString(), mensaje }));
        return json({ error: mensaje }, 500);
      }
    }
    return json({ error: "no existe" }, 404);
  },

  async scheduled(evento, env, ctx) {
    if (!env.RIOT_KEY) return;
    ctx.waitUntil(
      ronda(env)
        .then(() => env.COMPS.delete(K_ERROR))
        .catch((err) =>
          env.COMPS.put(K_ERROR, JSON.stringify({ at: new Date().toISOString(), mensaje: String(err.message ?? err) }))
        )
    );
  },
};

// ---- Riot API ----

async function riot(env, host, ruta) {
  const res = await fetch(`https://${host}.api.riotgames.com${ruta}`, { headers: { "X-Riot-Token": env.RIOT_KEY } });
  if (!res.ok) throw new Error(`Riot ${res.status} en ${ruta.split("?")[0]}`);
  return res.json();
}

// "Version 16.15.700.1234 (Aug 01 2026...)" -> "16.15"
function parcheDe(version) {
  const m = String(version ?? "").match(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

// ---- Una ronda de muestreo ----

const vacio = () => ({ parche: null, partidas: 0, rondas: 0, cursor: 0, vistas: [], comps: {}, calculado: null });

// La comp de un tablero se identifica por sus dos rasgos activos mas fuertes
// mas su carry (la unidad con mas objetos). Es como se nombran las comps en
// cualquier tier list, solo que aqui sale de los datos y no de una opinion.
function claveDeComp(p, set) {
  const activos = (p.traits ?? [])
    .filter((t) => (t.tier_current ?? 0) > 0)
    .sort((a, b) => (b.tier_current ?? 0) - (a.tier_current ?? 0) || (b.num_units ?? 0) - (a.num_units ?? 0))
    .slice(0, 2);
  const carry = [...(p.units ?? [])].sort(
    (a, b) =>
      (b.itemNames?.length ?? 0) - (a.itemNames?.length ?? 0) ||
      (b.rarity ?? 0) - (a.rarity ?? 0) ||
      (b.tier ?? 0) - (a.tier ?? 0)
  )[0];
  const limpio = (s) => String(s ?? "").replace(/^TFT\d*_?/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  const nombreRasgo = (t) => set.rasgos?.[t.name] ?? limpio(t.name);
  const nombreUnidad = (u) => set.unidades?.[u?.character_id]?.n ?? limpio(u?.character_id);
  return {
    id: [...activos.map((t) => t.name), carry?.character_id].filter(Boolean).join("|"),
    nombre: [activos.map(nombreRasgo).join(" "), carry ? nombreUnidad(carry) : null].filter(Boolean).join(" · "),
    rasgos: activos.map((t) => ({ id: t.name, nombre: nombreRasgo(t), nivel: t.tier_current, unidades: t.num_units })),
    carry: carry ? { id: carry.character_id, nombre: nombreUnidad(carry) } : null,
  };
}

function acumula(datos, p, set) {
  const clave = claveDeComp(p, set);
  if (!clave.id) return;
  const c = (datos.comps[clave.id] ??= {
    nombre: clave.nombre, rasgos: clave.rasgos, carry: clave.carry,
    partidas: 0, suma: 0, top4: 0, primeros: 0, unidades: {}, aumentos: {},
  });
  const puesto = p.placement ?? 8;
  c.partidas++;
  c.suma += puesto;
  if (puesto <= 4) c.top4++;
  if (puesto === 1) c.primeros++;
  for (const u of p.units ?? []) {
    const e = (c.unidades[u.character_id] ??= { veces: 0, estrellas: 1, objetos: {} });
    e.veces++;
    e.estrellas = Math.max(e.estrellas, u.tier ?? 1);
    for (const it of u.itemNames ?? []) e.objetos[it] = (e.objetos[it] ?? 0) + 1;
  }
  for (const a of p.augments ?? []) c.aumentos[a] = (c.aumentos[a] ?? 0) + 1;
}

async function ronda(env) {
  const set = await env.COMPS.get(K_SET, "json");
  if (!set) throw new Error("falta el mapa del set en KV: sube set:v1 con tools/set.mjs");
  let datos = (await env.COMPS.get(K_DATOS, "json")) ?? vacio();

  const porJugador = Number(env.PARTIDAS ?? 5);
  const jugadores = Number(env.JUGADORES ?? 6);
  const tope = Number(env.PARTIDAS_RONDA ?? 30);

  const liga = await riot(env, env.PLATAFORMA, "/tft/league/v1/challenger");
  const entradas = (liga.entries ?? []).filter((e) => e.puuid).sort((a, b) => (b.leaguePoints ?? 0) - (a.leaguePoints ?? 0));
  if (!entradas.length) throw new Error("la liga de Challenger vino vacia");

  // Tanda rotatoria: cada ronda mira jugadores distintos, asi la muestra no se
  // queda pegada a los mismos diez de siempre.
  const inicio = (datos.cursor ?? 0) % entradas.length;
  const ids = [];
  for (let i = 0; i < jugadores; i++) {
    const e = entradas[(inicio + i) % entradas.length];
    try {
      ids.push(...(await riot(env, env.RUTA, `/tft/match/v1/matches/by-puuid/${e.puuid}/ids?count=${porJugador}`)));
    } catch {
      // un jugador que falle no tumba la ronda
    }
  }
  datos.cursor = inicio + jugadores;

  const vistas = new Set(datos.vistas ?? []);
  const nuevas = [...new Set(ids)].filter((id) => !vistas.has(id)).slice(0, tope);

  let sumadas = 0;
  let saltadas = 0;
  for (const id of nuevas) {
    let m;
    try {
      m = await riot(env, env.RUTA, `/tft/match/v1/matches/${id}`);
    } catch {
      continue;
    }
    const info = m.info ?? {};
    vistas.add(id);
    // Solo normal y clasificatoria de 8: fuera dobles, hiperrapido y modos raros.
    if ((info.participants ?? []).length !== 8) { saltadas++; continue; }
    if (info.queue_id != null && ![1090, 1100].includes(info.queue_id)) { saltadas++; continue; }

    const parche = parcheDe(info.game_version);
    if (parche && datos.parche && parche !== datos.parche) {
      // Parche nuevo: la muestra vieja ya no representa nada.
      datos = { ...vacio(), cursor: datos.cursor, parche };
      vistas.clear();
      vistas.add(id);
    }
    datos.parche ??= parche;

    for (const p of info.participants) acumula(datos, p, set);
    datos.partidas++;
    sumadas++;
  }

  datos.rondas = (datos.rondas ?? 0) + 1;
  datos.calculado = new Date().toISOString();
  datos.vistas = [...vistas].slice(-TOPE_PARTIDAS);
  datos.set = set.numero ?? null;
  await env.COMPS.put(K_DATOS, JSON.stringify(datos));

  return {
    ronda: datos.rondas,
    nuevas: sumadas,
    saltadas,
    partidas: datos.partidas,
    comps: Object.keys(datos.comps).length,
    parche: datos.parche,
  };
}

// ---- Lo que ve la app ----

const masVistos = (obj, n) =>
  Object.entries(obj ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);

function salida(datos, set) {
  const unidad = (id) => set?.unidades?.[id] ?? {};
  const nombreObjeto = (id) => set?.objetos?.[id] ?? String(id).replace(/^TFT\d*_?(Item_)?/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  const minimo = Math.max(4, Math.round(datos.partidas * 0.03));
  const lista = Object.entries(datos.comps ?? {})
    .filter(([, c]) => c.partidas >= minimo)
    .map(([id, c]) => ({
      id,
      nombre: c.nombre,
      rasgos: c.rasgos,
      carry: c.carry,
      partidas: c.partidas,
      puesto: c.suma / c.partidas,
      top4: c.top4 / c.partidas,
      primeros: c.primeros / c.partidas,
      unidades: Object.entries(c.unidades ?? {})
        .sort((a, b) => b[1].veces - a[1].veces)
        .slice(0, 9)
        .map(([uid, u]) => ({
          id: uid,
          nombre: unidad(uid).n ?? uid.replace(/^TFT\d*_?/, ""),
          coste: unidad(uid).c ?? 1,
          icono: unidad(uid).i ?? null,
          estrellas: u.estrellas,
          objetos: masVistos(u.objetos, 3).map(nombreObjeto),
          veces: u.veces,
        }))
        .sort((a, b) => b.coste - a.coste),
      aumentos: masVistos(c.aumentos, 3).map(nombreObjeto),
    }))
    .sort((a, b) => a.puesto - b.puesto)
    .slice(0, 24);

  // Tier por puesto medio, que es la escala real de TFT (4.5 = del monton).
  for (const c of lista) c.tier = c.puesto <= 4.0 ? "S" : c.puesto <= 4.35 ? "A" : c.puesto <= 4.6 ? "B" : "C";

  return {
    calculado: datos.calculado,
    parche: datos.parche,
    set: datos.set,
    partidas: datos.partidas,
    rondas: datos.rondas,
    comps: lista,
  };
}
