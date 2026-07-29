// Cliente WebSocket minimo (RFC 6455) sobre node:tls para el Riot Client local.
// Sin dependencias: solo necesitamos texto, ping/pong y close.
// Protocolo del cliente: WAMP-like — enviar [5, "evento"] suscribe; los eventos
// llegan como [8, "evento", { data, eventType, uri }].
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

export class RiotWs extends EventEmitter {
  #sock;
  #buf = Buffer.alloc(0);
  #frag = null;
  closed = false;

  static connect(lock, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const auth = Buffer.from(`riot:${lock.password}`).toString("base64");
      const sock = tls.connect({
        host: "127.0.0.1",
        port: lock.port,
        rejectUnauthorized: false, // cert self-signed del cliente local
      });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("Timeout abriendo el websocket local"));
      }, timeoutMs);
      sock.once("secureConnect", () => {
        sock.write(
          `GET / HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${lock.port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `Authorization: Basic ${auth}\r\n\r\n`
        );
      });
      let header = Buffer.alloc(0);
      const onData = (chunk) => {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf("\r\n\r\n");
        if (end === -1) return;
        clearTimeout(timer);
        sock.off("data", onData);
        const statusLine = header.subarray(0, end).toString().split("\r\n")[0];
        if (!/ 101 /.test(statusLine)) {
          sock.destroy();
          return reject(new Error("El cliente rechazo el websocket: " + statusLine));
        }
        const ws = new RiotWs(sock);
        const rest = header.subarray(end + 4);
        if (rest.length) ws.#onData(rest);
        resolve(ws);
      };
      sock.on("data", onData);
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  constructor(sock) {
    super();
    this.#sock = sock;
    sock.on("data", (c) => this.#onData(c));
    const done = () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("close");
      }
    };
    sock.on("close", done);
    sock.on("error", done);
  }

  send(obj) {
    if (this.closed) return;
    this.#sock.write(this.#frame(0x1, Buffer.from(JSON.stringify(obj))));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#sock.write(this.#frame(0x8, Buffer.alloc(0)));
    } catch {}
    this.#sock.destroy();
  }

  // El cliente DEBE enmascarar sus frames (el servidor no).
  #frame(op, payload) {
    const mask = randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | op, 0x80 | len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 0xfe;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 0xff;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([head, mask, body]);
  }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const f = this.#readFrame();
      if (!f) return;
      this.#handle(f);
    }
  }

  // Devuelve un frame completo del buffer o null si aun faltan bytes.
  #readFrame() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      len = Number(b.readBigUInt64BE(off));
      off += 8;
    }
    let key = null;
    if (masked) {
      if (b.length < off + 4) return null;
      key = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (key) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
      payload = out;
    }
    this.#buf = b.subarray(off + len);
    return { fin, op, payload };
  }

  #handle({ fin, op, payload }) {
    if (op === 0x9) {
      this.#sock.write(this.#frame(0xa, payload)); // ping -> pong
      return;
    }
    if (op === 0x8) {
      const wasClosed = this.closed;
      this.close();
      if (!wasClosed) this.emit("close"); // cierre iniciado por el servidor
      return;
    }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      this.#frag = op === 0x0 ? Buffer.concat([this.#frag ?? Buffer.alloc(0), payload]) : payload;
      if (!fin) return;
      const text = this.#frag.toString("utf8");
      this.#frag = null;
      if (!text) return; // el cliente manda un frame vacio al suscribirse
      try {
        this.emit("message", JSON.parse(text));
      } catch {
        // no-JSON: ignorar
      }
    }
  }
}
