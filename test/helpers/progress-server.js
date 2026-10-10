// A stdio MCP server for tests with one tool that reports progress quickly.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'progress', version: '1.0.0' });

server.registerTool('count', { description: 'Counts to 3, reporting progress.' }, async (extra) => {
  const token = extra._meta?.progressToken;
  for (let i = 1; i <= 3; i++) {
    if (token !== undefined) {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 3, message: `step ${i}` } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { content: [{ type: 'text', text: 'counted' }] };
});

await server.connect(new StdioServerTransport());
