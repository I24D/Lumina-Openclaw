#!/usr/bin/env python3
"""CLI de Bitso para agentes (OpenClaw / Codex / Claude Code).

Lee BITSO_API_KEY y BITSO_API_SECRET del .env unico del workspace.
Sin dependencias externas: basta `python bitso.py <subcomando>`.

Frenos de seguridad para operaciones que mueven dinero:
  1. Sin --confirm no se envia nada: se imprime la simulacion y se sale.
  2. BITSO_TRADING_ENABLED debe ser true en el .env.
  3. El importe no puede superar BITSO_MAX_ORDER_MINOR.
Cancelar solo exige --confirm: cerrar posiciones nunca debe ser dificil.

Codigos de salida: 0 ok | 1 error | 2 uso invalido | 3 configuracion/limites.
"""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bitso_client import (  # noqa: E402
    PROD_BASE,
    STAGE_BASE,
    BitsoClient,
    BitsoError,
    ConfigError,
    credentials_from_settings,
    dec_to_str,
    find_env_file,
    load_settings,
    to_decimal,
)
from bitso_market import (  # noqa: E402
    enforce_order_limits,
    format_fill,
    is_trading_enabled,
    max_order_minor,
    simulate_fill,
    split_book,
)

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_CONFIG = 3


# --------------------------------------------------------------------------
# Salida
# --------------------------------------------------------------------------


def emit(args: argparse.Namespace, data: Any, text: str) -> None:
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False, default=str))
    else:
        print(text)


def table(rows: list[tuple[str, ...]], headers: tuple[str, ...]) -> str:
    if not rows:
        return "(sin resultados)"
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    sep = "  ".join("-" * widths[i] for i in range(len(headers)))
    body = [
        "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)) for row in rows
    ]
    return "\n".join([line, sep, *body])


# --------------------------------------------------------------------------
# Contexto
# --------------------------------------------------------------------------


class Context:
    def __init__(self, args: argparse.Namespace) -> None:
        self.settings = load_settings(args.env_file)
        self.env_path = find_env_file(args.env_file)
        self.base_url = STAGE_BASE if args.stage else PROD_BASE
        self.timeout = args.timeout
        self._client: BitsoClient | None = None
        self._public: BitsoClient | None = None

    @property
    def client(self) -> BitsoClient:
        """Cliente autenticado. Falla limpio si faltan credenciales."""
        if self._client is None:
            creds = credentials_from_settings(self.settings)
            self._client = BitsoClient(creds, base_url=self.base_url, timeout=self.timeout)
        return self._client

    @property
    def public(self) -> BitsoClient:
        """Cliente sin firmar, para precios y libro: no necesita credenciales."""
        if self._public is None:
            self._public = BitsoClient(None, base_url=self.base_url, timeout=self.timeout)
        return self._public


# --------------------------------------------------------------------------
# Subcomandos de lectura
# --------------------------------------------------------------------------


def cmd_check(ctx: Context, args: argparse.Namespace) -> int:
    report: dict[str, Any] = {
        "env_file": str(ctx.env_path) if ctx.env_path else None,
        "base_url": ctx.base_url,
    }
    lines = [
        f".env            : {ctx.env_path or 'NO ENCONTRADO'}",
        f"API             : {ctx.base_url}",
    ]

    try:
        creds = credentials_from_settings(ctx.settings)
        report["credentials"] = {"present": True, "key": creds.masked_key}
        lines.append(f"Credenciales    : OK ({creds.masked_key})")
    except ConfigError as exc:
        report["credentials"] = {"present": False, "detail": exc.message}
        lines.append(f"Credenciales    : FALTAN - {exc.message}")

    try:
        ticker = ctx.public.ticker("btc_mxn")
        report["public_api"] = {"ok": True, "btc_mxn_last": ticker.get("last")}
        lines.append(f"API publica     : OK (BTC/MXN ultimo {ticker.get('last')})")
    except BitsoError as exc:
        report["public_api"] = {"ok": False, "detail": exc.message}
        lines.append(f"API publica     : FALLO - {exc.message}")

    if report.get("credentials", {}).get("present"):
        try:
            balances = ctx.client.balance().get("balances", [])
            funded = [b for b in balances if to_decimal(b.get("total", 0), field="total") > 0]
            report["private_api"] = {"ok": True, "currencies_with_balance": len(funded)}
            lines.append(f"API firmada     : OK ({len(funded)} monedas con saldo)")
        except BitsoError as exc:
            report["private_api"] = {"ok": False, "detail": exc.message, "code": exc.code}
            lines.append(f"API firmada     : FALLO - {exc.message}")

    enabled = is_trading_enabled(ctx.settings)
    cap = max_order_minor(ctx.settings)
    report["trading_enabled"] = enabled
    report["max_order_minor"] = dec_to_str(cap)
    lines.append(
        "Trading         : "
        + ("HABILITADO" if enabled else "BLOQUEADO (BITSO_TRADING_ENABLED != true)")
    )
    lines.append(f"Limite/orden    : {dec_to_str(cap)} (moneda minor del book)")

    emit(args, report, "\n".join(lines))
    ok = report.get("public_api", {}).get("ok") and report.get("private_api", {}).get("ok")
    return EXIT_OK if ok else EXIT_ERROR


