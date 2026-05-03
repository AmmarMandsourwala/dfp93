from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"
FRUITS_PATH = DATA_DIR / "fruits.json"
FIREBASE_WEIGHT_URL = os.getenv(
    "FIREBASE_WEIGHT_URL",
    "https://food-dryer-dab22-default-rtdb.asia-southeast1.firebasedatabase.app/foodDrier/live.json",
).rstrip("/")
FIREBASE_BASE_URL = os.getenv(
    "FIREBASE_BASE_URL",
    "https://food-dryer-dab22-default-rtdb.asia-southeast1.firebasedatabase.app",
).rstrip("/")
FIREBASE_SECRET = os.getenv("FIREBASE_SECRET", "MBU8l4t114ysjAytcWqhuNv6A4Iub7c86utPwXaW")
FIREBASE_CONTROL_PATH = os.getenv("FIREBASE_CONTROL_PATH", "foodDrier").strip("/")
POLL_SECONDS = float(os.getenv("POLL_SECONDS", "1.0"))
alTELEMETRY_SAMPLE_SECONDS = float(os.getenv("TELEMETRY_SAMPLE_SECONDS", "120"))


@dataclass
class BatchState:
    running: bool = False
    fruit_id: str | None = None
    fruit_name: str | None = None
    started_at: float | None = None
    initial_weight_g: float | None = None
    target_weight_g: float | None = None
    estimated_minutes: float | None = None
    remaining_minutes: float | None = None
    completed_at: float | None = None
    notified: bool = False
    prev_weight_g: float | None = None
    curr_weight_g: float | None = None
    last_weight_check_time: float | None = None
    stabilization_warning: bool = False


class DryerState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.batch = BatchState()
        self.latest: dict[str, Any] = {}
        self.history: list[dict[str, Any]] = []
        self.sample_window_started_at: float | None = None
        self.sample_window_weights: list[float] = []
        self.selected_fruit_id: str | None = None
        self.manual_weight_g: float | None = None
        self.use_manual_weight: bool = False
        self.manual_elapsed_minutes: float | None = None
        self.use_manual_elapsed_time: bool = False
        self.manual_elapsed_started_at: float | None = None

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "batch": asdict(self.batch),
                "latest": self.latest,
                "history": self.history[-720:],
                "selected_fruit_id": self.selected_fruit_id,
                "firebase_weight_url": FIREBASE_WEIGHT_URL or None,
                "telemetry_sample_seconds": TELEMETRY_SAMPLE_SECONDS,
                "manual_weight_g": self.manual_weight_g,
                "use_manual_weight": self.use_manual_weight,
                "manual_elapsed_minutes": self.manual_elapsed_minutes,
                "use_manual_elapsed_time": self.use_manual_elapsed_time,
                "manual_elapsed_started_at": self.manual_elapsed_started_at,
            }


STATE = DryerState()


def load_fruits() -> list[dict[str, Any]]:
    with FRUITS_PATH.open("r", encoding="utf-8") as file:
        return json.load(file)


def fruit_by_id(fruit_id: str) -> dict[str, Any] | None:
    for fruit in load_fruits():
        if fruit["id"] == fruit_id:
            return fruit
    return None


def json_response(handler: SimpleHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_request_json(handler: SimpleHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length == 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def call_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=2.5) as response:
        return json.loads(response.read().decode("utf-8"))


def firebase_url(path: str) -> str:
    url = f"{FIREBASE_BASE_URL}/{path.strip('/')}.json"
    if FIREBASE_SECRET:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}auth={FIREBASE_SECRET}"
    return url


def patch_firebase(path: str, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        firebase_url(path),
        data=body,
        method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=2.5) as response:
        response.read()


def write_dryer_controls(is_ready: bool, target_weight_g: float | None = None) -> None:
    payload: dict[str, Any] = {
        "isActive": bool(is_ready),
    }
    if target_weight_g is not None:
        payload["targetWeight"] = round(float(target_weight_g), 2)
    patch_firebase(FIREBASE_CONTROL_PATH, payload)


def calculate_target_weight(
    initial_weight: float,
    fruit: dict[str, Any],
    moist_final_override: float | None = None,
) -> float:
    moist_init = fruit.get("moist_init")
    moist_final = moist_final_override if moist_final_override is not None else fruit.get("moist_final")
    if isinstance(moist_init, (int, float)) and isinstance(moist_final, (int, float)):
        if moist_init < 0 or moist_init >= 1 or moist_final < 0 or moist_final >= 1:
            raise ValueError("Fruit moisture values must be between 0 and 1")
        if moist_final >= moist_init:
            raise ValueError("Final moisture must be less than initial moisture")
        return initial_weight * (1 - float(moist_init)) / (1 - float(moist_final))

    target_percent = float(fruit.get("target_percent_initial", 0))
    if target_percent <= 0 or target_percent >= 100:
        raise ValueError("Fruit target percent must be between 0 and 100")
    return initial_weight * (target_percent / 100)


