// Perfiles de controles de Dota 2: guardas tu configuracion con un nombre y la
// aplicas a la cuenta de Steam que tengas abierta, sin copiar carpetas a mano.
//
// Dota guarda los controles fuera del juego, en el arbol por usuario de Steam:
//   userdata\<steamid3>\570\remote\  -> se sincroniza con Steam Cloud
//   userdata\<steamid3>\570\local\   -> solo esta maquina
// Nada de eso va atado a la cuenta, asi que un perfil sirve igual en otra.
//
// En disco:
//   %APPDATA%\GRIEF\dota-perfiles\perfiles\<slug>\    los que tu guardas y ves
//   %APPDATA%\GRIEF\dota-perfiles\respaldos\<cuenta>\ copias internas (Deshacer)
//   %APPDATA%\GRIEF\dota-perfiles\estado.json         que perfil hay puesto
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const APPID = "570";
const RESPALDOS_POR_CUENTA = 5; // suficiente para deshacer sin acumular basura

// Dota tiene dos capas de controles: los globales y los de cada heroe. Las dos
// viajan juntas: un perfil es la configuracion completa, no media. Dentro del
// .lst conviven en bloques distintos ("Keys" e "Items" son los globales,
// "Units" son los de cada heroe), por eso basta con copiar el archivo.
export const LST = "remote/cfg/dotakeys_personal.lst";

const ARCHIVOS = [
  LST, // globales + por heroe, en un solo archivo
  "remote/user_keys.vcfg", // global: binds hechos por consola
  "remote/user_convars.vcfg", // global: ajustes de juego
  "remote/cfg/dota_armory_filters.txt", // global
  "remote/cfg/dota_player_loadout_shuffle.txt", // global: rotacion de objetos
  "remote/scripts/item_suggest_preference.txt", // global
  "remote/scripts/lobby_settings.txt", // global
  "local/cfg/user_convars_0_slot0.vcfg", // global
  "local/cfg/user_keys_0_slot0.vcfg", // global
  "remote/scripts/control_groups.txt", // por heroe: grupos de control
  "remote/cfg/herobuilds.cfg", // por heroe: guias de objetos
  "remote/cfg/hero_facet_config.cfg", // por heroe
  "remote/cfg/saved_sets.kv", // por heroe: sets de aspecto
];

export const RAIZ = join(process.env.APPDATA ?? join(homedir(), ".config"), "GRIEF", "dota-perfiles");
const DIR_PERFILES = join(RAIZ, "perfiles");
const DIR_RESPALDOS = join(RAIZ, "respaldos");
const ESTADO = join(RAIZ, "estado.json");

// ---- Steam ----

function steamPath() {
  const candidatos = [
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Steam") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Steam") : null,
    "C:\\Program Files (x86)\\Steam",
  ].filter(Boolean);
  return candidatos.find((p) => existsSync(join(p, "userdata"))) ?? null;
}

