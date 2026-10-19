#!/usr/bin/env python3
"""
T3 ambilight host — one process, Python 3 stdlib + Pillow (+ tinytuya or flatbuffers).

Runs on an always-on Linux box on the same LAN as the TV (e.g. a Proxmox
container). It does two jobs on one HTTP port (default 8777):

1. Frame sink. The TV app (service.js >= v6.0) captures the screen and POSTs
   each JPEG to /frame. A worker thread takes the newest frame (stale frames
   are dropped, so the output always follows the latest picture) and, by
   config "output":
   - "hyperhdr": decodes it and forwards it as a RawImage to HyperHDR's
     flatbuffers server (:19400). HyperHDR does LED layout, black borders,
     smoothing, calibration and drives the strip (e.g. DDP to OpenBeken/WLED).
   - "tuya": computes one colour per screen-edge zone, maps zones to strip
     modules and sends a single Tuya DP61 "full pattern" (standalone mode).
   The /frame reply steers the TV loop ({on, q, w, h, gap}), changeable at
   runtime via POST /stream.

2. LAN discovery (UDP 8778), so the TV needs no server address: answers the
   TV's "T3-DISCOVER" broadcast and sends a beacon every few seconds, both as
   {"t3":1,"control":"http://<this host>:<port>"}. "discovery.advertise" overrides
   the URL (e.g. behind NAT or with several interfaces).

3. Agent relay (debug). Same API as the old control-server.js: the TV polls
   GET /cmd for one typed command and POSTs the outcome to /result; operators
   queue commands with POST /enqueue and read GET /result/<id>.

Endpoints:
  POST /frame        <- image/jpeg body (empty = "paused, send params")
  GET  /status       -> fps, LED stats, last errors, agent heartbeat
  POST /stream       <- {"on":false} / {"q":40} ... -> new stream params
  GET  /cmd  POST /result  POST|GET /ping  POST /enqueue  GET /result/<id>

usage: t3_ambilight.py [--config config.json] [--port 8777]
"""
import base64, colorsys, io, json, math, os, socket, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from PIL import Image
except ImportError:
    sys.exit("need Pillow: pip install pillow")


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(arg("--config", os.path.join(HERE, "config.json"))))
PORT = int(arg("--port", CFG.get("port", 8777)))