def parse_firebase_weight(payload: Any) -> float:
    if isinstance(payload, (int, float)):
        return round(abs(float(payload)), 2)
    if isinstance(payload, dict):
        value = payload.get("weight", payload.get("value"))
        if isinstance(value, (int, float, str)):
            return round(abs(float(value)), 2)
    raise ValueError("Firebase payload must be a number or an object with numeric 'weight' or 'value'")


def parse_firebase_timestamp(payload: Any) -> float | None:
    if not isinstance(payload, dict):
        return None

    value = payload.get("timestamp")
    if not isinstance(value, (int, float, str)):
        return None

    numeric_value = float(value)
    if numeric_value > 100000000000:
        return numeric_value / 1000
    return numeric_value


def get_telemetry() -> dict[str, Any]:
    if not FIREBASE_WEIGHT_URL:
        return offline_telemetry("Firebase URL is not configured")

    try:
        telemetry = firebase_telemetry()
        telemetry["source"] = "firebase"
        telemetry["connected"] = True
        return telemetry
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        return offline_telemetry(f"{type(exc).__name__}: {exc}")


def firebase_telemetry() -> dict[str, Any]:
    payload = call_json(FIREBASE_WEIGHT_URL)
    telemetry = {
        "weight_g": parse_firebase_weight(payload),
    }
    sampled_at = parse_firebase_timestamp(payload)
    if sampled_at is not None:
        telemetry["sampled_at"] = sampled_at
    return telemetry


def offline_telemetry(error: str) -> dict[str, Any]:
    with STATE.lock:
        last_weight = STATE.latest.get("weight_g")
    fallback_weight = round(float(last_weight), 2) if isinstance(last_weight, (int, float)) else 0.0

    payload: dict[str, Any] = {
        "weight_g": fallback_weight,
        "source": "firebase",
        "connected": False,
        "error": error,
    }
    return payload


def estimate_remaining_minutes(batch: BatchState, current_weight_g: float | None) -> float | None:
    if not batch.running or not batch.started_at:
        return batch.remaining_minutes
    if current_weight_g is None:
        return batch.remaining_minutes
    if not batch.initial_weight_g or not batch.target_weight_g or not batch.estimated_minutes:
        return None
    if batch.initial_weight_g <= batch.target_weight_g:
        return 0

    total_loss = batch.initial_weight_g - batch.target_weight_g
    remaining_weight = max(0, current_weight_g - batch.target_weight_g)
    remaining_ratio = max(0.0, min(1.0, remaining_weight / total_loss))
    return round(batch.estimated_minutes * remaining_ratio, 1)


def poll_loop() -> None:
    while True:
        telemetry = get_telemetry()
        record_telemetry(telemetry)
        time.sleep(POLL_SECONDS)