def cmd_books(ctx: Context, args: argparse.Namespace) -> int:
    books = ctx.public.available_books()
    if args.filter:
        needle = args.filter.lower()
        books = [b for b in books if needle in str(b.get("book", "")).lower()]
    rows = [
        (
            b.get("book", ""),
            b.get("minimum_amount", ""),
            b.get("maximum_amount", ""),
            b.get("minimum_value", ""),
            b.get("maximum_value", ""),
        )
        for b in books
    ]
    emit(
        args,
        books,
        table(rows, ("book", "min_major", "max_major", "min_minor", "max_minor")),
    )
    return EXIT_OK


def cmd_ticker(ctx: Context, args: argparse.Namespace) -> int:
    t = ctx.public.ticker(args.book)
    _, minor = split_book(args.book)
    text = (
        f"{args.book}\n"
        f"  ultimo    : {t.get('last')} {minor.upper()}\n"
        f"  compra/bid: {t.get('bid')}\n"
        f"  venta/ask : {t.get('ask')}\n"
        f"  24h alto  : {t.get('high')}   bajo: {t.get('low')}\n"
        f"  24h cambio: {t.get('change_24')}   volumen: {t.get('volume')}\n"
        f"  vwap      : {t.get('vwap')}"
    )
    emit(args, t, text)
    return EXIT_OK


def cmd_depth(ctx: Context, args: argparse.Namespace) -> int:
    ob = ctx.public.order_book(args.book)
    asks = ob.get("asks", [])[: args.depth]
    bids = ob.get("bids", [])[: args.depth]
    rows = []
    for i in range(max(len(asks), len(bids))):
        bid = bids[i] if i < len(bids) else {}
        ask = asks[i] if i < len(asks) else {}
        rows.append(
            (
                bid.get("amount", ""),
                bid.get("price", ""),
                ask.get("price", ""),
                ask.get("amount", ""),
            )
        )
    emit(
        args,
        {"asks": asks, "bids": bids, "updated_at": ob.get("updated_at")},
        f"{args.book} (mejores {args.depth})\n"
        + table(rows, ("cant_compra", "precio_compra", "precio_venta", "cant_venta")),
    )
    return EXIT_OK


def cmd_balance(ctx: Context, args: argparse.Namespace) -> int:
    balances = ctx.client.balance().get("balances", [])
    if args.currency:
        wanted = args.currency.lower()
        balances = [b for b in balances if str(b.get("currency", "")).lower() == wanted]
    elif not args.all:
        balances = [
            b for b in balances if to_decimal(b.get("total", 0), field="total") > Decimal(0)
        ]
    rows = [
        (
            str(b.get("currency", "")).upper(),
            b.get("available", ""),
            b.get("locked", ""),
            b.get("total", ""),
        )
        for b in balances
    ]
    emit(args, balances, table(rows, ("moneda", "disponible", "bloqueado", "total")))
    return EXIT_OK


def cmd_fees(ctx: Context, args: argparse.Namespace) -> int:
    payload = ctx.client.fees()
    fees = payload.get("fees", [])
    if args.book:
        fees = [f for f in fees if f.get("book") == args.book]
    rows = [
        (f.get("book", ""), f.get("maker_fee_percent", ""), f.get("taker_fee_percent", ""))
        for f in fees
    ]
    emit(args, payload, table(rows, ("book", "maker_%", "taker_%")))
    return EXIT_OK


