/*
 * HyperTizen T3 Probe v3 - TizenBrew service module (Node.js, runs on the TV)
 *
 * v2 proved the system service CAPTURES the screen:
 *   dbus system -> samsung.tizen.dcapture . RequestCaptureToFileSync
 *   (app=0, mode=0, comp=0, w=0, h=0, q=90, /tmp, t3cap)
 *   -> retVal=0, 480x270, /tmp/t3cap.png
 * But the daemon runs as root and the PNG it creates is unreadable to our app
 * (EACCES - different SMACK label / perms).
 *
 * v3 works around that by PRE-CREATING the output file ourselves (our label,
 * mode 0666) so the daemon truncates+writes it in place, keeping our label, and
 * we can read it back. It tries several output directories to find one shared
 * between our sandbox and the daemon.
 *
 * Endpoints (http://<TV-IP>:8096):
 *   /         env + writable-dir probe (JSON, has version)
 *   /grab     precreate + capture + read, sweeping candidate dirs; serves /img
 *   /grab?dir=/tmp&w=0&h=0&app=0&mode=0   single explicit attempt
 *   /img      the captured image (if any)
 *   /sweep    v2 raw dbus matrix (diagnostics)
 *
 * Node v4/v5 => ES5 only.
 */
(function () {
    'use strict';

    var fs = require('fs');
    var http = require('http');
    var cp = require('child_process');

    var VERSION = 'v3.1';
    var PORT = 8096;
    var DBUS = '/usr/bin/dbus-send';
    var NAME = 'samsung.tizen.dcapture';
    var OBJ = '/samsung/tizen/dcapture';
    var METHOD = NAME + '.RequestCaptureToFileSync';

    var lastImage = null; // { path, buf, ct }

    function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return '(' + e.code + ')'; } }
    function smackOf(p) {
        // best-effort: label of a path via /proc not available; return own label
        return readText('/proc/self/attr/current').replace(/\0/g, '').trim();
    }

    function candidateDirs() {
        var list = [];
        function add(d) { if (d && list.indexOf(d) < 0) list.push(d); }
        add('/tmp');
        add(process.env.HOME);
        add(process.env.TMPDIR);
        try { add(process.cwd()); } catch (e) {}
        add('/opt/usr/home/owner/share/tmp');
        add('/opt/usr/home/owner/tmp');
        add('/home/owner/share/tmp');
        return list;
    }

    // can we create+read a file in this dir?
    function dirWritable(dir) {
        var p = dir + '/.t3w';
        try {
            fs.writeFileSync(p, 'x');
            var ok = fs.readFileSync(p, 'utf8') === 'x';
            try { fs.unlinkSync(p); } catch (e) {}
            return ok;
        } catch (e) { return e.code || String(e); }
    }

    function capture(dir, file, app, mode, w, h, comp, q, cb) {
        var target = dir + '/' + file + (comp === 1 ? '.jpg' : '.png');
        var pre = null;
        // PRE-CREATE the output file with our label + open perms
        try {
            fs.writeFileSync(target, '');
            try { fs.chmodSync(target, 0x1b6 /* 0666 */); } catch (e) {}
            pre = 'ok';
        } catch (e) { pre = e.code || String(e); }

        var args = ['--system', '--print-reply', '--reply-timeout=4000', '--type=method_call',
            '--dest=' + NAME, OBJ, METHOD,
            'int32:' + app, 'int32:' + mode, 'int32:' + comp,
            'int32:' + w, 'int32:' + h, 'int32:' + q,
            'string:' + dir, 'string:' + file];
        var res = { dir: dir, file: target, precreate: pre, app: app, mode: mode, w: w, h: h, comp: comp };

        cp.execFile(DBUS, args, { timeout: 6000, maxBuffer: 1 << 20 }, function (err, stdout, stderr) {
            res.stderr = String(stderr || '');
            res.exit = err ? (err.code != null ? err.code : String(err)) : 0;
            var ints = []; var re = /int32\s+(-?\d+)/g, m;
            while ((m = re.exec(String(stdout)))) ints.push(parseInt(m[1], 10));
            var pm = /string\s+"([^"]*)"/.exec(String(stdout));
            res.reply = { retVal: ints[0], ret_w: ints[1], ret_h: ints[2], ret_path: pm ? pm[1] : null };
            // read back the file we pre-created (daemon should have written into it)
            try {
                var st = fs.statSync(target);
                res.size = st.size;
                if (st.size > 0) {
                    var buf = fs.readFileSync(target);
                    var ct = (buf[0] === 0xff && buf[1] === 0xd8) ? 'image/jpeg'
                        : (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png' : 'application/octet-stream';
                    res.magic = buf.slice(0, 8).toString('hex');
                    res.readable = true;
                    res.imageType = ct;
                    lastImage = { path: target, buf: buf, ct: ct };
                } else {
                    res.readable = false; res.note = 'file present but empty (daemon may write to a different mount)';
                }
            } catch (e) { res.readable = false; res.readErr = e.code || String(e); }
            cb(res);
        });
    }

    function grabSweep(cb) {
        var dirs = candidateDirs();
        var results = [];
        var i = 0;
        function next() {
            if (i >= dirs.length) { cb({ success: false, results: results }); return; }
            var dir = dirs[i++];
            var w = dirWritable(dir);
            if (w !== true) { results.push({ dir: dir, writable: w }); next(); return; }
            capture(dir, 't3cap', 0, 0, 0, 0, 0, 90, function (r) {
                r.writable = true; results.push(r);
                if (r.readable) { cb({ success: true, winner: r, results: results }); return; }
                next();
            });
        }
        next();
    }

    // Measure achievable rate of the dbus->png->read cycle on this TV.
    function bench(dir, n, cb) {
        var file = 't3bench';
        var target = dir + '/' + file + '.png';
        try { fs.writeFileSync(target, ''); fs.chmodSync(target, 0x1b6); } catch (e) {}
        var samples = []; var i = 0;
        var args = ['--system', '--print-reply', '--reply-timeout=4000', '--type=method_call',
            '--dest=' + NAME, OBJ, METHOD, 'int32:0', 'int32:0', 'int32:0',
            'int32:0', 'int32:0', 'int32:90', 'string:' + dir, 'string:' + file];
        function one() {
            if (i >= n) {
                var tot = 0, mn = 1e9, mx = 0;
                for (var k = 0; k < samples.length; k++) { tot += samples[k]; if (samples[k] < mn) mn = samples[k]; if (samples[k] > mx) mx = samples[k]; }
                var avg = samples.length ? tot / samples.length : 0;
                cb({ dir: dir, n: samples.length, ms_avg: Math.round(avg), ms_min: mn, ms_max: mx,
                    fps_avg: avg ? +(1000 / avg).toFixed(1) : 0, samples_ms: samples });
                return;
            }
            i++;
            var t0 = Date.now();
            cp.execFile(DBUS, args, { timeout: 6000, maxBuffer: 1 << 20 }, function () {
                try { fs.readFileSync(target); } catch (e) {}
                samples.push(Date.now() - t0);
                one();
            });
        }
        one();
    }

    function send(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj, null, 2));
    }

    function parseQ(url) {
        var q = {}; var qs = (url.split('?')[1] || '');
        qs.split('&').forEach(function (kv) { var a = kv.split('='); if (a[0]) q[a[0]] = decodeURIComponent(a[1] || ''); });
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
            if (url.indexOf('/grab') === 0) {
                var q = parseQ(url);
                if (q.dir) {
                    capture(q.dir, q.file || 't3cap', +(q.app || 0), +(q.mode || 0),
                        +(q.w || 0), +(q.h || 0), +(q.comp || 0), +(q.q || 90),
                        function (r) { send(res, 200, r); });
                } else {
                    grabSweep(function (out) { send(res, 200, out); });
                }
                return;
            }
            if (url.indexOf('/bench') === 0) {
                var qb = parseQ(url);
                bench(qb.dir || '/tmp', +(qb.n || 10), function (r) { send(res, 200, r); });
                return;
            }
            if (url.indexOf('/sweep') === 0) {
                // minimal diagnostic: single known-good call, no precreate
                capture('/tmp', 't3raw', 0, 0, 0, 0, 0, 90, function (r) { send(res, 200, r); });
                return;
            }
            // default: env + writable dirs
            var env = { ok: true, version: VERSION, port: PORT, node: process.version, smack: smackOf() };
            try { env.uid = process.getuid(); } catch (e) {}
            env.HOME = process.env.HOME; env.cwd = (function () { try { return process.cwd(); } catch (e) { return null; } })();
            env.dirs = {};
            var ds = candidateDirs();
            for (var i = 0; i < ds.length; i++) env.dirs[ds[i]] = dirWritable(ds[i]);
            env.hint = 'GET /grab to capture into a readable dir, then /img to view';
            send(res, 200, env);
        });
        server.on('error', function (e) { try { console.log('[t3-probe] http err ' + e.code); } catch (i) {} });
        server.listen(PORT, '0.0.0.0', function () { try { console.log('[t3-probe ' + VERSION + '] http://<TV-IP>:' + PORT + '  (/, /grab, /img)'); } catch (i) {} });
    } catch (e) { try { console.log('[t3-probe] server fail ' + e); } catch (i) {} }
})();
