#!/usr/bin/env python3
"""
T3 ambilight host — one process, Python 3 stdlib + Pillow + tinytuya.

Runs on an always-on Linux box on the same LAN as the TV (e.g. a Proxmox
container). It does two jobs on one HTTP port (default 8777):

1. Frame sink. The TV app (service.js >= v6.0) captures the screen and POSTs
   each JPEG to /frame. A worker thread takes the newest frame, computes one
   colour per screen-edge zone, maps zones to strip modules and sends a single
   Tuya DP61 "full pattern" to the LED strip. Stale frames are dropped, so the
   LEDs always follow the latest picture. The /frame reply steers the TV loop
   ({on, q, w, h, gap}), changeable at runtime via POST /stream.

2. Agent relay (debug). Same API as the old control-server.js: the TV polls
   GET /cmd for one typed command and POSTs the outcome to /result; operators
   queue commands with POST /enqueue and read GET /result/<id>.

Endpoints:
  POST /frame        <- image/jpeg body (empty = "paused, send params")
  GET  /status       -> fps, LED stats, last errors, agent heartbeat
  POST /stream       <- {"on":false} / {"q":40} ... -> new stream params
  GET  /cmd  POST /result  POST|GET /ping  POST /enqueue  GET /result/<id>

usage: t3_ambilight.py [--config config.json] [--port 8777]
"""
import base64, colorsys, io, json, os, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from PIL import Image
except ImportError:
    sys.exit("need Pillow: pip install pillow")
try:
    import tinytuya
except ImportError:
    sys.exit("need tinytuya: pip install tinytuya")


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(arg("--config", os.path.join(HERE, "config.json"))))
PORT = int(arg("--port", CFG.get("port", 8777)))

