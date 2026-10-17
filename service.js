/*
 * HyperTizen T3 Probe v4 - TizenBrew service module (Node.js, runs on the TV)
 *
 * Findings so far:
 *  - card1 openable; dbus system -> samsung.tizen.dcapture . RequestCaptureToFileSync
 *    succeeds (retVal 0, 480x270) BUT the PNG it writes is unreadable to our app
 *    (SMACK / mount isolation) - pre-create did not help.
 *  - The capture format is YUV (NV21/NV61/NV42) and the raw frame lands in the
 *    shared-memory object /dev/shm/shm_libsecv_capture, which IS world-rw (0666)
 *    and openable from our sandbox.
 *
 * v4 therefore: trigger a capture over D-Bus, then read the raw bytes directly
 * from /dev/shm/shm_libsecv_capture and reconstruct a viewable image from the
 * luma (Y) plane. This needs no file access and no native code.
 *
 * Endpoints (http://<TV-IP>:8097):
 *   /            env + shm info
 *   /shminfo     trigger a dbus capture, report shm size + header hex
 *   /shot?off=0&w=480&h=270&bus=1   build a grayscale BMP from Y plane at `off`
 *                (bus=1 triggers a fresh dbus capture first). View via /img
 *   /img         last reconstructed image (BMP)
 *   /grab        legacy file attempt (diagnostics)
 *   /bench       timing of dbus capture cycle
 *
 * Node v4/v5 => ES5 only.
 */
