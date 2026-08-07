// Perfiles de controles de Dota 2: guardar la configuracion tal como esta
// ahora y volver a ponerla en cualquier cuenta de Steam de esta computadora.
//
// Dota guarda los controles fuera del juego, en el arbol por usuario de Steam:
//   userdata\<steamid3>\570\remote\  -> se sincroniza con Steam Cloud
//   userdata\<steamid3>\570\local\   -> solo esta maquina
// Un "perfil" aqui es una copia de esos archivos. Como no llevan nada atado a
// la cuenta, la copia de una cuenta sirve tal cual en otra.
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const APPID = "570";

// Archivos que forman un perfil, relativos a userdata\<id>\570\. Solo
// configuracion: nada de estadisticas, ultima partida ni logos de equipo, que
// cambian cada rato y no son parte de "como juego".
//
// Dota tiene dos capas de controles: los globales (valen juegues lo que
// juegues) y los de cada heroe (teclas propias para sus habilidades). Las dos
// viajan siempre juntas: un perfil es la configuracion completa, no media.
// Dentro del .lst conviven en bloques distintos —"Keys" e "Items" son los
// globales, "Units" son los de cada heroe— y por eso basta copiar el archivo.
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

// Raiz de los perfiles guardados. Fuera del repo y fuera de Steam: sobrevive a
// reinstalaciones del juego y a las actualizaciones de la app.
export const RAIZ = join(process.env.APPDATA ?? join(homedir(), ".config"), "GRIEF", "dota-perfiles");

function steamPath() {
  // El registro es la fuente fiable; la ruta clasica es solo el respaldo.
  const candidatos = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Steam") : null,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Steam") : null,
    "C:\\Program Files (x86)\\Steam",
  ].filter(Boolean);
  return candidatos.find((p) => existsSync(join(p, "userdata"))) ?? null;
}

async function steamPathRegistro() {
  try {
    const { stdout } = await ejecutar("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
    const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) {
      const ruta = m[1].trim().replace(/\//g, "\\");
      if (existsSync(join(ruta, "userdata"))) return ruta;
    }
  } catch {}
  return steamPath();
}

// Cuenta con la que Steam esta abierto ahora mismo (SteamID3). Es el dato que
// evita el error clasico: aplicar un perfil "a mi sesion" y mandarlo sin
// querer a otra cuenta. Devuelve null con Steam cerrado.
async function cuentaActiva() {
  try {
    const { stdout } = await ejecutar("reg", [
      "query",
      "HKCU\\Software\\Valve\\Steam\\ActiveProcess",
      "/v",
      "ActiveUser",
    ]);
    const m = stdout.match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const id = m ? parseInt(m[1], 16) : 0;
    return id > 0 ? String(id) : null;
  } catch {
    return null;
  }
}

// El nombre visible de la cuenta esta en su localconfig.vdf.
async function personaDe(dirUsuario) {
  try {
    const vdf = await readFile(join(dirUsuario, "config", "localconfig.vdf"), "utf8");
    const m = vdf.match(/"PersonaName"\s+"([^"]+)"/);
    if (m) return m[1];
  } catch {}
  return null;
}

// last_match.dat es KeyValues binario: el id va como uint64 LE justo despues
// de la clave "last_match_id\0". Sirve para saber con que controles se jugo.
async function ultimaPartida(appDir) {
  try {
    const buf = await readFile(join(appDir, "remote", "cfg", "last_match.dat"));
    const clave = Buffer.from("last_match_id\0", "ascii");
    const i = buf.indexOf(clave);
    if (i < 0 || i + clave.length + 8 > buf.length) return null;
    const id = buf.readBigUInt64LE(i + clave.length);
    return id > 0n ? id.toString() : null;
  } catch {
    return null;
  }
}

