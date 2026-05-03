from __future__ import annotations

import base64
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


SUPABASE_URL = (os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
OLLAMA_URLS = [url.strip().rstrip("/") for url in os.environ.get("OLLAMA_URLS", OLLAMA_URL).split(",") if url.strip()]
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
N8N_API_TOKEN = os.environ.get("N8N_API_TOKEN", "")
N8N_IMPORT_WEBHOOK_URL = os.environ.get("N8N_IMPORT_WEBHOOK_URL", "").strip()
N8N_PROACTIVE_WEBHOOK_URL = os.environ.get("N8N_PROACTIVE_WEBHOOK_URL", "").strip()

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


def extract_multipart_file(body: bytes, content_type: str) -> tuple[bytes | None, str]:
    boundary_match = re.search("boundary=(.+)", content_type)
    if not boundary_match:
        return None, "cartera-siigo.xlsx"
    boundary = ("--" + boundary_match.group(1)).encode("utf-8")
    for part in body.split(boundary):
        if b'filename="' not in part:
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers = part[:header_end].decode("utf-8", errors="replace")
        filename_match = re.search(r'filename="([^"]+)"', headers)
        filename = filename_match.group(1) if filename_match else "cartera-siigo.xlsx"
        return part[header_end + 4:].rstrip(b"\r\n--"), filename
    return None, "cartera-siigo.xlsx"


def send_file_to_n8n(file_bytes: bytes, filename: str) -> dict:
    if not N8N_IMPORT_WEBHOOK_URL:
        raise RuntimeError("N8N_IMPORT_WEBHOOK_URL no está configurado.")

    boundary = f"----copacol-{uuid.uuid4().hex}"
    content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    parts = [
        f"--{boundary}",
        f'Content-Disposition: form-data; name="attachment_0"; filename="{filename}"',
        f"Content-Type: {content_type}",
        "",
    ]
    body = "\r\n".join(parts).encode("utf-8") + b"\r\n" + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
    }
    if N8N_API_TOKEN:
        headers["Authorization"] = f"Bearer {N8N_API_TOKEN}"

    req = urllib.request.Request(
        N8N_IMPORT_WEBHOOK_URL,
        data=body,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw:
                return {"status": "accepted", "message": "n8n recibió el archivo sin cuerpo de respuesta."}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"status": "accepted", "message": raw}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"n8n respondió {exc.code}: {detail}")


def post_json_to_n8n(url: str, payload: dict, timeout: int = 60) -> dict:
    if not url:
        raise RuntimeError("Webhook de n8n no configurado.")
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if N8N_API_TOKEN:
        headers["Authorization"] = f"Bearer {N8N_API_TOKEN}"
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw:
                return {"status": "received", "message": "n8n recibió la solicitud sin cuerpo de respuesta."}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"status": "received", "message": raw}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"n8n respondió {exc.code}: {detail}")


def response_output_text(payload: dict) -> str:
    if payload.get("output_text"):
        return str(payload["output_text"]).strip()
    parts: list[str] = []
    for item in payload.get("output", []) or []:
        for content in item.get("content", []) or []:
            text = content.get("text")
            if text:
                parts.append(str(text))
    return "\n".join(parts).strip()


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


def build_whatsapp_payload(nit: str, requested_by: str = "dashboard") -> dict:
    payload = build_client_payload(nit)
    client = payload.get("client") or {}
    if not client:
        raise ValueError("Cliente no encontrado.")
    phone = client.get("telefono") or client.get("telefono_2") or ""
    overdue = [
        inv for inv in payload.get("invoices", [])
        if money(inv.get("dias_mora")) > 0
    ]
    return {
        "action": "whatsapp_context_request",
        "source": "copacol_dashboard",
        "requested_at": datetime.now().isoformat(),
        "requested_by": requested_by or "dashboard",
        "telefono": phone,
        "client": client,
        "invoices": payload.get("invoices", []),
        "overdue_invoices": sorted(overdue, key=lambda inv: money(inv.get("dias_mora")), reverse=True)[:20],
        "promises": payload.get("promises", []),
        "payments": payload.get("payments", []),
        "contacts": payload.get("contacts", []),
        "ai_context": {
            "cliente": client.get("razon_social"),
            "nit": client.get("nit"),
            "telefono": phone,
            "asesor": client.get("asesor_nombre"),
            "saldo_total": client.get("total_saldo"),
            "saldo_vencido": client.get("total_vencido"),
            "saldo_vigente": client.get("total_vigente"),
            "facturas": client.get("num_facturas"),
            "facturas_vencidas": client.get("num_vencidas"),
            "dias_mora_max": client.get("dias_mora_max"),
            "etapa_cobranza": client.get("etapa_cobranza"),
            "fecha_corte": client.get("fecha_corte"),
            "ultimas_gestiones": payload.get("contacts", [])[:5],
        },
    }


