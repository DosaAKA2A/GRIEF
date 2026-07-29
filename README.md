# valo-tracker

Tracker ligero de Valorant: stats de los jugadores de tu partida antes de empezar, leyendo la API local del cliente de Riot. Sin overlay in-game, sin tocar el proceso del juego, sin Overwolf.

## Estado

Maqueta funcional (fase 1). Solo consola; lo visual llega despues.

## Uso

Con el cliente de Riot abierto (y VALORANT arrancado al menos una vez):

```
npm start           # una pasada: muestra la partida actual si la hay
npm run watch       # sondea cada 10 s hasta detectar partida
```

- En seleccion de agentes muestra tu equipo (5).
- En partida muestra los 10 con equipo, agente, rango actual, RR y peak.
- Jugadores en modo incognito salen como `(oculto)`.

## Como funciona

1. `src/lockfile.js` — lee `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` (puerto + password del cliente local).
2. `src/localapi.js` — basic auth contra `https://127.0.0.1:{port}`: tokens (access + entitlements + PUUID), version del cliente, y region/shard desde el log de VALORANT.
3. `src/remote.js` — con esos tokens consulta `glz` (pregame / core-game) y `pd` (name-service, MMR).
4. `src/cli.js` — orquesta y pinta la tabla.

Sin dependencias npm: Node >= 20 y `node:https`.

## Limitaciones conocidas

- API interna no documentada: Riot puede cambiarla en cualquier parche.
- Un lockfile presente no garantiza cliente vivo (queda huerfano si el cliente muere); se detecta por `ECONNREFUSED`.
- El cambio de cuenta en caliente aun no se detecta (previsto: watcher del lockfile + websocket local + re-auth ante 401).

## Roadmap

- [ ] Deteccion de cambio de cuenta (watcher + websocket + 401)
- [ ] Cache de MMR/nombres por PUUID
- [ ] Websocket local para detectar pregame sin polling
- [ ] UI (ventana ligera para segunda pantalla)
