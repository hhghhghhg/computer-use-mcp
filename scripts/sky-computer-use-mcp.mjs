import { createSkyComputerUseRuntime } from "./sky-computer-use-bridge.mjs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot =
  process.env.CODEX_COMPUTER_USE_PLUGIN_ROOT || path.resolve(scriptDir, "..");

const SERVER_NAME = "sky-computer-use";
const SERVER_VERSION = "0.1.0";
const logPath =
  process.env.SKY_COMPUTER_USE_MCP_LOG ||
  "C:/Users/admin/.codex/sky-computer-use-mcp.log";

let desktopRuntimePromise = null;
let browserSkyPromise = null;
let desktopRuntimeInstance = null;
let browserSkyInstance = null;
let transportMode = "line";

async function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stderr.write(`[sky-computer-use-mcp] ${message}\n`);
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(logPath, line, "utf8");
  } catch {
    // Logging must never break the MCP stdio transport.
  }
}

function isBrowserApp(app) {
  const value = String(app ?? "").toLowerCase();
  return (
    value.includes("msedge") ||
    value.includes("chrome") ||
    value.includes("firefox") ||
    value.includes("brave") ||
    value.includes("opera")
  );
}

function useBrowserRuntime(args) {
  const app = args?.app;
  const windowApp = args?.window?.app;
  return isBrowserApp(app) || isBrowserApp(windowApp);
}

async function createBrowserSky() {
  globalThis.nodeRepl = {
    createElicitation: async () => ({ action: "accept" }),
  };

  const skyEntry = pathToFileURL(
    path.join(
      pluginRoot,
      "node_modules",
      "@oai",
      "sky",
      "dist",
      "project",
      "cua",
      "sky_js",
      "src",
      "index.js",
    ),
  ).href;
  const { sky } = await import(skyEntry);
  return sky;
}

async function getDesktopRuntime() {
  if (desktopRuntimePromise == null) {
    desktopRuntimePromise = createSkyComputerUseRuntime().then((runtime) => {
      desktopRuntimeInstance = runtime;
      return runtime;
    });
  }
  return desktopRuntimePromise;
}

async function getBrowserSky() {
  if (browserSkyPromise == null) {
    browserSkyPromise = createBrowserSky().then((sky) => {
      browserSkyInstance = sky;
      return sky;
    });
  }
  return browserSkyPromise;
}

async function selectSky(args = {}) {
  if (useBrowserRuntime(args)) {
    return getBrowserSky();
  }
  const runtime = await getDesktopRuntime();
  return runtime.sky;
}

const tools = [
  {
    name: "list_apps",
    description: "List installed apps and any currently open targetable windows.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const runtime = await getDesktopRuntime();
      return runtime.sky.list_apps();
    },
  },
  {
    name: "list_windows",
    description: "List currently open targetable windows.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const runtime = await getDesktopRuntime();
      return runtime.sky.list_windows();
    },
  },
  {
    name: "launch_app",
    description: "Launch an app by id or executable path.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
      },
      required: ["app"],
      additionalProperties: false,
    },
    handler: async ({ app }) => {
      const sky = await selectSky({ app });
      await sky.launch_app({ app });
      return { ok: true };
    },
  },
  {
    name: "get_window",
    description: "Rehydrate a currently open window by id and optional app id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        app: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async ({ id, app }) => {
      const runtime = await getDesktopRuntime();
      return runtime.sky.get_window({ id, app });
    },
  },
  {
    name: "activate_window",
    description: "Bring a window to the foreground.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
      },
      required: ["window"],
      additionalProperties: false,
    },
    handler: async ({ window }) => {
      const runtime = await getDesktopRuntime();
      await runtime.sky.activate_window({ window });
      return { ok: true };
    },
  },
  {
    name: "get_window_state",
    description:
      "Capture a window screenshot and optionally accessibility text/tree.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        include_screenshot: { type: "boolean" },
        include_text: { type: "boolean" },
      },
      required: ["window"],
      additionalProperties: false,
    },
    handler: async ({ window, include_screenshot, include_text }) => {
      const sky = await selectSky({ window });
      return sky.get_window_state({
        window,
        include_screenshot,
        include_text,
      });
    },
  },
  {
    name: "click",
    description: "Click in a window by element index or coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        element_index: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        screenshotId: { type: "string" },
        click_count: { type: "number" },
        mouse_button: { type: "string" },
      },
      required: ["window"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sky = await selectSky(args);
      await sky.click(args);
      return { ok: true };
    },
  },
  {
    name: "press_key",
    description: "Press a key or key chord in a window.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        key: { type: "string" },
      },
      required: ["window", "key"],
      additionalProperties: false,
    },
    handler: async ({ window, key }) => {
      const sky = await selectSky({ window });
      await sky.press_key({ window, key });
      return { ok: true };
    },
  },
  {
    name: "type_text",
    description: "Type text into the focused control in a window.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        text: { type: "string" },
      },
      required: ["window", "text"],
      additionalProperties: false,
    },
    handler: async ({ window, text }) => {
      const sky = await selectSky({ window });
      await sky.type_text({ window, text });
      return { ok: true };
    },
  },
  {
    name: "scroll",
    description: "Scroll from a given coordinate inside a window.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        x: { type: "number" },
        y: { type: "number" },
        scrollX: { type: "number" },
        scrollY: { type: "number" },
        screenshotId: { type: "string" },
      },
      required: ["window", "x", "y", "scrollX", "scrollY"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sky = await selectSky(args);
      await sky.scroll(args);
      return { ok: true };
    },
  },
  {
    name: "drag",
    description: "Drag from one coordinate to another inside a window.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        from_x: { type: "number" },
        from_y: { type: "number" },
        to_x: { type: "number" },
        to_y: { type: "number" },
        screenshotId: { type: "string" },
      },
      required: ["window", "from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sky = await selectSky(args);
      await sky.drag(args);
      return { ok: true };
    },
  },
  {
    name: "set_value",
    description: "Replace the value of an editable UI element.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        element_index: { type: "number" },
        value: { type: "string" },
      },
      required: ["window", "element_index", "value"],
      additionalProperties: false,
    },
    handler: async ({ window, element_index, value }) => {
      const runtime = await getDesktopRuntime();
      await runtime.sky.set_value({ window, element_index, value });
      return { ok: true };
    },
  },
  {
    name: "perform_secondary_action",
    description: "Invoke a secondary accessibility action on a UI element.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "object" },
        element_index: { type: "number" },
        action: { type: "string" },
      },
      required: ["window", "element_index", "action"],
      additionalProperties: false,
    },
    handler: async ({ window, element_index, action }) => {
      const runtime = await getDesktopRuntime();
      await runtime.sky.perform_secondary_action({
        window,
        element_index,
        action,
      });
      return { ok: true };
    },
  },
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

