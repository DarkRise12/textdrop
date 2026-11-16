const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function worker({failInstall = false, missing = false} = {}) {
  const listeners = new Map(), calls = {add: [], deleted: [], fetch: [], claims: 0, skips: 0};
  const origin = 'https://textdrop.test';
  const cache = {addAll: async requests => {calls.add.push(...requests); if (failInstall) throw Error('storage failure');}, match: async () => missing ? undefined : new Response('cached shell')};
  const self = {location: {origin}, addEventListener: (name, callback) => listeners.set(name, callback),
    clients: {claim: async () => calls.claims++}, skipWaiting: async () => calls.skips++};
  const context = {self, URL, Set, Request: class extends Request {constructor(url, options) {super(new URL(url, origin), options);}},
    fetch: async request => {calls.fetch.push(request); return new Response('from network');},
    caches: {open: async () => cache, delete: async key => calls.deleted.push(key), keys: async () => ['textdrop-shell-old', 'textdrop-shell-test', 'another-application']}};
  const assets = [{url: '/', integrity: 'sha256-test'}, {url: '/app.js', integrity: 'sha256-test'}];
  const source = fs.readFileSync(path.join(__dirname, '../static/sw.js'), 'utf8').replace('__TEXTDROP_VERSION__', 'test').replace('__TEXTDROP_ASSETS__', JSON.stringify(assets));
  vm.runInNewContext(source, context);
  const send = (name, extra = {}) => {let promise; listeners.get(name)({...extra, waitUntil: value => promise = value, respondWith: value => promise = value}); return promise;};
  return {calls, send, origin};
}
test('offline cache never intercepts API, downloads, previews, writes or foreign origins',()=>{
  const {calls, send, origin} = worker();
  for (const [url, method] of [['/api/session','GET'],['/api/notes','GET'],['/api/files/id','GET'],['/api/files/id/preview','GET'],['/','POST'],['/sw.js','GET'],['/unknown','GET'],['https://other.test/app.js','GET']]) {
    assert.equal(send('fetch', {request: new Request(new URL(url, origin), {method})}), undefined, method + ' ' + url);
  }
  assert.equal(calls.add.length, 0); assert.equal(calls.fetch.length, 0);
});
test('precache omits cookies, checks integrity, and waits for user approval to activate',async()=>{
  const {calls, send} = worker(); await send('install');
  assert.equal(calls.add.length, 2); assert(calls.add.every(request => request.credentials === 'omit' && request.cache === 'reload' && request.integrity));
  assert.equal(calls.skips, 0);
  await send('message', {data: {type: 'APPLY_UPDATE'}}); assert.equal(calls.skips, 1);
  await send('activate'); assert.deepEqual(calls.deleted, ['textdrop-shell-old']); assert.equal(calls.claims, 1);
});
test('failed installs discard only the new cache; allowed shell reads use the complete active cache',async()=>{
  const failed = worker({failInstall: true}); await assert.rejects(failed.send('install')); assert.deepEqual(failed.calls.deleted, ['textdrop-shell-test']);
  const active = worker(); const response = await active.send('fetch', {request: new Request(active.origin + '/')}); assert.equal(await response.text(), 'cached shell');
  assert.equal(active.calls.fetch.length, 0);
  const missing = worker({missing: true}); const fallback = await missing.send('fetch', {request: new Request(missing.origin + '/app.js')}); assert.equal(await fallback.text(), 'from network'); assert.equal(missing.calls.add.length, 0);
});
