/*
 * HyperTizen T3 Probe v2 - TizenBrew service module (Node.js, runs on the TV)
 *
 * v1 confirmed the capture gate is reachable from a self-signed app
 * (/dev/dri/card1 opens OK). v2 tries to actually GET A FRAME without any
 * native code, by asking the system display-capture-service over D-Bus.
 *
 * Reversed from /usr/bin/display-capture-service (firmware T-KTMDEUC 1310.1):
 *   bus name / interface : samsung.tizen.dcapture   (also org.volt.FirstScreen)
 *   object path          : /samsung/tizen/dcapture  (also /org/volt/FirstScreen)
 *   method RequestCaptureToFileSync(
 *       i app_type, i capture_mode, i comp_type, i width, i height,
 *       i jpeg_quality, s dir_path, s file_name)
 *     -> i retVal, i ret_width, i ret_height, s ret_path
 * The daemon renders the screen to <dir>/<file>.png (or jpeg) and returns the
 * path. We invoke it with /usr/bin/dbus-send and then read the file.
 *
 * Endpoints (http://<TV-IP>:8095):
 *   /            device + environment probe (JSON)
 *   /sweep       try RequestCaptureToFileSync across bus/app_type/mode/comp
 *   /capture?bus=system&app=0&mode=0&comp=0&w=0&h=0&q=90&dir=/tmp
 *   /img         serve the most recently captured image
 *
 * Read-only w.r.t. the system; it only asks the OS to screenshot to a temp file.
 * Node v4/v5 => ES5 only.
 */
