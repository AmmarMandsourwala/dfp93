from __future__ import annotations

from http import HTTPStatus
from urllib.parse import parse_qs, urlsplit

from backend.server import AppHandler, get_telemetry, json_response, record_telemetry


class handler(AppHandler):
    def _restore_rewritten_path(self) -> None:
        parsed = urlsplit(self.path)
        route = parse_qs(parsed.query).get("route", [""])[0]
        if route:
            self.path = route if route.startswith("/") else f"/{route}"

    def _refresh_telemetry(self) -> None:
        record_telemetry(get_telemetry())

    def do_GET(self) -> None:
        self._restore_rewritten_path()
        route = self.path.split("?", 1)[0]
        if route in {"/api/state", "/api/events"}:
            self._refresh_telemetry()
        if route == "/api/events":
            json_response(self, {"ok": True}, HTTPStatus.OK)
            return
        super().do_GET()

    def do_POST(self) -> None:
        self._restore_rewritten_path()
        route = self.path.split("?", 1)[0]
        if route == "/api/batch/start":
            self._refresh_telemetry()
        super().do_POST()
