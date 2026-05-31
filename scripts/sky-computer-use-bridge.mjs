import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPluginRoot = path.resolve(scriptDir, "..");

const APPROVED_APP_META_KEY = "x-oai-cua-approved-app";
const pluginRoot =
  process.env.CODEX_COMPUTER_USE_PLUGIN_ROOT || defaultPluginRoot;

const clientPath = path.join(pluginRoot, "scripts", "computer-use-client.mjs");
const helperPath = path.join(
  pluginRoot,
  "node_modules",
  "@oai",
  "sky",
  "bin",
  "windows",
  "codex-computer-use.exe",
);

const FRAME_HEADER_BYTES = 4;
const timeoutMs = 15000;

function encodeFrame(message) {
  const payload = Buffer.from(message, "utf8");
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= FRAME_HEADER_BYTES) {
    const payloadLength = buffer.readUInt32LE(offset);
    const frameLength = FRAME_HEADER_BYTES + payloadLength;
    if (buffer.length - offset < frameLength) {
      break;
    }
    messages.push(
      buffer
        .subarray(offset + FRAME_HEADER_BYTES, offset + frameLength)
        .toString("utf8"),
    );
    offset += frameLength;
  }

  return {
    messages,
    remainingData: buffer.subarray(offset),
  };
}

class SkyHelperBridge {
  constructor({
    pluginRoot: inputPluginRoot = pluginRoot,
    timeout = timeoutMs,
  } = {}) {
    this.pluginRoot = inputPluginRoot;
    this.timeout = timeout;
    this.clientPath = path.join(
      this.pluginRoot,
      "scripts",
      "computer-use-client.mjs",
    );
    this.helperPath = path.join(
      this.pluginRoot,
      "node_modules",
      "@oai",
      "sky",
      "bin",
      "windows",
      "codex-computer-use.exe",
    );
    this.helper = null;
    this.helperStdoutBuffer = "";
    this.helperPending = new Map();
    this.server = null;
    this.pipePath = `\\\\.\\pipe\\codex-sky-bridge-${process.pid}-${Date.now()}`;
  }

