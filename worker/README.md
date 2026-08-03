# grief-tft

Worker de Cloudflare que calcula las mejores composiciones de TFT del parche a
partir de partidas reales de Challenger (API oficial de Riot) y las sirve como
JSON para la app. Vive aparte del resto de proyectos: cuenta de Studio Iris,
worker propio `grief-tft`, nada compartido con Iris.

## Que hace

1. Coge los mejores Challenger de la region (`PLATAFORMA`).
2. Baja sus ultimas partidas y se queda con las normales/clasificatorias de 8.
3. Agrupa cada tablero por sus dos rasgos activos mas fuertes + su carry.
4. Calcula puesto medio, top 4, primeros puestos, unidades y objetos mas
   repetidos y aumentos mas vistos.
5. Ordena por puesto medio y reparte tiers (S ≤ 4.00, A ≤ 4.35, B ≤ 4.60, C).

Recalcula solo una vez al dia (cron) y guarda el resultado en KV: la app nunca
espera y la clave de Riot no sale del worker.

## Rutas

- `GET /comps` — la lista de comps (lo que consume GRIEF)
- `GET /estado` — cuando se calculo, cuantas partidas entraron, que parche
- `GET /refresca` — recalcula ahora (cabecera `X-Clave` con el secreto `ADMIN`)

## Puesta en marcha

```
cd worker
npx wrangler kv namespace create COMPS      # pega el id en wrangler.toml
npx wrangler secret put RIOT_KEY            # clave de developer.riotgames.com
npx wrangler secret put ADMIN               # opcional, para /refresca
npx wrangler deploy
```

La clave de desarrollo de Riot caduca cada 24 h; para que esto viva solo hay
que pedir una **Personal API Key** en developer.riotgames.com (gratis, la
aprueban en unos dias) y volver a hacer `wrangler secret put RIOT_KEY`.

Ajustes en `wrangler.toml`: `PLATAFORMA` (na1, euw1, la1...), `RUTA` (americas,
europe, asia), `JUGADORES` y `PARTIDAS` controlan cuantas peticiones se hacen
por recalculo (40 x 8 se queda muy por debajo del limite de una clave normal).