OUTPUT = CFG.get("output", "tuya")
TUYA = CFG.get("tuya", {})
DP = str(CFG.get("dp", "61"))
COUNT = int(CFG.get("count", 20))
PER = int(CFG.get("per_module", COUNT // 4))
MODULE_ZONES = CFG.get("module_zones", ["right", "top-right", "top-left", "left"])
MODULE_ZONES = MODULE_ZONES[::-1] if CFG.get("reverse") else MODULE_ZONES
SAT = float(CFG.get("sat_boost", 1.7))
SMOOTH = float(CFG.get("smooth", 0.15))
GAMMA = float(CFG.get("gamma", 2.2))
MIN_V = float(CFG.get("min_v", 0.12))
BLACK = float(CFG.get("black_luma", 6.0))
IDLE_S = float(CFG.get("idle_disconnect_s", 10))
# nowait: fire DP61 without waiting for the strip's ack (~200ms) and drain the
# acks from the socket instead; max_hz caps the send rate in that mode.
NOWAIT = bool(CFG.get("tuya_nowait", False))
MAX_HZ = float(CFG.get("tuya_max_hz", 12))
# Brightness fade (seconds, time constant) when the picture goes to / comes back
# from black, so the strip dims out instead of snapping off.
FADE_OUT = float(CFG.get("fade_out_s", 0.6))
FADE_IN = float(CFG.get("fade_in_s", 0.25))
# HyperHDR output: image duration lets HyperHDR drop the source on its own when
# the TV stops streaming (TV off), instead of freezing on the last frame.
HH = {"host": "127.0.0.1", "port": 19400, "priority": 150, "origin": "t3-tv", "duration_ms": 3000}
HH.update(CFG.get("hyperhdr", {}))
STREAM = {"on": True, "q": 55, "w": 480, "h": 270, "gap": 0}
STREAM.update(CFG.get("stream", {}))
DISCO = {"port": 8778, "beacon_s": 5, "advertise": None}
DISCO.update(CFG.get("discovery", {}))


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


def to_tuya_hsv(r, g, b, level=1.0):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    r2, g2, b2 = colorsys.hsv_to_rgb(h, min(1.0, s * SAT), max(MIN_V, v))
    h2, s2, v2 = colorsys.rgb_to_hsv(*(x ** (1 / GAMMA) for x in (r2, g2, b2)))
    return int(h2 * 360) % 360, int(s2 * 1000), int(v2 * level * 1000)


def dp61_pattern(mods, level=1.0):
    """Tuya RGBIC 'paint colour' full pattern: header + COUNT x (H,S,V) BE16.
    level scales brightness (fades); below 2% the strip gets digital black."""
    pkt = bytearray.fromhex("0003") + struct.pack(">H", COUNT) + b"\x00"
    for r, g, b in mods:
        off = level < 0.02 or (r, g, b) == (0, 0, 0)
        hsv = (0, 0, 0) if off else to_tuya_hsv(r, g, b, level)
        pkt += struct.pack(">HHH", *hsv) * PER
    return base64.b64encode(bytes(pkt)).decode()


# ---------------------------------------------------------------- shared state

frame_cv = threading.Condition()
frame = {"jpg": None, "seq": 0, "at": 0.0}
stats = {"rx": 0, "rx_fps": 0.0, "led": 0, "led_fps": 0.0, "led_ms": 0.0,
         "skipped": 0, "tuya": "disconnected", "tuya_err": None, "loop_err": None,
         "out": "disconnected", "out_err": None}


def ema(old, new, k=0.2):
    return new if not old else old * (1 - k) + new * k


class Strip:
    """Lazy, self-healing Tuya connection. The strip is powered by the TV, so it
    vanishes whenever the TV is off and must be re-dialled when frames resume."""

    def __init__(self):
        self.dev = None
        self.next_try = 0.0

    def _connect(self):
        import tinytuya
        d = tinytuya.BulbDevice(TUYA["id"], TUYA["ip"], TUYA["key"])
        d.set_version(float(TUYA.get("version", 3.5)))
        d.set_socketTimeout(2)
        d.set_socketRetryLimit(1)  # fail fast; send() re-dials every 2s anyway
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
            if NOWAIT:
                self._drain()
            r = self.dev.set_value(DP, value, nowait=NOWAIT)
            if r and "Error" in r:
                raise RuntimeError(r["Error"])
            return True
        except Exception as e:
            log("tuya send failed:", e)
            stats["tuya_err"] = str(e)
            self.close()
            return False

    def _drain(self):
        """Discard unread acks so they don't pile up on the persistent socket."""
        s = getattr(self.dev, "socket", None)
        if s is None:
            return
        t = s.gettimeout()
        s.settimeout(0)
        try:
            while s.recv(4096):
                pass
        except (BlockingIOError, InterruptedError):
            pass
        finally:
            s.settimeout(t)

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
    level, level_t = 1.0, time.time()
    while True:
        if NOWAIT and last_sent:
            rest = 1 / MAX_HZ - (time.time() - last_sent)
            if rest > 0:
                time.sleep(rest)
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
            black = mean_luma(im) < BLACK
            if not black:
                boxes = edge_zones(*im.size)
                for i, z in enumerate(MODULE_ZONES):
                    c = zone_color(im, boxes[z])
                    if prev[i]:
                        c = tuple(p * SMOOTH + n * (1 - SMOOTH) for p, n in zip(prev[i], c))
                    prev[i] = c
            # black screen: keep the last colours and fade their brightness out
            now = time.time()
            tau = FADE_OUT if black else FADE_IN
            k = 1 - math.exp(-(now - level_t) / tau) if tau > 0 else 1.0
            level += ((0.0 if black else 1.0) - level) * k
            level_t = now
            if level > 0.98 and not black:
                level = 1.0
            mods = [c or (0, 0, 0) for c in prev]
            val = dp61_pattern(mods, level)
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


# ---------------------------------------------------------------- HyperHDR

# FlatBuffers wire format (HyperHDR include/flatbuffers/parser/hyperhdr_request.fbs):
#   union Command {Color=1, Image=2, Clear=3, Register=4}; union ImageType {RawImage=1, NV12Image=2}
#   table Register {origin:string; priority:int}  table RawImage {data:[ubyte]; width:int; height:int}
#   table Image {data:ImageType; duration:int}    table Request {command:Command}   (root)
# Framing: 4-byte big-endian length + payload.

def hh_request(b, command_type, command):
    b.StartObject(2)
    b.PrependUint8Slot(0, command_type, 0)
    b.PrependUOffsetTRelativeSlot(1, command, 0)
    b.Finish(b.EndObject())
    return bytes(b.Output())


def hh_register(origin, priority):
    import flatbuffers
    b = flatbuffers.Builder(256)
    o = b.CreateString(origin)
    b.StartObject(2)
    b.PrependUOffsetTRelativeSlot(0, o, 0)
    b.PrependInt32Slot(1, priority, 0)
    return hh_request(b, 4, b.EndObject())


def hh_image(rgb, width, height, duration):
    import flatbuffers
    b = flatbuffers.Builder(len(rgb) + 256)
    data = b.CreateByteVector(rgb)
    b.StartObject(3)
    b.PrependUOffsetTRelativeSlot(0, data, 0)
    b.PrependInt32Slot(1, width, -1)
    b.PrependInt32Slot(2, height, -1)
    raw = b.EndObject()
    b.StartObject(3)
    b.PrependUint8Slot(0, 1, 0)
    b.PrependUOffsetTRelativeSlot(1, raw, 0)
    b.PrependInt32Slot(2, duration, -1)
    return hh_request(b, 2, b.EndObject())


class HyperHDRSink:
    """Self-healing flatbuffers client; replies are drained and ignored."""

    def __init__(self):
        self.sock = None
        self.next_try = 0.0

    def _connect(self):
        import socket
        s = socket.create_connection((HH["host"], int(HH["port"])), timeout=3)
        s.sendall(self._frame(hh_register(HH["origin"], int(HH["priority"]))))
        self.sock = s
        stats["out"], stats["out_err"] = "hyperhdr connected", None
        log("hyperhdr connected %s:%s prio %s" % (HH["host"], HH["port"], HH["priority"]))

    @staticmethod
    def _frame(payload):
        return struct.pack(">I", len(payload)) + payload

    def _drain(self):
        self.sock.settimeout(0)
        try:
            while self.sock.recv(65536):
                pass
        except (BlockingIOError, InterruptedError):
            pass
        finally:
            self.sock.settimeout(3)

    def send(self, rgb, w, h):
        if self.sock is None:
            if time.time() < self.next_try:
                return False
            try:
                self._connect()
            except Exception as e:
                self.next_try = time.time() + 2
                if stats.get("out_err") != str(e):
                    log("hyperhdr connect failed:", e)
                stats["out"], stats["out_err"] = "disconnected", str(e)
                return False
        try:
            self._drain()
            self.sock.sendall(self._frame(hh_image(rgb, w, h, int(HH["duration_ms"]))))
            return True
        except Exception as e:
            log("hyperhdr send failed:", e)
            stats["out_err"] = str(e)
            self.close()
            return False

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None
        stats["out"] = "disconnected"


def hyperhdr_worker():
    sink, seen, last_sent = HyperHDRSink(), 0, 0.0
    while True:
        with frame_cv:
            frame_cv.wait_for(lambda: frame["seq"] != seen, timeout=1.0)
            jpg, seq = frame["jpg"], frame["seq"]
        if seq == seen:
            continue
        stats["skipped"] += max(0, seq - seen - 1)
        seen = seq
        try:
            im = Image.open(io.BytesIO(jpg)).convert("RGB")
            t0 = time.time()
            if sink.send(im.tobytes(), im.width, im.height):
                now = time.time()
                stats["led_ms"] = ema(stats["led_ms"], (now - t0) * 1000)
                stats["led_fps"] = ema(stats["led_fps"], 1 / max(1e-3, now - last_sent)) if last_sent else 0.0
                stats["led"] += 1
                last_sent = now
            stats["loop_err"] = None
        except Exception as e:
            stats["loop_err"] = str(e)
            log("loop err:", e)


# ---------------------------------------------------------------- discovery

def own_url(peer=None):
    """URL the TV should use to reach us: the address of the interface that
    routes to the TV (or to the default route for broadcasts)."""
    if DISCO.get("advertise"):
        return DISCO["advertise"]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # UDP connect sends nothing; it only selects the outgoing interface.
        # 192.0.2.1 is TEST-NET-1 (never routed), used just to pick the default route.
        s.connect((peer or "192.0.2.1", 9))
        return "http://%s:%d" % (s.getsockname()[0], PORT)
    finally:
        s.close()


def discovery_worker():
    port, every = int(DISCO["port"]), float(DISCO.get("beacon_s") or 0)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.bind(("", port))
    s.settimeout(every or None)
    log("discovery on udp %d, advertising %s" % (port, own_url()))
    next_beacon = 0.0
    while True:
        if every and time.time() >= next_beacon:
            try:
                s.sendto(json.dumps({"t3": 1, "control": own_url()}).encode(), ("255.255.255.255", port))
            except OSError as e:
                stats["disco_err"] = str(e)
            next_beacon = time.time() + every
        try:
            data, addr = s.recvfrom(512)
        except socket.timeout:
            continue
        if data.strip() == b"T3-DISCOVER":
            s.sendto(json.dumps({"t3": 1, "control": own_url(addr[0])}).encode(), addr)
            if stats.get("discovered_by") != addr[0]:
                log("discovery request from", addr[0])
            stats["discovered_by"] = addr[0]


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
                "output": OUTPUT, "stream": STREAM, "stats": stats,
                "module_zones": MODULE_ZONES if OUTPUT == "tuya" else None,
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
    worker = hyperhdr_worker if OUTPUT == "hyperhdr" else led_worker
    threading.Thread(target=worker, daemon=True).start()
    if DISCO.get("port"):
        threading.Thread(target=discovery_worker, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    if OUTPUT == "hyperhdr":
        log("T3 ambilight host on :%d | output hyperhdr %s:%s" % (PORT, HH["host"], HH["port"]))
    else:
        log("T3 ambilight host on :%d | output tuya %s | zones->modules %s" % (PORT, TUYA.get("ip"), MODULE_ZONES))
    srv.serve_forever()


if __name__ == "__main__":
    main()
