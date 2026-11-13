import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

async function unusedPort() {
  const socket = createTcpServer();
  await new Promise((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}

function forward(req, res, port) {
  const upstream = request({
    host: '127.0.0.1', port, method: req.method, path: req.url,
    headers: { ...req.headers, host: '127.0.0.1:' + port },
  }, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

export async function startModelProxy(endpoint) {
  const publicUrl = new URL(endpoint);
  const backendPort = await unusedPort();
  let active = 0;
  let lastResponseAt = Date.now();
  const server = createHttpServer((req, res) => {
    const path = req.url.split('?')[0];
    const inference = !['/health', '/healthz', '/v1/models'].includes(path);
    if (inference) active++;
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      if (inference) {
        active--;
        lastResponseAt = Date.now();
      }
    };
    res.once('finish', release);
    res.once('close', release);
    forward(req, res, backendPort);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(Number(publicUrl.port),
      publicUrl.hostname === '[::1]' ? '::1' : publicUrl.hostname, done);
  });
  const upstream = new URL(endpoint);
  upstream.port = String(backendPort);
  return {
    endpoint: upstream.origin,
    active: () => active,
    lastResponseAt: () => lastResponseAt,
    close: () => new Promise((done, reject) => {
      server.close(error => error ? reject(error) : done());
    }),
  };
}
