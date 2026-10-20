/*
 * T3 TV core - the hot-reloadable part of the TV module.
 *
 * Served by the host (host/t3_ambilight.py, GET /tv/core.js) and run by the
 * TizenBrew bootstrap (service.js), which re-downloads it whenever its hash
 * changes: updating the TV = copying this file to the host. No TizenBrew
 * reload, no tag, no jsDelivr.
 *
 * The file is ONE function expression (require, ctx) -> { version, handle, stop }:
 *   ctx.upstream   {control, source, ...}  host URL, owned by the bootstrap
 *   ctx.saveConfig(url|null)               pin a host / back to discovery
 *   ctx.reload()                           ask the bootstrap to re-fetch the core
 *   ctx.boot                               bootstrap status (version, core hash)
 * stop() must leave nothing running: every loop checks `alive`.
 *
 * Node v4 on Tizen 3 => ES5 only.
 */
(function (require, ctx) {
    'use strict';

    var fs = require('fs');
    var http = require('http');
    var cp = require('child_process');

    var VERSION = 'core-1.0';
    var DBUS = '/usr/bin/dbus-send';
    var NAME = 'samsung.tizen.dcapture';
    var OBJ = '/samsung/tizen/dcapture';
    var METHOD = NAME + '.RequestCaptureToFileSync';
    var EXEC_WHITELIST = ['/usr/bin/python2.7', '/usr/bin/dbus-send', '/bin/ls', '/usr/bin/env'];
    var POLL_MS = 250;

    var alive = true;
    var upstream = ctx.upstream;

    function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return '(' + e.code + ')'; } }
    function errText(e) { return String((e && (e.code || e.message)) || e); }
    function later(fn, ms) { setTimeout(function () { if (alive) fn(); }, ms); }

    function hostRequest(method, path, headers, body, cb) {
        var m = /^http:\/\/([^:\/]+):?(\d+)?/.exec(upstream.control || '');
        if (!m) return cb(new Error('no server yet'));
        var req = http.request({ host: m[1], port: m[2] ? +m[2] : 80, path: path, method: method, headers: headers },
            function (res) {
                var b = ''; res.on('data', function (c) { b += c; });
                res.on('end', function () {
                    upstream.lastOk = Date.now();
                    try { cb(null, b ? JSON.parse(b) : {}); } catch (e) { cb(e); }
                });
            });
        req.setTimeout(5000, function () { req.abort(); });
        req.on('error', function (e) { cb(e); });
        if (body) req.write(body);
        req.end();
    }

    // One screen capture through the system daemon -> JPEG file. cb(err, ms, reply)
    function capture(o, cb) {
        var t0 = Date.now();
        var args = ['--system', '--print-reply', '--reply-timeout=4000', '--type=method_call',
            '--dest=' + NAME, OBJ, METHOD,
            'int32:' + (o.app | 0), 'int32:' + (o.mode | 0), 'int32:' + (o.comp == null ? 1 : o.comp | 0),
            'int32:' + (o.w | 0), 'int32:' + (o.h | 0), 'int32:' + (o.q | 0),
            'string:' + (o.dir || '/dev/shm'), 'string:' + o.file];
        cp.execFile(DBUS, args, { timeout: 6000, maxBuffer: 1 << 20 }, function (err, stdout) {
            var ints = [], re = /int32\s+(-?\d+)/g, m;
            while ((m = re.exec(String(stdout || '')))) ints.push(parseInt(m[1], 10));
            cb(err, Date.now() - t0, { retVal: ints[0], w: ints[1], h: ints[2] });
        });
    }

    /* ======================= FRAME STREAM =======================
     * The TV captures continuously and POSTs each JPEG to <host>/frame; the
     * reply steers the loop {on, q, w, h, gap, par, mode, app}. Capture costs
     * a fixed ~95 ms inside the daemon (resolution doesn't matter) and the
     * daemon serializes; 'par' overlaps our own per-capture overhead.     */
    var STREAM_FILE = 't3stream';
    var MAX_PAR = 4;
    var stream = { on: true, q: 55, w: 480, h: 270, gap: 0, par: 1, mode: 0, app: 0,
        frames: 0, lastErr: null, lastMs: 0 };
    var streamWorkers = {};

    function streamPar() { return Math.max(1, Math.min(MAX_PAR, stream.par | 0)); }
    function streamEnsureWorkers() {
        for (var i = 0; i < streamPar(); i++) {
            if (!streamWorkers[i]) {
                streamWorkers[i] = true;
                (function (n) { later(function () { streamLoop(n); }, n * 40); })(i);
            }
        }
    }
    function streamPost(buf, cb) {
        hostRequest('POST', '/frame', { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length }, buf, cb);
    }
    function streamNext(n, err, cfg) {
        if (!err && cfg) for (var k in cfg) if (k in stream && k !== 'frames') stream[k] = cfg[k];
        if (!alive || n >= streamPar()) { streamWorkers[n] = false; return; }
        streamEnsureWorkers();
        if (err) { stream.lastErr = errText(err); return later(function () { streamLoop(n); }, 2000); }
        stream.lastErr = null;
        later(function () { streamLoop(n); }, stream.on ? (stream.gap || 0) : 2000);
    }
    function streamLoop(n) {
        if (!upstream.control) { stream.lastErr = 'no server yet'; return later(function () { streamLoop(n); }, 2000); }
        if (!stream.on) {
            if (n > 0) { streamWorkers[n] = false; return; }
            return streamPost(new Buffer(0), function (e, cfg) { streamNext(n, e, cfg); });
        }
        var file = STREAM_FILE + n;
        capture({ app: stream.app, mode: stream.mode, comp: 1, w: stream.w, h: stream.h, q: stream.q, file: file },
            function (err, ms) {
                var buf;
                try { buf = fs.readFileSync('/dev/shm/' + file + '.jpg'); }
                catch (e) { return streamNext(n, e); }
                streamPost(buf, function (e, cfg) {
                    if (!e) { stream.frames++; stream.lastMs = ms; }
                    streamNext(n, e, cfg);
                });
            });
    }

    /* ======================= REMOTE AGENT =======================
     * Polls the host for one typed command, runs it, posts the result.  */
    var agentState = { control: null, lastPoll: 0, lastErr: null, ran: 0 };

    function mountFor(dir) {
        try {
            var mi = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n'), best = null, bestLen = -1;
            for (var i = 0; i < mi.length; i++) {
                var mp = mi[i].split(' ')[4];
                if (mp && dir.indexOf(mp) === 0 && mp.length > bestLen) { best = mi[i]; bestLen = mp.length; }
            }
            if (!best) return null;
            var parts = best.split(' ');
            return { mountpoint: parts[4], opts: parts[5], noexec: best.indexOf('noexec') >= 0 };
        } catch (e) { return { err: errText(e) }; }
    }

    var AGENT_OPS = {
        ls: function (a, cb) {
            var names = fs.readdirSync(a.path);
            cb(null, { path: a.path, count: names.length, entries: names.map(function (n) {
                var p = a.path.replace(/\/$/, '') + '/' + n;
                try { var st = fs.statSync(p); return { name: n, size: st.size, mode: (st.mode & 0x1ff).toString(8), dir: st.isDirectory() }; }
                catch (e) { return { name: n, err: errText(e) }; }
            }) });
        },
        stat: function (a, cb) {
            var st = fs.statSync(a.path);
            cb(null, { path: a.path, size: st.size, mode: (st.mode & 0x1ff).toString(8),
                dir: st.isDirectory(), file: st.isFile(), link: st.isSymbolicLink() });
        },
        readtext: function (a, cb) { cb(null, { path: a.path, text: readText(a.path).slice(0, a.max || 65536) }); },
        readhex: function (a, cb) {
            // reading char/DRM devices with readSync blocks the whole event loop
            if (/^\/dev\/(dri\/|mem$|kmem$|fb\d|watchdog)/.test(a.path)) return cb(new Error('refused: device would block'));
            if (!fs.statSync(a.path).isFile()) return cb(new Error('refused: not a regular file'));
            var fd = fs.openSync(a.path, 'r'), len = a.len || 256, buf = new Buffer(len);
            var n = fs.readSync(fd, buf, 0, len, a.off || 0); fs.closeSync(fd);
            cb(null, { path: a.path, off: a.off || 0, read: n, hex: buf.slice(0, n).toString('hex') });
        },
        exec: function (a, cb) {
            if (EXEC_WHITELIST.indexOf(a.bin) < 0) return cb(new Error('bin not whitelisted: ' + a.bin));
            cp.execFile(a.bin, a.argv || [], { timeout: a.timeout || 25000, maxBuffer: 8 << 20 }, function (err, so, se) {
                cb(null, { bin: a.bin, argv: a.argv, exit: err ? (err.code != null ? err.code : String(err)) : 0,
                    stdout: String(so || ''), stderr: String(se || '') });
            });
        },
        dlopen: function (a, cb) {
            try { process.dlopen({ exports: {} }, a.lib); cb(null, { lib: a.lib, result: 'loaded as addon' }); }
            catch (de) {
                var msg = String(de.message || de);
                var ok = /self-register|NODE_MODULE|Module did|init|symbol/i.test(msg);
                cb(null, { lib: a.lib, loaded: ok, result: msg.slice(0, 300) });
            }
        },
        writefile: function (a, cb) {
            fs.writeFileSync(a.path, a.content);
            cb(null, { path: a.path, size: fs.statSync(a.path).size });
        },
        // binary upload in base64 chunks: {path, b64, append}
        writeb64: function (a, cb) {
            var buf = new Buffer(a.b64 || '', 'base64');
            if (a.append) fs.appendFileSync(a.path, buf); else fs.writeFileSync(a.path, buf);
            if (a.mode) fs.chmodSync(a.path, parseInt(a.mode, 8));
            cb(null, { path: a.path, size: fs.statSync(a.path).size });
        },
        // where could a library of ours live? writable + mount flags (noexec?)
        mounts: function (a, cb) {
            var dirs = a.dirs || ['/tmp', '/dev/shm', '/opt/usr/home/owner/share/tmp', '/opt/usr/home/owner/share'];
            var o = {};
            dirs.forEach(function (d) { o[d] = mountFor(d); });
            cb(null, o);
        },
        // time n daemon captures with the given params (bypasses the stream)
        bench: function (a, cb) {
            var n = a.n || 10, samples = [], last = null;
            (function one(i) {
                if (i >= n || !alive) {
                    var tot = 0; samples.forEach(function (s) { tot += s; });
                    var size = null; try { size = fs.statSync((a.dir || '/dev/shm') + '/t3bench.jpg').size; } catch (e) { }
                    return cb(null, { params: a, n: samples.length, ms_avg: samples.length ? Math.round(tot / samples.length) : null,
                        samples: samples, last: last, file_size: size });
                }
                capture({ app: a.app, mode: a.mode, comp: a.comp == null ? 1 : a.comp, w: a.w || 480, h: a.h || 270,
                    q: a.q || 55, dir: a.dir, file: 't3bench' }, function (err, ms, rep) {
                    samples.push(ms); last = { err: err ? errText(err) : null, reply: rep };
                    one(i + 1);
                });
            })(0);
        },
        config: function (a, cb) { ctx.saveConfig(a.control || null); cb(null, { upstream: upstream }); },
        reload: function (a, cb) { cb(null, { reloading: true, from: VERSION }); setTimeout(ctx.reload, 300); }
    };

    function agentRun(cmd) {
        agentState.ran++;
        function done(err, data) {
            var body = new Buffer(JSON.stringify({ id: cmd.id, ok: !err, data: data, err: err ? errText(err) : undefined }));
            hostRequest('POST', '/result', { 'Content-Type': 'application/json', 'Content-Length': body.length }, body, function () { });
        }
        var fn = AGENT_OPS[cmd.op];
        if (!fn) return done(new Error('unknown op ' + cmd.op));
        try { fn(cmd.args || {}, done); } catch (e) { done(e); }
    }
    function agentPing() {
        var body = new Buffer(JSON.stringify({ version: VERSION, boot: ctx.boot.version,
            uid: (function () { try { return process.getuid(); } catch (e) { return -1; } })(),
            smack: readText('/proc/self/attr/current').replace(/\0/g, '').trim() }));
        hostRequest('POST', '/ping', { 'Content-Type': 'application/json', 'Content-Length': body.length }, body, function () { });
    }
    function agentPoll() {
        if (agentState.control !== upstream.control) {   // new/changed server: say hello
            agentState.control = upstream.control;
            if (upstream.control) agentPing();
        }
        hostRequest('GET', '/cmd', {}, null, function (err, cmd) {
            agentState.lastPoll = Date.now();
            if (err) agentState.lastErr = errText(err);
            else { agentState.lastErr = null; if (cmd && cmd.op) agentRun(cmd); }
            later(agentPoll, err ? 2000 : POLL_MS);
        });
    }

    /* ======================= HTTP (via bootstrap) ======================= */
    function send(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj, null, 2));
    }
    function handle(req, res) {
        var url = req.url || '/';
        if (url.indexOf('/agent') === 0) {
            return send(res, 200, { version: VERSION, upstream: upstream, agent: agentState, stream: stream,
                seenMsAgo: agentState.lastPoll ? Date.now() - agentState.lastPoll : null });
        }
        var env = { ok: true, core: VERSION, boot: ctx.boot, node: process.version,
            smack: readText('/proc/self/attr/current').replace(/\0/g, '').trim(), upstream: upstream,
            stream: stream, hint: 'see /agent /config /boot' };
        try { env.uid = process.getuid(); } catch (e) { }
        send(res, 200, env);
    }

    later(agentPoll, POLL_MS);
    later(streamEnsureWorkers, 400);

    return {
        version: VERSION,
        handle: handle,
        stop: function () { alive = false; streamWorkers = {}; }
    };
})
