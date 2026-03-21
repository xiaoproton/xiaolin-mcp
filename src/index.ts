import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ─── Server factory ───────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({
    name: "xiaolin-mcp",
    version: "1.0.0",
  });

  // ─── Tools ─────────────────────────────────────────────────────────────────

  server.tool(
    "add",
    "Add two numbers together",
    { a: z.number().describe("First number"), b: z.number().describe("Second number") },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    })
  );

  server.tool(
    "echo",
    "Echo a message back to the caller",
    { message: z.string().describe("Message to echo") },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
    })
  );

  server.tool(
    "get_time",
    "Return the current UTC date and time",
    {},
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    })
  );

  // ─── Resources ─────────────────────────────────────────────────────────────

  server.resource(
    "readme",
    "file:///readme",
    { mimeType: "text/plain" },
    async () => ({
      contents: [
        {
          uri: "file:///readme",
          mimeType: "text/plain",
          text: "This is the xiaolin-mcp server. It exposes tools for basic operations.",
        },
      ],
    })
  );

  // ─── Prompts ───────────────────────────────────────────────────────────────

  server.prompt(
    "summarize",
    "Ask the model to summarize a piece of text",
    { text: z.string().describe("Text to summarize") },
    ({ text }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Please summarize the following:\n\n${text}` },
        },
      ],
    })
  );

  return server;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

// Sessions map: sessionId → { server, transport }
const sessions = new Map<
  string,
  { server: McpServer; transport: StreamableHTTPServerTransport }
>();

const app = createMcpExpressApp({ host: HOST });

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Resume existing session
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized(id) {
      sessions.set(id, { server, transport });
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing mcp-session-id header" });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await session.transport.handleRequest(req, res);
});

// Graceful session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing mcp-session-id header" });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await session.transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

app.listen(PORT, HOST, () => {
  console.log(`xiaolin-mcp listening on http://${HOST}:${PORT}/mcp`);
});
