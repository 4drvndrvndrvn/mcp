// An MCP client transport that speaks to a stdio MCP server running on another machine,
// through an SSH channel (newline-delimited JSON-RPC on the command's stdin/stdout).

import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

export class SshStdioTransport {
  /** @param {() => Promise<import('ssh2').ClientChannel>} open  starts the remote command */
  constructor(open) {
    this.open = open;
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
  }

  async start() {
    this.stream = await this.open();
    this.stream.on('data', (chunk) => this._read(chunk));
    this.stream.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    this.stream.on('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    this.stream.on('error', (err) => this.onerror?.(err));
  }

  _read(chunk) {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      // Anything that isn't a JSON object is stray program output, not protocol.
      if (!line.startsWith('{')) continue;
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
      } catch (err) {
        this.onerror?.(new Error(`Unreadable message from the remote MCP server: ${err.message}`));
      }
    }
  }

  async send(message) {
    if (this.closed || !this.stream) throw new Error('The remote MCP server has exited');
    this.stream.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    if (!this.stream || this.closed) return;
    this.stream.end();
    this.stream.close();
  }
}
