"""Cliente de la API v3 de Bitso.

Solo biblioteca estandar: se puede invocar con cualquier Python 3.10+ sin
instalar nada, desde OpenClaw, Codex o Claude Code indistintamente.

Autenticacion (docs.bitso.com/bitso-api/docs/create-signed-requests):

    Authorization: Bitso <key>:<nonce>:<signature>
    signature = hex(HMAC_SHA256(nonce + METHOD + path_con_query + body, secret))

El `path_con_query` incluye el prefijo `/v3` y la query string, y debe ser
byte-a-byte el mismo que viaja en la peticion. Por eso el cuerpo JSON se
serializa UNA sola vez y se reutiliza para firmar y para enviar.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

PROD_BASE = "https://api.bitso.com"
STAGE_BASE = "https://stage.bitso.com/api"

# El workspace tiene un unico .env en la raiz (regla del proyecto). Se busca
# primero subiendo desde este archivo, para que el skill siga funcionando si la
# carpeta se mueve, y este path queda como ultimo recurso.
FALLBACK_ENV_PATH = Path("C:/I24D_WhatsApp/.env")

USER_AGENT = "lumina-bitso-skill/1.0"


class BitsoError(RuntimeError):
    """Fallo al hablar con Bitso (red, credenciales o error de negocio)."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        http_status: int | None = None,
        payload: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.http_status = http_status
        self.payload = payload

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"error": self.message}
        if self.code is not None:
            out["code"] = self.code
        if self.http_status is not None:
            out["http_status"] = self.http_status
        return out


class ConfigError(BitsoError):
    """Falta configuracion (credenciales, interruptor de trading, limites)."""


# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------


def parse_env_text(text: str) -> dict[str, str]:
    """Parsea un .env sencillo: KEY=VALUE, ignora comentarios y lineas vacias.

    Tolera espacios sobrantes alrededor del '=' y valores que contienen
    espacios (p.ej. un app-password de Google). No interpreta comillas dentro
    del valor mas alla de quitar un par envolvente.
    """
    data: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        data[key] = value
    return data


def find_env_file(explicit: str | os.PathLike[str] | None = None) -> Path | None:
    """Localiza el .env: parametro explicito, BITSO_ENV_FILE, o subiendo arbol."""
    if explicit:
        path = Path(explicit)
        return path if path.is_file() else None

    from_env = os.environ.get("BITSO_ENV_FILE")
    if from_env:
        path = Path(from_env)
        if path.is_file():
            return path

    for parent in Path(__file__).resolve().parents:
        candidate = parent / ".env"
        if candidate.is_file():
            return candidate

    cwd_env = Path.cwd() / ".env"
    if cwd_env.is_file():
        return cwd_env

    if FALLBACK_ENV_PATH.is_file():
        return FALLBACK_ENV_PATH

    return None


def load_settings(env_file: str | os.PathLike[str] | None = None) -> dict[str, str]:
    """Une el .env con os.environ. Las variables ya exportadas tienen prioridad."""
    settings: dict[str, str] = {}
    path = find_env_file(env_file)
    if path is not None:
        try:
            settings.update(parse_env_text(path.read_text(encoding="utf-8", errors="replace")))
        except OSError as exc:  # pragma: no cover - depende del FS
            raise ConfigError(f"No se pudo leer {path}: {exc}") from exc
    for key, value in os.environ.items():
        if key.startswith("BITSO_"):
            settings[key] = value
    return settings


# --------------------------------------------------------------------------
# Credenciales y nonce
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Credentials:
    key: str
    secret: str

    @property
    def masked_key(self) -> str:
        if len(self.key) <= 8:
            return "*" * len(self.key)
        return f"{self.key[:4]}...{self.key[-4:]}"


