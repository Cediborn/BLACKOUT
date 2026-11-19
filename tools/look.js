// ============================================================
// tools/look.js — scripted visual review of the REAL game (verification only)
//
// Serves the repo, boots index.html in headless Chrome, then runs a small
// "shot list" script against the live page: evaluate JS (drive the game
// through LG.eventBus, move the camera via LG.debug), wait real time, and
// capture PNGs. Use it to look at players, fans, cars and lighting from
// chosen angles without clicking through the game by hand.
//
//   node tools/look.js tools/looks/match.js --out shots/
//   CHROME=/path/to/chrome node tools/look.js my-script.js
//
// A shot-list script is a CommonJS module:
//   module.exports = async function (page) {
//     await page.eval("LG.eventBus.emit('quickPlayRequested')");
//     await page.wait(4000);
//     await page.cam([8, 3, 8], [0, 1, 0]);     // freeze the camera here
//     await page.shot('wide');                   // -> <out>/wide.png
//   };
// page.cam() parks the camera (the game loop's own camera writes are paused
// while parked); page.free() hands it back.
// ============================================================
var fs = require('fs');
var path = require('path');
var http = require('http');
var net = require('net');
var child = require('child_process');
var os = require('os');

var ROOT = path.join(__dirname, '..');
var args = process.argv.slice(2);
function arg(name, dflt) {
  var i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
var SCRIPT = args[0] && !/^--/.test(args[0]) ? path.resolve(args[0]) : null;
if (!SCRIPT) { console.error('usage: node tools/look.js <shot-list.js> [--out dir] [--size 1440x667] [--query a=1&b=2]'); process.exit(2); }
var OUT = path.resolve(arg('out', 'looks-out'));
var SIZE = String(arg('size', '1440x667')).split('x').map(Number);
var QUERY = arg('query', '');
fs.mkdirSync(OUT, { recursive: true });

var CHROME = [
  process.env.CHROME || '',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(function (p) { return p && fs.existsSync(p); })[0];
if (!CHROME) { console.error('no chrome found (set CHROME=...)'); process.exit(1); }

var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2',
};
var server = http.createServer(function (req, res) {
  var u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  var file = path.join(ROOT, u);
  if (file.indexOf(ROOT) !== 0) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function freePort() {
  return new Promise(function (resolve, reject) {
    var s = net.createServer();
    s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { resolve(p); }); });
    s.on('error', reject);
  });
}
function CDP(url) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(url), next = 1, pending = {}, listeners = [];
    ws.onopen = function () { resolve(api); };
    ws.onerror = function () { reject(new Error('ws error')); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); return; }
      listeners.forEach(function (fn) { fn(m); });
    };
    var api = {
      on: function (fn) { listeners.push(fn); },
      send: function (method, params) {
        var id = next++;
        return new Promise(function (r, j) { pending[id] = { resolve: r, reject: j }; ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); });
      },
      close: function () { try { ws.close(); } catch (e) {} },
    };
  });
}

server.listen(0, '127.0.0.1', async function () {
  var port = server.address().port;
  var dbg = await freePort();
  var profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-look-'));
  var url = 'http://127.0.0.1:' + port + '/index.html' + (QUERY ? '?' + QUERY : '');
  var cmd = ['--headless=new', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-extensions', '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + profile,
    '--window-size=' + SIZE[0] + ',' + SIZE[1], '--remote-debugging-port=' + dbg, url];
  if (process.getuid && process.getuid() === 0) cmd.unshift('--no-sandbox');
  var proc = child.spawn(CHROME, cmd, { stdio: ['ignore', 'ignore', 'ignore'] });
  var errors = [];
  var exitCode = 0;
  try {
    var target = null;
    for (var i = 0; i < 80 && !target; i++) {
      await sleep(250);
      try {
        var list = await (await fetch('http://127.0.0.1:' + dbg + '/json/list')).json();
        target = list.filter(function (t) { return t.type === 'page'; })[0];
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('chrome did not come up');
    var cdp = await CDP(target.webSocketDebuggerUrl);
    cdp.on(function (m) {
      if (m.method === 'Runtime.exceptionThrown') {
        var d = m.params.exceptionDetails;
        var msg = (d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text);
        errors.push(String(msg)); console.log('[exception] ' + String(msg).split('\n')[0]);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        var txt = (m.params.args || []).map(function (a) { return a.value !== undefined ? a.value : (a.description || ''); }).join(' ');
        if (/^LOOK|^\[look\]|^\[ATH\]|FALLBACK/.test(txt)) console.log(txt);
        if (m.params.type === 'error') { errors.push(txt); console.log('[console.error] ' + txt.slice(0, 300)); }
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    var page = {
      eval: async function (expr) {
        var r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        return r.result ? r.result.value : undefined;
      },
      wait: sleep,
      until: async function (expr, ms) {
        var t0 = Date.now();
        while (Date.now() - t0 < (ms || 60000)) {
          try { if (await page.eval(expr)) return true; } catch (e) { /* page still booting */ }
          await sleep(200);
        }
        throw new Error('timed out waiting for: ' + expr);
      },
      // park the camera: the game's loop keeps running, but a per-frame hook
      // re-applies this pose after the loop wrote its own (see main.js)
      cam: function (pos, look, fov) {
        return page.eval('window.__lookCam = ' + JSON.stringify({ p: pos, l: look, f: fov || 0 }) + '; true');
      },
      free: function () { return page.eval('window.__lookCam = null; true'); },
      shot: async function (name) {
        await sleep(120);
        var s = await cdp.send('Page.captureScreenshot', { format: 'png' });
        var f = path.join(OUT, name + '.png');
        fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
        console.log('[look] wrote ' + f);
        return f;
      },
      log: function (m) { console.log('[look] ' + m); },
    };
    await page.until("!!(window.LG && window.LGMain && LGMain.getState && document.getElementById('loading-overlay').classList.contains('hidden'))", 90000);
    await require(SCRIPT)(page);
    cdp.close();
  } catch (e) {
    console.log('[look] FAILED: ' + e.message);
    exitCode = 1;
  } finally {
    try { proc.kill('SIGKILL'); } catch (e) {}
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  if (errors.length) { console.log('[look] page errors: ' + errors.length); exitCode = exitCode || 3; }
  process.exit(exitCode);
});
