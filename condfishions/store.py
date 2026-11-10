"""Persistence: Supabase (PostgREST + Storage) when configured, local JSON otherwise."""
from __future__ import annotations

import gzip
import json
import os
from pathlib import Path

import requests

from .config import ROOT


class Store:
    def __init__(self):
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        self.enabled = bool(self.url and self.key)
        self.out = ROOT / "out"
        if not self.enabled:
            self.out.mkdir(exist_ok=True)

    # ── helpers ────────────────────────────────────────────────────────────────
    def _h(self, extra: dict | None = None) -> dict:
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}",
             "Content-Type": "application/json"}
        h.update(extra or {})
        return h

    def upsert(self, table: str, rows: list[dict], on_conflict: str, chunk: int = 1000) -> None:
        if not rows:
            return
        if not self.enabled:
            self._dump(table, rows)
            return
        for i in range(0, len(rows), chunk):
            r = requests.post(
                f"{self.url}/rest/v1/{table}", params={"on_conflict": on_conflict},
                headers=self._h({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                data=json.dumps(rows[i:i + chunk], default=str), timeout=120)
            if r.status_code >= 300:
                raise RuntimeError(f"upsert {table} failed {r.status_code}: {r.text[:500]}")

    def insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        if not self.enabled:
            self._dump(table, rows)
            return
        r = requests.post(f"{self.url}/rest/v1/{table}", headers=self._h({"Prefer": "return=minimal"}),
                          data=json.dumps(rows, default=str), timeout=120)
        if r.status_code >= 300:
            raise RuntimeError(f"insert {table} failed {r.status_code}: {r.text[:500]}")

    def delete_before(self, table: str, column: str, iso: str) -> None:
        if not self.enabled:
            return
        r = requests.delete(f"{self.url}/rest/v1/{table}", params={column: f"lt.{iso}"},
                            headers=self._h(), timeout=120)
        if r.status_code >= 300:
            raise RuntimeError(f"delete {table} failed {r.status_code}: {r.text[:500]}")

    def get_settings(self) -> dict | None:
        """Home location etc. set from the app (settings table, single row id=1)."""
        if not self.enabled:
            return None
        r = requests.get(f"{self.url}/rest/v1/settings", params={"id": "eq.1", "select": "*"},
                         headers=self._h(), timeout=60)
        if r.status_code >= 300 or not r.json():
            return None
        return r.json()[0]

    def upload_gz(self, bucket: str, path: str, obj) -> None:
        data = gzip.compress(json.dumps(obj, default=str).encode())
        if not self.enabled:
            p = self.out / bucket / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return
        r = requests.post(f"{self.url}/storage/v1/object/{bucket}/{path}",
                          headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                                   "Content-Type": "application/gzip", "x-upsert": "true"},
                          data=data, timeout=120)
        if r.status_code >= 300:
            raise RuntimeError(f"upload {bucket}/{path} failed {r.status_code}: {r.text[:300]}")

    def _dump(self, table: str, rows: list[dict]) -> None:
        p = self.out / f"{table}.json"
        existing = json.loads(p.read_text()) if p.exists() else []
        p.write_text(json.dumps(existing + rows, default=str, indent=1))
