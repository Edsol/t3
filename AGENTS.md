# AGENTS.md — T3 Ambilight handoff for LLMs

Handoff for an AI agent resuming this project cold. It states the architecture,
what works (with numbers), the dead ends (so you don't retry them), what's left,
and how to operate everything. Written to be read start-to-finish before acting.

> Scope: a DIY ambient-light ("ambilight") system for an old Samsung TV with no
> official support for it. All work is on the owner's own hardware and public
> firmware. Secrets (Tuya local key, Wi-Fi creds) are NOT in this repo — see
> "Secrets" below.

---

## 1. Goal

Drive an LED strip behind a **Samsung UE55MU6120** (Tizen 3.0, 2017) so the light
follows the on-screen colours — including the **internal tuner channels and
streaming apps**, not just HDMI. No rooting, no jailbreak: the TV app runs inside
TizenBrew's sandbox.

User's end goals (`t3-goals` memory): 4 physical LED modules (2 top + 1 per side,
no bottom), a future graphical zone-mapping configurator, and an **open-source
release** — keep code and docs publishable.

---

## 2. Current architecture (what is deployed and running)

```
Samsung TV (192.168.1.31, Tizen 3)          Proxmox LXC "hyperhdr" (192.168.1.61, Debian 13)
┌───────────────────────────────┐           ┌────────────────────────────────────────────┐
│ TizenBrew module:             │  JPEG     │ t3_ambilight.py (systemd: t3-ambilight, :8777)│
│  service.js  = BOOTSTRAP      │  POST     │  - frame sink  -> forwards to HyperHDR        │
│   - finds host (discovery)    │ ───────►  │  - serves /tv/core.js + /tv/core.sha          │
│   - downloads & runs core     │  /frame   │  - agent relay (/cmd,/result,/enqueue)        │
│  tv/core.js = LOGIC (hot)     │           │  - UDP discovery responder+beacon (:8778)     │
│   - captures screen (dbus)    │           └───────────────┬──────────────────────────────┘
│   - streams frames            │                           │ flatbuffers RawImage :19400
│   - agent ops                 │                           ▼
└───────────────────────────────┘           ┌────────────────────────────────────────────┐
                                             │ HyperHDR v22 (systemd: hyperhdr@root, :8090) │
                                             │  layout, black-border, smoothing, calibrate  │
                                             └───────────────┬──────────────────────────────┘
                                                             │ DDP (UDP :4048)
                                                             ▼
                                             ┌────────────────────────────────────────────┐
                                             │ LED strip 192.168.1.88  (Eurodomest RGBIC)   │
                                             │  BK7238 flashed with OpenBeken 1.18.318      │
                                             │  SM16703P driver on P16, 120 px, DDP receiver│
                                             └────────────────────────────────────────────┘
```

Data path: **TV captures JPEG → POSTs to host → host decodes & forwards RawImage
to HyperHDR → HyperHDR computes per-LED colours → DDP → OpenBeken → strip.**

### Hosts, services, ports
- **TV** `192.168.1.31`: TizenBrew module HTTP on **:8101** (`/config`, `/boot`,
  `/agent`). Node v4.4.3, ES5 only, sandbox uid 5001, SMACK `User::Pkg::xvvl3S1bvH`.
- **Container** `192.168.1.61` (Proxmox LXC id 108, Debian 13, unprivileged, root
  via SSH key `~/.ssh/t3_proxmox`). Created with the community-scripts HyperHDR script.
  - `t3-ambilight.service` → `/opt/t3/t3_ambilight.py --config /opt/t3/config.json`, port **:8777**, UDP **:8778**. Serves TV core from `/opt/t3/tv/core.js`.
  - `hyperhdr@root.service` → HyperHDR v22.0.0 (apt). Web **:8090**, flatbuffers **:19400**, JSON API TCP **:19444**. NB: the script also installs a duplicate `hyperhdr.service` that loops — it is DISABLED, leave it so.
  - `/opt/t3/hh_api.py` = JSON API client over TCP :19444 (login needs admin pw).
  - ARM cross-compiler `gcc-arm-linux-gnueabi` installed here (for native probes).
- **LED strip** `192.168.1.88`: OpenBeken web/REST on **:80** (`/cm?cmnd=...`), DDP receiver **:4048**.
- **Old Asterisk LXC** `192.168.1.60`: ran an earlier version of the host; its `t3-ambilight` user service is now DISABLED. Not used.
- **Mac** (dev box): drives everything remotely; holds `~/.ssh/t3_proxmox` and the flash backup.

