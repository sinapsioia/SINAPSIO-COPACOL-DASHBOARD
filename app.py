from __future__ import annotations

import json
import mimetypes
import os
import re
import tempfile
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).parent
STATIC = ROOT / "static"
PORT = int(os.getenv("PORT", "8787"))


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key, value)


load_env()


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# In-memory cache for import previews pending confirmation
IMPORT_CACHE: dict[str, dict] = {}


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict | list) -> None:
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def supabase_get(table: str, query: str) -> list[dict]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Missing Supabase configuration")
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_all(table: str, select: str, order: str | None = None, page_size: int = 1000) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        params = {
            "select": select,
            "limit": str(page_size),
            "offset": str(offset),
        }
        if order:
            params["order"] = order
        chunk = supabase_get(table, urllib.parse.urlencode(params, safe="*,.()"))
        rows.extend(chunk)
        if len(chunk) < page_size:
            break
        offset += page_size
    return rows


def money(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def aging_bucket(days: float) -> str:
    if days <= 0:
        return "vigente"
    if days <= 30:
        return "1_30"
    if days <= 60:
        return "31_60"
    if days <= 90:
        return "61_90"
    if days <= 120:
        return "91_120"
    if days <= 180:
        return "121_180"
    return "181_plus"


def build_dashboard_payload() -> dict:
    clients = fetch_all(
        "copacol_clients",
        "nit,razon_social,telefono,telefono_2,direccion,ciudad,asesor_codigo,asesor_nombre,total_saldo,total_vencido,total_vigente,num_facturas,num_vencidas,dias_mora_max,etapa_cobranza,escalado,promesa_fecha,ultimo_contacto,fecha_corte",
        "total_saldo.desc",
    )
    invoices = fetch_all(
        "copacol_facturas",
        "nit,numero_factura,tipo_mov,monto,vlr_mora,fecha_emision,fecha_vencimiento,dias_mora,condicion_pago,estado",
        "fecha_vencimiento.asc",
    )
    promises = fetch_all(
        "copacol_promesas_pago",
        "nit,telefono,fecha_promesa,monto_prometido,observacion,status,registrado_por,created_at",
        "fecha_promesa.asc",
    )
    payments = fetch_all(
        "copacol_pagos_reportados",
        "nit,telefono,metodo,monto_reportado,status,verificado_por,fecha_verificacion,created_at",
        "created_at.desc",
    )

    client_lookup = {client.get("nit"): client for client in clients}
    client_stats: dict[str, dict] = defaultdict(
        lambda: {
            "saldo": 0.0,
            "vencido": 0.0,
            "vigente": 0.0,
            "facturas": 0,
            "vencidas": 0,
            "dias_mora_max": 0.0,
        }
    )

    by_seller: dict[str, dict] = {}
    by_city: dict[str, float] = defaultdict(float)
    aging = {"vigente": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "91_120": 0.0, "121_180": 0.0, "181_plus": 0.0}
    condition_mix: dict[str, float] = defaultdict(float)
    seller_aging: dict[str, dict] = {}
    enriched_invoices = []

    for client in clients:
        seller_key = client.get("asesor_codigo") or "sin_codigo"
        seller = by_seller.setdefault(
            seller_key,
            {
                "codigo": seller_key,
                "nombre": client.get("asesor_nombre") or "Sin asesor",
                "saldo": 0.0,
                "vencido": 0.0,
                "clientes": 0,
            },
        )
        seller["saldo"] += money(client.get("total_saldo"))
        seller["vencido"] += money(client.get("total_vencido"))
        seller["clientes"] += 1
        by_city[client.get("ciudad") or "Sin ciudad"] += money(client.get("total_saldo"))

    for invoice in invoices:
        client = client_lookup.get(invoice.get("nit"), {})
        amount = money(invoice.get("monto"))
        days = money(invoice.get("dias_mora"))
        nit = invoice.get("nit")
        bucket = aging_bucket(days)
        seller_code = client.get("asesor_codigo") or "sin_codigo"
        seller_name = client.get("asesor_nombre") or "Sin asesor"
        seller_matrix = seller_aging.setdefault(
            seller_code,
            {
                "codigo": seller_code,
                "nombre": seller_name,
                "total": 0.0,
                "vencido": 0.0,
                "vigente": 0.0,
                "1_30": 0.0,
                "31_60": 0.0,
                "61_90": 0.0,
                "91_120": 0.0,
                "121_180": 0.0,
                "181_plus": 0.0,
                "pct_vencido": 0.0,
            },
        )
        seller_matrix["total"] += amount
        seller_matrix[bucket] += amount
        if days > 0:
            seller_matrix["vencido"] += amount

        condition_mix[invoice.get("condicion_pago") or "sin_condicion"] += amount
        if nit:
            client_stats[nit]["saldo"] += amount
            client_stats[nit]["facturas"] += 1
            if days > 0:
                client_stats[nit]["vencido"] += amount
                client_stats[nit]["vencidas"] += 1
                client_stats[nit]["dias_mora_max"] = max(client_stats[nit]["dias_mora_max"], days)
            else:
                client_stats[nit]["vigente"] += amount

        aging[bucket] += amount

        enriched_invoices.append(
            {
                **invoice,
                "cliente": client.get("razon_social") or "Sin cliente",
                "asesor_codigo": seller_code,
                "asesor_nombre": seller_name,
                "ciudad": client.get("ciudad") or "Sin ciudad",
                "telefono": client.get("telefono") or client.get("telefono_2") or "",
                "aging_bucket": bucket,
            }
        )

    total_vigente = aging["vigente"]
    total_vencido = aging["1_30"] + aging["31_60"] + aging["61_90"] + aging["91_120"] + aging["121_180"] + aging["181_plus"]
    total_saldo = total_vigente + total_vencido
    vencidos = sum(1 for stats in client_stats.values() if stats["vencido"] > 0)
    avg_mora_vencida = 0.0
    overdue_days = [money(row.get("dias_mora")) for row in enriched_invoices if money(row.get("dias_mora")) > 0]
    if overdue_days:
        avg_mora_vencida = sum(overdue_days) / len(overdue_days)

    enriched_clients = []
    for client in clients:
        stats = client_stats.get(client.get("nit"), {})
        saldo = money(stats.get("saldo")) or money(client.get("total_saldo"))
        vencido = money(stats.get("vencido"))
        dias_max = money(stats.get("dias_mora_max")) or money(client.get("dias_mora_max"))
        if dias_max > 60 or vencido > 15000000:
            priority = "Alta"
        elif dias_max > 30 or vencido > 5000000:
            priority = "Media"
        else:
            priority = "Normal"
        enriched_clients.append(
            {
                **client,
                "total_saldo": saldo,
                "total_vencido": vencido,
                "total_vigente": money(stats.get("vigente")),
                "num_facturas": int(stats.get("facturas") or client.get("num_facturas") or 0),
                "num_vencidas": int(stats.get("vencidas") or client.get("num_vencidas") or 0),
                "dias_mora_max": dias_max,
                "prioridad": priority,
            }
        )

    top_clients = sorted(enriched_clients, key=lambda c: money(c.get("total_saldo")), reverse=True)
    top_sellers = sorted(by_seller.values(), key=lambda s: s["saldo"], reverse=True)
    seller_matrix_rows = []
    for row in seller_aging.values():
        row["pct_vencido"] = row["vencido"] / row["total"] if row["total"] else 0.0
        seller_matrix_rows.append(row)
    seller_matrix_rows = sorted(seller_matrix_rows, key=lambda row: row["total"], reverse=True)
    top_cities = sorted(
        [{"ciudad": key, "saldo": value} for key, value in by_city.items()],
        key=lambda item: item["saldo"],
        reverse=True,
    )[:12]
    overdue_invoices = sorted(
        [row for row in enriched_invoices if money(row.get("dias_mora")) > 0],
        key=lambda row: (money(row.get("dias_mora")), money(row.get("monto"))),
        reverse=True,
    )
    due_soon = sorted(
        [row for row in enriched_invoices if -7 <= money(row.get("dias_mora")) <= 0],
        key=lambda row: money(row.get("dias_mora")),
        reverse=True,
    )
    concentration_top10 = sum(money(c.get("total_saldo")) for c in top_clients[:10])
    over_90 = aging["91_120"] + aging["121_180"] + aging["181_plus"]
    status_overdue = "green" if (total_vencido / total_saldo if total_saldo else 0) <= 0.08 else "yellow" if (total_vencido / total_saldo if total_saldo else 0) <= 0.15 else "red"
    status_over90 = "green" if (over_90 / total_saldo if total_saldo else 0) < 0.03 else "red"

    return {
        "summary": {
            "total_saldo": total_saldo,
            "total_vencido": total_vencido,
            "total_vigente": total_vigente,
            "clientes": len(clients),
            "clientes_vencidos": vencidos,
            "facturas": len(invoices),
            "facturas_vencidas": len(overdue_invoices),
            "mora_promedio": avg_mora_vencida,
            "concentracion_top10": concentration_top10,
            "concentracion_top10_pct": concentration_top10 / total_saldo if total_saldo else 0,
            "over_90": over_90,
            "over_90_pct": over_90 / total_saldo if total_saldo else 0,
            "semaforo_vencida": status_overdue,
            "semaforo_90": status_over90,
            "promesas_pendientes": sum(1 for p in promises if (p.get("status") or "").lower() in {"pendiente", "open", ""}),
            "pagos_pendientes": sum(1 for p in payments if (p.get("status") or "").lower() in {"pendiente", "reported", ""}),
            "fecha_corte": max([c.get("fecha_corte") or "" for c in clients] or [""]),
        },
        "aging": aging,
        "condition_mix": [{"condicion": key, "saldo": value} for key, value in sorted(condition_mix.items(), key=lambda item: item[1], reverse=True)],
        "seller_aging": seller_matrix_rows,
        "sellers": top_sellers,
        "cities": top_cities,
        "clients": top_clients,
        "invoices": enriched_invoices,
        "overdue_invoices": overdue_invoices[:150],
        "due_soon": due_soon[:150],
        "promises": promises[:50],
        "payments": payments[:50],
    }


def supabase_upsert(table: str, rows: list[dict], on_conflict: str) -> int:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Missing Supabase configuration")
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    body = json.dumps(rows, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": f"resolution=merge-duplicates,return=minimal",
        },
    )
    req.add_unredirected_header("X-Upsert", "true")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status