def credentials_from_settings(settings: dict[str, str]) -> Credentials:
    key = (settings.get("BITSO_API_KEY") or "").strip()
    secret = (settings.get("BITSO_API_SECRET") or "").strip()
    missing = [
        name
        for name, value in (("BITSO_API_KEY", key), ("BITSO_API_SECRET", secret))
        if not value
    ]
    if missing:
        raise ConfigError(
            "Faltan credenciales en el .env: "
            + ", ".join(missing)
            + ". Generalas en https://bitso.com/api_setup y pegalas en "
            "C:/I24D_WhatsApp/.env"
        )
    return Credentials(key=key, secret=secret)


def build_signature_message(nonce: int, method: str, path_with_query: str, body: str) -> str:
    """Concatenacion exacta que exige Bitso: nonce + METODO + path + cuerpo.

    Aislado en su propia funcion porque el orden es lo unico que se puede
    romper en silencio (la firma sale bien formada pero Bitso la rechaza con
    un 0201 opaco), y asi queda cubierto por un test.
    """
    return f"{nonce}{method.upper()}{path_with_query}{body}"


_NONCE_STATE = Path.home() / ".bitso-skill" / "nonce"


def next_nonce() -> int:
    """Entero estrictamente creciente. Microsegundos + guarda de monotonia.

    Bitso rechaza un nonce repetido o menor que el anterior. Los microsegundos
    ya hacen improbable la colision; el fichero de estado la descarta tambien
    entre procesos concurrentes. Si el fichero no se puede usar, se degrada
    silenciosamente al reloj (fail-open) en vez de bloquear la operacion.
    """
    nonce = time.time_ns() // 1_000
    try:
        _NONCE_STATE.parent.mkdir(parents=True, exist_ok=True)
        previous = 0
        if _NONCE_STATE.is_file():
            raw = _NONCE_STATE.read_text(encoding="utf-8").strip()
            if raw.isdigit():
                previous = int(raw)
        if nonce <= previous:
            nonce = previous + 1
        _NONCE_STATE.write_text(str(nonce), encoding="utf-8")
    except OSError:
        pass
    return nonce


# --------------------------------------------------------------------------
# Decimales
# --------------------------------------------------------------------------


def to_decimal(value: Any, *, field: str) -> Decimal:
    """Convierte a Decimal rechazando basura. Nunca usamos float para dinero."""
    try:
        dec = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise BitsoError(f"'{field}' no es un numero valido: {value!r}") from exc
    if not dec.is_finite():
        raise BitsoError(f"'{field}' no es un numero finito: {value!r}")
    return dec


def dec_to_str(value: Decimal) -> str:
    """Decimal -> texto plano, sin notacion cientifica (Bitso la rechaza)."""
    return format(value.normalize(), "f")


# --------------------------------------------------------------------------
# Cliente
# --------------------------------------------------------------------------