async function valorRegistro(clave, nombre) {
  try {
    const { stdout } = await ejecutar("reg", ["query", clave, "/v", nombre]);
    const m = stdout.match(new RegExp(`${nombre}\\s+REG_\\w+\\s+(.+)`, "i"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function steamPathRegistro() {
  const v = await valorRegistro("HKCU\\Software\\Valve\\Steam", "SteamPath");
  if (v) {
    const ruta = v.replace(/\//g, "\\");
    if (existsSync(join(ruta, "userdata"))) return ruta;
  }
  return steamPath();
}

async function steamExe() {
  const v = await valorRegistro("HKCU\\Software\\Valve\\Steam", "SteamExe");
  if (v) {
    const ruta = v.replace(/\//g, "\\");
    if (existsSync(ruta)) return ruta;
  }
  const steam = await steamPathRegistro();
  const candidato = steam ? join(steam, "steam.exe") : null;
  return candidato && existsSync(candidato) ? candidato : null;
}

// Cuenta con la que Steam esta abierto ahora (SteamID3). null con Steam cerrado.
async function cuentaActiva() {
  const v = await valorRegistro("HKCU\\Software\\Valve\\Steam\\ActiveProcess", "ActiveUser");
  const id = v ? parseInt(v.replace(/^0x/i, ""), 16) : 0;
  return id > 0 ? String(id) : null;
}

async function procesosAbiertos() {
  try {
    const { stdout } = await ejecutar("tasklist", ["/fo", "csv", "/nh"]);
    const bajo = stdout.toLowerCase();
    return { dota: bajo.includes('"dota2.exe"'), steam: bajo.includes('"steam.exe"') };
  } catch {
    return { dota: false, steam: false };
  }
}

// ---- Lectura del .lst (KeyValues de Valve, un token por linea) ----

function trocear(texto) {
  const lineas = texto.split(/\r?\n/);
  let i = 0;
  while (i < lineas.length && lineas[i].trim() !== "{") i++;
  if (i >= lineas.length) return null;
  let fin = lineas.length - 1;
  while (fin > i && lineas[fin].trim() !== "}") fin--;

  const piezas = [];
  let j = i + 1;
  while (j < fin) {
    const linea = lineas[j];
    const escalar = linea.match(/^\s*"([^"]+)"\s+"(.*)"\s*$/);
    if (escalar) {
      piezas.push({ clave: escalar[1], lineas: [linea] });
      j++;
      continue;
    }
    const bloque = linea.match(/^\s*"([^"]+)"\s*$/);
    if (bloque && lineas[j + 1]?.trim() === "{") {
      const acumulado = [linea];
      let prof = 0;
      let k = j + 1;
      for (; k < fin; k++) {
        const t = lineas[k].trim();
        acumulado.push(lineas[k]);
        if (t === "{") prof++;
        else if (t === "}" && --prof === 0) break;
      }
      piezas.push({ clave: bloque[1], lineas: acumulado });
      j = k + 1;
      continue;
    }
    piezas.push({ clave: null, lineas: [linea] });
    j++;
  }
  return { cabecera: lineas.slice(0, i + 1), piezas, cierre: lineas.slice(fin) };
}

// Que trae un .lst: cuantos controles globales y que heroes tienen los suyos.
export function capasDelLst(texto) {
  const t = trocear(texto);
  if (!t) return { globales: 0, items: 0, heroes: [], heroBindings: false };

  const hijos = (clave, patron) => {
    const bloque = t.piezas.find((p) => p.clave === clave);
    if (!bloque) return [];
    return bloque.lineas.map((l) => l.match(patron)).filter(Boolean).map((m) => m[1]);
  };
  const escalar = (clave) => t.piezas.find((p) => p.clave === clave)?.lineas[0]?.match(/"([^"]*)"\s*$/)?.[1];

  return {
    globales: hijos("Keys", /^\t\t"([^"]+)"\s*$/).length,
    items: hijos("Items", /^\t\t"(item_[^"]+)"\s*$/).length,
    heroes: hijos("Units", /^\t\t"npc_dota_(?:hero_)?([a-z0-9_]+)"\s*$/).map((n) =>
      n.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    ),
    heroBindings: escalar("UseHeroBindings") === "1",
  };
}

// Enciende "UseHeroBindings". Sin esto Dota ignora las teclas por heroe y usa
// el layout global, aunque el bloque "Units" este lleno: es el interruptor
// maestro de la pestaña HEROES. Se toca esa linea y nada mas.
export function encenderHeroBindings(texto) {
  if (/^\t"UseHeroBindings"\s+"1"\s*$/m.test(texto)) return texto;
  if (/^\t"UseHeroBindings"\s+"\d*"\s*$/m.test(texto)) {
    return texto.replace(/^\t"UseHeroBindings"\s+"\d*"\s*$/m, '\t"UseHeroBindings"\t\t"1"');
  }
  // No estaba: se agrega justo despues del nombre del layout.
  return texto.replace(/^(\t"Name"\s+"[^"]*"\s*)$/m, '$1\r\n\t"UseHeroBindings"\t\t"1"');
}

// ---- Almacen ----

async function leerEstado() {
  try {
    return JSON.parse(await readFile(ESTADO, "utf8"));
  } catch {
    return { aplicado: {} };
  }
}

async function guardarEstado(estado) {
  await mkdir(RAIZ, { recursive: true });
  await writeFile(ESTADO, JSON.stringify(estado, null, 2), "utf8");
}

// Los perfiles vivian sueltos en la raiz, mezclados con los respaldos
// automaticos (los "Antes de ..."), que ensuciaban la lista. Se reordena una
// vez: los tuyos a perfiles\, los automaticos fuera.
async function migrar() {
  if (!existsSync(RAIZ)) return;
  let dirs = [];
  try {
    dirs = await readdir(RAIZ, { withFileTypes: true });
  } catch {
    return;
  }
  await mkdir(DIR_PERFILES, { recursive: true });
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === "perfiles" || d.name === "respaldos") continue;
    const viejo = join(RAIZ, d.name);
    if (!existsSync(join(viejo, "perfil.json"))) continue;
    let meta = {};
    try {
      meta = JSON.parse(await readFile(join(viejo, "perfil.json"), "utf8"));
    } catch {}
    if (meta.automatico) {
      await rm(viejo, { recursive: true, force: true });
    } else if (!existsSync(join(DIR_PERFILES, d.name))) {
      await rename(viejo, join(DIR_PERFILES, d.name));
    }
  }
}

