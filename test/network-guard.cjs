// Preload in Node processes to block and record any request outside loopback.
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const log = process.env.SUPERSTABLES_NETWORK_GUARD_LOG;
function check(host) {
  host = String(host).replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return;
  const message = `Blocked non-loopback network request: ${host}`;
  if (log) fs.appendFileSync(log, message + '\n');
  throw new Error(message);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  if (!options.path) check(options.host || 'localhost');
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  if (!options.path) check(options.host || 'localhost');
  return tlsConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  check(new URL(input instanceof Request ? input.url : input).hostname);
  return originalFetch(input, init);
};
try {
  const undici = require('undici');
  for (const name of ['fetch', 'request', 'stream', 'pipeline', 'connect', 'upgrade']) {
    const original = undici[name];
    if (!original) continue;
    undici[name] = function (url, ...args) {
      check(new URL(url).hostname);
      return original.call(this, url, ...args);
    };
  }
  const dispatcher = undici.getGlobalDispatcher();
  const dispatch = dispatcher.dispatch;
  dispatcher.dispatch = function (options, handler) {
    check(new URL(options.origin).hostname);
    return dispatch.call(this, options, handler);
  };
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

require('node:module').syncBuiltinESMExports();