  async start() {
    if (this.helper?.stdin == null || this.helper.killed) {
      this.startHelper();
    }

    if (this.server != null) {
      return;
    }

    this.server = net.createServer((socket) => this.handleBridgeSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.pipePath, resolve);
    });
  }

  startHelper() {
    if (this.helper != null && !this.helper.killed) {
      this.helper.kill();
    }

    const helper = spawn(this.helperPath, ["--parent-pid", String(process.pid)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.helper = helper;

    if (helper.stdin == null || helper.stdout == null || helper.stderr == null) {
      this.helper = null;
      throw new Error("sky helper did not expose stdio pipes");
    }

    helper.stdout.setEncoding("utf8");
    helper.stderr.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => this.handleHelperStdout(chunk));
    helper.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        process.stderr.write(`[sky-helper] ${text}\n`);
      }
    });
    helper.on("error", (error) => {
      process.stderr.write(`[sky-helper] failed to start: ${error.message}\n`);
      if (this.helper === helper) {
        this.helper = null;
      }
    });
    helper.on("exit", (code, signal) => {
      process.stderr.write(
        `[sky-helper] exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      );
      for (const { reject, timer } of this.helperPending.values()) {
        clearTimeout(timer);
        reject(new Error(`sky helper exited unexpectedly code=${code ?? "null"}`));
      }
      this.helperPending.clear();
      if (this.helper === helper) {
        this.helper = null;
      }
    });
  }

  async stop() {
    const closePromises = [];

    if (globalThis.sky?.close instanceof Function) {
      closePromises.push(globalThis.sky.close().catch(() => {}));
    }

    if (this.server != null) {
      closePromises.push(
        new Promise((resolve) => this.server.close(() => resolve())),
      );
      this.server = null;
    }

    if (this.helper != null) {
      this.helper.kill();
      this.helper = null;
    }

    await Promise.all(closePromises);
  }

  handleHelperStdout(chunk) {
    this.helperStdoutBuffer += String(chunk);
    const lines = this.helperStdoutBuffer.split(/\r?\n/);
    this.helperStdoutBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const msg = JSON.parse(line);
      if (typeof msg.id !== "number") {
        continue;
      }
      const pending = this.helperPending.get(msg.id);
      if (pending == null) {
        continue;
      }
      clearTimeout(pending.timer);
      this.helperPending.delete(msg.id);
      pending.resolve(msg);
    }
  }

  async helperRequest(method, params = {}, meta = {}) {
    await this.start();

    return new Promise((resolve, reject) => {
      if (this.helper?.stdin == null || this.helper.killed) {
        reject(new Error("sky helper is not running"));
        return;
      }

      const id = Math.floor(Math.random() * 1e9);
      const timer = setTimeout(() => {
        this.helperPending.delete(id);
        reject(new Error(`timeout waiting for helper ${method}`));
      }, this.timeout);

      this.helperPending.set(id, { resolve, reject, timer });
      this.helper.stdin.write(
        `${JSON.stringify({ id, method, params, meta })}\n`,
        "utf8",
        (error) => {
          if (error == null) {
            return;
          }
          clearTimeout(timer);
          this.helperPending.delete(id);
          reject(error);
        },
      );
    });
  }

  async maybeApproveAndRetry({
    helperMsg,
    method,
    params,
    meta,
    createElicitation,
  }) {
    const approvalRequest =
      helperMsg != null && typeof helperMsg === "object"
        ? helperMsg.approvalRequest
        : null;
    const approvalApp =
      approvalRequest != null && typeof approvalRequest === "object"
        ? approvalRequest.app
        : null;

    if (
      helperMsg?.ok ||
      typeof approvalApp !== "string" ||
      approvalApp.trim() === ""
    ) {
      return helperMsg;
    }

    const approvalResult = await createElicitation({
      message: `Allow Computer Use to use "${approvalRequest.displayName ?? approvalApp}"?`,
      meta: {
        codex_approval_kind: "mcp_tool_call",
        connector_id: "computer-use",
        connector_name: "Computer Use",
        persist: ["session", "always"],
        riskLevel: approvalRequest.riskLevel ?? "low",
        tool_params: { app: approvalApp },
        tool_params_display: [
          {
            name: "app",
            display_name: "App",
            value: approvalRequest.displayName ?? approvalApp,
          },
        ],
      },
    });

    if (approvalResult?.action !== "accept") {
      return {
        id: helperMsg.id,
        ok: false,
        error: `Computer Use was not approved to use ${approvalRequest.displayName ?? approvalApp}`,
      };
    }

    return this.helperRequest(method, params, {
      ...(meta ?? {}),
      [APPROVED_APP_META_KEY]: approvalApp,
    });
  }

  handleBridgeSocket(socket) {
    let pendingData = Buffer.alloc(0);

    socket.on("data", async (chunk) => {
      pendingData = Buffer.concat([pendingData, Buffer.from(chunk)]);
      const decoded = decodeFrames(pendingData);
      pendingData = decoded.remainingData;

      for (const messageText of decoded.messages) {
        let rpc;
        try {
          rpc = JSON.parse(messageText);
        } catch {
          socket.write(
            encodeFrame(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { message: "invalid json" },
                id: null,
              }),
            ),
          );
          continue;
        }

        try {
          if (rpc.method === "close") {
            socket.write(
              encodeFrame(
                JSON.stringify({ jsonrpc: "2.0", result: null, id: rpc.id }),
              ),
            );
            socket.end();
            continue;
          }

          if (rpc.method !== "request") {
            socket.write(
              encodeFrame(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { message: `unsupported method ${rpc.method}` },
                  id: rpc.id,
                }),
              ),
            );
            continue;
          }

          const helperMsg = await this.helperRequest(
            rpc.params?.method,
            rpc.params?.params ?? {},
            rpc.params?.codexTurnMetadata ?? {},
          );
          const finalHelperMsg = await this.maybeApproveAndRetry({
            helperMsg,
            method: rpc.params?.method,
            params: rpc.params?.params ?? {},
            meta: rpc.params?.codexTurnMetadata ?? {},
            createElicitation:
              globalThis.nodeRepl?.createElicitation ??
              (async () => ({ action: "accept" })),
          });

          if (finalHelperMsg.ok) {
            socket.write(
              encodeFrame(
                JSON.stringify({
                  jsonrpc: "2.0",
                  result: finalHelperMsg.result,
                  id: rpc.id,
                }),
              ),
            );
          } else {
            socket.write(
              encodeFrame(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    message:
                      typeof finalHelperMsg.error === "string" &&
                      finalHelperMsg.error.trim() !== ""
                        ? finalHelperMsg.error
                        : JSON.stringify(finalHelperMsg),
                  },
                  id: rpc.id,
                }),
              ),
            );
          }
        } catch (error) {
          socket.write(
            encodeFrame(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
                id: rpc?.id ?? null,
              }),
            ),
          );
        }
      }
    });
  }

  async setupComputerUseRuntime({ globals = globalThis } = {}) {
    await this.start();

    globals.nodeRepl = {
      env: {
        SKY_CUA_NATIVE_PIPE_DIRECTORY: this.pipePath,
      },
      nativePipe: {
        createConnection(target) {
          return new Promise((resolve, reject) => {
            const socket = net.createConnection(target, () => {
              socket.off("error", reject);
              resolve(socket);
            });
            socket.once("error", reject);
          });
        },
      },
      createElicitation: async () => ({ action: "accept" }),
    };

    const { setupComputerUseRuntime } = await import(
      `file:///${this.clientPath.replace(/\\/g, "/")}`
    );
    return setupComputerUseRuntime({ globals });
  }
}

export async function createSkyComputerUseRuntime(options = {}) {
  const bridge = new SkyHelperBridge(options);
  await bridge.setupComputerUseRuntime({ globals: globalThis });
  return {
    bridge,
    sky: globalThis.sky,
    stop: async () => bridge.stop(),
  };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const runtime = await createSkyComputerUseRuntime();
  const apps = await runtime.sky.list_apps();
  console.log(
    JSON.stringify(
      {
        ok: true,
        count: Array.isArray(apps) ? apps.length : null,
        sample: Array.isArray(apps) ? apps.slice(0, 5) : [],
      },
      null,
      2,
    ),
  );
  await runtime.stop();
}
