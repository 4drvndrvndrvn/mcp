#!/usr/bin/env node
// MCP server with a web_search tool, backed by NanoGPT's web-search models
// (any model id with an ":online" suffix searches the web before answering).
//
// Settings (from .env or the environment):
//   NANOGPT_API_KEY     required (the same key the chat uses)
//   WEB_SEARCH_MODEL    default openai/gpt-5.4-mini:online
//   NANOGPT_BASE_URL    default https://nano-gpt.com/api/v1

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NanoGPT } from '../src/nanogpt.js';
import { loadEnv, safe, text } from './lib/common.js';

loadEnv();

const nano = new NanoGPT({
  apiKey: process.env.NANOGPT_API_KEY || '',
  baseUrl: (process.env.NANOGPT_BASE_URL || 'https://nano-gpt.com/api/v1').replace(/\/+$/, ''),
});
const model = process.env.WEB_SEARCH_MODEL || 'openai/gpt-5.4-mini:online';

const INSTRUCTIONS =
  'You are a web research assistant. Search the web and answer concisely and factually. ' +
  'Give exact URLs, version numbers and install commands where relevant, and list your sources. ' +
  'If you cannot find something, say so plainly. Never invent URLs.';

const server = new McpServer({ name: 'web', version: '1.0.0' });

server.registerTool(
  'web_search',
  {
    title: 'Search the web',
    description:
      'Search the web and get a short answer with source links. Use it whenever you are not sure what something is, ' +
      'where to download it or how to install it — never guess URLs or package names. Each search costs a few cents.',
    inputSchema: { query: z.string().describe('What to find out, e.g. "what is tuxblox and how do I install it on Linux"') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ query }, extra) => {
    if (!nano.apiKey) throw new Error('NANOGPT_API_KEY is not set in .env.');
    const res = await nano.chat({
      model,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: query },
      ],
      signal: extra.signal,
    });
    const answer = res.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error('The search returned no answer.');
    const cost = res.x_nanogpt_pricing?.cost;
    return text(`${answer}${typeof cost === 'number' ? `\n\n(search cost: $${cost.toFixed(4)})` : ''}`);
  }),
);

await server.connect(new StdioServerTransport());
