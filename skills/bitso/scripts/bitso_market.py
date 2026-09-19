"""Simulacion de llenado contra el libro real y limites de seguridad.

Separado del cliente HTTP porque es logica pura y testeable: cuanto acabas
pagando de verdad por una orden a mercado, y si esa orden pasa o no los frenos
configurados en el .env.
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Any

from bitso_client import BitsoError, ConfigError, dec_to_str, to_decimal

ZERO = Decimal(0)
SATOSHI = Decimal("0.00000001")  # precision maxima que acepta la API

# Freno por defecto si el .env no dice otra cosa. Esta en la moneda "minor" del
# book (en btc_mxn => MXN). Deliberadamente bajo: un agente autonomo que se
# equivoque no puede hacer mucho dano hasta que el dueno lo suba a mano.
DEFAULT_MAX_ORDER_MINOR = Decimal("1000")

TRUE_VALUES = {"1", "true", "yes", "on", "si", "sí"}


def is_trading_enabled(settings: dict[str, str]) -> bool:
    return (settings.get("BITSO_TRADING_ENABLED") or "").strip().lower() in TRUE_VALUES


def max_order_minor(settings: dict[str, str]) -> Decimal:
    raw = (settings.get("BITSO_MAX_ORDER_MINOR") or "").strip()
    if not raw:
        return DEFAULT_MAX_ORDER_MINOR
    value = to_decimal(raw, field="BITSO_MAX_ORDER_MINOR")
    if value <= ZERO:
        raise ConfigError("BITSO_MAX_ORDER_MINOR debe ser mayor que 0.")
    return value


def simulate_fill(
    levels: list[dict[str, Any]],
    *,
    target_major: Decimal | None = None,
    target_minor: Decimal | None = None,
) -> dict[str, Any]:
    """Recorre el libro nivel a nivel y calcula el llenado real.

    `levels` viene ordenado de mejor a peor precio (asks ascendente para
    comprar, bids descendente para vender). Se indica UNO de los dos objetivos:
    `target_major` (cantidad de cripto) o `target_minor` (dinero a mover).
    """
    if (target_major is None) == (target_minor is None):
        raise BitsoError("simulate_fill necesita exactamente uno de target_major/target_minor.")
    if not levels:
        raise BitsoError("El libro de ordenes vino vacio; no se puede estimar el precio.")

    filled_major = ZERO
    total_minor = ZERO
    best_price: Decimal | None = None
    worst_price: Decimal | None = None
    levels_used = 0

    for level in levels:
        price = to_decimal(level["price"], field="price")
        available = to_decimal(level["amount"], field="amount")
        if price <= ZERO or available <= ZERO:
            continue

        if target_major is not None:
            take = min(available, target_major - filled_major)
        else:
            remaining = target_minor - total_minor
            take = min(available, remaining / price)

        if take <= ZERO:
            break

        filled_major += take
        total_minor += take * price
        levels_used += 1
        if best_price is None:
            best_price = price
        worst_price = price

        if target_major is not None and filled_major >= target_major:
            break
        if target_minor is not None and total_minor >= target_minor:
            break

    if filled_major <= ZERO or best_price is None or worst_price is None:
        raise BitsoError("El libro no tiene profundidad suficiente para esa cantidad.")

    complete = (
        filled_major >= target_major if target_major is not None else total_minor >= target_minor
    )
    average = total_minor / filled_major
    slippage_pct = (worst_price - best_price) / best_price * Decimal(100)

    return {
        "filled_major": filled_major,
        "total_minor": total_minor,
        "average_price": average,
        "best_price": best_price,
        "worst_price": worst_price,
        "slippage_pct": abs(slippage_pct),
        "levels_used": levels_used,
        "complete": complete,
    }


def format_fill(fill: dict[str, Any]) -> dict[str, str]:
    """Version en texto plano de simulate_fill, lista para imprimir o serializar.

    Se redondea a 8 decimales (la precision de la API) y siempre en tu contra:
    lo que recibes hacia abajo, lo que pagas hacia arriba. Asi la estimacion
    nunca promete de mas.
    """
    return {
        "filled_major": dec_to_str(fill["filled_major"].quantize(SATOSHI, rounding=ROUND_DOWN)),
        "total_minor": dec_to_str(fill["total_minor"].quantize(SATOSHI, rounding=ROUND_UP)),
        "average_price": dec_to_str(fill["average_price"].quantize(SATOSHI, rounding=ROUND_UP)),
        "best_price": dec_to_str(fill["best_price"]),
        "worst_price": dec_to_str(fill["worst_price"]),
        "slippage_pct": dec_to_str(fill["slippage_pct"].quantize(Decimal("0.0001"))),
        "levels_used": str(fill["levels_used"]),
        "complete": "true" if fill["complete"] else "false",
    }


def split_book(book: str) -> tuple[str, str]:
    """'btc_mxn' -> ('btc', 'mxn'). major = cripto, minor = lo que pagas."""
    parts = book.strip().lower().split("_")
    if len(parts) != 2 or not all(parts):
        raise BitsoError(
            f"Book invalido: {book!r}. Se espera 'major_minor', p.ej. btc_mxn. "
            "Consulta los disponibles con el subcomando 'books'."
        )
    return parts[0], parts[1]


def enforce_order_limits(
    *,
    settings: dict[str, str],
    book: str,
    notional_minor: Decimal,
) -> None:
    """Frenos duros antes de mandar una orden. Lanza ConfigError si no pasa.

    Son dos comprobaciones independientes y ambas se resuelven editando el .env
    una sola vez, a conciencia:
      1. BITSO_TRADING_ENABLED debe estar en true.
      2. El importe no puede superar BITSO_MAX_ORDER_MINOR.
    """
    if not is_trading_enabled(settings):
        raise ConfigError(
            "El trading esta desactivado. Para permitir ordenes reales pon "
            "BITSO_TRADING_ENABLED=true en C:/I24D_WhatsApp/.env. "
            "(Las consultas de precios y saldos funcionan igualmente.)"
        )

    cap = max_order_minor(settings)
    _, minor = split_book(book)
    if notional_minor > cap:
        raise ConfigError(
            f"La orden mueve {dec_to_str(notional_minor.quantize(Decimal('0.01')))} "
            f"{minor.upper()} y el limite por orden es {dec_to_str(cap)} {minor.upper()}. "
            "Si es intencionado, sube BITSO_MAX_ORDER_MINOR en el .env."
        )
