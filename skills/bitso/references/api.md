# API v3 de Bitso — referencia

Lo necesario para mantener este skill o extenderlo. Docs oficiales:
https://docs.bitso.com/bitso-api/docs/getting-started

## Bases

| Entorno             | Base                          | Path que se firma |
| ------------------- | ----------------------------- | ----------------- |
| Produccion          | `https://api.bitso.com`       | `/v3/...`         |
| Pruebas (`--stage`) | `https://stage.bitso.com/api` | `/api/v3/...`     |

El prefijo `/api` de stage **entra en la firma**. `BitsoClient._build_url`
deriva el path firmado de la propia URL para que los dos entornos funcionen sin
ramas especiales.

## Firma HMAC

```
Authorization: Bitso <key>:<nonce>:<signature>
signature = hex( HMAC_SHA256( nonce + METODO + path_con_query + cuerpo, secret ) )
```

- Sin separadores entre los trozos.
- `METODO` en mayusculas (`GET`, `POST`, `DELETE`).
- `path_con_query` incluye `/v3` y la query string, exactamente como viaja.
- `cuerpo` es el JSON serializado, o cadena vacia si no hay.
- `nonce`: entero unico y creciente. Aqui se usan microsegundos con guarda de
  monotonia en `~/.bitso-skill/nonce`.

Los dos fallos clasicos, ambos cubiertos por tests:

1. Firmar un JSON distinto del enviado (reserializar con otro espaciado). Por
   eso el cuerpo se serializa **una sola vez** en `BitsoClient.request`.
2. Invertir el orden de la concatenacion. Aislado en
   `build_signature_message` para poder fijarlo con un test.

## Endpoints usados

### Publicos (sin firma)

| Metodo | Path                                   | Para que                       |
| ------ | -------------------------------------- | ------------------------------ |
| GET    | `/v3/available_books/`                 | pares, minimos y maximos       |
| GET    | `/v3/ticker/?book=`                    | precio actual                  |
| GET    | `/v3/order_book/?book=&aggregate=true` | libro, base de la simulacion   |
| GET    | `/v3/trades/?book=&limit=`             | operaciones publicas recientes |

### Privados (firmados)

| Metodo | Path                            | Para que               |
| ------ | ------------------------------- | ---------------------- |
| GET    | `/v3/balance/`                  | saldos                 |
| GET    | `/v3/fees/`                     | comisiones maker/taker |
| GET    | `/v3/open_orders/?book=&limit=` | ordenes abiertas       |
| GET    | `/v3/orders/{oid}/`             | estado de una orden    |
| GET    | `/v3/user_trades/?book=&limit=` | tus ejecuciones        |
| POST   | `/v3/orders/`                   | poner una orden        |
| DELETE | `/v3/orders/{oid}/`             | cancelar una           |
| DELETE | `/v3/orders/all/`               | cancelar todas         |

## POST /v3/orders/

| Campo                | Obligatorio | Notas                                                                    |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| `book`               | si          | p.ej. `btc_mxn`                                                          |
| `side`               | si          | `buy` \| `sell`                                                          |
| `type`               | si          | `market` \| `limit`                                                      |
| `major`              | condicional | cantidad de cripto. Obligatorio en `limit`                               |
| `minor`              | condicional | cantidad de fiat. Solo en `market`, y nunca junto a `major`              |
| `price`              | solo limit  | 8 decimales maximo                                                       |
| `stop`               | no          | ordenes stop                                                             |
| `time_in_force`      | no          | `goodtillcancelled` \| `fillorkill` \| `immediateorcancel` \| `postonly` |
| `origin_id`          | no          | max 40 chars, alfanumerico/`_`/`-`, unico                                |
| `slippage_tolerance` | no          | market/stop, porcentaje 0-100                                            |

Respuesta: `{"success": true, "payload": {"oid": "..."}}`

Los importes viajan **como cadena**, nunca como numero: un float de Python
imprime `1e-05` para un satoshi y Bitso lo rechaza. `dec_to_str` fuerza notacion
plana y hay un test que lo fija.

## Errores

Formato: `{"success": false, "error": {"code": "0201", "message": "..."}}`,
normalmente con HTTP 4xx. `BitsoClient.request` lo convierte en `BitsoError`
conservando `code` y `http_status`.

| Codigo | Causa habitual                                                         |
| ------ | ---------------------------------------------------------------------- |
| `0201` | Nonce invalido: reloj desfasado o nonce repetido                       |
| `0202` | A la API key le falta ese permiso (regenerarla en bitso.com/api_setup) |
| `0304` | Fondos insuficientes                                                   |

## Permisos de la API key

Los permisos se marcan al crear la llave y **no se pueden ampliar despues**: hay
que generar una nueva. Para este skill hacen falta lectura de saldos, lectura de
ordenes y, si se va a operar, creacion y cancelacion de ordenes.

Deja el permiso de **retiro sin marcar**. Este skill no lo usa, y una llave que
no puede sacar fondos no puede vaciar la cuenta aunque se filtre.

## Mantenimiento

```bash
python -m pytest scripts/test_bitso.py -q   # 38 tests, no tocan la red
python scripts/bitso.py check               # diagnostico contra la API real
```

Los tests interceptan `urllib.request.urlopen`, asi que nunca contactan con
Bitso ni con la cuenta. `check` si habla con la API, pero solo lee.