class BitsoClient:
    def __init__(
        self,
        credentials: Credentials | None = None,
        *,
        base_url: str = PROD_BASE,
        timeout: float = 30.0,
    ) -> None:
        self.credentials = credentials
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # -- plomeria ---------------------------------------------------------

    def _build_url(self, path: str, params: dict[str, Any] | None) -> tuple[str, str]:
        """Devuelve (url_absoluta, path_con_query) — el segundo es lo que se firma."""
        if not path.startswith("/"):
            path = "/" + path
        query = ""
        if params:
            clean = {k: str(v) for k, v in params.items() if v is not None}
            if clean:
                query = urllib.parse.urlencode(clean)
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{query}"
        base_path = urllib.parse.urlsplit(self.base_url).path.rstrip("/")
        path_with_query = f"{base_path}{path}"
        if query:
            path_with_query = f"{path_with_query}?{query}"
        return url, path_with_query

    def _auth_header(self, method: str, path_with_query: str, body: str) -> str:
        if self.credentials is None:
            raise ConfigError(
                "Esta operacion necesita credenciales. Define BITSO_API_KEY y "
                "BITSO_API_SECRET en el .env."
            )
        nonce = next_nonce()
        message = build_signature_message(nonce, method, path_with_query, body)
        signature = hmac.new(
            self.credentials.secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"Bitso {self.credentials.key}:{nonce}:{signature}"

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        signed: bool = False,
    ) -> Any:
        method = method.upper()
        url, path_with_query = self._build_url(path, params)

        # Se serializa una sola vez: firmar algo distinto de lo que se envia es
        # el fallo clasico de esta API.
        body_text = "" if body is None else json.dumps(body, separators=(",", ":"))
        data = body_text.encode("utf-8") if body_text else None

        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if signed:
            headers["Authorization"] = self._auth_header(method, path_with_query, body_text)

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            status = exc.code
        except urllib.error.URLError as exc:
            raise BitsoError(f"No se pudo conectar con Bitso: {exc.reason}") from exc
        except TimeoutError as exc:
            raise BitsoError(f"Bitso no respondio en {self.timeout}s") from exc

        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise BitsoError(
                f"Bitso devolvio algo que no es JSON (HTTP {status}): {raw[:300]}"
            ) from exc

        if isinstance(parsed, dict) and parsed.get("success") is True:
            return parsed.get("payload")

        error = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(error, dict):
            raise BitsoError(
                error.get("message") or f"Bitso rechazo la peticion (HTTP {status})",
                code=str(error.get("code")) if error.get("code") is not None else None,
                http_status=status,
                payload=parsed,
            )
        raise BitsoError(
            f"Respuesta inesperada de Bitso (HTTP {status}): {raw[:300]}",
            http_status=status,
            payload=parsed,
        )

    # -- endpoints publicos ------------------------------------------------

    def available_books(self) -> list[dict[str, Any]]:
        return self.request("GET", "/v3/available_books/")

    def ticker(self, book: str) -> dict[str, Any]:
        return self.request("GET", "/v3/ticker/", params={"book": book})

    def order_book(self, book: str, *, aggregate: bool = True) -> dict[str, Any]:
        return self.request(
            "GET",
            "/v3/order_book/",
            params={"book": book, "aggregate": "true" if aggregate else "false"},
        )

    def public_trades(self, book: str, *, limit: int = 25) -> list[dict[str, Any]]:
        return self.request("GET", "/v3/trades/", params={"book": book, "limit": limit})

    # -- endpoints privados ------------------------------------------------

    def balance(self) -> dict[str, Any]:
        return self.request("GET", "/v3/balance/", signed=True)

    def fees(self) -> dict[str, Any]:
        return self.request("GET", "/v3/fees/", signed=True)

    def open_orders(self, book: str | None = None, *, limit: int = 100) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if book:
            params["book"] = book
        return self.request("GET", "/v3/open_orders/", params=params, signed=True)

    def lookup_order(self, oid: str) -> list[dict[str, Any]]:
        return self.request("GET", f"/v3/orders/{urllib.parse.quote(oid)}/", signed=True)

    def user_trades(self, book: str | None = None, *, limit: int = 25) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if book:
            params["book"] = book
        return self.request("GET", "/v3/user_trades/", params=params, signed=True)

    def place_order(
        self,
        *,
        book: str,
        side: str,
        order_type: str,
        major: str | None = None,
        minor: str | None = None,
        price: str | None = None,
        stop: str | None = None,
        time_in_force: str | None = None,
        origin_id: str | None = None,
        slippage_tolerance: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"book": book, "side": side, "type": order_type}
        optional = {
            "major": major,
            "minor": minor,
            "price": price,
            "stop": stop,
            "time_in_force": time_in_force,
            "origin_id": origin_id,
            "slippage_tolerance": slippage_tolerance,
        }
        body.update({k: v for k, v in optional.items() if v is not None})
        return self.request("POST", "/v3/orders/", body=body, signed=True)

    def cancel_order(self, oid: str) -> list[str]:
        return self.request("DELETE", f"/v3/orders/{urllib.parse.quote(oid)}/", signed=True)

    def cancel_all(self) -> list[str]:
        return self.request("DELETE", "/v3/orders/all/", signed=True)