### Repo layout
- `service.js` — TV **bootstrap** (small, stable): host discovery/config, HTTP :8101, downloads+hot-swaps the core. Served to the TV via TizenBrew+jsDelivr (tag-based).
- `tv/core.js` — TV **core logic** (hot-reloadable): capture loop, frame stream, agent ops. Served by the host at `/tv/core.js`; updated by copying to the container, no TizenBrew reload.
- `host/t3_ambilight.py` — the container daemon (frame sink + HyperHDR forward OR standalone Tuya mode + agent relay + discovery + TV-core server).
- `host/config.example.json`, `host/install.sh` — host config template & installer.
- `firmware-backup/` — **gitignored**; 2 MiB BK7238 stock dump (`eurodomest_backup_1.bin`, sha256 `6b0d7ace…dbdc`, verified by 2 identical reads). The restore path if OpenBeken must be undone.
- `native/` — `probe.c` + `build.sh`: native-.so feasibility probe (a dead end, see §5).
- `DIARIO.md`, `README.md` — **STALE** (pre-v5.8 era). Do not trust them; rewrite for the open-source release. This file + the `t3-*` project memories are the source of truth.

---

## 3. Current state (what works, with numbers)

- **Full chain works** with a real TV picture: tuner channels, Netflix, UI all captured (no HDCP/DRM black on this set).
- **Capture rate: ~12.5 fps**, the hard ceiling of the capture daemon (see §5). Config: `mode=2`, `par=2`. Was ~3.5 fps in the earliest Mac-relay design.
- **LED output: DDP at ~50 Hz**; HyperHDR smooths/interpolates between the ~12 captured fps, so steady scenes look fluid.
- **Known weakness:** fast action looks laggy at 12 fps — the main open problem (§4).
- **Zero config on the TV:** no IP in code; the TV finds the host by LAN discovery. Survives a power-cycle and re-discovers on its own.
- **Updating the TV = copying `tv/core.js` to the container** (TV re-fetches within 30 s). TizenBrew reload only needed if `service.js` (the bootstrap) itself changes.

### Strip facts (from the decrypted stock firmware `user_param`)
- Module: Tuya **T1-U-HL** = **BK7238** (Beken, WiFi+BLE). LED data on **P16** (SPI MOSI). **120 pixels**, colour order **GRB**. Power-enable relay on **P22** (active high). IR on P9, mic on P20, button on P21.
- OpenBeken `autoexec.bat` on the strip: `startDriver SM16703P` / `SM16703P_Init 120 GRB` / `startDriver DDP` / `setChannel 1 1`.
- HyperHDR layout: classic frame 60 top / 30 left / 30 right / 0 bottom, **reverse ON**, **input position 90** → LED 0 is bottom-right, numbering runs counter-clockwise (verified with a 4-colour test: right=red, top-right=green, top-left=blue, left=yellow).

---

## 4. What's left (open tasks)

1. **Higher capture fps (biggest).** 12 fps feels laggy in action scenes. The daemon is capped (§5). Only legitimate avenue left: **TV→mobile mirroring** (SmartThings / Smart View, elements `miracast_server` / `ScreenMirroring-daemon` / `smsrcavsource`). Plan: with mirroring active from a phone, port-scan the TV from the host and try to receive the (RTSP/H.264?) stream into the container → 25-30 fps. Unknowns: proprietary/encrypted protocol; protected content may be black over mirroring.
   - Cheap interim win: tune HyperHDR **smoothing** for a ~12 fps source so interpolation hides the stutter (no capture change).
2. **"Stuck blue" pixel.** A short run (~1 IC, 3 LEDs) at the **start of the chain** (bottom-right seen from the front) stays blue regardless of data: ignored `all white` (even Init 150), `pixel0 red`, blink pixel0. Last test (blink pixel 1 green) — user never reported the result. Hypothesis: pixel 0 is dead, or that stub is off the data chain. Fix: skip it in HyperHDR (offset) or repair in hardware. **RESOLVE THIS before writing user docs.**
3. **HyperHDR tuning:** enable black-border detector (off now) for letterboxed films; weighted/dominant colour instead of mean; smoothing time ~150-200 ms; disable background effect so the strip goes dark when the TV stops (source has a 3 s duration).
4. **User-facing docs for the open-source release:** rewrite `README.md` (what/architecture/hardware/install/config) and `DIARIO.md` (the journey + dead ends). Confirm license (MIT per package.json), author, language (README EN?), and keep secrets out.
5. **Own `.wgt` app (optional):** leave TizenBrew entirely by packaging the bootstrap as a signed-with-Apps2Samsung `.wgt`. Note: Apps2Samsung signing covers the web package, NOT native ELF (§5), and such apps still can't autostart at boot. User to check the TV's "Autorun Last App" setting and whether the service survives standby.

---

## 5. Dead ends — DO NOT RETRY (and why)

All verified on this TV. Re-testing wastes time and risks destabilising a working system.

