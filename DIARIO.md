# T3 — Ambilight su Samsung UE55MU6120 (Tizen 3, 2017) via TizenBrew

Diario tecnico: processo, approccio, scoperte e stato. Progetto di studio personale sul
recupero di un vecchio TV (hardware di proprietà, firmware pubblico).

> Scritto per: me stesso e chiunque riprenda il progetto più avanti.

---

## 1. Obiettivo

Catturare lo schermo del TV — **inclusi i canali del sintonizzatore interno e le app** —
e pilotare una striscia LED dietro il TV (ambilight), su un apparecchio retail bloccato,
lavorando solo via **TizenBrew** (nessun root, nessun jailbreak).

## 2. Ambiente

- **TV**: Samsung UE55MU6120, IP `192.168.1.31`. Firmware T-KTMDEUC 1310.1,
  "TIZEN-3.0-TRUNK2017-KantM", armv7 soft-float, Node 4.4.3 (wrt-service, ES5), Crosswalk/V8.
- **Mac**: IP `192.168.1.140`. Tizen Studio CLI (`sdb`) installato.
- **Modulo TizenBrew**: repo `github.com/Edsol/t3`, servito via jsDelivr, caricato sul TV
  con tag (`Edsol/t3@tNN`). Il servizio Node espone HTTP su `http://192.168.1.31:8101/`.

## 3. Vincoli del sandbox (verificati, non supposti)

- `sdb`: solo `push`/`pull`/`forward`. `shell`/`install`/`dlog` **disabilitati**
  (`intershell_support=disabled`, `appcmd_support=disabled`). Il `pull` di file di sistema
  spesso fallisce (canale sync instabile).
