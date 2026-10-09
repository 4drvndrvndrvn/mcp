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
    annotations: { readOnlyHint: true },
  },
  async ({ min, max }) => {
    if (min > max) [min, max] = [max, min];
    return text(String(min + Math.floor(Math.random() * (max - min + 1))));
  },
);

server.registerTool(
  'wait',
  {
    title: 'Wait',
    description: 'Pause for a number of seconds before continuing, e.g. to give a job time to run.',
    inputSchema: { seconds: z.number().min(0).max(600).describe('How long to wait (max 600)') },
    annotations: { readOnlyHint: true },
  },
  async ({ seconds }, extra) => {
    // Progress notifications keep long waits from hitting the client's request timeout.
    const token = extra._meta?.progressToken;
    let elapsed = 0;
    const ticker = setInterval(() => {
      elapsed += 10;
      if (token !== undefined) {
        extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: elapsed, total: seconds, message: `${elapsed}s of ${seconds}s` },
        }).catch(() => {});
      }
    }, 10_000);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, seconds * 1000);
        extra.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Cancelled'));
        });
      });
    } finally {
      clearInterval(ticker);
    }
    return text(`Waited ${seconds} seconds.`);
  },
);

await server.connect(new StdioServerTransport());