def record_telemetry(telemetry: dict[str, Any]) -> None:
    now = time.time()
    telemetry["timestamp"] = now
    current_weight = telemetry.get("weight_g")
    has_weight = isinstance(current_weight, (int, float))
    should_clear_controls = False

    with STATE.lock:
        batch = STATE.batch
        target = batch.target_weight_g
        progress = 0.0
        if has_weight and batch.initial_weight_g and target and batch.initial_weight_g > target:
            progress = (batch.initial_weight_g - current_weight) / (batch.initial_weight_g - target)
            progress = max(0.0, min(1.0, progress))
        telemetry["drying_progress"] = round(progress, 4)
        batch.remaining_minutes = estimate_remaining_minutes(batch, current_weight if has_weight else None)

        should_capture = batch.running and has_weight and float(current_weight) > 0
        if should_capture:
            if STATE.sample_window_started_at is None:
                STATE.sample_window_started_at = now
                STATE.sample_window_weights = []
            STATE.sample_window_weights.append(float(current_weight))

            window_elapsed = now - STATE.sample_window_started_at
            if window_elapsed >= TELEMETRY_SAMPLE_SECONDS:
                weights = STATE.sample_window_weights
                if len(weights) >= 5:
                    mean_weight = sum(weights) / len(weights)
                    filtered_weights = [weight for weight in weights if abs(weight - mean_weight) < 50]
                    average_source = filtered_weights or weights
                    average_weight = sum(average_source) / len(average_source)
                    elapsed_seconds = 0
                    if batch.started_at is not None:
                        elapsed_seconds = int(now - batch.started_at)
                    STATE.history.append(
                        {
                            "t": max(0, elapsed_seconds),
                            "weight_g": round(average_weight, 2),
                            "timestamp": now,
                            "sample_count": len(average_source),
                            "sample_window_seconds": round(window_elapsed, 1),
                        }
                    )
                    STATE.history = STATE.history[-720:]
                STATE.sample_window_started_at = now
                STATE.sample_window_weights = []

        completed = (
            batch.running
            and not batch.completed_at
            and target is not None
            and has_weight
            and current_weight <= target
        )
        if completed:
            batch.completed_at = now
            batch.running = False
            batch.remaining_minutes = 0
            should_clear_controls = True

        # Check weight stabilization every 10 minutes (600 seconds)
        if batch.running and has_weight:
            if batch.last_weight_check_time is None:
                # Initialize on first check
                batch.prev_weight_g = current_weight
                batch.curr_weight_g = current_weight
                batch.last_weight_check_time = now
            elif now - batch.last_weight_check_time >= 600:
                # Update weights every 10 minutes
                batch.prev_weight_g = batch.curr_weight_g
                batch.curr_weight_g = current_weight
                batch.last_weight_check_time = now
                
                # Check if weight change is less than 2 grams
                if batch.prev_weight_g is not None and batch.curr_weight_g is not None:
                    weight_change = abs(batch.prev_weight_g - batch.curr_weight_g)
                    if weight_change < 2.0:
                        batch.stabilization_warning = True
                        print(f"[DRYING] Weight stabilization detected: change = {weight_change:.2f}g (< 2g)")
        
        # Reset stabilization warning when batch ends
        if not batch.running:
            batch.stabilization_warning = False

        STATE.latest = telemetry

    if should_clear_controls:
        try:
            write_dryer_controls(False)
        except (OSError, urllib.error.URLError, TimeoutError) as exc:
            print(f"[FIREBASE] Failed to clear dryer controls after completion: {exc}")

    # Console output for live weight monitoring
    weight_label = f"{current_weight:7.2f}g" if has_weight else "   --.-g"
    source = telemetry.get("source", "unknown")
    status = telemetry.get("connected", False)
    
    if batch.running:
        target_label = f"{target:7.2f}g" if isinstance(target, (int, float)) else "   --.-g"
        remaining = batch.remaining_minutes
        remaining_label = f"{remaining:5.1f}min" if isinstance(remaining, (int, float)) else "   --.-min"
        print(f"[LIVE] {weight_label} | Target: {target_label} | Progress: {progress*100:5.1f}% | Remaining: {remaining_label} | Source: {source}")
    else:
        print(f"[LIVE] {weight_label} | Source: {source} | Connected: {status}")