- **Our own native code (any form).** The kernel refuses to map unsigned (non-Samsung) ELF. `process.dlopen()` of our cross-compiled `.so` (armel soft-float, nostdlib, ELF constructor) → `failed to map segment from shared object` in /tmp, /dev/shm, /opt (none are noexec — it's a kernel UEP/signing policy). `spawn` of our own binary → EPERM. `native/probe.c` is the test. Apps2Samsung signs the `.wgt`, not ELF.
- **Wayland `screenshooter` (gst `waylandsrc`).** The compositor denies it: `tizen_screenshooter notify privilege 0` → needs the platform `screenshot` privilege, reserved for signed system apps. This is exactly why the `dcapture` daemon exists as a broker.
- **`StartPeriodicCapture` on the daemon.** Accepts and returns 0, but writes pixels only to the **protected DMA buffer**; `/dev/shm/shm_libsecv_capture` stays a 120 B descriptor (not pixels) and does not update per frame. No readable fast path.
- **Reading the DMA buffer directly** (`/dev/dri/card1`): handle is a 64-bit physical address; mapping needs GEM/PRIME ioctls = native code = blocked.
- **python2.7 + ctypes → libsec-video-capture.** Binary exists but `libpython2.7.so.1.0` is absent from the visible partition (not an LD_LIBRARY_PATH issue). Dead.
- **V4L2 `/dev/video*`:** they are the `sdp-mfc` hardware codecs (encode/decode), not capture nodes. `VIDIOC_QUERYCAP` fails.
- **Beating the daemon's per-capture cost.** `RequestCaptureToFileSync` is ~80 ms/frame at idle, **independent of resolution (160×90..540p) and JPEG quality**; the daemon serializes, so `par` > 2 gives nothing (~12.5 fps ceiling). Talking D-Bus from Node directly would NOT help (spawn cost is negligible vs the 80 ms).
- **`capture_mode=3`:** corrupt (vertical bands). Use `mode 2` (fastest, ~80 ms) or `mode 0`.
- **BK7238 flash with ltchiptool directly:** its `boot_protection_bypass` adds `+flash_size` to write addresses (BK7231T quirk) which the BK7238 ROM ignores; and the ROM mishandles 4K-write. Working method: `bk7231tools` with `boot_protection_bypass=False` and `program_flash` (the host had a one-off script). **Power the board from its own PSU during flash** — parasitic power from the CH340 TX line reads fine but corrupts writes (this caused hours of false failures). The BK7238 UART download mode is in mask ROM, so it can't be soft-bricked; the stock dump restores it.

---

## 6. How to operate (everything is driven from the Mac)

The container's agent relay lets you run typed ops inside the TV sandbox without
redeploying. Enqueue a command, poll the result:

```bash
# Host (container) status: capture fps, forward state, agent heartbeat
curl -s http://192.168.1.61:8777/status | python3 -m json.tool

# Change the TV capture loop live (persisted in /opt/t3/config.json via the file)
curl -s -X POST -d '{"mode":2,"par":2}' http://192.168.1.61:8777/stream

# Run an agent op on the TV: enqueue -> {id}, then read /result/<id>
ID=$(curl -s -X POST -d '{"op":"bench","args":{"n":8,"mode":2}}' http://192.168.1.61:8777/enqueue | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s http://192.168.1.61:8777/result/$ID | python3 -m json.tool
```

Agent ops (in `tv/core.js`): `ls`, `stat`, `readtext`, `readhex`, `exec` (whitelist of
Samsung-signed binaries only), `dlopen`, `writefile`, `writeb64` (binary upload),
`mounts` (noexec check), `bench` (time n captures), `config` (pin/reset host), `reload`.

TV endpoints: `GET http://192.168.1.31:8101/boot` (bootstrap+core status),
`/config?control=<url>` (pin a host) / `?reset=1` (back to discovery), `/agent`.

OpenBeken strip (direct): `curl 'http://192.168.1.88/cm?cmnd=SM16703P_SetPixel+0+255+0+0'` etc.
Pause DDP first with `stopDriver DDP` to test pixels manually; `startDriver DDP` to resume.

Hot-reload the TV core after editing `tv/core.js`:
```bash
scp -i ~/.ssh/t3_proxmox tv/core.js root@192.168.1.61:/opt/t3/tv/
curl -s "http://192.168.1.31:8101/boot?reload=1"   # or wait ≤30s
```

Release flow for the bootstrap (`service.js`) — only when it changes:
`commit → git tag tNN → push → load Edsol/t3@tNN in TizenBrew`. Current tag **t22**
(bootstrap v7.0, core-1.x). jsDelivr caches tags; a new tag each time, never reuse one.

---

## 7. Secrets (never commit)

`firmware-backup/` and `host/config.json` are gitignored. The Tuya **local key** and
**Wi-Fi credentials** live only in the stock dump and (historically) the Tuya config —
keep them out of any committed file and out of docs. The strip now runs OpenBeken and
no longer uses Tuya, but the backup still contains those secrets.

---

## 8. Project memories (fuller, running notes)

`t3-ambilight-plan` (main log), `t3-capture-findings` (sandbox/capture details),
`t3-remote-agent` (agent channel), `t3-goals` (user intent). Keep them updated as the
source of truth alongside this file.