// Nombre del layout tal como lo llama el propio Dota (campo "Name" del .lst).
async function nombreLayout(rutaLst) {
  try {
    const texto = await readFile(rutaLst, "utf8");
    const m = texto.match(/^\s*"Name"\s+"([^"]*)"/m);
    return m ? m[1] : null;
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
  const cuentas = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const appDir = join(userdata, d.name, APPID);
    if (!existsSync(appDir)) continue;
    const lst = join(appDir, "remote", "cfg", "dotakeys_personal.lst");
    let tamano = 0;
    let tocado = null;
    try {
      const s = await stat(lst);
      tamano = s.size;
      tocado = s.mtimeMs;
    } catch {}
    cuentas.push({
      id: d.name,
      persona: await personaDe(join(userdata, d.name)),
      appDir,
      layout: await nombreLayout(lst),
      bytes: tamano,
      tocado,
      ultimaPartida: await ultimaPartida(appDir),
      capas: await capasDe(lst),
      activa: d.name === activa, // la sesion de Steam abierta ahora
    });
  }
  // Primero la cuenta con la que Steam esta abierto: es a la que casi siempre
  // se quiere aplicar. Detras, las demas por configuracion tocada mas
  // recientemente. Ordenar por fecha a secas ponia arriba la cuenta de la que
  // acabas de guardar el perfil, que es justo la que NO es el destino.
  cuentas.sort((a, b) => Number(b.activa) - Number(a.activa) || (b.tocado ?? 0) - (a.tocado ?? 0));
  return cuentas;
}

// Nombre de carpeta seguro a partir de lo que escriba el usuario.
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

export async function listarPerfiles() {
  let dirs = [];
  try {
    dirs = await readdir(RAIZ, { withFileTypes: true });
  } catch {
    return [];
  }
  const perfiles = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let meta = {};
    try {
      meta = JSON.parse(await readFile(join(RAIZ, d.name, "perfil.json"), "utf8"));
    } catch {}
    const lst = join(RAIZ, d.name, ...LST.split("/"));
    let bytes = 0;
    try {
      bytes = (await stat(lst)).size;
    } catch {}
    // Las capas se releen del propio archivo guardado: valen tambien para los
    // perfiles creados antes de que se anotaran en perfil.json.
    perfiles.push({ id: d.name, bytes, ...meta, capas: await capasDe(lst) });
  }
  perfiles.sort((a, b) => String(b.guardado ?? "").localeCompare(String(a.guardado ?? "")));
  return perfiles;
}

// ---- Lectura del .lst ----
// KeyValues de Valve, un token por linea. Se trocea en piezas de primer nivel
// solo para mirar dentro (que heroes traen teclas propias); el archivo se
// copia tal cual, nunca se reserializa.
function trocear(texto) {
  const lineas = texto.split(/\r?\n/);
  let i = 0;
  while (i < lineas.length && lineas[i].trim() !== "{") i++;
  if (i >= lineas.length) return null; // no es el formato esperado
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
    piezas.push({ clave: null, lineas: [linea] }); // vacios y lo que no encaje
    j++;
  }
  return { cabecera: lineas.slice(0, i + 1), piezas, cierre: lineas.slice(fin) };
}

// Que trae un .lst: cuantas teclas globales y que heroes tienen las suyas.
// Es lo que la UI enseña para dejar claro que un perfil lleva las dos capas.
export function capasDelLst(texto) {
  const t = trocear(texto);
  if (!t) return { globales: 0, items: 0, heroes: [] };

  const cuentaHijos = (clave, patron) => {
    const bloque = t.piezas.find((p) => p.clave === clave);
    if (!bloque) return [];
    return bloque.lineas.map((l) => l.match(patron)).filter(Boolean).map((m) => m[1]);
  };

  const heroes = cuentaHijos("Units", /^\t\t"npc_dota_(?:hero_)?([a-z0-9_]+)"\s*$/).map((n) =>
    n.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
  return {
    globales: cuentaHijos("Keys", /^\t\t"([^"]+)"\s*$/).length,
    items: cuentaHijos("Items", /^\t\t"(item_[^"]+)"\s*$/).length,
    heroes,
  };
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

// Capas de un .lst en disco; si no esta, ceros.
async function capasDe(ruta) {
  try {
    return capasDelLst(await readFile(ruta, "utf8"));
  } catch {
    return { globales: 0, items: 0, heroes: [] };
  }
}

export async function guardarPerfil({ cuenta, nombre, automatico = false }) {
  const cuentas = await listarCuentas();
  const origen = cuentas.find((c) => c.id === String(cuenta));
  if (!origen) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const base = slug(nombre);
  if (!base) throw new Error("Ponle un nombre al perfil.");

  // Nunca pisa uno existente en silencio: si el nombre esta tomado, numera.
  let id = base;
  let n = 2;
  while (existsSync(join(RAIZ, id))) {
    id = `${base}-${n++}`;
  }

  const destino = join(RAIZ, id);
  await mkdir(destino, { recursive: true });
  const archivos = await copiarLote(origen.appDir, destino);

  const meta = {
    nombre: String(nombre).trim(),
    guardado: new Date().toISOString(),
    cuenta: origen.id,
    persona: origen.persona,
    layout: origen.layout,
    ultimaPartida: origen.ultimaPartida,
    capas: origen.capas, // globales + heroes con teclas propias, para la ficha
    automatico,
    archivos,
  };
  await writeFile(join(destino, "perfil.json"), JSON.stringify(meta, null, 2), "utf8");
  return { id, ...meta, bytes: origen.bytes };
}

