# HyperTizen T3 Probe

Probe minimo per capire se un'app **auto-firmata** installata su una Samsung TV
**Tizen 3 / 2017** (testato su UE55MU6120, chassis "KantM") riesce a raggiungere
le risorse usate dall'API di sistema `secvideo_api_capture_screen()`.

Dall'analisi del firmware (`libsec-video-capture.so.0`, `libsec-video-drm-helper.so.0`)
la cattura passa da:

- `/dev/dri/card1` — ioctl proprietario `DRM_IOCTL_SDP_HW_CAPTURE`
- `/dev/shm/shm_libsecv_capture` — memoria condivisa del frame
- helper: `/dev/dri/card0`, `/dev/ocm`, `/dev/video20/21/28`

**Se questo sandbox non riesce nemmeno ad aprire `/dev/dri/card1`, la cattura
in-app è impossibile** con qualsiasi linguaggio o packaging, e ci si ferma qui.
Se invece l'apertura riesce, ha senso passare allo step successivo (chiamata
nativa `dlopen` + ioctl).

> Il probe **legge soltanto** i device (stat + open in sola lettura/lettura-scrittura).
> Non esegue nessuna cattura e non modifica nulla sul televisore.

## Cosa fa

Un servizio Node (eseguito da TizenBrew sul TV) raccoglie:

- etichetta **SMACK** del processo (`/proc/self/attr/current`) e gruppi UNIX
- per ogni device: esistenza, tipo, permessi, e l'`errno` di `open(O_RDONLY)` /
  `open(O_RDWR)` (es. `EACCES`, `ENOENT`, `EPERM`, oppure successo)
- leggibilità delle librerie di cattura in `/usr/lib`
- contenuto di `/dev/dri` e `/dev/shm`
- un **verdetto** sintetico sul gate `/dev/dri/card1`

I risultati sono serviti in JSON e visibili in due modi:

1. nell'interfaccia del modulo dentro TizenBrew (verdetto grande + dump);
2. da qualsiasi browser sulla stessa rete: **`http://<IP-della-TV>:8095`**.

## Installazione (via Apps2Samsung + TizenBrew)

1. Sul TV: **Apps** → digita `12345` → attiva **Developer Mode**, imposta
   **Host PC IP** con l'IP del tuo PC → **OK** → riavvia il TV.
2. Installa **TizenBrew** sul TV con
   [Apps2Samsung](https://github.com/Apps2Samsung) (opzione *Custom WGT File*,
   usando il `TizenBrewStandalone.wgt` della
   [release TizenBrew](https://github.com/reisxd/TizenBrew/releases/latest)).
3. Pubblica questa cartella come repo GitHub (es. `Edsol/hypertizen-t3-probe`).
   TizenBrew carica i moduli da GitHub via jsDelivr, quindi **basta che il repo
   sia pubblico** — nessuna build necessaria.
4. Apri TizenBrew sul TV → **Module Manager** (tasto **VERDE**) → aggiungi il
   modulo `Edsol/hypertizen-t3-probe`.
5. Avvia il modulo. Parte il servizio e si apre l'interfaccia con il verdetto.

## Come leggere il risultato

- **`card1-OPEN-OK`** → il device di cattura è apribile dall'app: vale la pena
  costruire la chiamata nativa. Prossimo step: eseguibile ARM soft-float
  (EABIv5, glibc 2.4) che fa `dlopen("libsec-video-capture.so.0")` e chiama
  `secvideo_api_capture_screen` / `_video_only`.
- **`card1-readonly`** → apribile ma non in scrittura: l'ioctl potrebbe comunque
  essere negato; da verificare con lo step nativo.
- **`card1-BLOCKED (EACCES/EPERM)`** → il sandbox SMACK/DAC blocca l'accesso: la
  cattura in-app non è possibile su questo TV. Si passa alle alternative
  (webcam + HyperHDR, oppure decoder esterno).
- **`card1-absent`** → su questo firmware il nodo non esiste con quel nome;
  guarda `ls_dev_dri` nel JSON per i nomi reali.

## Note tecniche

- Runtime JS del TV: Crosswalk/V8; il servizio gira su Node vecchio (v4/v5),
  perciò il codice è **solo ES5**.
- Il servizio apre una porta HTTP su `0.0.0.0:8095` solo in LAN, per la lettura
  dei risultati. Nessun dato esce dalla rete locale.