TUYA = CFG["tuya"]
DP = str(CFG.get("dp", "61"))
COUNT = int(CFG.get("count", 20))
PER = int(CFG.get("per_module", COUNT // 4))
MODULE_ZONES = CFG["module_zones"][::-1] if CFG.get("reverse") else CFG["module_zones"]
SAT = float(CFG.get("sat_boost", 1.7))
SMOOTH = float(CFG.get("smooth", 0.15))
GAMMA = float(CFG.get("gamma", 2.2))
MIN_V = float(CFG.get("min_v", 0.12))
BLACK = float(CFG.get("black_luma", 6.0))
IDLE_S = float(CFG.get("idle_disconnect_s", 10))
STREAM = {"on": True, "q": 55, "w": 480, "h": 270, "gap": 0}
STREAM.update(CFG.get("stream", {}))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- colour maths

def pixels(img):
    # Pillow 13 deprecates getdata() in favour of get_flattened_data()
    return getattr(img, "get_flattened_data", img.getdata)()


def edge_zones(w, h):
    dw, dh = int(w * 0.18), int(h * 0.18)
    return {
        "top-left": (0, 0, w // 2, dh), "top-right": (w // 2, 0, w, dh),
        "right": (w - dw, dh, w, h - dh), "left": (0, dh, dw, h - dh),
        "bottom-left": (0, h - dh, w // 2, h), "bottom-right": (w // 2, h - dh, w, h),
        "top": (0, 0, w, dh), "bottom": (0, h - dh, w, h),
    }


def zone_color(im, box):
    """Average weighted towards saturated, bright pixels (vivid wins over grey)."""
    tw = tr = tg = tb = 0.0
    for r, g, b in pixels(im.crop(box).resize((16, 16))):
        _, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        wt = (s * v) ** 1.6 + 0.02
        tw += wt; tr += r * wt; tg += g * wt; tb += b * wt
    return (tr / tw, tg / tw, tb / tw)


def mean_luma(im):
    px = list(pixels(im.resize((32, 18))))
    return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px) / len(px)


def to_tuya_hsv(r, g, b):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    r2, g2, b2 = colorsys.hsv_to_rgb(h, min(1.0, s * SAT), max(MIN_V, v))
    h2, s2, v2 = colorsys.rgb_to_hsv(*(x ** (1 / GAMMA) for x in (r2, g2, b2)))
    return int(h2 * 360) % 360, int(s2 * 1000), int(v2 * 1000)


def dp61_pattern(mods):
    """Tuya RGBIC 'paint colour' full pattern: header + COUNT x (H,S,V) BE16."""
    pkt = bytearray.fromhex("0003") + struct.pack(">H", COUNT) + b"\x00"
    for r, g, b in mods:
        hsv = (0, 0, 0) if (r, g, b) == (0, 0, 0) else to_tuya_hsv(r, g, b)
        pkt += struct.pack(">HHH", *hsv) * PER
    return base64.b64encode(bytes(pkt)).decode()


# ---------------------------------------------------------------- shared state

frame_cv = threading.Condition()
frame = {"jpg": None, "seq": 0, "at": 0.0}
stats = {"rx": 0, "rx_fps": 0.0, "led": 0, "led_fps": 0.0, "led_ms": 0.0,
         "skipped": 0, "tuya": "disconnected", "tuya_err": None, "loop_err": None}


def ema(old, new, k=0.2):
    return new if not old else old * (1 - k) + new * k


class Strip:
    """Lazy, self-healing Tuya connection. The strip is powered by the TV, so it
    vanishes whenever the TV is off and must be re-dialled when frames resume."""

    def __init__(self):
        self.dev = None
        self.next_try = 0.0

    def _connect(self):
        d = tinytuya.BulbDevice(TUYA["id"], TUYA["ip"], TUYA["key"])
        d.set_version(float(TUYA.get("version", 3.5)))
        d.set_socketTimeout(3)
        d.set_socketPersistent(True)
        st = d.status()
        if not st or "Error" in st:
            raise RuntimeError((st or {}).get("Error", "no status"))
        d.set_value(20, True)
        d.set_value(21, "colour")
        self.dev = d
        stats["tuya"], stats["tuya_err"] = "connected", None
        log("tuya connected", TUYA["ip"])

    def send(self, value):
        if self.dev is None:
            if time.time() < self.next_try:
                return False
            try:
                self._connect()
            except Exception as e:
                self.next_try = time.time() + 2
                if stats["tuya_err"] != str(e):
                    log("tuya connect failed:", e)
                stats["tuya"], stats["tuya_err"] = "disconnected", str(e)
                return False
        try:
            r = self.dev.set_value(DP, value)
            if r and "Error" in r:
                raise RuntimeError(r["Error"])
            return True
        except Exception as e:
            log("tuya send failed:", e)
            stats["tuya_err"] = str(e)
            self.close()
            return False

    def close(self):
        if self.dev is not None:
            try:
                self.dev.close()
            except Exception:
                pass
        self.dev = None
        stats["tuya"] = "disconnected"


def led_worker():
    strip = Strip()
    seen, prev, last_val, last_sent = 0, [None] * len(MODULE_ZONES), None, 0.0
    while True:
        with frame_cv:
            frame_cv.wait_for(lambda: frame["seq"] != seen, timeout=1.0)
            jpg, seq, at = frame["jpg"], frame["seq"], frame["at"]
        if seq == seen:
            if strip.dev is not None and time.time() - at > IDLE_S:
                log("no frames for %ss, dropping tuya link" % IDLE_S)
                strip.close()
            continue
        stats["skipped"] += max(0, seq - seen - 1)
        seen = seq
        try:
            im = Image.open(io.BytesIO(jpg)).convert("RGB")
            if mean_luma(im) < BLACK:
                mods = [(0, 0, 0)] * len(MODULE_ZONES)
            else:
                boxes, mods = edge_zones(*im.size), []
                for i, z in enumerate(MODULE_ZONES):
                    c = zone_color(im, boxes[z])
                    if prev[i]:
                        c = tuple(p * SMOOTH + n * (1 - SMOOTH) for p, n in zip(prev[i], c))
                    prev[i] = c
                    mods.append(c)
            val = dp61_pattern(mods)
            if val == last_val and time.time() - last_sent < 2:
                continue
            t0 = time.time()
            if strip.send(val):
                now = time.time()
                stats["led_ms"] = ema(stats["led_ms"], (now - t0) * 1000)
                stats["led_fps"] = ema(stats["led_fps"], 1 / max(1e-3, now - last_sent)) if last_sent else 0.0
                stats["led"] += 1
                last_val, last_sent = val, now
            stats["loop_err"] = None
        except Exception as e:
            stats["loop_err"] = str(e)
            log("loop err:", e)


# ---------------------------------------------------------------- agent relay

relay_cv = threading.Condition()
relay = {"seq": 1, "queue": [], "results": {}, "last_seen": 0.0, "info": None}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _jbody(self):
        b = self._body()
        try:
            return json.loads(b, strict=False) if b else {}
        except ValueError:
            return {}

    def do_GET(self):
        u = self.path.split("?")[0]
        if u == "/cmd":
            with relay_cv:
                relay["last_seen"] = time.time()
                cmd = relay["queue"].pop(0) if relay["queue"] else {}
            return self._json(200, cmd)
        if u == "/ping":
            relay["last_seen"] = time.time()
            return self._json(200, {"ok": True})
        if u.startswith("/result/"):
            cid = int(u[len("/result/"):])
            with relay_cv:
                relay_cv.wait_for(lambda: cid in relay["results"], timeout=30)
                r = relay["results"].get(cid)
            return self._json(200, r) if r else self._json(202, {"pending": True})
        if u == "/status":
            now = time.time()
            return self._json(200, {
                "stream": STREAM, "stats": stats, "module_zones": MODULE_ZONES,
                "frame_age_s": round(now - frame["at"], 1) if frame["at"] else None,
                "agent_seen_s": round(now - relay["last_seen"], 1) if relay["last_seen"] else None,
                "agent_info": relay["info"],
                "pending": [{"id": c["id"], "op": c["op"]} for c in relay["queue"]],
            })
        self._json(404, {"err": "no route " + u})

    def do_POST(self):
        u = self.path.split("?")[0]
        if u == "/frame":
            jpg = self._body()
            if jpg:
                now = time.time()
                with frame_cv:
                    if frame["at"]:
                        stats["rx_fps"] = ema(stats["rx_fps"], 1 / max(1e-3, now - frame["at"]))
                    frame.update(jpg=jpg, seq=frame["seq"] + 1, at=now)
                    stats["rx"] += 1
                    frame_cv.notify_all()
            return self._json(200, STREAM)
        if u == "/stream":
            b = self._jbody()
            STREAM.update({k: b[k] for k in STREAM if k in b})
            log("stream params", STREAM)
            return self._json(200, STREAM)
        if u == "/ping":
            relay["last_seen"], relay["info"] = time.time(), self._jbody()
            log("agent ping", relay["info"])
            return self._json(200, {"ok": True})
        if u == "/result":
            b = self._jbody()
            with relay_cv:
                relay["last_seen"] = time.time()
                if b.get("id") is not None:
                    relay["results"][b["id"]] = {"ok": b.get("ok"), "data": b.get("data"),
                                                 "err": b.get("err"), "at": time.time()}
                    for old in list(relay["results"])[:-50]:
                        relay["results"].pop(old)
                    relay_cv.notify_all()
            return self._json(200, {"ok": True})
        if u == "/enqueue":
            b = self._jbody()
            if not b.get("op"):
                return self._json(400, {"err": "need {op,args}"})
            with relay_cv:
                cid = relay["seq"]; relay["seq"] += 1
                relay["queue"].append({"id": cid, "op": b["op"], "args": b.get("args") or {}})
            log("enqueue #%d %s" % (cid, b["op"]))
            return self._json(200, {"id": cid})
        self._json(404, {"err": "no route " + u})


def main():
    threading.Thread(target=led_worker, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log("T3 ambilight host on :%d | zones->modules %s | strip %s" % (PORT, MODULE_ZONES, TUYA["ip"]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
