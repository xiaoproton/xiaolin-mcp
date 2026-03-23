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

  server.registerTool(
    "add",
    {
      description: "Add two numbers together",
      inputSchema: { a: z.number().describe("First number"), b: z.number().describe("Second number") },
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    })
  );

  server.registerTool(
    "echo",
    {
      description: "Echo a message back to the caller",
      inputSchema: { message: z.string().describe("Message to echo") },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
    })
  );

  server.registerTool(
    "get_time",
    { description: "Return the current UTC date and time" },
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    })
  );

  server.registerTool(
    "http_post",
    {
      description: "Send an HTTP POST request to any URL with a JSON body and optional headers",
      inputSchema: {
        url: z.string().url().describe("The URL to POST to"),
        body: z.record(z.unknown()).describe("The JSON request body"),
        headers: z.record(z.string()).optional().describe("Optional HTTP headers"),
      },
    },
    async ({ url, body, headers }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      let pretty: string;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        pretty = text;
      }

      return {
        content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n\n${pretty}` }],
      };
    }
  );

  server.registerTool(
    "http_get",
    {
      description: "Send an HTTP GET request to any URL and return the response (JSON or HTML)",
      inputSchema: {
        url: z.string().url().describe("The URL to GET"),
        headers: z.record(z.string()).optional().describe("Optional HTTP headers"),
      },
    },
    async ({ url, headers }) => {
      const res = await fetch(url, {
        method: "GET",
        headers: { ...headers },
      });

      const text = await res.text();
      let pretty: string;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        pretty = text;
      }

      return {
        content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n\n${pretty}` }],
      };
    }
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

function log(method: string, path: string, detail?: string) {
  const ts = new Date().toISOString();
  const parts = [`[${ts}] ${method} ${path}`];
  if (detail) parts.push(`→ ${detail}`);
  console.log(parts.join(" "));
}

const app = createMcpExpressApp({ host: HOST });

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const method = req.body?.method ?? "unknown";

  // Resume existing session
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      log("POST", "/mcp", `session ${sessionId} not found`);
      res.status(404).json({ error: "Session not found" });
      return;
    }
    log("POST", "/mcp", `session=${sessionId} method=${method}`);
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized(id) {
      sessions.set(id, { server, transport });
      log("POST", "/mcp", `new session=${id}`);
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) {
      sessions.delete(id);
      log("CLOSE", "/mcp", `session=${id} closed`);
    }
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    log("GET", "/mcp", "missing mcp-session-id");
    res.status(400).json({ error: "Missing mcp-session-id header" });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    log("GET", "/mcp", `session ${sessionId} not found`);
    res.status(404).json({ error: "Session not found" });
    return;
  }
  log("GET", "/mcp", `SSE stream opened session=${sessionId}`);
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
