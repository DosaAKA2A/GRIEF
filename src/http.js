// Helper HTTPS minimo sin dependencias.
// Permite rejectUnauthorized:false SOLO para la API local (cert self-signed
// del Riot Client); las llamadas remotas a pd/glz validan TLS normal.
import https from "node:https";

export function request(url, { method = "GET", headers = {}, body = null, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(payload != null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        rejectUnauthorized: !insecure,
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Timeout: " + url)));
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} en ${url}`);
    this.status = status;
    this.body = body;
  }
}

export async function requestOk(url, opts) {
  const res = await request(url, opts);
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, url, res.body);
  return res.body;
}
