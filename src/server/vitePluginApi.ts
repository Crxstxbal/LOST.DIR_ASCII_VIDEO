import type { Plugin } from 'vite';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Local API served by the Vite dev server (single local process, no cloud):
 *   GET  /api/projects            list saved projects (projects/*.json)
 *   GET  /api/projects/:name      load one
 *   PUT  /api/projects/:name      save (JSON body)
 *   POST /api/capture?name=x.png  write a PNG (binary body) to exports/
 */
const SAFE = /^[\w\-. ]{1,80}$/;

function readBody(req: any): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function send(res: any, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function lostdirApi(root = process.cwd()): Plugin {
  const projDir = resolve(root, 'projects');
  const expDir = resolve(root, 'exports');
  return {
    name: 'lostdir-api',
    configureServer(server) {
      mkdirSync(projDir, { recursive: true });
      mkdirSync(expDir, { recursive: true });
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = new URL(req.url ?? '/', 'http://local');
        if (!url.pathname.startsWith('/api/')) return next();
        try {
          if (url.pathname === '/api/projects' && req.method === 'GET') {
            const list = readdirSync(projDir)
              .filter((f) => f.endsWith('.json'))
              .map((f) => ({ name: f.replace(/\.json$/, ''), mtime: statSync(join(projDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            return send(res, 200, list);
          }
          const m = url.pathname.match(/^\/api\/projects\/(.+)$/);
          if (m) {
            const name = decodeURIComponent(m[1]);
            if (!SAFE.test(name)) return send(res, 400, { error: 'Nombre de proyecto no válido.' });
            const file = join(projDir, name + '.json');
            if (req.method === 'GET') {
              if (!existsSync(file)) return send(res, 404, { error: 'No existe.' });
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              return res.end(readFileSync(file, 'utf8'));
            }
            if (req.method === 'PUT') {
              const body = (await readBody(req)).toString('utf8');
              JSON.parse(body); // reject invalid JSON
              writeFileSync(file, body, 'utf8');
              return send(res, 200, { ok: true, path: `projects/${name}.json` });
            }
          }
          if (url.pathname === '/api/capture' && req.method === 'POST') {
            const name = url.searchParams.get('name') ?? `captura_${Date.now()}.png`;
            if (!SAFE.test(name) || !name.endsWith('.png')) return send(res, 400, { error: 'Nombre de archivo no válido.' });
            const body = await readBody(req);
            if (body.length < 8 || body[0] !== 0x89 || body[1] !== 0x50) return send(res, 400, { error: 'No es un PNG.' });
            writeFileSync(join(expDir, name), body);
            return send(res, 200, { ok: true, path: `exports/${name}`, bytes: body.length });
          }
          return send(res, 404, { error: 'Ruta desconocida.' });
        } catch (e: any) {
          return send(res, 500, { error: String(e?.message ?? e) });
        }
      });
    },
  };
}
