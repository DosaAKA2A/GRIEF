// API local del Riot Client (127.0.0.1:{port}, basic auth riot:{password}).
// De aqui salen los tokens y el PUUID de la cuenta logeada.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requestOk } from "./http.js";

export class LocalApi {
  constructor(lock) {
    this.base = `https://127.0.0.1:${lock.port}`;
    this.auth = "Basic " + Buffer.from(`riot:${lock.password}`).toString("base64");
  }

  get(path) {
    return requestOk(this.base + path, {
      headers: { Authorization: this.auth },
      insecure: true, // cert self-signed del cliente local
    });
  }

  // Tokens de la cuenta logeada: accessToken + entitlements token + PUUID.
  async getEntitlements() {
    const e = await this.get("/entitlements/v1/token");
    return { accessToken: e.accessToken, entitlementsToken: e.token, puuid: e.subject };
  }

  // Presencias del chat local: en seleccion de agentes y en partida incluyen
  // a los jugadores de tu partida; su blob private (base64) trae el partyId.
  // Funciona incluso con jugadores en incognito.
  async getPresences() {
    const res = await this.get("/chat/v4/presences");
    const map = new Map();
    for (const p of res?.presences ?? []) {
      if (p.product !== "valorant" || !p.private) continue;
      try {
        const priv = JSON.parse(Buffer.from(p.private, "base64").toString("utf8"));
        if (priv?.partyId) {
          map.set(p.puuid, { partyId: priv.partyId, partySize: priv.partySize ?? null });
        }
      } catch {
        // blob raro o de otro producto: ignorar
      }
    }
    return map;
  }

  // Version del cliente (necesaria como header en varios endpoints pd/glz).
  // Se intenta local primero; fallback a valorant-api.com.
  async getClientVersion() {
    try {
      const s = await this.get("/product-session/v1/external-sessions");
      for (const key of Object.keys(s)) {
        const args = s[key]?.launchConfiguration?.arguments ?? [];
        for (const a of args) {
          const m = a.match(/-ares-deployment.*|release-.+-shipping-.+/);
          if (m && s[key].productId === "valorant") {
            // El formato esperado es p.ej. release-08.11-shipping-15-2456856
            const v = args.find((x) => /release-.+-shipping/.test(x));
            if (v) return v.replace(/^.*?(release-)/, "$1");
          }
        }
      }
    } catch {
      // caemos al fallback
    }
    const v = await requestOk("https://valorant-api.com/v1/version");
    return v.data.riotClientVersion;
  }
}

// Region y shard: el metodo mas fiable es leer la URL glz del log de VALORANT.
export async function getRegionShard() {
  const logPath = join(
    process.env.LOCALAPPDATA,
    "VALORANT",
    "Saved",
    "Logs",
    "ShooterGame.log"
  );
  const log = await readFile(logPath, "utf8");
  const m = log.match(/https:\/\/glz-(.+?)-1\.(.+?)\.a\.pvp\.net/);
  if (!m) throw new Error("No se encontro la URL glz en ShooterGame.log. Abre VALORANT al menos una vez.");
  return { region: m[1], shard: m[2] };
}

// Header X-Riot-ClientPlatform: blob base64 estandar de plataforma Windows.
export const CLIENT_PLATFORM = Buffer.from(
  JSON.stringify({
    platformType: "PC",
    platformOS: "Windows",
    platformOSVersion: "10.0.19042.1.256.64bit",
    platformChipset: "Unknown",
  })
).toString("base64");
