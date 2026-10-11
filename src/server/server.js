/**
 * Loopback-only HTTP server for the DiskWatch dashboard.
 */

import http from 'node:http';
import { handleRequest } from './routes.js';

/**
 * Start the dashboard server bound to 127.0.0.1 only.
 * @param {number} [port=7381]
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(port = 7381) {
  const listenPort = Number(port) || 7381;

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, { port: listenPort });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(`server error: ${err && err.message ? err.message : err}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export default startServer;