def cmd_orders(ctx: Context, args: argparse.Namespace) -> int:
    orders = ctx.client.open_orders(args.book, limit=args.limit)
    rows = [
        (
            o.get("oid", ""),
            o.get("book", ""),
            o.get("side", ""),
            o.get("type", ""),
            o.get("price", ""),
            o.get("original_amount", ""),
            o.get("unfilled_amount", ""),
            o.get("status", ""),
        )
        for o in orders
    ]
    emit(
        args,
        orders,
        table(
            rows,
            ("oid", "book", "lado", "tipo", "precio", "original", "pendiente", "estado"),
        ),
    )
    return EXIT_OK


def cmd_order(ctx: Context, args: argparse.Namespace) -> int:
    found = ctx.client.lookup_order(args.oid)
    emit(args, found, json.dumps(found, indent=2, ensure_ascii=False))
    return EXIT_OK


def cmd_trades(ctx: Context, args: argparse.Namespace) -> int:
    trades = ctx.client.user_trades(args.book, limit=args.limit)
    rows = [
        (
            t.get("created_at", ""),
            t.get("book", ""),
            t.get("side", ""),
            t.get("price", ""),
            t.get("major", ""),
            t.get("minor", ""),
            f"{t.get('fees_amount', '')} {str(t.get('fees_currency', '')).upper()}",
        )
        for t in trades
    ]
    emit(
        args,
        trades,
        table(rows, ("fecha", "book", "lado", "precio", "major", "minor", "comision")),
    )
    return EXIT_OK


# --------------------------------------------------------------------------
# Simulacion y ordenes
# --------------------------------------------------------------------------


def build_preview(ctx: Context, *, book: str, side: str, major, minor, price) -> dict[str, Any]:
    """Calcula que pasaria con esta orden, sin enviar nada.

    Para limit el importe es exacto (precio x cantidad). Para market se recorre
    el libro real, que es lo unico que dice de verdad cuanto vas a pagar.
    """
    major_ccy, minor_ccy = split_book(book)
    preview: dict[str, Any] = {
        "book": book,
        "side": side,
        "type": "limit" if price is not None else "market",
        "major_currency": major_ccy.upper(),
        "minor_currency": minor_ccy.upper(),
    }

    if price is not None:
        notional = major * price
        preview.update(
            {
                "price": dec_to_str(price),
                "major": dec_to_str(major),
                "notional_minor": dec_to_str(notional.quantize(Decimal("0.00000001"))),
                "estimated": False,
            }
        )
        return preview

    ob = ctx.public.order_book(book)
    levels = ob.get("asks", []) if side == "buy" else ob.get("bids", [])
    fill = simulate_fill(levels, target_major=major, target_minor=minor)
    preview.update(format_fill(fill))
    preview["notional_minor"] = preview["total_minor"]
    preview["estimated"] = True
    if major is not None:
        preview["major"] = dec_to_str(major)
    if minor is not None:
        preview["minor"] = dec_to_str(minor)
    return preview


def render_preview(preview: dict[str, Any], *, confirmed: bool) -> str:
    verb = "COMPRAR" if preview["side"] == "buy" else "VENDER"
    lines = [
        "",
        f"  {verb} en {preview['book']}  ({preview['type']})",
        "  " + "-" * 52,
    ]
    if preview["type"] == "limit":
        lines += [
            f"  cantidad     : {preview['major']} {preview['major_currency']}",
            f"  precio limite: {preview['price']} {preview['minor_currency']}",
            f"  importe      : {preview['notional_minor']} {preview['minor_currency']}",
            "  nota         : es una orden limite; se ejecuta solo a ese precio o mejor.",
        ]
    else:
        lines += [
            f"  recibes/das  : {preview['filled_major']} {preview['major_currency']}",
            f"  importe est. : {preview['total_minor']} {preview['minor_currency']}",
            f"  precio medio : {preview['average_price']} {preview['minor_currency']}",
            f"  mejor/peor   : {preview['best_price']} / {preview['worst_price']}",
            f"  slippage     : {preview['slippage_pct']} %  ({preview['levels_used']} niveles)",
        ]
        if preview.get("complete") == "false":
            lines.append("  AVISO        : el libro no cubre la cantidad entera.")
        lines.append("  nota         : estimacion sobre el libro actual; el precio real puede variar.")
    lines.append("  " + "-" * 52)
    if not confirmed:
        lines += [
            "  SIMULACION - no se ha enviado nada a Bitso.",
            "  Para ejecutarla de verdad, repite el comando con --confirm",
            "",
        ]
    return "\n".join(lines)


