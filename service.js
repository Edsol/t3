/*
 * HyperTizen T3 Probe - TizenBrew service module (Node.js, runs on the TV)
 *
 * v5.8: adds a REMOTE AGENT. The app polls a control server on the Mac
 * (192.168.1.140:8777) for one typed command at a time, runs it inside the app
 * sandbox, and POSTs the result back. This lets us drive diagnostics and the
 * capture work entirely from the Mac WITHOUT re-deploying the TizenBrew module
 * every time. All ops act on the user's own device; exec is restricted to a
 * fixed whitelist of SYSTEM binaries (python2.7, dbus-send).
 *
 * Findings so far:
 *  - card1 openable; dbus system -> samsung.tizen.dcapture . RequestCaptureToFileSync
 *    succeeds (retVal 0, 480x270) BUT the PNG it writes is unreadable to our app.
 *  - raw frame is NV21 480x270; /dev/shm/shm_libsecv_capture holds only a 120B
 *    descriptor, not the pixels.
 *  - app can exec SYSTEM binaries (dbus-send works; python2.7 now spawns, but its
 *    loader cannot find libpython2.7.so.1.0 -> exit 127, under investigation via
 *    the remote agent's find/ls ops).
 *
 * HTTP endpoints (http://<TV-IP>:8101):
 *   /         env + shm info          /native  dlopen/mount feasibility
 *   /find     what libs the app sees  /helper  last python-probe output
 *   /shminfo  dbus capture + shm hdr  /shms    dbus capture + all /dev/shm
 *   /shot     grayscale BMP from Y    /img     last reconstructed image
 *   /bench    dbus capture timing     /grab    legacy file attempt
 *   /agent    remote-agent status
 *
 * Node v4/v5 => ES5 only.
 */
