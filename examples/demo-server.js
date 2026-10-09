#!/usr/bin/env node
// A small stdio MCP server so the chat has working tools out of the box.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { evaluate } from './calc.js';

const server = new McpServer({ name: 'demo-tools', version: '1.0.0' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });

server.registerTool(
  'get_current_time',
  {
    title: 'Current time',
    description: 'Get the current date and time, optionally in a specific IANA timezone (e.g. "Asia/Tokyo").',
    inputSchema: { timezone: z.string().optional().describe('IANA timezone name; defaults to UTC') },
    annotations: { readOnlyHint: true },
  },
  async ({ timezone = 'UTC' }) => {
    try {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);
      return text(`${formatted}\nISO (UTC): ${now.toISOString()}`);
    } catch {
      return { ...text(`Unknown timezone "${timezone}"`), isError: true };
    }
  },
);

server.registerTool(
  'calculate',
  {
    title: 'Calculator',
    description:
      'Evaluate a math expression exactly. Supports + - * / % ^, parentheses, pi, e, ' +
      'and functions: sqrt, cbrt, abs, round, floor, ceil, sin, cos, tan, asin, acos, atan, log (base 10), ln, exp, min, max, pow.',
    inputSchema: { expression: z.string().describe('e.g. "sqrt(2) * (3 + 4)^2"') },
    annotations: { readOnlyHint: true },
  },
  async ({ expression }) => {
    try {
      return text(`${expression} = ${evaluate(expression)}`);
    } catch (err) {
      return { ...text(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  'random_number',
  {
    title: 'Random number',
    description: 'Generate a random integer between min and max (inclusive).',
    inputSchema: {
      min: z.number().int().describe('Lower bound'),
      max: z.number().int().describe('Upper bound'),
    },
  },
  async ({ min, max }) => {
    if (min > max) [min, max] = [max, min];
    return text(String(min + Math.floor(Math.random() * (max - min + 1))));
  },
);

await server.connect(new StdioServerTransport());
