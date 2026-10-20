/*
 * T3 Ambilight - TizenBrew service module (Node.js, runs on the TV): BOOTSTRAP.
 *
 * Small and meant to rarely change. It:
 *  1. finds the host (host/t3_ambilight.py): a URL saved on the TV, else LAN
 *     discovery (UDP 8778 broadcast "T3-DISCOVER" + listening for the host's
 *     beacons {"t3":1,"control":url}); a discovered host that stops answering
 *     for 30s is looked up again;
 *  2. downloads the actual logic (tv/core.js, served at <host>/tv/core.js) and
 *     runs it; every 30s it checks <host>/tv/core.sha and hot-swaps the core in
 *     this same process when it changed. Updating the TV = copying core.js to
 *     the host: no TizenBrew reload, no tag, no jsDelivr, no duplicate services.
 *  3. owns the HTTP port 8101: /config and /boot here, everything else is
 *     passed to the core.
 *
 * Trust model: the TV runs code served by the host it discovered (or that you
 * pinned) on your LAN. Pin a host to stop discovery from choosing one.
 *
 * HTTP (http://<TV-IP>:8101):
 *   /config                     current host + where it came from
 *   /config?control=http://h:p  pin that host (saved on the TV)
 *   /config?reset=1             forget it, use LAN discovery
 *   /boot                       bootstrap + core status;  /boot?reload=1 re-fetch core
 *
 * Node v4 on Tizen 3 => ES5 only.
 */