// Procesos que pelean por estos archivos. Dota los tiene abiertos y los
// reescribe al salir; Steam Cloud puede volver a bajar la version del servidor.
async function procesosAbiertos() {
  try {
    const { stdout } = await ejecutar("tasklist", ["/fo", "csv", "/nh"]);
    const bajo = stdout.toLowerCase();
    return {
      dota: bajo.includes('"dota2.exe"'),
      steam: bajo.includes('"steam.exe"'),
    };
  } catch {
    return { dota: false, steam: false };
  }
}

export async function estado() {
  const [cuentas, perfiles, procesos] = await Promise.all([
    listarCuentas(),
    listarPerfiles(),
    procesosAbiertos(),
  ]);
  return { cuentas, perfiles, procesos, raiz: RAIZ };
}

export async function aplicarPerfil({ perfil, cuenta }) {
  const origen = join(RAIZ, String(perfil));
  if (!existsSync(join(origen, "perfil.json"))) throw new Error("Ese perfil ya no existe.");

  const cuentas = await listarCuentas();
  const destino = cuentas.find((c) => c.id === String(cuenta));
  if (!destino) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const procesos = await procesosAbiertos();
  if (procesos.dota) {
    // Con el juego abierto no sirve de nada: Dota tiene los controles en
    // memoria y los vuelve a escribir al cerrar, borrando lo que se copie.
    throw new Error("Cierra Dota 2 antes de aplicar un perfil: al salir reescribe los controles.");
  }

  // Red de seguridad: lo que habia se guarda solo antes de pisarlo.
  let respaldo = null;
  try {
    respaldo = await guardarPerfil({
      cuenta: destino.id,
      nombre: `Antes de ${perfil}`,
      automatico: true,
    });
  } catch {}

  const archivos = await copiarLote(origen, destino.appDir);
  // Se comprueba sobre lo ya escrito: confirma que las dos capas llegaron.
  const capas = await capasDe(join(destino.appDir, ...LST.split("/")));
  return {
    archivos: archivos.length,
    capas,
    respaldo: respaldo?.id ?? null,
    steamAbierto: procesos.steam,
    destino: { id: destino.id, persona: destino.persona, activa: destino.activa },
  };
}

// Ruta de steam.exe: el propio Steam la deja en el registro al instalarse.
async function steamExe() {
  try {
    const { stdout } = await ejecutar("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamExe"]);
    const m = stdout.match(/SteamExe\s+REG_SZ\s+(.+)/i);
    if (m) {
      const ruta = m[1].trim().replace(/\//g, "\\");
      if (existsSync(ruta)) return ruta;
    }
  } catch {}
  const steam = await steamPathRegistro();
  const candidato = steam ? join(steam, "steam.exe") : null;
  return candidato && existsSync(candidato) ? candidato : null;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Reinicio limpio de Steam. Hace falta despues de aplicar un perfil: Steam
// tiene en memoria el estado de la nube de esta sesion y al salir puede subir
// —o volver a bajar— la version vieja por encima de lo que se acaba de copiar.
// `steam.exe -shutdown` es el apagado ordenado que ofrece el propio cliente:
// cierra sesion y guarda, nada de matar el proceso.
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
    // Steam tarda lo suyo en cerrar del todo (sube la nube antes de irse).
    for (let i = 0; i < 60 && !cerrado; i++) {
      await esperar(700);
      cerrado = !(await procesosAbiertos()).steam;
    }
    if (!cerrado) {
      throw new Error("Steam no terminó de cerrarse. Ciérralo a mano y vuelve a intentarlo.");
    }
    await esperar(1500); // margen para que suelte sus archivos
  }

  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  return { ok: true, cerrado };
}

export async function borrarPerfil({ perfil }) {
  const dir = join(RAIZ, String(perfil));
  if (!existsSync(join(dir, "perfil.json"))) throw new Error("Ese perfil ya no existe.");
  await rm(dir, { recursive: true, force: true });
  return { ok: true };
}