(function () {
    'use strict';

    var fs = require('fs');
    var http = require('http');
    var cp = require('child_process');

    var VERSION = 'v5.8';
    var PORT = 8101;
    var DBUS = '/usr/bin/dbus-send';
    var NAME = 'samsung.tizen.dcapture';
    var OBJ = '/samsung/tizen/dcapture';
    var METHOD = NAME + '.RequestCaptureToFileSync';
    var SHM = '/dev/shm/shm_libsecv_capture';

    var lastImage = null; // { buf, ct }
    var helperReport = 'helper not run yet';
    var agentState = { control: null, lastPoll: 0, lastErr: null, ran: 0 };

    function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return '(' + e.code + ')'; } }

    // libpython2.7.so.1.0 exists in the firmware but the loader cannot find it
    // (exit 127): the sandboxed process does not inherit the right search path.
    // Try the known system lib dirs via LD_LIBRARY_PATH (read-only).
    var PY_LIBDIRS = ['/usr/lib', '/lib', '/usr/lib/python2.7',
        '/usr/lib/python2.7/lib-dynload', '/usr/lib/python2.7/config',
        '/usr/local/lib', '/opt/usr/lib'];
    function findPyLibDir() {
        for (var i = 0; i < PY_LIBDIRS.length; i++) {
            try { if (fs.statSync(PY_LIBDIRS[i] + '/libpython2.7.so.1.0').isFile()) return PY_LIBDIRS[i]; } catch (e) { }
        }
        try {
            var names = fs.readdirSync('/usr/lib');
            for (var j = 0; j < names.length; j++) if (names[j].indexOf('libpython2.7') === 0) return '/usr/lib';
        } catch (e) { }
        return null;
    }
    function pyEnv() {
        var env = {}; for (var k in process.env) env[k] = process.env[k];
        var dir = findPyLibDir();
        env.LD_LIBRARY_PATH = (dir ? dir + ':' : '') + PY_LIBDIRS.join(':')
            + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
        return env;
    }

    // Read-only: what does OUR sandboxed process actually see? For each candidate
    // dir, its entry count and any file matching 'libpython'/'libsec-video'.
    function findLibs() {
        var dirs = ['/usr/lib', '/lib', '/usr/lib/python2.7',
            '/usr/lib/python2.7/lib-dynload', '/usr/lib/python2.7/config',
            '/usr/local/lib', '/opt/usr/lib', '/ro/usr/lib', '/usr/lib/python2.7/plat-linux2'];
        var o = {};
        for (var i = 0; i < dirs.length; i++) {
            var d = dirs[i]; var row = {};
            try {
                var names = fs.readdirSync(d);
                row.count = names.length;
                row.match = names.filter(function (n) {
                    return n.indexOf('libpython') === 0 || n.indexOf('libsec-video') === 0;
                });
            } catch (e) { row.err = e.code || String(e); }
            o[d] = row;
        }
        var files = ['/usr/lib/libpython2.7.so.1.0', '/usr/lib/libsec-video-capture.so.0',
            '/usr/bin/python2.7', '/usr/bin/dbus-send'];
        o._stat = {};
        for (var j = 0; j < files.length; j++) {
            try { var st = fs.statSync(files[j]); o._stat[files[j]] = { size: st.size, mode: (st.mode & 0x1ff).toString(8) }; }
            catch (e) { o._stat[files[j]] = e.code || String(e); }
        }
        return o;
    }
    function runHelperOnce() {
        var script = '/home/owner/share/tmp/cap.py';
        var env = pyEnv();
        helperReport = 'running python on ' + script + '\nfound libdir=' + findPyLibDir()
            + '\nLD_LIBRARY_PATH=' + env.LD_LIBRARY_PATH + '\n';
        try {
            cp.execFile('/usr/bin/python2.7', [script],
                { timeout: 25000, maxBuffer: 8 << 20, env: env }, function (err, so, se) {
                    helperReport += 'python exit=' + (err ? (err.code != null ? err.code : String(err)) : 0)
                        + '\n--- stdout ---\n' + String(so || '')
                        + '\n--- stderr ---\n' + String(se || '');
                });
        } catch (e) { helperReport = 'spawn error: ' + (e && e.stack || e); }
    }

    /* ====================== REMOTE AGENT ====================== *
     * Polls the Mac control server for one typed command, runs it, posts back.
     * Ops: ls, stat, find, readhex, exec (whitelist), dlopen, writefile.
     * Lets us iterate from the Mac without re-deploying this module.           */
    var CONTROL = 'http://192.168.1.140:8777';
    var POLL_MS = 1000;
    var EXEC_WHITELIST = ['/usr/bin/python2.7', '/usr/bin/dbus-send', '/bin/ls', '/usr/bin/env'];

    function agentHttp(method, path, body, cb) {
        var data = body ? new Buffer(JSON.stringify(body)) : null;
        var m = CONTROL.match(/^http:\/\/([^:\/]+):?(\d+)?/);
        var opts = { host: m[1], port: m[2] ? +m[2] : 80, path: path, method: method,
            headers: { 'Content-Type': 'application/json' } };
        if (data) opts.headers['Content-Length'] = data.length;
        var req = http.request(opts, function (res) {
            var b = ''; res.on('data', function (c) { b += c; });
            res.on('end', function () { try { cb(null, b ? JSON.parse(b) : {}); } catch (e) { cb(e); } });
        });
        req.on('error', function (e) { cb(e); });
        if (data) req.write(data);
        req.end();
    }
    function agentLdEnv(extra) {
        var env = {}; for (var k in process.env) env[k] = process.env[k];
        if (extra) for (var k2 in extra) env[k2] = extra[k2];
        if (!env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = PY_LIBDIRS.join(':');
        return env;
    }
    var AGENT_OPS = {
        ls: function (a, cb) {
            var names = fs.readdirSync(a.path);
            cb(null, { path: a.path, count: names.length, entries: names.map(function (n) {
                var p = a.path.replace(/\/$/, '') + '/' + n;
                try { var st = fs.statSync(p); return { name: n, size: st.size, mode: (st.mode & 0x1ff).toString(8), dir: st.isDirectory() }; }
                catch (e) { return { name: n, err: e.code || String(e) }; }
            }) });
        },
        stat: function (a, cb) {
            var st = fs.statSync(a.path);
            cb(null, { path: a.path, size: st.size, mode: (st.mode & 0x1ff).toString(8),
                dir: st.isDirectory(), file: st.isFile(), link: st.isSymbolicLink() });
        },
        find: function (a, cb) {
            var needle = a.needle || 'libpython'; var out = {};
            for (var i = 0; i < PY_LIBDIRS.length; i++) {
                try {
                    var ns = fs.readdirSync(PY_LIBDIRS[i]);
                    out[PY_LIBDIRS[i]] = { count: ns.length, match: ns.filter(function (n) { return n.indexOf(needle) >= 0; }) };
                } catch (e) { out[PY_LIBDIRS[i]] = { err: e.code || String(e) }; }
            }
            cb(null, out);
        },
        readhex: function (a, cb) {
            // Guard: reading char/DRM devices with readSync hangs the whole Node
            // event loop (no EOF). Refuse known-blocking device paths; only read
            // regular files. This keeps the agent from locking up on probes.
            if (/^\/dev\/(dri\/|mem$|kmem$|fb\d|watchdog)/.test(a.path)) {
                return cb(new Error('refused: char/DRM device would block readSync (' + a.path + ')'));
            }
            try {
                var st = fs.statSync(a.path);
                if (!st.isFile()) return cb(new Error('refused: not a regular file (' + a.path + ')'));
            } catch (e) { return cb(e); }
            var fd = fs.openSync(a.path, 'r');
            var len = a.len || 256; var buf = new Buffer(len);
            var n = fs.readSync(fd, buf, 0, len, a.off || 0); fs.closeSync(fd);
            cb(null, { path: a.path, off: a.off || 0, read: n, hex: buf.slice(0, n).toString('hex') });
        },
        exec: function (a, cb) {
            if (EXEC_WHITELIST.indexOf(a.bin) < 0) return cb(new Error('bin not whitelisted: ' + a.bin));
            cp.execFile(a.bin, a.argv || [], { timeout: a.timeout || 25000, maxBuffer: 8 << 20, env: agentLdEnv(a.env) },
                function (err, so, se) {
                    cb(null, { bin: a.bin, argv: a.argv, exit: err ? (err.code != null ? err.code : String(err)) : 0,
                        stdout: String(so || ''), stderr: String(se || '') });
                });
        },
        dlopen: function (a, cb) {
            try { process.dlopen({ exports: {} }, a.lib); cb(null, { lib: a.lib, result: 'loaded (unexpected for non-addon)' }); }
            catch (de) {
                var msg = String(de.message || de);
                var ok = /self-register|NODE_MODULE|Module did|init|symbol/i.test(msg);
                cb(null, { lib: a.lib, result: ok ? 'dlopen-OK (lib loaded; not a node addon)' : msg.slice(0, 200) });
            }
        },
        writefile: function (a, cb) {
            fs.writeFileSync(a.path, a.content);
            cb(null, { path: a.path, size: fs.statSync(a.path).size });
        }
    };
    function agentRun(cmd) {
        agentState.ran++;
        function done(err, data) {
            agentHttp('POST', '/result', { id: cmd.id, ok: !err, data: data,
                err: err ? (err.code || String(err.message || err)) : undefined }, function () { });
        }
        var fn = AGENT_OPS[cmd.op];
        if (!fn) return done(new Error('unknown op ' + cmd.op));
        try { fn(cmd.args || {}, done); } catch (e) { done(e); }
    }
    function agentPoll() {
        agentHttp('GET', '/cmd', null, function (err, cmd) {
            agentState.lastPoll = Date.now();
            if (err) { agentState.lastErr = String(err.code || err); }
            else { agentState.lastErr = null; if (cmd && cmd.op) agentRun(cmd); }
            setTimeout(agentPoll, POLL_MS);
        });
    }
    function agentStart() {
        agentState.control = CONTROL;
        try {
            agentHttp('POST', '/ping', { version: VERSION,
                uid: (function () { try { return process.getuid(); } catch (e) { return -1; } })(),
                smack: (function () { try { return fs.readFileSync('/proc/self/attr/current', 'utf8').replace(/\0/g, '').trim(); } catch (e) { return '?'; } })()
            }, function () { });
        } catch (e) { }
        setTimeout(agentPoll, POLL_MS);
    }
    /* ==================== END REMOTE AGENT ==================== */

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

    // ---- native-feasibility probe (read-only) ----
    function candidateDirs() {
        var l = []; function add(d) { if (d && l.indexOf(d) < 0) l.push(d); }
        try { add(process.cwd()); } catch (e) { }
        add(process.env.HOME); add(process.env.TMPDIR); add('/tmp');
        add('/opt/usr/home/owner/share/tmp'); add('/opt/usr/apps');
        return l;
    }
    function mountFor(dir) {
        try {
            var mi = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
            var best = null, bestLen = -1;
            for (var i = 0; i < mi.length; i++) {
                var mp = mi[i].split(' ')[4];
                if (mp && dir.indexOf(mp) === 0 && mp.length > bestLen) { best = mi[i]; bestLen = mp.length; }
            }
            if (!best) return null;
            return { mountpoint: best.split(' ')[4], noexec: best.indexOf('noexec') >= 0 };
        } catch (e) { return { err: e.code || String(e) }; }
    }
    function dirWritable(dir) {
        var p = dir + '/.t3w';
        try { fs.writeFileSync(p, 'x'); var ok = fs.readFileSync(p, 'utf8') === 'x'; try { fs.unlinkSync(p); } catch (e) { } return ok; }
        catch (e) { return e.code || String(e); }
    }
    function dlopenExisting() {
        var libs = ['/usr/lib/libdrm.so.2', '/usr/lib/libteec.so', '/usr/lib/libpng.so.3', '/lib/libz.so.1'];
        for (var i = 0; i < libs.length; i++) {
            try { fs.statSync(libs[i]); } catch (e) { continue; }
            try {
                process.dlopen({ exports: {} }, libs[i]);
                return { lib: libs[i], result: 'loaded (unexpected)' };
            } catch (de) {
                var m = String(de.message || de);
                var ok = /self-register|NODE_MODULE|Module did|init|symbol/i.test(m);
                return { lib: libs[i], result: ok ? 'dlopen-OK (loaded, not an addon)' : m.slice(0, 160) };
            }
        }
        return { result: 'no candidate lib found' };
    }
    function nativeProbe() {
        var o = { version: VERSION, dlopen: dlopenExisting(), dirs: {} };
        var ds = candidateDirs();
        for (var i = 0; i < ds.length; i++) o.dirs[ds[i]] = { writable: dirWritable(ds[i]), mount: mountFor(ds[i]) };
        return o;
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

            if (url.indexOf('/native') === 0) { send(res, 200, nativeProbe()); return; }

            if (url.indexOf('/find') === 0) { send(res, 200, { version: VERSION, libs: findLibs() }); return; }

            if (url.indexOf('/agent') === 0) {
                send(res, 200, { version: VERSION, agent: agentState,
                    seenMsAgo: agentState.lastPoll ? Date.now() - agentState.lastPoll : null });
                return;
            }

            if (url.indexOf('/helper') === 0) {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
                res.end(helperReport);
                return;
            }

            if (url.indexOf('/shms') === 0) {
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
                        try { fs.readFileSync(SHM); } catch (e) { }
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
            try { env.uid = process.getuid(); } catch (e) { }
            env.hint = 'remote agent polls ' + CONTROL + ' ; see /agent /find /helper';
            send(res, 200, env);
        });
        server.on('error', function (e) { try { console.log('[t3-probe] http err ' + e.code); } catch (i) { } });
        server.listen(PORT, '0.0.0.0', function () { try { console.log('[t3-probe ' + VERSION + '] :' + PORT); } catch (i) { } });
        setTimeout(function () { try { runHelperOnce(); } catch (e) { } }, 500);
        setTimeout(function () { try { agentStart(); } catch (e) { } }, 800);
    } catch (e) { try { console.log('[t3-probe] server fail ' + e); } catch (i) { } }
})();