- **Niente binari nostri**: `spawn EPERM` anche su un eseguibile scritto da noi in `/tmp`
  (l'exec di binari non-di-sistema è vietato, non è solo questione di label SMACK).
- `.tpk` nativi **non installabili** (il TV accetta solo web `.wgt`).
- L'app **può**: `fs.*` su tutto il filesystem (vista non ridotta), `cp.execFile` di **binari
  di sistema** (`dbus-send`, …), `process.dlopen` di **librerie di sistema**.
  Scrivibili: `/tmp`, `/dev/shm`, `/opt/usr/home/owner/share/tmp`. HOME non scrivibile.
- Identità processo app: uid **5001**, SMACK label **`User::Pkg::xvvl3S1bvH`**.

## 4. Il problema del redeploy → la svolta: l'agente remoto

Ogni modifica richiedeva: commit → tag → purge jsDelivr → **riavviare TizenBrew sul TV**.
Lentissimo per iterare. Soluzione: l'app è diventata un **esecutore remoto**.

- **control-server.js** gira sul Mac (`:8777`), tiene una coda di comandi.
- L'**agent** (dentro `service.js`, da v5.8) fa polling `GET /cmd` ogni 1s, esegue un comando
  **tipizzato** nella sandbox, e fa `POST /result`.
- Ops: `ls`, `stat`, `find`, `readhex`, `exec` (whitelist: python2.7, dbus-send), `dlopen`,
  `writefile`. Non è una shell remota: è un canale diagnostico ristretto sul proprio device.
- Da qui in poi tutta l'esplorazione si fa **dal Mac senza redeploy**. (`t3.js` = CLI comoda.)
- Endpoint diagnostici sul TV: `/agent` (stato polling), `/find` (cosa vede l'app),
  `/helper`, `/shminfo`, `/shot`, `/bench`.

> Lezione: leggere device a caratteri (`/dev/dri/*`, `/dev/mem`, `/dev/fb*`) con `readSync`
> **blocca** l'intero loop Node dell'agent (niente EOF). `readhex` ora li rifiuta.

## 5. Le vie di cattura esplorate (e perché scartate)

| Via | Esito | Motivo |
|-----|-------|--------|
| Stream/flusso diretto del video | ❌ non esiste | i pixel vivono su buffer DMA protetto |
| Shared memory con i pixel | ❌ | `shm_libsecv_capture` è solo un **descrittore** 120B, non i pixel |
| Buffer DMA via `/dev/dri/card1` | ❌ (senza codice nativo) | schermo reale **4K**, l'handle è un **indirizzo fisico** a 64bit; mappare richiede `ioctl` GEM/PRIME = addon/binario nostro = `spawn EPERM`. I device non si leggono come file (si appendono). |
| `python2.7` + `ctypes` → `secvideo` | ❌ | il binario c'è ma **manca `libpython2.7.so.1.0`** nella partizione visibile (non è un problema di `LD_LIBRARY_PATH`: il file non c'è). |
| Eseguire `display-capture-service` a mano | ❌ | è un **puro demone D-Bus**, nessuna CLI; eseguirlo va in conflitto col demone già attivo |
| **File JPEG via D-Bus in `/dev/shm`** | ✅ **FUNZIONA** | unica via che dà pixel leggibili, senza codice nativo |

## 6. La soluzione di cattura

Il demone **`/usr/bin/display-capture-service`** (build 0.021) espone sul system bus
`samsung.tizen.dcapture`, obj `/samsung/tizen/dcapture`. Metodo usato:

```
RequestCaptureToFileSync(app_type:i, capture_mode:i, comp_type:i, width:i, height:i,
                         jpeg_quality:i, dir_path:s, file_name:s)
  -> retVal:i, ret_width:i, ret_height:i, ret_path:s
```

**Ricetta che funziona** (chiamabile con `dbus-send`, già permesso):
`app_type=0, capture_mode=0, comp_type=1 (JPEG), 480×270, q, dir="/dev/shm"`.

- **Perché `/dev/shm`**: è l'unica dir dove il file nasce con label SMACK **leggibile**
  dall'app (tmpfs world-rw). In `/tmp` o nelle dir home il file è completo ma **EACCES**
  (nasce con la label del demone; l'app può leggere solo label `User::Pkg::<x>::SharedRO`,
  da `/sys/fs/smackfs/load2`).
- **Perché JPEG e non PNG**: in `/dev/shm` il **PNG esce troncato a 8192 byte** (bug del
  demone), mentre il **JPEG è completo** (termina con `ffd9`). `comp_type`: 0=PNG, 1=JPEG, ≥2=invalido.
- `capture_mode` 0/1/2 validi; **mode=3 produce frame corrotti** (bande verticali) — scartare.
- Il demone **ignora** width/height richiesti: ritorna sempre 480×270 (downscale del 4K reale).

**Cosa si cattura** (verificato dal vivo):
- ✅ **Canali TV / tuner** (il video reale, non solo la UI) — era il requisito critico.
- ✅ **Netflix in riproduzione** — **nessun blocco DRM/HDCP** su questo TV.
- ✅ UI / menu.

**Performance**: cattura nativa sul TV **~5–9 fps** (`/bench`: 198ms medi, migliori 110–170ms).
Via canale remoto Mac solo ~0.3 fps (il polling 1s + round-trip è il collo di bottiglia) → il
loop ambilight **definitivo deve girare sul TV o su un host dedicato, non sul Mac**.

## 7. Output LED — stato

- **Hardware attuale**: *Eurodomest Smart LED Strip Kit* (Action), striscia WiFi **Tuya**,
  già integrata in **Home Assistant via LocalTuya**. Device su `192.168.1.88`, protocollo **v3.5**.
- **Test locale (tinytuya dal Mac)**: connessione OK, cambi colore OK, **24 comandi/sec** (0 errori
  con socket persistente) → altro che lento, regge un ambilight fluido.
- **Limite**: i DPS esposti sono solo 4 (20=on/off, 21=mode, 24=colore **globale** HSV, 26=timer).
  **Nessun controllo per-segmento** via Tuya locale → con questa striscia si fa un **BIAS-LIGHT a
  colore unico** (colore medio/dominante dello schermo), non ambilight per-zona.
- **Per-zona vero** → richiede il piano futuro: **ESP + WLED** su striscia dedicata (segmenti
  indirizzabili, UDP DRGB/DNRGB, 30+ fps).

## 8. Architettura scelta

Il loop non passa dal Mac (troppo lento). Due percorsi verso i LED:

1. **Ponte via Home Assistant** (semplice, subito): il TV manda il **colore medio** a HA via
   REST; HA comanda la striscia (LocalTuya già configurato). Il TV fa solo una HTTP, **zero crypto**.
2. **HyperHDR** (qualità, pronto per ESP+WLED): HyperHDR gira sull'host HA; il TV gli **pusha i
   frame** (flatbuffers `:19400`, schema `RawImage`/`NV12Image`); HyperHDR fa zone, smoothing,
   gamma e output verso WLED/Hue. Con Tuya serve comunque un bridge; con ESP+WLED è plug-and-play.

> Nota su Tuya v3.5 dal TV: reimplementare il protocollo (AES-GCM + handshake session key) in
> Node 4.4 ES5 è troppo oneroso/rischioso come primo passo → si preferisce il **ponte HA**
> (il TV fa una semplice richiesta HTTP).

## 9. Stato attuale

- ✅ Cattura schermo risolta, leggibile, su tutte le sorgenti (tuner + app), senza codice nativo.
- ✅ Canale remoto per sviluppare senza redeploy.
- ✅ Controllo striscia Tuya verificato (bias-light fluido possibile).
- ✅ Prototipo immagine→colore (media/vibrant, smoothing, gamma) funzionante dal Mac.
- ⏭️ Da fare: scegliere il motore (ponte HA vs HyperHDR) e rendere il loop autonomo;
  in prospettiva ESP+WLED per il per-zona.

## 10. File del progetto

- `service.js` — modulo TizenBrew (HTTP + agent remoto + cattura). Gira sul TV.
- `app/index.html`, `package.json` — resto del modulo.
- Strumenti Mac (fuori repo, in `~/Downloads/t3-control/` e nello scratchpad di sessione):
  `control-server.js` (coda comandi), `t3.js` (CLI), `biaslight.py`/`ambilight_proto.py`
  (prototipi colore), `sweep.py`/`tuner_test.py` (test cattura), `tuya.json` (credenziali locali LED).