def supabase_insert(table: str, row: dict) -> dict:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Missing Supabase configuration")
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    body = json.dumps(row, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_client_payload(nit: str) -> dict:
    params = urllib.parse.urlencode({"nit": f"eq.{nit}", "limit": "1"})
    clients = supabase_get(
        "copacol_clients",
        f"select=*&{params}",
    )
    client = clients[0] if clients else {}

    inv_params = urllib.parse.urlencode({"nit": f"eq.{nit}", "limit": "200", "order": "fecha_vencimiento.asc"})
    invoices = supabase_get("copacol_facturas", f"select=*&{inv_params}")

    promise_params = urllib.parse.urlencode({"nit": f"eq.{nit}", "limit": "20", "order": "created_at.desc"})
    promises = supabase_get("copacol_promesas_pago", f"select=*&{promise_params}")

    payment_params = urllib.parse.urlencode({"nit": f"eq.{nit}", "limit": "20", "order": "created_at.desc"})
    payments = supabase_get("copacol_pagos_reportados", f"select=*&{payment_params}")

    contacts: list[dict] = []
    try:
        contact_params = urllib.parse.urlencode({"nit": f"eq.{nit}", "limit": "30", "order": "created_at.desc"})
        contacts = supabase_get("copacol_log_contactos", f"select=*&{contact_params}")
    except Exception:
        pass

    return {
        "client": client,
        "invoices": invoices,
        "promises": promises,
        "payments": payments,
        "contacts": contacts,
    }


def confirm_import(token: str) -> dict:
    entry = IMPORT_CACHE.get(token)
    if not entry:
        raise ValueError("Token de importación inválido o expirado.")

    records = entry["records"]
    by_client = entry["by_client"]
    fecha_corte = entry.get("fecha_corte") or datetime.now().date().isoformat()

    # Map records to copacol_facturas columns
    facturas_rows = [
        {
            "nit": r["cliente_nit"],
            "numero_factura": r["documento"],
            "monto": r["saldo"],
            "vlr_mora": r["vlr_mora"],
            "fecha_emision": r["fecha_emision"],
            "fecha_vencimiento": r["fecha_vencimiento"],
            "dias_mora": r["dias_mora"],
            "condicion_pago": r.get("cuenta", ""),
            "estado": "vigente" if r["dias_mora"] <= 0 else "vencido",
            "fecha_corte": fecha_corte,
        }
        for r in records
    ]

    # Map clients to copacol_clients columns
    client_rows = [
        {
            "nit": c["nit"],
            "razon_social": c["razon_social"],
            "ciudad": c.get("ciudad", ""),
            "asesor_codigo": c.get("asesor_codigo", ""),
            "asesor_nombre": c.get("asesor_nombre", ""),
            "telefono": c.get("telefono_1", ""),
            "telefono_2": c.get("telefono_2", ""),
            "direccion": c.get("direccion", ""),
            "total_saldo": c["saldo"],
            "total_vencido": c.get("vencido", 0.0),
            "total_vigente": c.get("vigente", 0.0),
            "num_facturas": c["facturas"],
            "num_vencidas": c["vencidas"],
            "dias_mora_max": c["dias_mora_max"],
            "fecha_corte": fecha_corte,
        }
        for c in by_client.values()
    ]

    # Upsert in batches of 500
    def batch_upsert(table: str, rows: list[dict], conflict_col: str) -> None:
        size = 500
        for i in range(0, len(rows), size):
            supabase_upsert(table, rows[i : i + size], conflict_col)

    batch_upsert("copacol_facturas", facturas_rows, "numero_factura")
    batch_upsert("copacol_clients", client_rows, "nit")

    del IMPORT_CACHE[token]

    return {
        "status": "imported",
        "facturas": len(facturas_rows),
        "clientes": len(client_rows),
        "fecha_corte": fecha_corte,
        "message": f"Importación exitosa: {len(facturas_rows)} facturas y {len(client_rows)} clientes actualizados.",
    }


XLSX_NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def column_number(cell_ref: str) -> int:
    letters = "".join(char for char in cell_ref if char.isalpha())
    number = 0
    for char in letters:
        number = number * 26 + ord(char.upper()) - 64
    return number


def excel_date(value: str) -> str | None:
    try:
        return (datetime(1899, 12, 30) + timedelta(days=float(value))).date().isoformat()
    except (TypeError, ValueError):
        return None


def parse_xlsx(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for si in root.findall("a:si", XLSX_NS):
                shared.append("".join((t.text or "") for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))

        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        rows: list[list[str]] = []
        for row in root.findall(".//a:sheetData/a:row", XLSX_NS):
            values: dict[int, str] = {}
            for cell in row.findall("a:c", XLSX_NS):
                ref = cell.attrib.get("r", "")
                raw_value = cell.find("a:v", XLSX_NS)
                value = ""
                if raw_value is not None:
                    if cell.attrib.get("t") == "s":
                        value = shared[int(raw_value.text or "0")]
                    else:
                        value = raw_value.text or ""
                values[column_number(ref)] = value
            if values:
                rows.append([values.get(index, "") for index in range(1, 21)])

    if len(rows) < 7:
        raise ValueError("El archivo no tiene suficientes filas para ser una cartera de Siigo.")

    expected = ["CIUDAD", "VENDED", "NIT", "DOCUMENTO", "FECHA", "VENCE", "DIAS", "SALDO"]
    header = [str(value).strip() for value in rows[5]]
    missing = [item for item in expected if item not in header]
    if missing:
        raise ValueError(f"No se encontraron columnas esperadas: {', '.join(missing)}")

    records = []
    by_client: dict[str, dict] = {}
    by_seller: dict[str, float] = defaultdict(float)
    aging = {"vigente": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "90_plus": 0.0}
    total_saldo = 0.0

    for raw in rows[6:]:
        if len(raw) < 20:
            continue
        if not raw[13] or not raw[4]:
            continue
        if any(str(value).strip().startswith("Total") for value in raw):
            continue

        saldo = money(raw[19])
        dias = money(raw[17])
        nit = str(raw[4]).strip()
        seller_code = str(raw[2]).strip() or "sin_codigo"
        seller_name = str(raw[3]).strip() or "Sin asesor"
        client_name = str(raw[6]).strip() or "Sin nombre"

        record = {
            "ciudad": str(raw[0]).strip(),
            "vendedor_codigo": seller_code,
            "vendedor_nombre": seller_name,
            "cliente_nit": nit,
            "cliente_nombre": client_name,
            "telefono_1": str(raw[7]).strip(),
            "telefono_2": str(raw[8]).strip(),
            "direccion": str(raw[9]).strip(),
            "cuenta": str(raw[10]).strip(),
            "documento": str(raw[13]).strip(),
            "fecha_emision": excel_date(raw[15]),
            "fecha_vencimiento": excel_date(raw[16]),
            "dias_mora": dias,
            "vlr_mora": money(raw[18]),
            "saldo": saldo,
        }
        records.append(record)
        total_saldo += saldo
        by_seller[f"{seller_code} - {seller_name}"] += saldo

        client = by_client.setdefault(
            nit,
            {
                "nit": nit,
                "razon_social": client_name,
                "saldo": 0.0,
                "facturas": 0,
                "vencidas": 0,
                "dias_mora_max": 0,
            },
        )
        client["saldo"] += saldo
        client["facturas"] += 1
        if dias > 0:
            client["vencidas"] += 1
            client["dias_mora_max"] = max(client["dias_mora_max"], dias)

        if dias <= 0:
            aging["vigente"] += saldo
        elif dias <= 30:
            aging["1_30"] += saldo
        elif dias <= 60:
            aging["31_60"] += saldo
        elif dias <= 90:
            aging["61_90"] += saldo
        else:
            aging["90_plus"] += saldo

    cut_date = None
    for row in rows[:6]:
        joined = " ".join(str(value) for value in row)
        match = re.search(r"(\d{4}/\d{2}/\d{2})", joined)
        if match:
            cut_date = match.group(1).replace("/", "-")
            break

    # Enrich by_client with extra fields needed for import
    for r in records:
        nit = r["cliente_nit"]
        c = by_client[nit]
        c.setdefault("ciudad", r["ciudad"])
        c.setdefault("asesor_codigo", r["vendedor_codigo"])
        c.setdefault("asesor_nombre", r["vendedor_nombre"])
        c.setdefault("telefono_1", r["telefono_1"])
        c.setdefault("telefono_2", r["telefono_2"])
        c.setdefault("direccion", r["direccion"])
        dias = r["dias_mora"]
        if dias > 0:
            c.setdefault("vencido", 0.0)
            c["vencido"] = c.get("vencido", 0.0) + r["saldo"]
        else:
            c.setdefault("vigente", 0.0)
            c["vigente"] = c.get("vigente", 0.0) + r["saldo"]

    import_token = str(uuid.uuid4())
    IMPORT_CACHE[import_token] = {
        "records": records,
        "by_client": by_client,
        "fecha_corte": cut_date,
        "created_at": datetime.now().isoformat(),
    }

    return {
        "status": "preview",
        "token": import_token,
        "fecha_corte_detectada": cut_date,
        "facturas": len(records),
        "clientes": len(by_client),
        "vendedores": len(by_seller),
        "saldo_total": total_saldo,
        "aging": aging,
        "top_clientes": sorted(by_client.values(), key=lambda c: c["saldo"], reverse=True)[:10],
        "top_vendedores": [
            {"vendedor": key, "saldo": value}
            for key, value in sorted(by_seller.items(), key=lambda item: item[1], reverse=True)[:10]
        ],
        "message": "Validación lista. Confirma para escribir en Supabase.",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/dashboard":
            try:
                json_response(self, 200, build_dashboard_payload())
            except Exception as exc:
                json_response(self, 500, {"error": str(exc)})
            return

        if parsed.path == "/api/config":
            json_response(self, 200, {"supabase_url": SUPABASE_URL, "anon_key": SUPABASE_ANON_KEY})
            return

        if parsed.path.startswith("/api/client/"):
            nit = parsed.path[len("/api/client/"):]
            if "/" not in nit:
                try:
                    json_response(self, 200, build_client_payload(nit))
                except Exception as exc:
                    json_response(self, 500, {"error": str(exc)})
                return

        path = "index.html" if parsed.path in {"/", ""} else parsed.path.lstrip("/")
        file_path = (STATIC / path).resolve()
        if not str(file_path).startswith(str(STATIC.resolve())) or not file_path.exists() or not file_path.is_file():
            json_response(self, 404, {"error": "Not found"})
            return

        content = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/import/confirm":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                json_response(self, 200, confirm_import(data.get("token", "")))
            except Exception as exc:
                json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path.startswith("/api/client/") and parsed.path.endswith("/contacto"):
            nit = parsed.path[len("/api/client/"):-len("/contacto")]
            length = int(self.headers.get("Content-Length", "0"))
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                row = {**data, "nit": nit, "created_at": data.get("created_at") or datetime.now().isoformat()}
                result = supabase_insert("copacol_log_contactos", row)
                json_response(self, 200, {"status": "ok", "data": result})
            except Exception as exc:
                json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path != "/api/import/preview":
            json_response(self, 404, {"error": "Not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)

        if "multipart/form-data" not in content_type:
            json_response(self, 400, {"error": "Envia el archivo como multipart/form-data."})
            return

        boundary_match = re.search("boundary=(.+)", content_type)
        if not boundary_match:
            json_response(self, 400, {"error": "No se encontro boundary del formulario."})
            return

        boundary = ("--" + boundary_match.group(1)).encode("utf-8")
        file_bytes = None
        for part in body.split(boundary):
            if b'filename="' not in part:
                continue
            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue
            file_bytes = part[header_end + 4 :].rstrip(b"\r\n--")
            break

        if not file_bytes:
            json_response(self, 400, {"error": "No se encontro archivo en la solicitud."})
            return

        try:
            with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = Path(tmp.name)
            preview = parse_xlsx(tmp_path)
            tmp_path.unlink(missing_ok=True)
            json_response(self, 200, preview)
        except Exception as exc:
            json_response(self, 400, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"COPACOL dashboard running on http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