let readBuffer = Buffer.alloc(0);

function writeMessage(message) {
  const json = JSON.stringify(message);
  if (transportMode === "header") {
    process.stdout.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
      "utf8",
    );
    return;
  }
  process.stdout.write(`${json}\n`, "utf8");
}

function makeError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

async function handleMessage(message) {
  const { id, method, params = {} } = message;
  await appendLog(`received ${method ?? "<missing-method>"} id=${id ?? "<none>"}`);

  if (method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    await appendLog(`sending tools/list count=${tools.length}`);
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    });
    return;
  }

  if (method === "resources/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [],
      },
    });
    return;
  }

  if (method === "resources/templates/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        resourceTemplates: [],
      },
    });
    return;
  }

  if (method === "prompts/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        prompts: [],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const tool = toolMap.get(params.name);
    if (tool == null) {
      writeMessage(makeError(id, -32601, `Unknown tool: ${params.name}`));
      return;
    }

    try {
      const result = await tool.handler(params.arguments ?? {});
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
    } catch (error) {
      writeMessage(
        makeError(
          id,
          -32000,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    return;
  }

  writeMessage(makeError(id, -32601, `Unknown method: ${method}`));
}

async function handleParsedBody(body) {
  try {
    const message = JSON.parse(body);
    if (Array.isArray(message)) {
      for (const item of message) {
        await handleMessage(item);
      }
      return;
    }
    await handleMessage(message);
  } catch (error) {
    await appendLog(
      `parse/handle error: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeMessage(
      makeError(
        null,
        -32700,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

process.stdin.on("data", async (chunk) => {
  readBuffer = Buffer.concat([readBuffer, Buffer.from(chunk)]);

  while (readBuffer.length > 0) {
    const asText = readBuffer.toString("utf8");

    if (/^Content-Length:/i.test(asText)) {
      transportMode = "header";
      const headerEndText = asText.indexOf("\r\n\r\n");
      if (headerEndText === -1) {
        return;
      }

      const headerBytes = Buffer.byteLength(
        asText.slice(0, headerEndText + 4),
        "utf8",
      );
      const header = asText.slice(0, headerEndText);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match == null) {
        writeMessage(makeError(null, -32700, "Missing Content-Length header"));
        readBuffer = Buffer.alloc(0);
        return;
      }

      const contentLength = Number(match[1]);
      if (readBuffer.length < headerBytes + contentLength) {
        return;
      }

      const body = readBuffer
        .subarray(headerBytes, headerBytes + contentLength)
        .toString("utf8");
      readBuffer = readBuffer.subarray(headerBytes + contentLength);
      await handleParsedBody(body);
      continue;
    }

    transportMode = "line";
    const newlineIndex = readBuffer.indexOf(0x0a);
    if (newlineIndex === -1) {
      return;
    }

    const lineBuffer = readBuffer.subarray(0, newlineIndex);
    readBuffer = readBuffer.subarray(newlineIndex + 1);
    const line = lineBuffer.toString("utf8").trim();
    if (!line) {
      continue;
    }
    await handleParsedBody(line);
  }
});

process.stdin.resume();
await appendLog(`started pid=${process.pid} mode=auto`);

const shutdown = async () => {
  if (desktopRuntimeInstance != null) {
    await desktopRuntimeInstance.stop().catch(() => {});
  }
  if (browserSkyInstance?.close instanceof Function) {
    await browserSkyInstance.close().catch(() => {});
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
