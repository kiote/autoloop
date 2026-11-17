import { type ChildProcess, spawn } from "node:child_process";
import {
  initAcpSession,
  sendAcpPrompt,
  terminateAcpSession,
} from "@mobrienv/autoloop-backends/acp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  const EventEmitter = require("node:events");
  const { Readable, Writable } = require("node:stream");

  function createMockChild(detached: boolean | undefined): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.pid = 12345;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      process.nextTick(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return true;
    });
    (child as any)._detached = detached;
    return child;
  }

  return {
    spawn: vi.fn((_cmd: string, _args: string[], opts: any) => {
      return createMockChild(opts?.detached);
    }),
  };
});

vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: "1.0",
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream(),
  })),
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({}),
    newSession: vi.fn().mockResolvedValue({ sessionId: "test-session" }),
    setSessionMode: vi.fn().mockResolvedValue({}),
    unstable_setSessionModel: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockImplementation(() => new Promise(() => {})),
    cancel: vi.fn(),
  })),
}));

describe("initAcpSession", () => {
  it("spawns child with detached: true for process group cleanup", async () => {
    const spawnFn = spawn as unknown as ReturnType<typeof vi.fn>;
    const session = await initAcpSession({
      command: "kiro-cli",
      args: ["--acp"],
      cwd: "/tmp",
      trustAllTools: true,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      "kiro-cli",
      ["--acp"],
      expect.objectContaining({ detached: true }),
    );
    expect(session.sessionId).toBe("test-session");
  });

  it("times out a wedged handshake and reaps the child", async () => {
    const sdk = await import("@agentclientprotocol/sdk");
    const Connection = sdk.ClientSideConnection as unknown as ReturnType<
      typeof vi.fn
    >;
    const spawnFn = spawn as unknown as ReturnType<typeof vi.fn>;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    Connection.mockImplementationOnce(() => ({
      initialize: vi.fn().mockImplementation(() => new Promise(() => {})),
      cancel: vi.fn(),
    }));

    try {
      const pending = initAcpSession({
        command: "wedged-acp",
        args: [],
        cwd: "/tmp",
        trustAllTools: true,
        handshakeTimeoutMs: 30,
      });

      await expect(pending).rejects.toThrow(
        'ACP handshake with "wedged-acp" timed out after 30ms',
      );
      const child = spawnFn.mock.results.at(-1)?.value as ChildProcess;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.killed).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("rejects immediately when the child exits during the handshake", async () => {
    const sdk = await import("@agentclientprotocol/sdk");
    const Connection = sdk.ClientSideConnection as unknown as ReturnType<
      typeof vi.fn
    >;
    const spawnFn = spawn as unknown as ReturnType<typeof vi.fn>;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    Connection.mockImplementationOnce(() => ({
      initialize: vi.fn().mockImplementation(() => new Promise(() => {})),
      cancel: vi.fn(),
    }));

    try {
      const pending = initAcpSession({
        command: "crashing-acp",
        args: [],
        cwd: "/tmp",
        trustAllTools: true,
        handshakeTimeoutMs: 10_000,
      });
      const child = spawnFn.mock.results.at(-1)?.value as ChildProcess;
      child.stderr?.push("boom: command exploded\n");
      await new Promise((resolve) => setImmediate(resolve));
      child.emit("close", 1, null);

      const error = await pending.catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'ACP agent ("crashing-acp") exited during the ACP handshake: code=1 signal=null',
      );
      expect((error as Error).message).toContain("boom: command exploded");
      expect((error as Error).message).not.toContain("timed out");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("sanitizes the environment passed to the ACP process", async () => {
    const spawnFn = spawn as unknown as ReturnType<typeof vi.fn>;
    await initAcpSession({
      command: "kiro-cli",
      args: ["--acp"],
      cwd: "/tmp/project",
      trustAllTools: true,
      environmentPolicy: "hardened",
      env: {
        PATH: "/usr/bin:/tmp/project/bin",
        NORMAL_PROJECT_FLAG: "enabled",
        NODE_OPTIONS: "--require ./owned.js",
      },
    });

    const options = spawnFn.mock.calls.at(-1)?.[2];
    expect(options.env.NORMAL_PROJECT_FLAG).toBe("enabled");
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.PATH).toBe("/usr/bin");
  });

  it("inherits the ACP process environment when policy is omitted", async () => {
    const spawnFn = spawn as unknown as ReturnType<typeof vi.fn>;
    const env = {
      PATH: "/usr/bin:/tmp/project/bin",
      NODE_OPTIONS: "--require ./project-hook.js",
    };
    await initAcpSession({
      command: "kiro-cli",
      args: ["--acp"],
      cwd: "/tmp/project",
      trustAllTools: true,
      env,
    });

    expect(spawnFn.mock.calls.at(-1)?.[2].env).toBe(env);
  });

  it("resolves provider metadata from options and command", async () => {
    const session = await initAcpSession({
      provider: "claude-agent-acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      cwd: "/tmp",
      trustAllTools: true,
    });

    expect(session.provider.id).toBe("claude-agent-acp");
    expect(session.provider.crashLabel).toBe("claude-agent-acp");
  });

  it("passes agent and model to capable ACP providers", async () => {
    const sdk = await import("@agentclientprotocol/sdk");
    const Connection = sdk.ClientSideConnection as unknown as ReturnType<
      typeof vi.fn
    >;

    await initAcpSession({
      provider: "kiro",
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp",
      trustAllTools: true,
      agentName: "reviewer",
      modelId: "sonnet",
    });

    const connection = Connection.mock.results.at(-1)?.value;
    expect(connection.setSessionMode).toHaveBeenCalledWith({
      sessionId: "test-session",
      modeId: "reviewer",
    });
    expect(connection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: "test-session",
      modelId: "sonnet",
    });
  });

  it("uses provider crash labels in prompt errors", async () => {
    const session = await initAcpSession({
      provider: "claude-agent-acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      cwd: "/tmp",
      trustAllTools: true,
    });

    process.nextTick(() => session.process.emit("close", 9, null));
    const result = await sendAcpPrompt(session, "hello", 1000);

    expect(result.error).toContain("claude-agent-acp exited unexpectedly");
  });
});

describe("ACP stdin transport", () => {
  async function transport() {
    const sdk = await import("@agentclientprotocol/sdk");
    const session = await initAcpSession({
      command: "mock-acp",
      args: [],
      cwd: "/tmp",
      trustAllTools: true,
    });
    const calls = (sdk.ndJsonStream as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    const stream = calls.at(-1)?.[0] as WritableStream<Uint8Array>;
    return {
      session,
      writer: stream.getWriter(),
      stdin: session.process.stdin!,
    };
  }

  it("rejects a failed write while handling the matching Node error event", async () => {
    const { writer, stdin } = await transport();
    const failure = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    vi.spyOn(stdin, "write").mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(failure);
      process.nextTick(() => stdin.emit("error", failure));
      return false;
    });
    await expect(writer.write(new Uint8Array([1]))).rejects.toBe(failure);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("preserves an earlier pipe error instead of silently accepting another write", async () => {
    const { writer, stdin } = await transport();
    const failure = new Error("pipe closed");
    expect(() => stdin.emit("error", failure)).not.toThrow();
    const write = vi.spyOn(stdin, "write");
    await expect(writer.write(new Uint8Array([1]))).rejects.toBe(failure);
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects writes to a destroyed pipe", async () => {
    const { writer, stdin } = await transport();
    stdin.destroy();
    await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
      "ACP stdin is not writable",
    );
  });

  it("still writes and closes a healthy pipe", async () => {
    const { writer, stdin } = await transport();
    await expect(writer.write(new Uint8Array([1]))).resolves.toBeUndefined();
    await writer.close();
    expect(stdin.writableEnded).toBe(true);
  });

  it.each([
    new Error("abort"),
    "abort",
  ])("handles transport abort: %s", async (reason) => {
    const { writer, stdin } = await transport();
    await writer.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stdin.destroyed).toBe(true);
  });

  it("handles cancellation rejection when a timed-out transport is closing", async () => {
    const { session } = await transport();
    (
      session.connection.cancel as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("EPIPE"));
    expect((await sendAcpPrompt(session, "timeout", 5)).timedOut).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("terminateAcpSession", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("sends SIGTERM to the child process group via negative PID", async () => {
    const spawnFn = spawn as unknown as ReturnType<typeof vi.fn>;
    const session = await initAcpSession({
      command: "kiro-cli",
      args: ["--acp"],
      cwd: "/tmp",
      trustAllTools: true,
    });

    await terminateAcpSession(session);

    // process.kill(-pid) targets the process group — requires detached: true
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
  });

  it("handles an asynchronous cancellation rejection during cleanup", async () => {
    const session = await initAcpSession({
      command: "mock-acp",
      args: [],
      cwd: "/tmp",
      trustAllTools: true,
    });
    (
      session.connection.cancel as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("EPIPE"));
    await expect(terminateAcpSession(session)).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("falls back to child.kill if process group kill fails", async () => {
    killSpy.mockImplementation((pid: number, signal?: string) => {
      if (pid < 0) throw new Error("ESRCH");
      return true;
    });

    const session = await initAcpSession({
      command: "kiro-cli",
      args: ["--acp"],
      cwd: "/tmp",
      trustAllTools: true,
    });

    await terminateAcpSession(session);

    expect(session.process.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