def cmd_place(ctx: Context, args: argparse.Namespace) -> int:
    side = args.side
    book = args.book

    price = to_decimal(args.price, field="--price") if args.price else None
    major = to_decimal(args.major, field="--major") if args.major else None
    minor = to_decimal(args.minor, field="--minor") if args.minor else None

    if price is not None:
        if major is None:
            raise BitsoError("Una orden limite necesita --major (cantidad) junto con --price.")
        if minor is not None:
            raise BitsoError("Con --price usa --major; Bitso no acepta --minor en limites.")
    else:
        if (major is None) == (minor is None):
            raise BitsoError(
                "Una orden a mercado necesita exactamente uno de --major o --minor. "
                f"En {book}: --major = cantidad de {split_book(book)[0].upper()}, "
                f"--minor = cuanto {split_book(book)[1].upper()} mueves."
            )
    for name, value in (("--major", major), ("--minor", minor), ("--price", price)):
        if value is not None and value <= Decimal(0):
            raise BitsoError(f"{name} debe ser mayor que 0.")

    preview = build_preview(ctx, book=book, side=side, major=major, minor=minor, price=price)

    # La simulacion es de solo lectura y siempre se muestra: es el paso util
    # aunque el usuario no vaya a ejecutar.
    if not args.confirm:
        preview["dry_run"] = True
        emit(args, preview, render_preview(preview, confirmed=False))
        return EXIT_OK

    notional = to_decimal(preview["notional_minor"], field="notional")
    enforce_order_limits(settings=ctx.settings, book=book, notional_minor=notional)

    slippage = None
    if price is None and args.slippage.lower() not in ("none", "off", "no"):
        slippage = dec_to_str(to_decimal(args.slippage, field="--slippage"))

    result = ctx.client.place_order(
        book=book,
        side=side,
        order_type="limit" if price is not None else "market",
        major=dec_to_str(major) if major is not None else None,
        minor=dec_to_str(minor) if minor is not None else None,
        price=dec_to_str(price) if price is not None else None,
        time_in_force=args.time_in_force,
        origin_id=args.origin_id,
        slippage_tolerance=slippage,
    )

    oid = result.get("oid") if isinstance(result, dict) else None
    payload = {"dry_run": False, "submitted": True, "oid": oid, "preview": preview}
    text = (
        render_preview(preview, confirmed=True)
        + f"\n  ENVIADA. oid = {oid}\n"
        + f"  Seguimiento: python bitso.py order {oid}\n"
    )
    emit(args, payload, text)
    return EXIT_OK


def cmd_quote(ctx: Context, args: argparse.Namespace) -> int:
    major = to_decimal(args.major, field="--major") if args.major else None
    minor = to_decimal(args.minor, field="--minor") if args.minor else None
    if (major is None) == (minor is None):
        raise BitsoError("Indica exactamente uno de --major o --minor.")
    preview = build_preview(
        ctx, book=args.book, side=args.side, major=major, minor=minor, price=None
    )
    preview["dry_run"] = True
    emit(args, preview, render_preview(preview, confirmed=False))
    return EXIT_OK


def cmd_cancel(ctx: Context, args: argparse.Namespace) -> int:
    if not args.oid and not args.all:
        raise BitsoError("Indica un OID o usa --all para cancelar todas las ordenes abiertas.")
    if args.oid and args.all:
        raise BitsoError("Usa un OID o --all, no ambos.")

    target = "TODAS las ordenes abiertas" if args.all else f"la orden {args.oid}"
    if not args.confirm:
        emit(
            args,
            {"dry_run": True, "would_cancel": "all" if args.all else args.oid},
            f"\n  Se cancelaria {target}.\n"
            "  SIMULACION - nada enviado. Repite con --confirm para cancelar.\n",
        )
        return EXIT_OK

    cancelled = ctx.client.cancel_all() if args.all else ctx.client.cancel_order(args.oid)
    emit(
        args,
        {"dry_run": False, "cancelled": cancelled},
        f"Canceladas {len(cancelled)} orden(es): {', '.join(cancelled) if cancelled else '(ninguna)'}",
    )
    return EXIT_OK