(function () {
    'use strict';

    var fs = require('fs');
    var http = require('http');
    var cp = require('child_process');

    var VERSION = 'v4.1';
    var PORT = 8097;
    var DBUS = '/usr/bin/dbus-send';
    var NAME = 'samsung.tizen.dcapture';
    var OBJ = '/samsung/tizen/dcapture';
    var METHOD = NAME + '.RequestCaptureToFileSync';
    var SHM = '/dev/shm/shm_libsecv_capture';

    var lastImage = null; // { buf, ct }

    function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return '(' + e.code + ')'; } }

    // fire one capture through the system service; cb(replyObj)
    function dbusCapture(dir, file, app, mode, w, h, comp, q, cb) {
        var args = ['--system', '--print-reply', '--reply-timeout=4000', '--type=method_call',
            '--dest=' + NAME, OBJ, METHOD,
            'int32:' + app, 'int32:' + mode, 'int32:' + comp,
            'int32:' + w, 'int32:' + h, 'int32:' + q, 'string:' + dir, 'string:' + file];
        cp.execFile(DBUS, args, { timeout: 6000, maxBuffer: 1 << 20 }, function (err, stdout) {
            var ints = []; var re = /int32\s+(-?\d+)/g, m;
            while ((m = re.exec(String(stdout)))) ints.push(parseInt(m[1], 10));
            cb({ retVal: ints[0], ret_w: ints[1], ret_h: ints[2], raw: String(stdout).replace(/\s+/g, ' ').slice(0, 160) });
        });
    }

    function shmInfo() {
        var o = {};
        try { o.size = fs.statSync(SHM).size; } catch (e) { o.statErr = e.code || String(e); }
        try {
            var fd = fs.openSync(SHM, 'r');
            var head = new Buffer(256); var n = fs.readSync(fd, head, 0, 256, 0);
            fs.closeSync(fd);
            o.head_hex = head.slice(0, n).toString('hex');
        } catch (e) { o.readErr = e.code || String(e); }
        return o;
    }

    function readShm(path) { return fs.readFileSync(path || SHM); }

    // list every /dev/shm entry with size + first 32 bytes, flag frame-sized ones
    function listShms() {
        var out = [];
        var names;
        try { names = fs.readdirSync('/dev/shm'); } catch (e) { return { err: e.code || String(e) }; }
        for (var i = 0; i < names.length; i++) {
            var p = '/dev/shm/' + names[i];
            var row = { name: names[i], path: p };
            try {
                var st = fs.statSync(p);
                row.size = st.size;
                // frame-size hints for 480x270
                row.looks = (st.size >= 120000) ? 'frame-sized?' : '';
                var fd = fs.openSync(p, 'r'); var hb = new Buffer(32); var n = fs.readSync(fd, hb, 0, 32, 0); fs.closeSync(fd);
                row.head = hb.slice(0, n).toString('hex');
            } catch (e) { row.err = e.code || String(e); }
            out.push(row);
        }
        out.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
        return out;
    }

    // Build a 24-bit BMP (bottom-up) from a grayscale plane: buf[off + y*w + x] = luma.
    function bmpFromLuma(buf, off, w, h) {
        var rowRaw = w * 3;
        var pad = (4 - (rowRaw % 4)) % 4;
        var rowSize = rowRaw + pad;
        var imgSize = rowSize * h;
        var fileSize = 54 + imgSize;
        var out = new Buffer(fileSize);
        out.fill(0);
        out.write('BM', 0);
        out.writeUInt32LE(fileSize, 2);
        out.writeUInt32LE(54, 10);
        out.writeUInt32LE(40, 14);
        out.writeInt32LE(w, 18);
        out.writeInt32LE(h, 22);
        out.writeUInt16LE(1, 26);
        out.writeUInt16LE(24, 28);
        out.writeUInt32LE(imgSize, 34);
        for (var y = h - 1; y >= 0; y--) {
            var srow = off + y * w;
            var d = 54 + (h - 1 - y) * rowSize;
            for (var x = 0; x < w; x++) {
                var v = buf[srow + x] || 0;
                out[d] = v; out[d + 1] = v; out[d + 2] = v; d += 3;
            }
        }
        return out;
    }

    function send(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj, null, 2));
    }
    function parseQ(url) {
        var q = {}; (url.split('?')[1] || '').split('&').forEach(function (kv) {
            var a = kv.split('='); if (a[0]) q[a[0]] = decodeURIComponent(a[1] || '');
        });
        return q;
    }

    try {
        var server = http.createServer(function (req, res) {
            var url = req.url || '/';

            if (url.indexOf('/img') === 0) {
                if (lastImage) { res.writeHead(200, { 'Content-Type': lastImage.ct, 'Access-Control-Allow-Origin': '*' }); res.end(lastImage.buf); }
                else { res.writeHead(404); res.end('no image yet'); }
                return;
            }

            if (url.indexOf('/shms') === 0) {
                // trigger a capture, then list all /dev/shm with sizes so we can
                // spot which buffer holds the frame (changes size / is frame-sized)
                dbusCapture('/tmp', 't3cap', 0, 0, 0, 0, 0, 90, function (rep) {
                    send(res, 200, { version: VERSION, capture: rep, shms: listShms() });
                });
                return;
            }

            if (url.indexOf('/shminfo') === 0) {
                dbusCapture('/tmp', 't3cap', 0, 0, 0, 0, 0, 90, function (rep) {
                    send(res, 200, { version: VERSION, capture: rep, shm: SHM, shmInfo: shmInfo() });
                });
                return;
            }

            if (url.indexOf('/shot') === 0) {
                var q = parseQ(url);
                var off = +(q.off || 0);
                var w = +(q.w || 480), h = +(q.h || 270);
                var bus = q.bus === undefined ? '1' : q.bus;
                var shmPath = q.shm ? ('/dev/shm/' + q.shm.replace(/^.*\//, '')) : SHM;
                function build() {
                    var r = { version: VERSION, off: off, w: w, h: h, shm: shmPath };
                    try {
                        var buf = readShm(shmPath);
                        r.shmSize = buf.length;
                        if (off + w * h > buf.length) { r.error = 'offset+w*h exceeds shm size'; send(res, 200, r); return; }
                        var min = 255, max = 0, sum = 0, cnt = 0, step = Math.max(1, Math.floor((w * h) / 4096));
                        for (var i = 0; i < w * h; i += step) { var v = buf[off + i]; if (v < min) min = v; if (v > max) max = v; sum += v; cnt++; }
                        r.luma = { min: min, max: max, avg: Math.round(sum / cnt) };
                        lastImage = { buf: bmpFromLuma(buf, off, w, h), ct: 'image/bmp' };
                        r.image = '/img';
                    } catch (e) { r.error = e.code || String(e); }
                    send(res, 200, r);
                }
                if (bus === '1' || bus === 'true') dbusCapture('/tmp', 't3cap', 0, 0, 0, 0, 0, 90, function () { build(); });
                else build();
                return;
            }

            if (url.indexOf('/bench') === 0) {
                var qb = parseQ(url); var n = +(qb.n || 10); var i = 0; var samples = [];
                (function one() {
                    if (i >= n) {
                        var tot = 0; for (var k = 0; k < samples.length; k++) tot += samples[k];
                        var avg = samples.length ? tot / samples.length : 0;
                        send(res, 200, { n: samples.length, ms_avg: Math.round(avg), fps_avg: avg ? +(1000 / avg).toFixed(1) : 0, samples_ms: samples });
                        return;
                    }
                    i++; var t0 = Date.now();
                    dbusCapture('/tmp', 't3b', 0, 0, 0, 0, 0, 90, function () {
                        try { fs.readFileSync(SHM); } catch (e) {}
                        samples.push(Date.now() - t0); one();
                    });
                })();
                return;
            }

            if (url.indexOf('/grab') === 0) {
                var dir = '/tmp', file = 't3cap', target = dir + '/' + file + '.png', pre;
                try { fs.writeFileSync(target, ''); fs.chmodSync(target, 0x1b6); pre = 'ok'; } catch (e) { pre = e.code; }
                dbusCapture(dir, file, 0, 0, 0, 0, 0, 90, function (rep) {
                    var r = { precreate: pre, capture: rep };
                    try { r.size = fs.statSync(target).size; } catch (e) { r.readErr = e.code; }
                    send(res, 200, r);
                });
                return;
            }

            var env = { ok: true, version: VERSION, port: PORT, node: process.version, smack: readText('/proc/self/attr/current').replace(/\0/g, '').trim(), shm: shmInfo() };
            try { env.uid = process.getuid(); } catch (e) {}
            env.hint = 'GET /shminfo (size+header), then /shot?off=0 and /img';
            send(res, 200, env);
        });
        server.on('error', function (e) { try { console.log('[t3-probe] http err ' + e.code); } catch (i) {} });
        server.listen(PORT, '0.0.0.0', function () { try { console.log('[t3-probe ' + VERSION + '] :' + PORT); } catch (i) {} });
    } catch (e) { try { console.log('[t3-probe] server fail ' + e); } catch (i) {} }
})();