function slug(nombre) {
  const limpio = String(nombre ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return limpio || null;
}

async function copiarLote(origenBase, destinoBase) {
  const copiados = [];
  for (const ruta of ARCHIVOS) {
    const origen = join(origenBase, ...ruta.split("/"));
    if (!existsSync(origen)) continue;
    const destino = join(destinoBase, ...ruta.split("/"));
    await mkdir(dirname(destino), { recursive: true });
    await copyFile(origen, destino);
    copiados.push(ruta);
  }
  return copiados;
}

async function capasDe(ruta) {
  try {
    return capasDelLst(await readFile(ruta, "utf8"));
  } catch {
    return { globales: 0, items: 0, heroes: [], heroBindings: false };
  }
}

// ---- Cuentas ----

// Steam guarda la foto de cada cuenta en config\avatarcache\<steamid64>.png,
// pero las carpetas de userdata van por steamid3 (el "accountid"). El salto
// entre los dos es una suma fija; con BigInt porque no cabe en un Number.
const BASE_STEAMID64 = 76561197960265728n;

function steamId64(id) {
  try {
    return String(BigInt(id) + BASE_STEAMID64);
  } catch {
    return null;
  }
}

async function avatarDeCuenta(id) {
  const steam = await steamPathRegistro();
  const id64 = steamId64(id);
  if (!steam || !id64) return null;
  const ruta = join(steam, "config", "avatarcache", `${id64}.png`);
  return existsSync(ruta) ? ruta : null;
}

// La foto de un preset se guarda DENTRO del preset: si luego cambias el avatar
// de esa cuenta de Steam, o quitas la cuenta de esta maquina, el preset sigue
// enseñando la foto con la que se guardo.
export async function avatarRuta({ tipo, id }) {
  if (tipo === "cuenta") return avatarDeCuenta(id);
  if (tipo === "perfil") {
    const ruta = join(DIR_PERFILES, String(id), "avatar.png");
    if (existsSync(ruta)) return ruta;
    // Presets guardados antes de que existieran las fotos: se cae a la de la
    // cuenta de origen, si esa cuenta sigue en esta maquina.
    return avatarDeCuenta(await cuentaDePerfil(id));
  }
  return null;
}

async function cuentaDePerfil(id) {
  try {
    const meta = JSON.parse(await readFile(join(DIR_PERFILES, String(id), "perfil.json"), "utf8"));
    return meta?.cuenta ?? null;
  } catch {
    return null;
  }
}

async function personaDe(dirUsuario) {
  try {
    const vdf = await readFile(join(dirUsuario, "config", "localconfig.vdf"), "utf8");
    return vdf.match(/"PersonaName"\s+"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function listarCuentas() {
  const steam = await steamPathRegistro();
  if (!steam) return [];
  const userdata = join(steam, "userdata");
  let dirs = [];
  try {
    dirs = await readdir(userdata, { withFileTypes: true });
  } catch {
    return [];
  }
  const activa = await cuentaActiva();
  const estado = await leerEstado();
  const cuentas = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const appDir = join(userdata, d.name, APPID);
    if (!existsSync(appDir)) continue;
    const lst = join(appDir, ...LST.split("/"));
    let tocado = null;
    try {
      tocado = (await stat(lst)).mtimeMs;
    } catch {}
    cuentas.push({
      id: d.name,
      persona: await personaDe(join(userdata, d.name)),
      avatar: !!(await avatarDeCuenta(d.name)),
      appDir,
      tocado,
      capas: await capasDe(lst),
      activa: d.name === activa,
      aplicado: estado.aplicado?.[d.name] ?? null,
      puedeDeshacer: existsSync(join(DIR_RESPALDOS, d.name)),
    });
  }
  // La sesion de Steam abierta va primera: es a la que casi siempre se aplica.
  cuentas.sort((a, b) => Number(b.activa) - Number(a.activa) || (b.tocado ?? 0) - (a.tocado ?? 0));
  return cuentas;
}

// ---- Perfiles ----

export async function listarPerfiles() {
  await migrar();
  let dirs = [];
  try {
    dirs = await readdir(DIR_PERFILES, { withFileTypes: true });
  } catch {
    return [];
  }
  const perfiles = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let meta = null;
    try {
      meta = JSON.parse(await readFile(join(DIR_PERFILES, d.name, "perfil.json"), "utf8"));
    } catch {}
    if (!meta?.nombre) continue; // carpeta suelta: no es un preset
    perfiles.push({
      id: d.name,
      ...meta,
      avatar: !!(await avatarRuta({ tipo: "perfil", id: d.name })),
      capas: await capasDe(join(DIR_PERFILES, d.name, ...LST.split("/"))),
    });
  }
  perfiles.sort((a, b) => String(b.guardado ?? "").localeCompare(String(a.guardado ?? "")));
  return perfiles;
}

export async function guardarPerfil({ cuenta, nombre }) {
  const cuentas = await listarCuentas();
  const origen = cuentas.find((c) => c.id === String(cuenta));
  if (!origen) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const base = slug(nombre);
  if (!base) throw new Error("Ponle un nombre al perfil.");

  let id = base;
  let n = 2;
  while (existsSync(join(DIR_PERFILES, id))) id = `${base}-${n++}`;

  const destino = join(DIR_PERFILES, id);
  await mkdir(destino, { recursive: true });
  const archivos = await copiarLote(origen.appDir, destino);
  // La foto de la cuenta de origen se copia al preset: es lo que lo hace
  // reconocible de un vistazo en la lista.
  const avatar = await avatarDeCuenta(origen.id);
  if (avatar) await copyFile(avatar, join(destino, "avatar.png")).catch(() => {});
  const meta = {
    nombre: String(nombre).trim(),
    guardado: new Date().toISOString(),
    cuenta: origen.id,
    persona: origen.persona,
    archivos,
  };
  await writeFile(join(destino, "perfil.json"), JSON.stringify(meta, null, 2), "utf8");
  return { id, ...meta, capas: origen.capas };
}

export async function borrarPerfil({ perfil }) {
  const dir = join(DIR_PERFILES, String(perfil));
  if (!existsSync(join(dir, "perfil.json"))) throw new Error("Ese perfil ya no existe.");
  await rm(dir, { recursive: true, force: true });
  const estado = await leerEstado();
  for (const [cuenta, id] of Object.entries(estado.aplicado ?? {})) {
    if (id === String(perfil)) delete estado.aplicado[cuenta];
  }
  await guardarEstado(estado);
  return { ok: true };
}

// ---- Respaldo interno (lo que usa Deshacer; no se muestra como perfil) ----

async function respaldar(cuenta) {
  const dir = join(DIR_RESPALDOS, cuenta.id, String(cuenta.tocado ?? 0).padStart(16, "0"));
  await mkdir(dir, { recursive: true });
  await copiarLote(cuenta.appDir, dir);
  // Solo se guardan los ultimos: esto es para deshacer, no un historial.
  const padre = join(DIR_RESPALDOS, cuenta.id);
  const todos = (await readdir(padre)).sort();
  for (const viejo of todos.slice(0, Math.max(0, todos.length - RESPALDOS_POR_CUENTA))) {
    await rm(join(padre, viejo), { recursive: true, force: true });
  }
  return dir;
}

async function ultimoRespaldo(cuentaId) {
  const padre = join(DIR_RESPALDOS, cuentaId);
  try {
    const todos = (await readdir(padre)).sort();
    return todos.length ? join(padre, todos[todos.length - 1]) : null;
  } catch {
    return null;
  }
}

// ---- Acciones ----

export async function estado() {
  const [cuentas, perfiles, procesos] = await Promise.all([
    listarCuentas(),
    listarPerfiles(),
    procesosAbiertos(),
  ]);
  return { cuentas, perfiles, procesos, raiz: RAIZ };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Reinicio limpio de Steam: `steam.exe -shutdown` es el apagado ordenado del
// propio cliente (cierra sesion y sube la nube), nada de matar el proceso.
export async function reiniciarSteam() {
  const procesos = await procesosAbiertos();
  if (procesos.dota) {
    throw new Error("Cierra Dota 2 antes: apagar Steam con el juego abierto lo corta de golpe.");
  }
  const exe = await steamExe();
  if (!exe) throw new Error("No encuentro steam.exe en esta computadora.");

  let cerrado = false;
  if (procesos.steam) {
    await ejecutar(exe, ["-shutdown"]);
    for (let i = 0; i < 60 && !cerrado; i++) {
      await esperar(700);
      cerrado = !(await procesosAbiertos()).steam;
    }
    if (!cerrado) throw new Error("Steam no terminó de cerrarse. Ciérralo a mano y reintenta.");
    await esperar(1500); // margen para que suelte sus archivos
  }
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  return { ok: true, cerrado };
}

// Escribe el perfil en la cuenta y deja las teclas por heroe encendidas.
async function volcar(origenDir, cuenta) {
  const archivos = await copiarLote(origenDir, cuenta.appDir);
  const lst = join(cuenta.appDir, ...LST.split("/"));
  let capas = await capasDe(lst);
  if (capas.heroes.length && !capas.heroBindings) {
    await writeFile(lst, encenderHeroBindings(await readFile(lst, "utf8")), "utf8");
    capas = await capasDe(lst);
  }
  return { archivos: archivos.length, capas };
}

// Aplicar es un solo paso de cara al usuario: respalda, escribe, reinicia
// Steam y vuelve a escribir. Lo ultimo es lo que hace que el perfil siga
// puesto despues del reinicio, pase lo que pase con la nube.
export async function aplicarPerfil({ perfil, cuenta }) {
  const origenDir = join(DIR_PERFILES, String(perfil));
  if (!existsSync(join(origenDir, "perfil.json"))) throw new Error("Ese perfil ya no existe.");

  const cuentas = await listarCuentas();
  const destino = cuentas.find((c) => c.id === String(cuenta));
  if (!destino) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const procesos = await procesosAbiertos();
  if (procesos.dota) {
    throw new Error("Cierra Dota 2 antes de aplicar: al salir reescribe los controles.");
  }

  await respaldar(destino);
  let resultado = await volcar(origenDir, destino);

  let reiniciado = false;
  if (procesos.steam) {
    await reiniciarSteam();
    resultado = await volcar(origenDir, destino); // que sobreviva al reinicio
    reiniciado = true;
  }

  const estadoApp = await leerEstado();
  estadoApp.aplicado = { ...estadoApp.aplicado, [destino.id]: String(perfil) };
  await guardarEstado(estadoApp);

  return {
    ...resultado,
    reiniciado,
    destino: { id: destino.id, persona: destino.persona },
  };
}

// Deshacer: devuelve la cuenta al estado justo anterior al ultimo cambio.
export async function deshacer({ cuenta }) {
  const cuentas = await listarCuentas();
  const destino = cuentas.find((c) => c.id === String(cuenta));
  if (!destino) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const respaldo = await ultimoRespaldo(destino.id);
  if (!respaldo) throw new Error("No hay nada que deshacer en esta cuenta.");

  const procesos = await procesosAbiertos();
  if (procesos.dota) {
    throw new Error("Cierra Dota 2 antes de deshacer: al salir reescribe los controles.");
  }

  const archivos = await copiarLote(respaldo, destino.appDir);
  await rm(respaldo, { recursive: true, force: true }); // un paso atras por vez

  if (procesos.steam) await reiniciarSteam();

  const estadoApp = await leerEstado();
  delete estadoApp.aplicado?.[destino.id];
  await guardarEstado(estadoApp);

  return {
    archivos: archivos.length,
    capas: await capasDe(join(destino.appDir, ...LST.split("/"))),
    destino: { id: destino.id, persona: destino.persona },
  };
}