# --------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bitso.py",
        description="Consulta precios y opera en Bitso. Las ordenes exigen --confirm.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Ejemplos:\n"
            "  python bitso.py check\n"
            "  python bitso.py ticker btc_mxn\n"
            "  python bitso.py balance\n"
            "  python bitso.py quote btc_mxn buy --minor 500\n"
            "  python bitso.py buy btc_mxn --minor 500            # simula\n"
            "  python bitso.py buy btc_mxn --minor 500 --confirm  # ejecuta\n"
            "  python bitso.py sell btc_mxn --major 0.001 --price 1450000 --confirm\n"
            "  python bitso.py orders\n"
            "  python bitso.py cancel <oid> --confirm\n"
        ),
    )
    parser.add_argument("--json", action="store_true", help="salida JSON para consumo automatico")
    parser.add_argument("--env-file", help="ruta a un .env alternativo")
    parser.add_argument("--stage", action="store_true", help="usar el entorno de pruebas de Bitso")
    parser.add_argument("--timeout", type=float, default=30.0, help="timeout HTTP (s)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="diagnostico: .env, credenciales, conectividad y frenos")

    p = sub.add_parser("books", help="pares disponibles y sus minimos/maximos")
    p.add_argument("--filter", help="subcadena para filtrar, p.ej. mxn")

    p = sub.add_parser("ticker", help="precio actual de un par")
    p.add_argument("book")

    p = sub.add_parser("depth", help="libro de ordenes")
    p.add_argument("book")
    p.add_argument("--depth", type=int, default=10)

    p = sub.add_parser("balance", help="saldos de la cuenta")
    p.add_argument("--currency", help="solo esta moneda")
    p.add_argument("--all", action="store_true", help="incluir monedas con saldo 0")

    p = sub.add_parser("fees", help="comisiones maker/taker")
    p.add_argument("--book")

    p = sub.add_parser("quote", help="simular una operacion contra el libro real")
    p.add_argument("book")
    p.add_argument("side", choices=["buy", "sell"])
    p.add_argument("--major", help="cantidad de cripto")
    p.add_argument("--minor", help="cantidad de la moneda de pago")

    for side, helptext in (("buy", "comprar"), ("sell", "vender")):
        p = sub.add_parser(side, help=f"{helptext} (simula salvo que pases --confirm)")
        p.add_argument("book")
        p.add_argument("--major", help="cantidad de cripto (p.ej. 0.001 BTC)")
        p.add_argument("--minor", help="cantidad de la moneda de pago (p.ej. 500 MXN)")
        p.add_argument("--price", help="precio limite; sin el, la orden es a mercado")
        p.add_argument(
            "--slippage",
            default="1",
            help="tolerancia de slippage %% en ordenes a mercado (por defecto 1; 'none' la omite)",
        )
        p.add_argument(
            "--time-in-force",
            choices=["goodtillcancelled", "fillorkill", "immediateorcancel", "postonly"],
        )
        p.add_argument("--origin-id", help="identificador propio, unico, max 40 caracteres")
        p.add_argument("--confirm", action="store_true", help="ENVIAR de verdad la orden")
        p.set_defaults(side=side)

    p = sub.add_parser("orders", help="ordenes abiertas")
    p.add_argument("--book")
    p.add_argument("--limit", type=int, default=100)

    p = sub.add_parser("order", help="consultar una orden por oid")
    p.add_argument("oid")

    p = sub.add_parser("trades", help="tus operaciones ejecutadas")
    p.add_argument("--book")
    p.add_argument("--limit", type=int, default=25)

    p = sub.add_parser("cancel", help="cancelar una orden o todas")
    p.add_argument("oid", nargs="?")
    p.add_argument("--all", action="store_true")
    p.add_argument("--confirm", action="store_true", help="CANCELAR de verdad")

    return parser


HANDLERS = {
    "check": cmd_check,
    "books": cmd_books,
    "ticker": cmd_ticker,
    "depth": cmd_depth,
    "balance": cmd_balance,
    "fees": cmd_fees,
    "quote": cmd_quote,
    "buy": cmd_place,
    "sell": cmd_place,
    "orders": cmd_orders,
    "order": cmd_order,
    "trades": cmd_trades,
    "cancel": cmd_cancel,
}


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        ctx = Context(args)
        return HANDLERS[args.command](ctx, args)
    except ConfigError as exc:
        if args.json:
            print(json.dumps(exc.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(f"Configuracion: {exc.message}", file=sys.stderr)
        return EXIT_CONFIG
    except BitsoError as exc:
        if args.json:
            print(json.dumps(exc.to_dict(), indent=2, ensure_ascii=False))
        else:
            detail = f" (codigo {exc.code})" if exc.code else ""
            print(f"Error: {exc.message}{detail}", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:
        print("Cancelado.", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
