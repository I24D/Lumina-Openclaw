"""Tests del skill de Bitso. No tocan la red ni la cuenta real.

Cubren lo que puede romperse en silencio y costar dinero: el orden exacto de
la firma, que se firme el mismo cuerpo que se envia, el formateo decimal, el
recorrido del libro y los frenos de seguridad.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from io import BytesIO
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bitso_client as bc  # noqa: E402
import bitso_market as bm  # noqa: E402

# --------------------------------------------------------------------------
# Firma
# --------------------------------------------------------------------------


def test_signature_message_order():
    """nonce + METODO + path + cuerpo, sin separadores."""
    msg = bc.build_signature_message(1234, "post", "/v3/orders/", '{"book":"btc_mxn"}')
    assert msg == '1234POST/v3/orders/{"book":"btc_mxn"}'


def test_signature_message_uppercases_method():
    assert bc.build_signature_message(1, "get", "/v3/balance/", "").startswith("1GET")


def test_signature_is_hex_sha256():
    creds = bc.Credentials(key="k", secret="s")
    client = bc.BitsoClient(creds)
    header = client._auth_header("GET", "/v3/balance/", "")
    scheme, _, rest = header.partition(" ")
    key, nonce, signature = rest.split(":")
    assert scheme == "Bitso"
    assert key == "k"
    assert nonce.isdigit()
    assert len(signature) == 64 and all(c in "0123456789abcdef" for c in signature)


def test_auth_header_without_credentials_is_config_error():
    with pytest.raises(bc.ConfigError):
        bc.BitsoClient(None)._auth_header("GET", "/v3/balance/", "")


# --------------------------------------------------------------------------
# Construccion de URL / path firmado
# --------------------------------------------------------------------------


def test_path_with_query_includes_v3_and_query():
    client = bc.BitsoClient(None, base_url=bc.PROD_BASE)
    url, path = client._build_url("/v3/ticker/", {"book": "btc_mxn"})
    assert url == "https://api.bitso.com/v3/ticker/?book=btc_mxn"
    assert path == "/v3/ticker/?book=btc_mxn"


def test_path_with_query_handles_stage_prefix():
    """En stage el host lleva /api: la firma debe incluirlo o falla."""
    client = bc.BitsoClient(None, base_url=bc.STAGE_BASE)
    url, path = client._build_url("/v3/balance/", None)
    assert url == "https://stage.bitso.com/api/v3/balance/"
    assert path == "/api/v3/balance/"


def test_build_url_drops_none_params():
    client = bc.BitsoClient(None)
    _, path = client._build_url("/v3/open_orders/", {"book": None, "limit": 10})
    assert path == "/v3/open_orders/?limit=10"


# --------------------------------------------------------------------------
# Que se firme exactamente el cuerpo que se envia
# --------------------------------------------------------------------------


class _FakeResponse(BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def test_signed_body_matches_sent_body(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = req.data.decode()
        captured["auth"] = req.get_header("Authorization")
        captured["url"] = req.full_url
        return _FakeResponse(json.dumps({"success": True, "payload": {"oid": "abc"}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)

    client = bc.BitsoClient(bc.Credentials(key="k", secret="s"))
    result = client.place_order(book="btc_mxn", side="buy", order_type="market", minor="500")

    assert result == {"oid": "abc"}
    # El cuerpo va compacto y sin espacios; recalculamos la firma sobre el
    # cuerpo REAL enviado y debe coincidir con la cabecera.
    nonce = captured["auth"].split(":")[1]
    expected = bc.hmac.new(
        b"s",
        bc.build_signature_message(int(nonce), "POST", "/v3/orders/", captured["body"]).encode(),
        bc.hashlib.sha256,
    ).hexdigest()
    assert captured["auth"].endswith(expected)
    assert json.loads(captured["body"]) == {
        "book": "btc_mxn",
        "side": "buy",
        "type": "market",
        "minor": "500",
    }


def test_place_order_omits_none_fields(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return _FakeResponse(json.dumps({"success": True, "payload": {"oid": "x"}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    bc.BitsoClient(bc.Credentials(key="k", secret="s")).place_order(
        book="btc_mxn", side="sell", order_type="limit", major="0.001", price="1400000"
    )
    assert "minor" not in captured["body"]
    assert "stop" not in captured["body"]
    assert captured["body"]["price"] == "1400000"


def test_business_error_surfaces_code(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise bc.urllib.error.HTTPError(
            req.full_url,
            401,
            "Unauthorized",
            {},
            BytesIO(
                json.dumps(
                    {"success": False, "error": {"code": "0201", "message": "Invalid Nonce"}}
                ).encode()
            ),
        )

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(bc.BitsoError) as exc:
        bc.BitsoClient(bc.Credentials(key="k", secret="s")).balance()
    assert exc.value.code == "0201"
    assert exc.value.http_status == 401
    assert "Invalid Nonce" in exc.value.message


# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------


def test_parse_env_handles_real_world_quirks():
    """Casos que existen de verdad en el .env del workspace."""
    parsed = bc.parse_env_text(
        "\n".join(
            [
                "# comentario",
                "",
                "BITSO_API_KEY=abc123",
                "WEATHERAPI_KEY= 9fd6f867   ",  # espacio tras el '='
                'QUOTED="con comillas"',
                "GMAIL_APP_PASSWORD=myit tgry zwrv pope",  # espacios dentro
                "export EXPORTED=si",
                "SIN_IGUAL",
            ]
        )
    )
    assert parsed["BITSO_API_KEY"] == "abc123"
    assert parsed["WEATHERAPI_KEY"] == "9fd6f867"
    assert parsed["QUOTED"] == "con comillas"
    assert parsed["GMAIL_APP_PASSWORD"] == "myit tgry zwrv pope"
    assert parsed["EXPORTED"] == "si"
    assert "SIN_IGUAL" not in parsed


def test_missing_credentials_names_the_missing_var():
    with pytest.raises(bc.ConfigError) as exc:
        bc.credentials_from_settings({"BITSO_API_KEY": "solo-la-key"})
    assert "BITSO_API_SECRET" in exc.value.message


def test_masked_key_never_exposes_the_middle():
    creds = bc.Credentials(key="ABCD1234EFGH", secret="s")
    assert creds.masked_key == "ABCD...EFGH"
    assert "1234" not in creds.masked_key


# --------------------------------------------------------------------------
# Decimales
# --------------------------------------------------------------------------


def test_small_amounts_never_use_scientific_notation():
    """Bitso rechaza '1E-5'. Un satoshi debe viajar como 0.00000001."""
    assert bc.dec_to_str(Decimal("0.00000001")) == "0.00000001"
    assert bc.dec_to_str(Decimal("0.000010")) == "0.00001"
    assert bc.dec_to_str(Decimal("1000.00")) == "1000"


def test_to_decimal_rejects_garbage():
    with pytest.raises(bc.BitsoError):
        bc.to_decimal("mucho", field="--major")
    with pytest.raises(bc.BitsoError):
        bc.to_decimal("NaN", field="--major")


# --------------------------------------------------------------------------
# Nonce
# --------------------------------------------------------------------------


def test_nonce_is_strictly_increasing():
    assert bc.next_nonce() < bc.next_nonce() < bc.next_nonce()


# --------------------------------------------------------------------------
# Libro de ordenes
# --------------------------------------------------------------------------


ASKS = [
    {"price": "100", "amount": "1"},
    {"price": "110", "amount": "2"},
    {"price": "130", "amount": "5"},
]


def test_fill_by_major_walks_multiple_levels():
    fill = bm.simulate_fill(ASKS, target_major=Decimal("2"))
    assert fill["filled_major"] == Decimal("2")
    assert fill["total_minor"] == Decimal("210")  # 1@100 + 1@110
    assert fill["average_price"] == Decimal("105")
    assert fill["worst_price"] == Decimal("110")
    assert fill["complete"] is True


def test_fill_by_minor_spends_the_budget():
    fill = bm.simulate_fill(ASKS, target_minor=Decimal("210"))
    assert fill["total_minor"] == Decimal("210")
    assert fill["filled_major"] == Decimal("2")


def test_fill_reports_slippage():
    fill = bm.simulate_fill(ASKS, target_major=Decimal("4"))
    # mejor 100, peor 130 => 30%
    assert fill["slippage_pct"] == Decimal("30")


def test_fill_flags_insufficient_depth():
    fill = bm.simulate_fill(ASKS, target_major=Decimal("100"))
    assert fill["complete"] is False
    assert fill["filled_major"] == Decimal("8")


def test_fill_rejects_empty_book():
    with pytest.raises(bc.BitsoError):
        bm.simulate_fill([], target_major=Decimal("1"))


def test_fill_needs_exactly_one_target():
    with pytest.raises(bc.BitsoError):
        bm.simulate_fill(ASKS, target_major=Decimal("1"), target_minor=Decimal("1"))
    with pytest.raises(bc.BitsoError):
        bm.simulate_fill(ASKS)


def test_fill_skips_junk_levels():
    fill = bm.simulate_fill(
        [{"price": "0", "amount": "5"}, {"price": "100", "amount": "1"}],
        target_major=Decimal("1"),
    )
    assert fill["average_price"] == Decimal("100")


# --------------------------------------------------------------------------
# Frenos de seguridad
# --------------------------------------------------------------------------


def test_split_book():
    assert bm.split_book("btc_mxn") == ("btc", "mxn")
    with pytest.raises(bc.BitsoError):
        bm.split_book("btcmxn")


def test_trading_disabled_by_default():
    assert bm.is_trading_enabled({}) is False
    assert bm.is_trading_enabled({"BITSO_TRADING_ENABLED": "false"}) is False
    assert bm.is_trading_enabled({"BITSO_TRADING_ENABLED": "true"}) is True
    assert bm.is_trading_enabled({"BITSO_TRADING_ENABLED": "SI"}) is True


def test_limits_block_when_trading_disabled():
    with pytest.raises(bc.ConfigError) as exc:
        bm.enforce_order_limits(settings={}, book="btc_mxn", notional_minor=Decimal("1"))
    assert "BITSO_TRADING_ENABLED" in exc.value.message


def test_limits_block_above_cap():
    settings = {"BITSO_TRADING_ENABLED": "true", "BITSO_MAX_ORDER_MINOR": "1000"}
    with pytest.raises(bc.ConfigError) as exc:
        bm.enforce_order_limits(
            settings=settings, book="btc_mxn", notional_minor=Decimal("1000.01")
        )
    assert "MXN" in exc.value.message
    # Justo en el limite si pasa.
    bm.enforce_order_limits(settings=settings, book="btc_mxn", notional_minor=Decimal("1000"))


def test_default_cap_applies_when_unset():
    assert bm.max_order_minor({}) == bm.DEFAULT_MAX_ORDER_MINOR
    with pytest.raises(bc.ConfigError):
        bm.max_order_minor({"BITSO_MAX_ORDER_MINOR": "0"})


# --------------------------------------------------------------------------
# CLI: validacion de argumentos (sin red)
# --------------------------------------------------------------------------


@pytest.fixture()
def cli(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("BITSO_API_KEY=k\nBITSO_API_SECRET=s\n", encoding="utf-8")
    monkeypatch.setenv("BITSO_ENV_FILE", str(env))
    for var in ("BITSO_TRADING_ENABLED", "BITSO_MAX_ORDER_MINOR"):
        monkeypatch.delenv(var, raising=False)
    import bitso

    return bitso


def test_cli_market_order_needs_one_amount(cli, capsys):
    assert cli.main(["buy", "btc_mxn"]) == cli.EXIT_ERROR
    assert "exactamente uno" in capsys.readouterr().err


def test_cli_limit_order_rejects_minor(cli, capsys):
    code = cli.main(["buy", "btc_mxn", "--minor", "500", "--price", "1400000"])
    assert code == cli.EXIT_ERROR
    assert "--major" in capsys.readouterr().err


def test_cli_rejects_negative_amounts(cli, capsys):
    assert cli.main(["sell", "btc_mxn", "--major", "-1"]) == cli.EXIT_ERROR
    assert "mayor que 0" in capsys.readouterr().err


def test_cli_cancel_without_target_fails(cli, capsys):
    assert cli.main(["cancel"]) == cli.EXIT_ERROR
    assert "OID" in capsys.readouterr().err


def test_cli_cancel_dry_run_sends_nothing(cli, capsys, monkeypatch):
    def explode(*a, **k):  # pragma: no cover - debe no llamarse
        raise AssertionError("no deberia tocar la red en dry-run")

    monkeypatch.setattr(bc.urllib.request, "urlopen", explode)
    assert cli.main(["--json", "cancel", "oid-123"]) == cli.EXIT_OK
    out = json.loads(capsys.readouterr().out)
    assert out == {"dry_run": True, "would_cancel": "oid-123"}


def test_cli_buy_dry_run_does_not_place_order(cli, capsys, monkeypatch):
    """La simulacion consulta el libro (GET) pero nunca hace POST."""
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.method)
        assert req.method == "GET", "dry-run no debe enviar ordenes"
        return _FakeResponse(json.dumps({"success": True, "payload": {"asks": ASKS}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    assert cli.main(["--json", "buy", "btc_mxn", "--minor", "210"]) == cli.EXIT_OK
    out = json.loads(capsys.readouterr().out)
    assert out["dry_run"] is True
    assert out["total_minor"] == "210"
    assert calls == ["GET"]


def test_cli_confirm_still_blocked_when_trading_disabled(cli, capsys, monkeypatch):
    """--confirm no basta: el interruptor del .env manda."""

    def fake_urlopen(req, timeout=None):
        assert req.method == "GET", "no debe enviar la orden con trading desactivado"
        return _FakeResponse(json.dumps({"success": True, "payload": {"asks": ASKS}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    code = cli.main(["buy", "btc_mxn", "--minor", "210", "--confirm"])
    assert code == cli.EXIT_CONFIG
    assert "BITSO_TRADING_ENABLED" in capsys.readouterr().err


def test_cli_confirm_blocked_above_cap(cli, capsys, monkeypatch):
    monkeypatch.setenv("BITSO_TRADING_ENABLED", "true")
    monkeypatch.setenv("BITSO_MAX_ORDER_MINOR", "100")

    def fake_urlopen(req, timeout=None):
        assert req.method == "GET", "no debe enviar la orden por encima del limite"
        return _FakeResponse(json.dumps({"success": True, "payload": {"asks": ASKS}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    code = cli.main(["buy", "btc_mxn", "--minor", "210", "--confirm"])
    assert code == cli.EXIT_CONFIG
    assert "limite por orden" in capsys.readouterr().err


def test_cli_confirmed_order_is_sent_with_slippage_guard(cli, capsys, monkeypatch):
    monkeypatch.setenv("BITSO_TRADING_ENABLED", "true")
    monkeypatch.setenv("BITSO_MAX_ORDER_MINOR", "1000")
    posts = []

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse(
                json.dumps({"success": True, "payload": {"asks": ASKS}}).encode()
            )
        posts.append(json.loads(req.data.decode()))
        return _FakeResponse(json.dumps({"success": True, "payload": {"oid": "OID1"}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    assert cli.main(["--json", "buy", "btc_mxn", "--minor", "210", "--confirm"]) == cli.EXIT_OK
    out = json.loads(capsys.readouterr().out)
    assert out["oid"] == "OID1"
    assert out["dry_run"] is False
    assert posts == [
        {
            "book": "btc_mxn",
            "side": "buy",
            "type": "market",
            "minor": "210",
            "slippage_tolerance": "1",
        }
    ]


def test_cli_slippage_none_omits_the_field(cli, capsys, monkeypatch):
    monkeypatch.setenv("BITSO_TRADING_ENABLED", "true")
    posts = []

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse(
                json.dumps({"success": True, "payload": {"asks": ASKS}}).encode()
            )
        posts.append(json.loads(req.data.decode()))
        return _FakeResponse(json.dumps({"success": True, "payload": {"oid": "x"}}).encode())

    monkeypatch.setattr(bc.urllib.request, "urlopen", fake_urlopen)
    cli.main(["buy", "btc_mxn", "--minor", "210", "--slippage", "none", "--confirm"])
    assert "slippage_tolerance" not in posts[0]
