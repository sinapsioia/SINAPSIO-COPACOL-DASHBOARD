#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FILE = Path("/Users/jpshak/Desktop/BASE DE DATOS TERCEROS.xlsx")
XLSX_NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


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


def column_number(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    number = 0
    for char in letters:
        number = number * 26 + ord(char.upper()) - 64
    return number


def normalize_text(value) -> str:
    return str(value or "").strip()


def normalize_nit(value) -> str:
    return re.sub(r"\D+", "", normalize_text(value))


def money(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def int_or_none(value):
    value = normalize_text(value)
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def credit_condition_key(plazo, observacion: str = "") -> str:
    plazo_txt = normalize_text(plazo).split(".")[0]
    obs = normalize_text(observacion).upper()
    if "PLATAM" in obs:
        return "platam_60d" if "60" in obs or plazo_txt == "60" else "platam_30d"
    if "CONTADO" in obs or plazo_txt in {"0", "1"}:
        return "contado"
    if "45" in obs or plazo_txt == "45":
        return "credito_45d"
    if "60" in obs or plazo_txt == "60":
        return "credito_60d"
    if plazo_txt == "30":
        return "platam_30d"
    return "credito_otro" if plazo_txt else "sin_condicion_real"


def condition_label(key: str) -> str:
    labels = {
        "platam_30d": "PLATAM 30 DIAS",
        "platam_60d": "PLATAM 60 DIAS",
        "credito_45d": "COPACOL 45 DIAS",
        "credito_60d": "COPACOL 60 DIAS",
        "contado": "CONTADO",
        "credito_otro": "CREDITO OTRO",
    }
    return labels.get(key, "SIN CONDICION")


def read_xlsx(path: Path) -> list[dict]:
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for si in root.findall("a:si", XLSX_NS):
                shared.append("".join((t.text or "") for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))

        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        rows: list[tuple[int, dict[int, str]]] = []
        for row in sheet.findall(".//a:sheetData/a:row", XLSX_NS):
            values: dict[int, str] = {}
            for cell in row.findall("a:c", XLSX_NS):
                raw_value = cell.find("a:v", XLSX_NS)
                if raw_value is None:
                    continue
                value = raw_value.text or ""
                if cell.attrib.get("t") == "s":
                    value = shared[int(value)] if value else ""
                values[column_number(cell.attrib.get("r", ""))] = value
            if values:
                rows.append((int(row.attrib.get("r", "0")), values))

    parsed = []
    for row_number, row in rows:
        if row_number < 6:
            continue
        nit = normalize_nit(row.get(1))
        if not nit:
            continue
        plazo = int_or_none(row.get(11))
        observacion = normalize_text(row.get(12))
        key = credit_condition_key(plazo, observacion)
        parsed.append(
            {
                "nit": nit,
                "sucursal": normalize_text(row.get(2)),
                "digito_verificacion": normalize_text(row.get(3)),
                "nombre": normalize_text(row.get(4)),
                "direccion": normalize_text(row.get(5)),
                "ciudad_codigo": normalize_text(row.get(6)),
                "activo": normalize_text(row.get(7)),
                "clasificacion": normalize_text(row.get(8)),
                "cupo_credito": money(row.get(9)),
                "vendedor_codigo": normalize_text(row.get(10)),
                "plazo_pago_real": plazo,
                "condicion_credito": condition_label(key),
                "condicion_key": key,
                "observacion": observacion,
                "source_filename": path.name,
                "raw": {
                    "fila": row_number,
                    "identificacion": normalize_text(row.get(1)),
                    "plazo_pago_real": normalize_text(row.get(11)),
                    "observacion": observacion,
                },
            }
        )
    return parsed


def dedupe_by_nit(rows: list[dict]) -> list[dict]:
    deduped: dict[str, dict] = {}
    for row in rows:
        nit = row.get("nit")
        if nit:
            deduped[nit] = row
    return list(deduped.values())


def chunks(rows: list[dict], size: int = 500):
    for index in range(0, len(rows), size):
        yield rows[index:index + size]


def upsert_rows(rows: list[dict]) -> None:
    supabase_url = (os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not supabase_key:
        raise RuntimeError("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env")

    endpoint = f"{supabase_url}/rest/v1/copacol_terceros_credito?{urllib.parse.urlencode({'on_conflict': 'nit'})}"
    for chunk in chunks(rows):
        body = json.dumps(chunk, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as response:
            response.read()


def main() -> int:
    load_env()
    dry_run = "--dry-run" in sys.argv
    args = [arg for arg in sys.argv[1:] if arg != "--dry-run"]
    path = Path(args[0]) if args else DEFAULT_FILE
    rows = read_xlsx(path)
    unique_rows = dedupe_by_nit(rows)
    counts = Counter(row["condicion_key"] for row in rows)
    unique_counts = Counter(row["condicion_key"] for row in unique_rows)
    print(f"Archivo: {path}")
    print(f"Terceros leídos: {len(rows)}")
    print(f"Terceros únicos por NIT: {len(unique_rows)}")
    for key, count in counts.most_common():
        print(f"- {key}: {count} leídos · {unique_counts.get(key, 0)} únicos")
    if dry_run:
        print("Dry run: no se subió información a Supabase.")
    else:
        upsert_rows(unique_rows)
        print("Carga completada en Supabase.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
