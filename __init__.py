"""ComfyUI Quick Paste - team base snippets + per-user local edits."""

from __future__ import annotations

import json
from pathlib import Path

WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_PACKAGE_DIR = Path(__file__).resolve().parent
_BASE_PATH = _PACKAGE_DIR / "snippets.base.json"


def _read_base() -> list:
    if not _BASE_PATH.exists():
        return []
    try:
        data = json.loads(_BASE_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[QuickModulePicker] Failed to read snippets.base.json: {exc}")
        return []

    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return data["items"]
    if isinstance(data, list):
        return data
    return []


def _write_base(items: list) -> None:
    payload = {
        "version": 2,
        "items": items,
    }
    _BASE_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _register_routes() -> None:
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/quickmodulepicker/base")
    async def qmp_get_base(request):
        return web.json_response(
            {
                "ok": True,
                "path": str(_BASE_PATH),
                "items": _read_base(),
            }
        )

    # Separate path from GET to avoid method conflicts on some ComfyUI / aiohttp setups
    @routes.post("/quickmodulepicker/save_base")
    async def qmp_save_base(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

        items = body.get("items", body)
        if not isinstance(items, list):
            return web.json_response(
                {"ok": False, "error": "'items' must be a list"}, status=400
            )

        try:
            _write_base(items)
        except Exception as exc:
            print(f"[QuickModulePicker] Failed to write snippets.base.json: {exc}")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

        return web.json_response(
            {
                "ok": True,
                "path": str(_BASE_PATH),
                "count": len(items),
            }
        )

    print(f"[QuickModulePicker] Routes ready. Team base file: {_BASE_PATH}")


try:
    _register_routes()
except Exception as exc:
    print(f"[QuickModulePicker] API routes not registered: {exc}")