def call_ai(system: str, user: str) -> str:
    if OPENAI_API_KEY:
        body = json.dumps({
            "model": OPENAI_MODEL,
            "instructions": system,
            "input": user,
            "max_output_tokens": 900,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.openai.com/v1/responses",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = response_output_text(json.loads(resp.read().decode("utf-8")))
                if text:
                    return text
                raise RuntimeError("OpenAI no devolvió texto en la respuesta.")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI error {exc.code}: {detail}")

    # Intenta Ollama primero (interno, sin API key)
    ollama_errors: list[str] = []
    for base_url in OLLAMA_URLS:
        try:
            body = json.dumps({
                "model": OLLAMA_MODEL,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "stream": False,
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{base_url}/api/chat",
                data=body,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))["message"]["content"]
        except Exception as exc:
            ollama_errors.append(f"{base_url}: {exc}")

    # Fallback: Groq (requiere GROQ_API_KEY)
    if not GROQ_API_KEY:
        raise RuntimeError(f"Asistente IA no disponible. Revisa OLLAMA_URLS. Detalle: {' | '.join(ollama_errors[-3:])}")
    body = json.dumps({
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": 1024,
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if exc.code == 403 and "1010" in detail:
            raise RuntimeError("Groq bloqueó la solicitud desde esta red (403/1010). Revisa Ollama interno o usa el modo local del asistente.")
        raise RuntimeError(f"Groq error {exc.code}: {detail}")


def local_assistant_answer(question: str, ctx: dict) -> str:
    q = question.lower()

    def fmt(value) -> str:
        return f"${money(value) / 1_000_000:.1f}M"

    aging = ctx.get("aging") or {}
    condition_mix = ctx.get("condition_mix") or []
    top_clients = ctx.get("top_clientes") or []
    pareto_clients = ctx.get("pareto_clientes") or top_clients
    top_advisors = ctx.get("top_asesores") or []
    overdue_invoices = ctx.get("facturas_vencidas_top") or []
    total_saldo = money(ctx.get("total_saldo"))
    total_vencido = money(ctx.get("total_vencido"))
    pct_vencido = money(ctx.get("pct_vencido"))
    fecha_corte = ctx.get("fecha_corte") or "sin fecha"
    semaforo = "verde" if pct_vencido <= 8 else "amarillo" if pct_vencido <= 15 else "rojo"

    def client_line(client: dict) -> str:
        return f"{client.get('razon_social', 'Cliente')} ({fmt(client.get('total_vencido'))}, {money(client.get('dias_mora_max')):.0f} días, asesor {client.get('asesor_nombre', 'sin asesor')})"

    def advisor_line(advisor: dict) -> str:
        return f"{advisor.get('nombre', 'Asesor')} ({fmt(advisor.get('vencido') or advisor.get('total'))} vencido, {money(advisor.get('pct_vencido')) * 100:.0f}%)"

    def invoice_line(invoice: dict) -> str:
        return f"{invoice.get('numero_factura', 'Factura')} de {invoice.get('cliente', 'cliente sin nombre')} por {fmt(invoice.get('monto'))}, vencida el {invoice.get('fecha_vencimiento') or 'sin fecha'} con {money(invoice.get('dias_mora')):.0f} días de mora"

    if any(term in q for term in ["pareto", "80/20", "80 20"]):
        top = "; ".join(
            f"{c.get('razon_social', 'Cliente')} aporta {fmt(c.get('total_vencido'))} ({money(c.get('pct_vencido_total')) * 100:.1f}% del vencido)"
            for c in pareto_clients[:5]
        ) or "no hay clientes vencidos para calcular Pareto"
        pct_top10 = money(ctx.get("concentracion_top10_pct")) * 100
        return f"El Pareto de clientes muestra qué pocos clientes concentran la mayor parte de la cartera vencida. En esta vista, el top 10 concentra cerca del {pct_top10:.1f}% del saldo total; los principales son: {top}. Sirve para priorizar gestión donde cada llamada mueve más dinero."

    if any(term in q for term in ["composición", "composicion", "compuesta", "mix", "condición", "condicion"]):
        aging_txt = ", ".join(f"{key}: {fmt(value)}" for key, value in aging.items() if money(value)) or "sin distribución por edad"
        cond_txt = ", ".join(
            f"{item.get('condicion', 'sin condición')}: {fmt(item.get('saldo'))}"
            for item in condition_mix[:5]
        ) or "sin composición por condición de pago"
        return f"La cartera se compone así: vigente {fmt(ctx.get('total_vigente'))} y vencida {fmt(total_vencido)} sobre {fmt(total_saldo)} total. Por edad: {aging_txt}. Por condición de pago: {cond_txt}."

    if any(term in q for term in ["factura más vieja", "factura mas vieja", "más antigua", "mas antigua", "mayor mora", "factura vieja"]):
        if overdue_invoices:
            oldest = sorted(overdue_invoices, key=lambda inv: money(inv.get("dias_mora")), reverse=True)[0]
            return f"La factura vencida más vieja en la vista actual es {invoice_line(oldest)}. Recomiendo revisarla primero con el asesor {oldest.get('asesor_nombre', 'sin asesor')} y confirmar si existe pago no aplicado o promesa documentada."
        return "No encontré facturas vencidas en el contexto actual. Revisa si los filtros del dashboard están limitando la cartera visible."

    if any(term in q for term in ["primero", "prioridad", "llamar", "cobrar"]):
        clients = "; ".join(client_line(c) for c in top_clients[:4]) or "no hay clientes críticos visibles"
        return f"Prioridad de contacto: {clients}. Empieza por los mayores saldos vencidos y más días de mora, validando si ya pagaron antes de ofrecer acuerdo. Corte: {fecha_corte}."

    if any(term in q for term in ["asesor", "crítico", "critico", "riesgo"]):
        advisors = "; ".join(advisor_line(a) for a in top_advisors[:4]) or "no hay asesores críticos visibles"
        return f"Los asesores con mayor presión de cartera son: {advisors}. Recomiendo revisar sus clientes vencidos de mayor saldo y activar seguimiento diario hasta normalizar pagos."

    if any(term in q for term in ["90", "+90", "noventa"]):
        over_90 = money(aging.get("90_plus") or aging.get("91_120") or 0) + money(aging.get("121_180")) + money(aging.get("181_plus"))
        return f"La cartera superior a 90 días está en {fmt(over_90)} según la vista actual. Si ese valor es bajo, el foco operativo debe estar en 1-30 y 31-60 días para evitar que escale."

    if any(term in q for term in ["semáforo", "semaforo", "verde", "amarillo", "rojo"]):
        return f"El semáforo está en {semaforo}: cartera vencida {fmt(total_vencido)} sobre saldo total {fmt(total_saldo)}, equivalente a {pct_vencido:.1f}%. Si supera 15%, lo trataría como alerta roja operativa."

    if any(term in q for term in ["resumen", "ejecutivo", "estado", "cómo está", "como esta"]):
        top = client_line(top_clients[0]) if top_clients else "sin cliente crítico destacado"
        return f"Resumen al corte {fecha_corte}: saldo total {fmt(total_saldo)}, vencido {fmt(total_vencido)} ({pct_vencido:.1f}%) y semáforo {semaforo}. El principal foco es {top}. Recomiendo priorizar llamadas a los mayores saldos vencidos y cerrar compromisos de pago documentados."

    return "Puedo ayudarte con cartera, cobranzas, clientes, asesores, facturas vencidas y prioridades del dashboard. Con los datos actuales, la acción más útil es priorizar clientes por saldo vencido, días de mora y asesor responsable."


def confirm_import(token: str, use_n8n: bool = False) -> dict:
    entry = IMPORT_CACHE.get(token)
    if not entry:
        raise ValueError("Token de importación inválido o expirado.")

    if use_n8n:
        file_bytes = entry.get("file_bytes")
        if not file_bytes:
            raise ValueError("El archivo original ya no está disponible para enviarlo a n8n. Vuelve a validar el XLSX.")
        result = send_file_to_n8n(file_bytes, entry.get("filename") or "cartera-siigo.xlsx")
        del IMPORT_CACHE[token]
        if isinstance(result, list):
            result = result[0] if result else {"status": "accepted"}
        if not isinstance(result, dict):
            result = {"status": "accepted", "message": str(result)}
        result.setdefault("status", "imported")
        result.setdefault("message", "Archivo enviado a n8n. Supabase fue actualizado por el flujo de ingesta.")
        result["via"] = "n8n"
        return result

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
            json_response(
                self,
                200,
                {
                    "supabase_url": SUPABASE_URL,
                    "anon_key": SUPABASE_ANON_KEY,
                    "n8n_import_enabled": bool(N8N_IMPORT_WEBHOOK_URL),
                    "n8n_proactive_enabled": bool(N8N_PROACTIVE_WEBHOOK_URL),
                },
            )
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
                json_response(self, 200, confirm_import(data.get("token", ""), use_n8n=bool(N8N_IMPORT_WEBHOOK_URL)))
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

        if parsed.path.startswith("/api/client/") and parsed.path.endswith("/whatsapp"):
            nit = parsed.path[len("/api/client/"):-len("/whatsapp")]
            length = int(self.headers.get("Content-Length", "0"))
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                payload = build_whatsapp_payload(nit, data.get("requested_by") or "dashboard")
                result = post_json_to_n8n(N8N_PROACTIVE_WEBHOOK_URL, payload)
                json_response(self, 200, {
                    "status": result.get("status", "received"),
                    "message": result.get("message", "Contexto enviado al flujo proactivo."),
                    "workflow": result.get("workflow", "COPACOL_Cobranza_Proactivo"),
                    "nit": payload["client"].get("nit"),
                    "cliente": payload["client"].get("razon_social"),
                    "telefono": payload.get("telefono"),
                    "via": "n8n",
                    "n8n": result,
                })
            except Exception as exc:
                json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/assistant":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                question = (data.get("question") or "").strip()
                if not question:
                    json_response(self, 400, {"error": "Pregunta vacía"})
                    return
                ctx = data.get("context") or {}

                def fmt(v: float) -> str:
                    return f"${v / 1_000_000:.1f}M"

                clients_txt = "\n".join(
                    f"- {c.get('razon_social','?')}: {fmt(money(c.get('total_vencido')))} vencido, {c.get('dias_mora_max',0):.0f} días, asesor {c.get('asesor_nombre','?')}"
                    for c in (ctx.get("top_clientes") or [])[:8]
                )
                asesores_txt = "\n".join(
                    f"- {a.get('nombre','?')}: {fmt(money(a.get('total')))} cartera, {money(a.get('pct_vencido',0))*100:.0f}% vencido"
                    for a in (ctx.get("top_asesores") or [])[:5]
                )
                aging_txt = "\n".join(
                    f"- {k}: {fmt(money(v))}"
                    for k, v in (ctx.get("aging") or {}).items()
                )
                condition_txt = "\n".join(
                    f"- {c.get('condicion','sin condición')}: {fmt(money(c.get('saldo')))}"
                    for c in (ctx.get("condition_mix") or [])[:8]
                )
                pareto_txt = "\n".join(
                    f"- {c.get('razon_social','?')}: {fmt(money(c.get('total_vencido')))} vencido ({money(c.get('pct_vencido_total'))*100:.1f}% del vencido), {c.get('dias_mora_max',0):.0f} días, asesor {c.get('asesor_nombre','?')}"
                    for c in (ctx.get("pareto_clientes") or [])[:10]
                )
                invoices_txt = "\n".join(
                    f"- {inv.get('numero_factura','?')} · {inv.get('cliente','?')}: {fmt(money(inv.get('monto')))}, vence/venció {inv.get('fecha_vencimiento') or '-'}, {money(inv.get('dias_mora')):.0f} días, asesor {inv.get('asesor_nombre','?')}"
                    for inv in (ctx.get("facturas_vencidas_top") or [])[:10]
                )
                pct_vencido = money(ctx.get("pct_vencido", 0))
                semaforo = "🟢 Verde" if pct_vencido <= 8 else "🟡 Amarillo" if pct_vencido <= 15 else "🔴 Rojo"

                system_prompt = f"""Eres el asistente de cobranzas de COPACOL, distribuidor ferretero colombiano. \
Tu única función es ayudar al equipo con preguntas sobre la cartera de crédito, cobranzas, clientes, asesores y métricas financieras del dashboard.

RESTRICCIÓN IMPORTANTE: Si la pregunta no está relacionada con cartera, cobranzas, clientes, asesores, facturas, mora, pagos o el dashboard de COPACOL, responde ÚNICAMENTE: "Solo puedo ayudarte con preguntas sobre la cartera y cobranzas de COPACOL."

DATOS ACTUALES (corte: {ctx.get('fecha_corte') or 'sin fecha'}):
- Saldo total: {fmt(money(ctx.get('total_saldo')))}
- Cartera vencida: {fmt(money(ctx.get('total_vencido')))} ({pct_vencido:.1f}% del total) · Semáforo: {semaforo}
- Cartera vigente: {fmt(money(ctx.get('total_vigente')))}
- Clientes: {ctx.get('clientes',0)} activos, {ctx.get('clientes_vencidos',0)} con mora
- Mora promedio: {money(ctx.get('mora_promedio',0)):.0f} días
- Facturas vencidas: {ctx.get('facturas_vencidas',0)}

DISTRIBUCIÓN POR EDAD:
{aging_txt}

COMPOSICIÓN POR CONDICIÓN DE PAGO:
{condition_txt}

TOP CLIENTES CON MAYOR MORA:
{clients_txt}

PARETO DE CLIENTES VENCIDOS:
{pareto_txt}

FACTURAS VENCIDAS MÁS ANTIGUAS / CRÍTICAS:
{invoices_txt}

ASESORES:
{asesores_txt}

Reglas de respuesta:
- Español, tono operativo y directo.
- Montos en millones (ej: $2.4M).
- Sé específico: nombra clientes, asesores y montos reales cuando des recomendaciones.
- Máximo 4 oraciones salvo que pidan análisis completo."""

                try:
                    answer = call_ai(system_prompt, question)
                except Exception:
                    answer = local_assistant_answer(question, ctx)
                json_response(self, 200, {"answer": answer})
            except Exception as exc:
                json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/n8n/preview":
            auth = self.headers.get("Authorization", "")
            if not N8N_API_TOKEN or auth != f"Bearer {N8N_API_TOKEN}":
                json_response(self, 401, {"error": "Unauthorized"})
                return
            content_type = self.headers.get("Content-Type", "")
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            file_bytes = None
            if "openxmlformats" in content_type or "octet-stream" in content_type or "excel" in content_type:
                file_bytes = body
            elif "multipart/form-data" in content_type:
                file_bytes, _ = extract_multipart_file(body, content_type)
            if not file_bytes:
                json_response(self, 400, {"error": "No se encontro archivo xlsx en la solicitud."})
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
            return

        if parsed.path == "/api/n8n/import":
            auth = self.headers.get("Authorization", "")
            if not N8N_API_TOKEN or auth != f"Bearer {N8N_API_TOKEN}":
                json_response(self, 401, {"error": "Unauthorized"})
                return
            content_type = self.headers.get("Content-Type", "")
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            file_bytes = None
            if "application/json" in content_type:
                data = json.loads(body.decode("utf-8"))
                file_b64 = data.get("file_base64", "")
                if not file_b64:
                    json_response(self, 400, {"error": "Campo file_base64 requerido."})
                    return
                file_bytes = base64.b64decode(file_b64)
            elif "multipart/form-data" in content_type:
                file_bytes, _ = extract_multipart_file(body, content_type)
            elif "openxmlformats" in content_type or "octet-stream" in content_type or "excel" in content_type:
                # Binary body enviado directamente por n8n (contentType: binaryData)
                file_bytes = body
            else:
                json_response(self, 400, {"error": "Envia application/json con file_base64, multipart/form-data o binario xlsx."})
                return
            if not file_bytes:
                json_response(self, 400, {"error": "No se encontro archivo en la solicitud."})
                return
            try:
                with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
                    tmp.write(file_bytes)
                    tmp_path = Path(tmp.name)
                preview = parse_xlsx(tmp_path)
                tmp_path.unlink(missing_ok=True)
                result = confirm_import(preview["token"])
                json_response(self, 200, result)
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

        file_bytes, filename = extract_multipart_file(body, content_type)

        if not file_bytes:
            json_response(self, 400, {"error": "No se encontro archivo en la solicitud."})
            return

        try:
            with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = Path(tmp.name)
            preview = parse_xlsx(tmp_path)
            tmp_path.unlink(missing_ok=True)
            IMPORT_CACHE[preview["token"]]["file_bytes"] = file_bytes
            IMPORT_CACHE[preview["token"]]["filename"] = filename
            json_response(self, 200, preview)
        except Exception as exc:
            json_response(self, 400, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"COPACOL dashboard running on http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
