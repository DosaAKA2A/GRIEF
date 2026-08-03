// Genera el mapa compacto del set activo (nombres, costes e iconos) y lo sube
// a KV como set:v1. El JSON de Community Dragon pesa 26 MB: bajarlo desde el
// worker en cada ronda es inviable, asi que se destila aqui una vez por set.
//
//   node tools/set.mjs           genera worker/set.json
//   node tools/set.mjs --subir   ademas lo sube a KV con wrangler
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const FUENTE = "https://raw.communitydragon.org/latest/cdragon/tft/es_mx.json";
const SALIDA = new URL("../set.json", import.meta.url);

const icono = (ruta) =>
  ruta
    ? "https://raw.communitydragon.org/latest/game/" +
      String(ruta).toLowerCase().replace(/\.(tex|dds)$/, ".png").replace(/^\/+/, "")
    : null;

console.log("bajando Community Dragon (26 MB)...");
const data = await fetch(FUENTE).then((r) => r.json());

// Set activo: el de numero mas alto que tenga campeones de verdad.
const sets = Object.entries(data.sets ?? {})
  .map(([num, s]) => ({ num: Number(num), ...s }))
  .filter((s) => (s.champions ?? []).length)
  .sort((a, b) => b.num - a.num);
const set = sets[0];
const prefijo = new RegExp(`^TFT${set.num}_`);

const unidades = {};
for (const c of set.champions ?? []) {
  // Fuera props y trastos: solo unidades del set con coste de 1 a 5.
  if (!prefijo.test(c.apiName) || !(c.cost >= 1 && c.cost <= 5)) continue;
  unidades[c.apiName] = { n: c.name, c: c.cost, i: icono(c.tileIcon ?? c.squareIcon) };
}

const rasgos = {};
for (const t of set.traits ?? []) if (t.apiName && t.name) rasgos[t.apiName] = t.name;

// Objetos y aumentos: solo el nombre, que es lo unico que se ensena.
const objetos = {};
for (const i of data.items ?? []) {
  const id = i.apiName ?? i.nameId;
  if (id && i.name) objetos[id] = i.name;
}

const mapa = { numero: set.num, nombre: set.name, unidades, rasgos, objetos };
const texto = JSON.stringify(mapa);
writeFileSync(SALIDA, texto);
console.log(
  `set ${set.num} (${set.name}): ${Object.keys(unidades).length} unidades, ` +
    `${Object.keys(rasgos).length} rasgos, ${Object.keys(objetos).length} objetos · ${(texto.length / 1024).toFixed(0)} KB`
);

if (process.argv.includes("--subir")) {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "kv", "key", "put", "set:v1", "--path", "set.json", "--binding", "COMPS", "--remote"],
    { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname.replace(/^\//, "") }
  );
  console.log("subido a KV como set:v1");
}
