/*
 * HyperTizen T3 Probe - TizenBrew service module (Node.js, runs on the TV)
 *
 * Goal: find out whether a self-signed app installed on a 2017 Tizen 3 TV
 * (UE55MU6120, "KantM") can reach the resources that the system capture API
 * secvideo_api_capture_screen() uses under the hood. Discovered from the
 * firmware (libsec-video-capture.so.0 / libsec-video-drm-helper.so.0):
 *   - opens /dev/dri/card1  (proprietary ioctl DRM_IOCTL_SDP_HW_CAPTURE)
 *   - maps  /dev/shm/shm_libsecv_capture
 *   - helper touches /dev/dri/card0, /dev/ocm, /dev/video20/21/28
 *
 * If this sandbox cannot even open /dev/dri/card1, no in-app capture is
 * possible regardless of language/packaging, and we stop there.
 *
 * This file only READS/stats device nodes. It performs no capture and
 * changes nothing on the device. Results are served as JSON on port 8095
 * (open http://<TV-IP>:8095 from a phone/PC on the same LAN) and printed to
 * the service log.
 *
 * Written to run on old Node (v4/v5): ES5 only, no Array.includes, no for-of.
 */
(function () {
    'use strict';

    var fs = require('fs');
    var http = require('http');

    var PORT = 8095;

    var DEVICES = [
        '/dev/dri/card1',
        '/dev/dri/card0',
        '/dev/dri/renderD128',
        '/dev/dri/renderD129',
        '/dev/shm/shm_libsecv_capture',
        '/dev/ocm',
        '/dev/video20',
        '/dev/video21',
        '/dev/video28'
    ];

    var LIBS = [
        '/usr/lib/libsec-video-capture.so.0',
        '/usr/lib/libsec-video-drm-helper.so.0',
        '/usr/lib/libicewater.so.0',
        '/usr/lib/libdrm.so.2',
        '/usr/lib/libteec.so'
    ];

    function readText(p) {
        try { return fs.readFileSync(p, 'utf8'); } catch (e) { return '(' + e.code + ')'; }
    }

    // Try to open a path with given flags; return null on success or the errno code.
    function tryOpen(p, flags) {
        var fd = -1;
        try {
            fd = fs.openSync(p, flags);
            return null; // success
        } catch (e) {
            return e.code || String(e);
        } finally {
            if (fd >= 0) { try { fs.closeSync(fd); } catch (ignore) {} }
        }
    }

    function statInfo(p) {
        try {
            var st = fs.statSync(p);
            var mode = (st.mode & 0x1ff).toString(8);
            var kind = st.isCharacterDevice() ? 'chardev'
                : st.isBlockDevice() ? 'blockdev'
                : st.isDirectory() ? 'dir'
                : st.isFile() ? 'file' : 'other';
            return { exists: true, kind: kind, mode: mode, uid: st.uid, gid: st.gid };
        } catch (e) {
            return { exists: false, err: e.code || String(e) };
        }
    }

    function probeOne(p) {
        var info = statInfo(p);
        // Only attempt opens if it exists, to keep errno meaningful.
        if (info.exists) {
            info.open_rdonly = tryOpen(p, 'r');
            info.open_rdwr = tryOpen(p, 'r+');
        }
        return info;
    }

    function listDir(p) {
        try { return fs.readdirSync(p); } catch (e) { return '(' + (e.code || e) + ')'; }
    }

    function collect() {
        var out = {
            when: new Date().toISOString(),
            node: process.version,
            arch: process.arch,
            platform: process.platform,
            pid: process.pid
        };

        try { out.uid = process.getuid(); } catch (e) { out.uid = 'n/a'; }
        try { out.gid = process.getgid(); } catch (e) { out.gid = 'n/a'; }

        // SMACK label of this process - the real sandbox identity.
        out.smack_current = readText('/proc/self/attr/current').replace(/\0/g, '').trim();
        // Supplementary groups (video/graphics group membership gates /dev/dri).
        var status = readText('/proc/self/status');
        var m = /Groups:.*/.exec(status);
        out.groups = m ? m[0] : status;

        out.devices = {};
        for (var i = 0; i < DEVICES.length; i++) {
            out.devices[DEVICES[i]] = probeOne(DEVICES[i]);
        }

        out.libs = {};
        for (var j = 0; j < LIBS.length; j++) {
            var lp = LIBS[j];
            var li = statInfo(lp);
            if (li.exists) { li.readable = tryOpen(lp, 'r'); }
            out.libs[lp] = li;
        }

        out.ls_dev_dri = listDir('/dev/dri');
        out.ls_dev_shm = listDir('/dev/shm');

        // Simple verdict for /dev/dri/card1 (the capture gate).
        var card1 = out.devices['/dev/dri/card1'];
        if (!card1 || !card1.exists) {
            out.verdict = 'card1-absent';
        } else if (card1.open_rdwr === null) {
            out.verdict = 'card1-OPEN-OK (capture gate reachable, worth building the native call)';
        } else if (card1.open_rdonly === null) {
            out.verdict = 'card1-readonly (ioctl may still be denied; promising)';
        } else {
            out.verdict = 'card1-BLOCKED (' + card1.open_rdwr + ') - in-app capture not permitted by sandbox';
        }
        return out;
    }

    var RESULT = { verdict: 'collecting...' };
    try {
        RESULT = collect();
    } catch (e) {
        RESULT = { error: String(e && e.stack || e) };
    }

    // Log a compact summary (shows up in TizenBrew's service/debug log).
    try {
        console.log('[t3-probe] verdict=' + RESULT.verdict
            + ' smack=' + RESULT.smack_current
            + ' card1=' + JSON.stringify(RESULT.devices && RESULT.devices['/dev/dri/card1']));
    } catch (e) {}

    // Serve the full JSON so it can be read from a browser on the LAN.
    try {
        var server = http.createServer(function (req, res) {
            if (req.url === '/refresh') {
                try { RESULT = collect(); } catch (e) { RESULT = { error: String(e) }; }
            }
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(RESULT, null, 2));
        });
        server.on('error', function (e) {
            try { console.log('[t3-probe] http server error: ' + e.code); } catch (ignore) {}
        });
        server.listen(PORT, '0.0.0.0', function () {
            try { console.log('[t3-probe] serving results on http://<TV-IP>:' + PORT); } catch (ignore) {}
        });
    } catch (e) {
        try { console.log('[t3-probe] could not start http server: ' + e); } catch (ignore) {}
    }
})();