(function () {
    'use strict';

    var fs = require('fs');
    var http = require('http');
    var vm = require('vm');

    var BOOT_VERSION = 'boot-7.0';
    var PORT = 8101;
    var CONFIG_DIR = '/opt/usr/home/owner/share/tmp/t3';
    var CONFIG_FILE = CONFIG_DIR + '/config.json';
    var DISCOVERY_PORT = 8778;

    var upstream = { control: null, source: 'none', lastOk: 0, lastBeacon: 0, discoErr: null };
    var boot = { version: BOOT_VERSION, coreVersion: null, coreSha: null, loadedAt: 0, checks: 0, err: null };
    var core = null;
    var discoveryProbe = null;
    var checkTimer = null;

    function errText(e) { return String((e && (e.code || e.message)) || e); }
    function parseUrl(u) {
        var m = /^http:\/\/([^:\/]+):?(\d+)?/.exec(u || '');
        return m ? { host: m[1], port: m[2] ? +m[2] : 80 } : null;
    }

    /* ---------------- host address: saved config + discovery ---------------- */
    function loadConfig() {
        try {
            var c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (parseUrl(c.control)) { upstream.control = c.control; upstream.source = 'file'; }
        } catch (e) { }
    }
    // control = url -> pin that host (persisted); control = null -> back to discovery
    function saveConfig(control) {
        if (control) {
            if (!parseUrl(control)) throw new Error('bad url: ' + control);
            try { fs.mkdirSync(CONFIG_DIR); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            fs.writeFileSync(CONFIG_FILE, JSON.stringify({ control: control }));
            upstream.control = control; upstream.source = 'file';
        } else {
            try { fs.unlinkSync(CONFIG_FILE); } catch (e) { }
            upstream.control = null; upstream.source = 'none';
            if (discoveryProbe) discoveryProbe();
        }
        scheduleCheck(500);
    }
    function discoveryStart() {
        var dgram = require('dgram'), sock;
        try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
        catch (e) { upstream.discoErr = errText(e); return; }
        sock.on('error', function (e) { upstream.discoErr = errText(e); });
        sock.on('message', function (msg) {
            var m;
            try { m = JSON.parse(msg.toString()); } catch (e) { return; }
            if (!m || !m.t3 || !parseUrl(m.control)) return;
            upstream.lastBeacon = Date.now();
            if (upstream.source === 'file' || upstream.control === m.control) return;
            upstream.control = m.control; upstream.source = 'discovery';
            scheduleCheck(200);
        });
        sock.bind(DISCOVERY_PORT, function () {
            try { sock.setBroadcast(true); } catch (e) { upstream.discoErr = 'setBroadcast: ' + errText(e); }
            discoveryProbe = function () {
                var b = new Buffer('T3-DISCOVER');
                sock.send(b, 0, b.length, DISCOVERY_PORT, '255.255.255.255', function (e) {
                    if (e) upstream.discoErr = errText(e);
                });
            };
            (function loop() {
                var stale = !upstream.control || Date.now() - upstream.lastOk > 30000;
                if (upstream.source !== 'file' && stale) discoveryProbe();
                setTimeout(loop, upstream.control ? 10000 : 3000);
            })();
        });
    }

    /* ---------------- core loader (hot reload) ---------------- */
    function hostGet(path, cb) {
        var u = parseUrl(upstream.control);
        if (!u) return cb(new Error('no server yet'));
        var req = http.get({ host: u.host, port: u.port, path: path }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode + ' ' + path));
                upstream.lastOk = Date.now();
                cb(null, Buffer.concat(chunks).toString('utf8'));
            });
        });
        req.setTimeout(8000, function () { req.abort(); });
        req.on('error', cb);
    }
    var ctx = {
        upstream: upstream,
        boot: boot,
        saveConfig: saveConfig,
        reload: function () { boot.coreSha = null; scheduleCheck(100); }
    };
    function startCore(code, sha) {
        var factory = vm.runInThisContext(code, { filename: 't3-core.js' });   // syntax errors: old core keeps running
        if (typeof factory !== 'function') throw new Error('core.js is not a function expression');
        if (core) { try { core.stop(); } catch (e) { } core = null; }
        core = factory(require, ctx);
        boot.coreSha = sha; boot.coreVersion = core.version; boot.loadedAt = Date.now(); boot.err = null;
    }
    function scheduleCheck(ms) {
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(checkCore, ms);
    }
    function checkCore() {
        boot.checks++;
        function next() { scheduleCheck(core ? 30000 : 3000); }
        hostGet('/tv/core.sha', function (e, sha) {
            if (e) { boot.err = errText(e); return next(); }
            sha = sha.trim();
            if (!sha || sha === boot.coreSha) return next();
            hostGet('/tv/core.js', function (e2, code) {
                if (e2) boot.err = errText(e2);
                else {
                    try { startCore(code, sha); }
                    catch (e3) { boot.err = 'core start: ' + errText(e3); boot.coreSha = sha; }   // don't retry a broken core
                }
                next();
            });
        });
    }

    /* ---------------- HTTP :8101 ---------------- */
    function send(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj, null, 2));
    }
    function parseQ(url) {
        var q = {};
        (url.split('?')[1] || '').split('&').forEach(function (kv) {
            var a = kv.split('='); if (a[0]) q[a[0]] = decodeURIComponent(a[1] || '');
        });
        return q;
    }
    function route(req, res) {
        var url = req.url || '/';
        if (url.indexOf('/config') === 0) {
            var qc = parseQ(url);
            try {
                if (qc.reset) saveConfig(null);
                else if (qc.control) saveConfig(qc.control);
            } catch (e) { return send(res, 400, { error: errText(e) }); }
            return send(res, 200, { boot: BOOT_VERSION, upstream: upstream, configFile: CONFIG_FILE });
        }
        if (url.indexOf('/boot') === 0) {
            if (parseQ(url).reload) ctx.reload();
            return send(res, 200, { boot: boot, upstream: upstream });
        }
        if (core && core.handle) {
            try { return core.handle(req, res); } catch (e) { return send(res, 500, { error: errText(e), boot: boot }); }
        }
        send(res, 503, { boot: boot, upstream: upstream, hint: 'core not loaded yet (waiting for the host)' });
    }

    try {
        var srv = http.createServer(route);
        srv.on('error', function (e) { boot.httpErr = errText(e); });
        srv.listen(PORT, '0.0.0.0');
    } catch (e) { boot.httpErr = errText(e); }
    try { loadConfig(); } catch (e) { }
    try { discoveryStart(); } catch (e) { upstream.discoErr = errText(e); }
    scheduleCheck(1000);
})();
