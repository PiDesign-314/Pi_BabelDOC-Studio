"""Persistent settings for BabelDOC Studio.

Secrets (API keys) are encrypted with Windows DPAPI so they can only be
decrypted by the current Windows user.  On non-Windows hosts the value falls
back to base64 with an explicit ``plain:`` marker.
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import sys
from ctypes import wintypes
from pathlib import Path

APP_NAME = "BabelDOC-Studio"
APP_DIR = Path(os.environ.get("APPDATA") or Path.home()) / APP_NAME
SETTINGS_FILE = APP_DIR / "settings.json"
GLOSSARY_DIR = APP_DIR / "glossaries"
UPLOAD_DIR = APP_DIR / "uploads"
DEFAULT_OUTPUT = Path.home() / "Documents" / "BabelDOC-Studio"

DEFAULTS: dict = {
    "exe_path": "",
    "active_provider": "zhipu",
    "providers": {},
    "lang_in": "en",
    "lang_out": "zh",
    "page_mode": "all",
    "page_range": "",
    "dual_mode": "side",
    "glossary_ids": [],
    "auto_glossary": True,
    "save_glossary": True,
    "skip_references": True,
    "reference_page": "",
    "output_dir": str(DEFAULT_OUTPUT),
    "watermark": "no_watermark",
    "open_when_done": True,
    "qps": 4,
    "custom_prompt": "",
    "price_input": "",
    "price_output": "",
    "price_currency": "",
    "skip_scanned": False,
    "ocr_workaround": False,
    "term_model": "",
    "term_model_enabled": False,
}


# --------------------------------------------------------------------------- #
# Windows DPAPI helpers
# --------------------------------------------------------------------------- #
class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data)
    blob = _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    return blob, buffer


def _dpapi_available() -> bool:
    return sys.platform == "win32"


def protect(secret: str) -> str:
    if not secret:
        return ""
    if not _dpapi_available():
        return "plain:" + base64.b64encode(secret.encode("utf-8")).decode("ascii")
    in_blob, _buf = _blob(secret.encode("utf-8"))
    out_blob = _DataBlob()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(in_blob), "BabelDOC-Studio", None, None, None, 0,
        ctypes.byref(out_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        return "dpapi:" + base64.b64encode(encrypted).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def unprotect(token: str) -> str:
    if not token:
        return ""
    try:
        if token.startswith("plain:"):
            return base64.b64decode(token[6:]).decode("utf-8")
        if token.startswith("dpapi:"):
            if not _dpapi_available():
                return ""
            raw = base64.b64decode(token[6:])
            in_blob, _buf = _blob(raw)
            out_blob = _DataBlob()
            ok = ctypes.windll.crypt32.CryptUnprotectData(
                ctypes.byref(in_blob), None, None, None, None, 0,
                ctypes.byref(out_blob),
            )
            if not ok:
                return ""
            try:
                return ctypes.string_at(out_blob.pbData, out_blob.cbData).decode("utf-8")
            finally:
                ctypes.windll.kernel32.LocalFree(out_blob.pbData)
    except Exception:
        return ""
    return ""


# --------------------------------------------------------------------------- #
# Settings store
# --------------------------------------------------------------------------- #
def _merge(defaults: dict, loaded: dict) -> dict:
    merged = dict(defaults)
    for key, value in loaded.items():
        if key == "providers" and isinstance(value, dict):
            merged["providers"] = {**value}
        else:
            merged[key] = value
    return merged


def load_raw() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return _merge(DEFAULTS, data)
    except (OSError, ValueError):
        pass
    return dict(DEFAULTS)


def save_raw(settings: dict) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def public_settings() -> dict:
    """Settings with decrypted API keys, safe to hand to the local UI."""
    settings = load_raw()
    providers = {}
    for pid, data in (settings.get("providers") or {}).items():
        if not isinstance(data, dict):
            continue
        providers[pid] = {
            "base_url": data.get("base_url", ""),
            "model": data.get("model", ""),
            "api_key": unprotect(data.get("api_key_enc", "")),
            "remember": bool(data.get("remember", False)),
        }
    settings["providers"] = providers
    settings.pop("_raw", None)
    return settings


def save_public(payload: dict) -> dict:
    """Persist settings coming from the UI, encrypting API keys again."""
    settings = load_raw()
    providers = {}
    for pid, data in (payload.get("providers") or {}).items():
        if not isinstance(data, dict):
            continue
        api_key = (data.get("api_key") or "").strip()
        remember = bool(data.get("remember"))
        providers[pid] = {
            "base_url": (data.get("base_url") or "").strip(),
            "model": (data.get("model") or "").strip(),
            "remember": remember,
            "api_key_enc": protect(api_key) if (remember and api_key) else "",
            # keep the plain key in memory only via the response below
            "_plain": api_key,
        }
    stored = {k: v for k, v in payload.items() if k != "providers"}
    stored["providers"] = {
        pid: {k: v for k, v in data.items() if k != "_plain"}
        for pid, data in providers.items()
    }
    for key, value in DEFAULTS.items():
        stored.setdefault(key, value)
    save_raw(stored)

    result = dict(stored)
    result["providers"] = {
        pid: {
            "base_url": data["base_url"],
            "model": data["model"],
            "remember": data["remember"],
            "api_key": data["_plain"],
        }
        for pid, data in providers.items()
    }
    return result


def ensure_dirs() -> None:
    for path in (APP_DIR, GLOSSARY_DIR, UPLOAD_DIR, Path(DEFAULTS["output_dir"])):
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
