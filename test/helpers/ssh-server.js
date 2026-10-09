// A throwaway SSH server for tests: public-key auth, runs exec requests with `sh -c`.

import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

/**
 * @param {object} opts
 * @param {() => string[]} opts.authorizedKeys  public key lines accepted for login (read on every attempt)
 * @param {string} [opts.cwd]  working directory for commands
 */
export async function startSshServer({ authorizedKeys, cwd } = {}) {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const commands = [];
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client
      .on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
        const match = authorizedKeys()
          .map((line) => utils.parseKey(line))
          .find((k) => !(k instanceof Error) && k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data));
        if (!match) return ctx.reject(['publickey']);
        if (ctx.signature && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
        ctx.accept();
      })
      .on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('exec', (accept, _reject, info) => {
            commands.push(info.command);
            const stream = accept();
            const child = spawn('sh', ['-c', info.command], { cwd });
            stream.pipe(child.stdin);
            child.stdout.on('data', (d) => stream.write(d));
            child.stderr.on('data', (d) => stream.stderr.write(d));
            child.on('close', (code) => {
              stream.exit(code ?? 1);
              stream.end();
            });
            stream.on('close', () => child.kill('SIGKILL'));
          });
        });
      })
      .on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    hostKeyBase64: utils.parseKey(hostKey.public).getPublicSSH().toString('base64'),
    commands,
    // Like a machine going away: drop open connections instead of waiting for them.
    close: () =>
      new Promise((resolve) => {
        for (const c of clients) c.end();
        server.close(resolve);
      }),
  };
}
