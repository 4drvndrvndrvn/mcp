// Shared helpers for the bundled MCP servers.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bundled servers read their settings (VAST_API_KEY, SSH_*, ...) from the project's .env. */
export function loadEnv() {
  try {
    process.loadEnvFile(path.join(ROOT_DIR, '.env'));
  } catch {
    // No .env file: rely on the real environment.
  }
}

export const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Wraps a tool handler so thrown errors become MCP tool errors the model can read. */
export const safe = (fn) => async (args, extra) => {
  try {
    return await fn(args, extra);
  } catch (err) {
    return text(`Error: ${err.message}`, true);
  }
};

/**
 * Returns a function that sends MCP progress notifications, if the client asked for them.
 * Progress also keeps long-running calls (instance boot, big downloads) from timing out.
 */
export function progressReporter(extra) {
  const token = extra?._meta?.progressToken;
  let step = 0;
  return (message) => {
    if (token === undefined) return;
    step += 1;
    extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: step, message } })
      .catch(() => {});
  };
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      },
      { once: true },
    );
  });
}
