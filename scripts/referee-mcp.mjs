#!/usr/bin/env node
/**
 * The CaptionVAR referee as an MCP server (stdio).
 *
 *   node scripts/referee-mcp.mjs --seed captionvar-demo-6
 *
 * The agent workflow (agents/captionvar_agents/factbox.py) calls these tools
 * over MCP: the Referee executor calls `check_caption`, the Extractor and
 * Editor get what they may see from `extractor_view` and `editor_view`, and
 * the Publisher falls back to `caption_from_data`. Any other MCP client can
 * use the same tools, for example GitHub Copilot agent mode in VS Code
 * through .vscode/mcp.json.
 *
 * Every tool is read-only and deterministic. `check_caption` sees only the
 * events recorded up to the moment being captioned.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFactbox, seedFromArgs } from './factbox-ops.mjs';
import { TOOLS } from './referee-tools.mjs';

export { TOOLS };

const seed = seedFromArgs();
const ops = createFactbox(seed);

const server = new McpServer({ name: 'captionvar-referee', version: '1.0.0' });
for (const tool of TOOLS) {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try {
      const result = ops[tool.op](args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`captionvar-referee MCP server ready (match seed ${seed})`);