class AppHandler(SimpleHTTPRequestHandler):
    def handle(self) -> None:
        try:
            super().handle()
        except ConnectionAbortedError:
            return

    def translate_path(self, path: str) -> str:
        route = path.split("?", 1)[0]
        if route == "/":
            return str(FRONTEND_DIR / "index.html")
        return str(FRONTEND_DIR / route.lstrip("/"))

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        if route == "/api/fruits":
            json_response(self, load_fruits())
            return
        if route == "/api/state":
            json_response(self, STATE.snapshot())
            return
        if route == "/api/events":
            self.stream_events()
            return
        super().do_GET()

    def do_POST(self) -> None:
        route = self.path.split("?", 1)[0]
        if route == "/api/batch/start":
            self.start_batch()
            return
        if route == "/api/batch/reset":
            self.reset_batch()
            return
        if route == "/api/selection":
            self.update_selection()
            return
        if route == "/api/manual-weight":
            self.update_manual_weight()
            return
        if route == "/api/manual-elapsed-time":
            self.update_manual_elapsed_time()
            return
        json_response(self, {"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        json_response(self, {"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def start_batch(self) -> None:
        body = read_request_json(self)
        fruit = fruit_by_id(str(body.get("fruit_id", "")))
        if fruit is None:
            json_response(self, {"error": "Unknown fruit profile"}, HTTPStatus.BAD_REQUEST)
            return

        with STATE.lock:
            latest_weight = STATE.latest.get("weight_g")
        initial_weight = float(body.get("initial_weight_g") or latest_weight or 0)
        estimated_minutes = float(body.get("estimated_minutes") or fruit["estimated_minutes"])
        moist_final_override = None
        if body.get("moist_final") is not None:
            try:
                moist_final_override = float(body["moist_final"])
            except (TypeError, ValueError):
                json_response(self, {"error": "Custom final moisture must be a number"}, HTTPStatus.BAD_REQUEST)
                return
        try:
            target_weight = calculate_target_weight(initial_weight, fruit, moist_final_override)
        except ValueError as exc:
            json_response(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if initial_weight <= 0:
            json_response(
                self,
                {"error": "Current Firebase weight is not available"},
                HTTPStatus.BAD_REQUEST,
            )
            return
        if initial_weight <= target_weight:
            json_response(
                self,
                {"error": "Current weight must be greater than the target weight"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        target_weight = round(target_weight, 2)
        try:
            write_dryer_controls(True, target_weight)
        except (OSError, urllib.error.URLError, TimeoutError) as exc:
            json_response(
                self,
                {"error": f"Could not send dryer controls to Firebase: {exc}"},
                HTTPStatus.BAD_GATEWAY,
            )
            return

        with STATE.lock:
            started_at = time.time()
            STATE.batch = BatchState(
                running=True,
                fruit_id=fruit["id"],
                fruit_name=fruit["name"],
                started_at=started_at,
                initial_weight_g=round(initial_weight, 2),
                target_weight_g=target_weight,
                estimated_minutes=round(estimated_minutes, 1),
                remaining_minutes=round(estimated_minutes, 1),
            )
            STATE.selected_fruit_id = fruit["id"]
            STATE.history = [
                {
                    "t": 0,
                    "weight_g": round(initial_weight, 2),
                    "timestamp": started_at,
                    "sample_count": 1,
                    "sample_window_seconds": 0,
                    "initial": True,
                }
            ]
            STATE.sample_window_started_at = started_at
            STATE.sample_window_weights = []
        json_response(self, STATE.snapshot())

    def update_selection(self) -> None:
        body = read_request_json(self)
        fruit_id = str(body.get("fruit_id", ""))
        if not fruit_id:
            with STATE.lock:
                STATE.selected_fruit_id = None
            json_response(self, STATE.snapshot())
            return

        fruit = fruit_by_id(fruit_id)
        if fruit is None:
            json_response(self, {"error": "Unknown fruit profile"}, HTTPStatus.BAD_REQUEST)
            return
        with STATE.lock:
            STATE.selected_fruit_id = fruit["id"]
        json_response(self, STATE.snapshot())

    def reset_batch(self) -> None:
        with STATE.lock:
            STATE.batch = BatchState()
            STATE.history = []
            STATE.sample_window_started_at = None
            STATE.sample_window_weights = []

        try:
            write_dryer_controls(False)
        except (OSError, urllib.error.URLError, TimeoutError) as exc:
            print(f"[FIREBASE] Failed to clear dryer controls during batch reset: {exc}")

        json_response(self, STATE.snapshot())

    def update_manual_weight(self) -> None:
        body = read_request_json(self)
        manual_weight = body.get("manual_weight_g")
        use_manual = body.get("use_manual_weight", False)
        
        with STATE.lock:
            if manual_weight is not None:
                STATE.manual_weight_g = float(manual_weight)
            STATE.use_manual_weight = bool(use_manual)
        
        json_response(self, STATE.snapshot())

    def update_manual_elapsed_time(self) -> None:
        body = read_request_json(self)
        manual_elapsed = body.get("manual_elapsed_minutes")
        use_manual = body.get("use_manual_elapsed_time", False)
        
        with STATE.lock:
            if manual_elapsed is not None:
                STATE.manual_elapsed_minutes = float(manual_elapsed)
            STATE.use_manual_elapsed_time = bool(use_manual)
            if STATE.use_manual_elapsed_time:
                STATE.manual_elapsed_started_at = time.time()
            else:
                STATE.manual_elapsed_started_at = None
        
        json_response(self, STATE.snapshot())

    def stream_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        while True:
            try:
                payload = json.dumps(STATE.snapshot()).encode("utf-8")
                self.wfile.write(b"event: state\n")
                self.wfile.write(b"data: " + payload + b"\n\n")
                self.wfile.flush()
                time.sleep(POLL_SECONDS)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")


def main() -> None:
    poller = threading.Thread(target=poll_loop, daemon=True)
    poller.start()

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), AppHandler)
    mobile_url = get_lan_hint(port)
    print(f"Fruit dryer app running at http://127.0.0.1:{port}")
    if mobile_url:
        print(f"Mobile LAN URL: {mobile_url}")
    print(f"Telemetry mode: firebase at {FIREBASE_WEIGHT_URL}" if FIREBASE_WEIGHT_URL else "Telemetry mode: firebase unavailable")
    server.serve_forever()


def get_lan_hint(port: int) -> str | None:
    try:
        import socket

        # Resolve the outbound interface address instead of relying on hostname
        # lookup, which often returns localhost or a non-routable adapter on Windows.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip_address = sock.getsockname()[0]
        if ip_address.startswith("127."):
            return None
        return f"http://{ip_address}:{port}"
    except OSError:
        return None
