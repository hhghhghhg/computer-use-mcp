import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(scriptDir, "sky-computer-use-mcp.mjs");

function createFrame(payload) {
  const json = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function waitForMessage(stdout, state) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for MCP response"));
    }, 15000);

    const onData = (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      while (state.buffer.length > 0) {
        const splitAt = state.buffer.indexOf(Buffer.from("\r\n\r\n", "utf8"));
        if (splitAt === -1) {
          return;
        }
        const header = state.buffer.slice(0, splitAt).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (match == null) {
          cleanup();
          reject(new Error(`Missing Content-Length header: ${header}`));
          return;
        }
        const bodyStart = splitAt + 4;
        const contentLength = Number(match[1]);
        if (state.buffer.length < bodyStart + contentLength) {
          return;
        }
        const body = state.buffer
          .slice(bodyStart, bodyStart + contentLength)
          .toString("utf8");
        state.buffer = state.buffer.slice(bodyStart + contentLength);
        cleanup();
        resolve(JSON.parse(body));
        return;
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`MCP server exited early with code ${code}`));
    };

    function cleanup() {
      clearTimeout(timeout);
      stdout.off("data", onData);
      proc.off("error", onError);
      proc.off("exit", onExit);
    }

    stdout.on("data", onData);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

const proc = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const state = { buffer: Buffer.alloc(0) };

async function send(payload) {
  proc.stdin.write(createFrame(payload), "utf8");
  return waitForMessage(proc.stdout, state);
}

try {
  const init = await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-sky-mcp", version: "0.0.0" },
    },
  });

  if (init.result?.serverInfo?.name !== "sky-computer-use") {
    throw new Error(`Unexpected initialize response: ${JSON.stringify(init)}`);
  }

  const tools = await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);
  if (!toolNames.includes("list_apps")) {
    throw new Error(`list_apps missing from tools/list: ${JSON.stringify(tools)}`);
  }

  const listApps = await send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "list_apps",
      arguments: {},
    },
  });

  const text = listApps.result?.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Unexpected list_apps payload: ${text}`);
  }

  const blockedBrowser = await send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "launch_app",
      arguments: {
        app: "MSEdge",
      },
    },
  });

  const launchText = blockedBrowser.result?.content?.[0]?.text ?? "";
  const launchParsed = JSON.parse(launchText);
  if (launchParsed?.ok !== true) {
    throw new Error(
      `Expected browser launch to succeed, got: ${JSON.stringify(blockedBrowser)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        toolCount: toolNames.length,
        firstTool: toolNames[0],
        appCount: parsed.length,
        browserLaunchPassed: true,
      },
      null,
      2,
    ),
  );
  proc.kill();
} catch (error) {
  proc.kill();
  throw error;
}
