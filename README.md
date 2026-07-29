# valo-tracker

Tracker ligero de Valorant: stats de los jugadores de tu partida antes de empezar, leyendo la API local del cliente de Riot. Sin overlay in-game, sin tocar el proceso del juego, sin Overwolf.

## Estado

Fase 2: consola + UI para segunda pantalla, con websocket local y cache.

## Uso

Con el cliente de Riot abierto (y VALORANT arrancado al menos una vez):

```
npm start           # una pasada por consola: muestra la partida actual si la hay
npm run watch       # consola en vivo: detecta partida al instante (websocket)
npm run ui          # UI en el navegador (se abre sola): http://127.0.0.1:4327
```

- En seleccion de agentes muestra tu equipo (5) y refresca con cada pick.
- En partida muestra los 10 con equipo, agente, rango actual, RR, peak y KDA
  de las ultimas 10 competitivas: (K+A)/D. El KDA llega unos segundos despues
  del resto (match-details pesa ~1 MB por partida); con cache es inmediato.
- Jugadores en modo incognito salen como `(oculto)`.
- `npm run ui` acepta `--port N` y `--no-open`.

## Como funciona

1. `src/lockfile.js` — lee `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` (puerto + password del cliente local).
2. `src/localapi.js` — basic auth contra `https://127.0.0.1:{port}`: tokens (access + entitlements + PUUID), version del cliente, y region/shard desde el log de VALORANT.
3. `src/remote.js` — con esos tokens consulta `glz` (pregame / core-game) y `pd` (name-service, MMR), con cache TTL por PUUID (`src/cache.js`: nombres 6 h, MMR 10 min).
4. `src/ws.js` — cliente WebSocket minimo (RFC 6455 sobre `node:tls`) contra el Riot Client; suscrito al riot-messaging-service, avisa de pregame/partida sin sondear.
5. `src/tracker.js` — el nucleo: conecta, detecta (websocket + sondeo de respaldo), enriquece jugadores y emite eventos.
6. `src/cli.js` — consumidor de consola. `src/server.js` + `src/ui/` — servidor local con SSE y la interfaz.

Sin dependencias npm: Node >= 20 y modulos nativos (`node:https`, `node:tls`, `node:http`).

## Limitaciones conocidas

- API interna no documentada: Riot puede cambiarla en cualquier parche.
- Un lockfile presente no garantiza cliente vivo (queda huerfano si el cliente muere); se detecta por `ECONNREFUSED`.
- Si el websocket local falla, se cae con gracia al sondeo cada 10 s.

## Roadmap

- [x] Deteccion de cambio de cuenta (re-auth ante 401)
- [x] Cache de MMR/nombres por PUUID
- [x] Websocket local para detectar pregame sin polling
- [x] UI (ventana ligera para segunda pantalla)
- [ ] Historial de partidas propias
- [ ] Empaquetado como app (icono, arranque con un doble clic)