(function () {
    'use strict';

    var fs = require('fs');
    var http = require('http');
    var cp = require('child_process');

    var VERSION = 'v2.1';
    var PORT = 8096; // v1 used 8095; use a fresh port so a stale v1 server never shadows v2
    var DBUS = '/usr/bin/dbus-send';
    var IFACE = 'samsung.tizen.dcapture';
    var OBJ = '/samsung/tizen/dcapture';
    var ALT_NAME = 'org.volt.FirstScreen';
    var ALT_OBJ = '/org/volt/FirstScreen';

    var lastImage = null; // { path, buf, ct }

    // ---------- environment probe (from v1) ----------
    var DEVICES = ['/dev/dri/card1', '/dev/dri/card0', '/dev/shm/shm_libsecv_capture'];

    function tryOpen(p, flags) {
        var fd = -1;
        try { fd = fs.openSync(p, flags); return null; }
        catch (e) { return e.code || String(e); }
        finally { if (fd >= 0) { try { fs.closeSync(fd); } catch (i) {} } }
    }
    function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return '(' + e.code + ')'; } }
    function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }

    function envProbe() {
        var o = { when: new Date().toISOString(), node: process.version, pid: process.pid };
        try { o.uid = process.getuid(); } catch (e) {}
        o.smack = readText('/proc/self/attr/current').replace(/\0/g, '').trim();
        o.dbus_send = exists(DBUS);
        o.devices = {};
        for (var i = 0; i < DEVICES.length; i++) o.devices[DEVICES[i]] = { exists: exists(DEVICES[i]), rdwr: tryOpen(DEVICES[i], 'r+') };
        return o;
    }

    // ---------- dbus capture ----------
    function dbusArgs(bus, name, obj, p) {
        return [
            '--' + bus, '--print-reply', '--reply-timeout=4000', '--type=method_call',
            '--dest=' + name, obj, IFACE + '.RequestCaptureToFileSync',
            'int32:' + p.app, 'int32:' + p.mode, 'int32:' + p.comp,
            'int32:' + p.w, 'int32:' + p.h, 'int32:' + p.q,
            'string:' + p.dir, 'string:' + p.file
        ];
    }

    function runCapture(bus, useAlt, p, cb) {
        var name = useAlt ? ALT_NAME : IFACE;
        var obj = useAlt ? ALT_OBJ : OBJ;
        var args = dbusArgs(bus, name, obj, p);
        var res = { bus: bus, dest: name, params: p, cmd: DBUS + ' ' + args.join(' ') };
        var done = false;
        var child;
        try {
            child = cp.execFile(DBUS, args, { timeout: 6000, maxBuffer: 1 << 20 },
                function (err, stdout, stderr) {
                    if (done) return; done = true;
                    res.stdout = String(stdout || '');
                    res.stderr = String(stderr || '');
                    res.exit = err ? (err.code != null ? err.code : String(err)) : 0;
                    // parse reply ints + path
                    var ints = [];
                    var re = /int32\s+(-?\d+)/g, m;
                    while ((m = re.exec(res.stdout))) ints.push(parseInt(m[1], 10));
                    var pm = /string\s+"([^"]*)"/.exec(res.stdout);
                    res.reply = { ints: ints, retVal: ints[0], ret_w: ints[1], ret_h: ints[2], ret_path: pm ? pm[1] : null };
                    // find the written file
                    var cand = (res.reply.ret_path && res.reply.ret_path.charAt(0) === '/')
                        ? res.reply.ret_path
                        : (p.dir + '/' + p.file + (p.comp === 1 ? '.jpg' : '.png'));
                    res.file = cand;
                    try {
                        var st = fs.statSync(cand);
                        res.fileSize = st.size;
                        res.fileFound = st.size > 0;
                        if (res.fileFound) {
                            var buf = fs.readFileSync(cand);
                            var ct = (buf[0] === 0xff && buf[1] === 0xd8) ? 'image/jpeg'
                                : (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png' : 'application/octet-stream';
                            lastImage = { path: cand, buf: buf, ct: ct };
                            res.imageType = ct;
                        }
                    } catch (e) { res.fileFound = false; res.fileErr = e.code || String(e); }
                    cb(res);
                });
        } catch (e) {
            res.spawnError = String(e); cb(res); return;
        }
    }

    // try a small matrix until a file is produced
    function sweep(cb) {
        var buses = ['system', 'session'];
        var alts = [false, true];
        var apps = [0, 1, 2];
        var modes = [0, 1];
        var comps = [0]; // png
        var dir = '/tmp';
        var combos = [];
        for (var b = 0; b < buses.length; b++)
          for (var a = 0; a < alts.length; a++)
            for (var ap = 0; ap < apps.length; ap++)
              for (var md = 0; md < modes.length; md++)
                for (var c = 0; c < comps.length; c++)
                  combos.push({ bus: buses[b], alt: alts[a],
                    p: { app: apps[ap], mode: modes[md], comp: comps[c], w: 0, h: 0, q: 90, dir: dir, file: 't3cap' } });
        var results = [];
        var i = 0;
        function next() {
            if (i >= combos.length) { cb({ success: false, tried: results.length, results: results }); return; }
            var cmb = combos[i++];
            runCapture(cmb.bus, cmb.alt, cmb.p, function (r) {
                results.push(r);
                if (r.fileFound) { cb({ success: true, winner: r, tried: results.length, results: results }); return; }
                // stop early if dbus-send itself is missing
                if (r.spawnError) { cb({ success: false, fatal: r.spawnError, results: results }); return; }
                next();
            });
        }
        next();
    }

    // ---------- http ----------
    function send(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj, null, 2));
    }

    try {
        var server = http.createServer(function (req, res) {
            var url = req.url || '/';
            if (url.indexOf('/img') === 0) {
                if (lastImage) { res.writeHead(200, { 'Content-Type': lastImage.ct, 'Access-Control-Allow-Origin': '*' }); res.end(lastImage.buf); }
                else { res.writeHead(404); res.end('no image yet'); }
                return;
            }
            if (url.indexOf('/sweep') === 0) { sweep(function (out) { send(res, 200, out); }); return; }
            if (url.indexOf('/capture') === 0) {
                var q = {}; var qs = url.split('?')[1] || '';
                qs.split('&').forEach(function (kv) { var a = kv.split('='); if (a[0]) q[a[0]] = decodeURIComponent(a[1] || ''); });
                var bus = q.bus || 'system';
                var useAlt = q.name === 'volt';
                var p = { app: +(q.app || 0), mode: +(q.mode || 0), comp: +(q.comp || 0),
                    w: +(q.w || 0), h: +(q.h || 0), q: +(q.q || 90), dir: q.dir || '/tmp', file: q.file || 't3cap' };
                runCapture(bus, useAlt, p, function (r) { send(res, 200, r); });
                return;
            }
            send(res, 200, { ok: true, version: VERSION, port: PORT, env: envProbe(),
                hint: 'GET /sweep to attempt a capture, then GET /img to view it' });
        });
        server.on('error', function (e) { try { console.log('[t3-probe] http err ' + e.code); } catch (i) {} });
        server.listen(PORT, '0.0.0.0', function () { try { console.log('[t3-probe v2] http://<TV-IP>:' + PORT + '  (/, /sweep, /img)'); } catch (i) {} });
    } catch (e) { try { console.log('[t3-probe] server fail ' + e); } catch (i) {} }
})();
