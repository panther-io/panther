import { describe, expect, it, vi } from "vitest";
import { Logger } from "@fentaris/core";
import {
  createInMemoryTelegramApprovalStore,
  handleTelegramApprovalCallback,
  telegramApproval,
  type TelegramApprovalDecision,
} from "./index.js";
import type { MiddlewareContext, ToolCallRequest } from "@fentaris/core";

function request(): ToolCallRequest {
  return {
    serverName: "github",
    toolName: "delete_repo",
    proxyToolName: "github__delete_repo",
    arguments: {
      owner: "fentaris",
      repo: "demo",
      token: "raw-token",
      nested: { password: "raw-password" },
    },
    raw: { name: "github__delete_repo" },
  };
}

function context(): MiddlewareContext {
  return {
    user: { id: "alice" },
    subject: {
      id: "alice",
      groups: [],
      hasGroup: () => false,
    },
    log: new Logger({ redact: false }),
    res: {
      deny: vi.fn(),
      fail: vi.fn(),
      continue: vi.fn(),
      injectToAgent: vi.fn(),
      on: vi.fn(),
      notifyError: vi.fn(),
      applyInjections: vi.fn(),
      injectedErrorResult: vi.fn(),
    } as unknown as MiddlewareContext["res"],
  };
}

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

describe("telegramApproval", () => {
  it("sends a Telegram approval request and returns pending metadata", async () => {
    const fetchMock = okFetch();
    const approval = telegramApproval({
      botToken: "bot-token",
      chatId: "chat-1",
      fetch: fetchMock,
      apiBaseUrl: "https://telegram.test",
      requestId: "req-1",
      approvalUrl: (requestId) => `https://approval.test/${requestId}`,
    }).approval;

    const result = await approval?.(request(), context());

    expect(result).toMatchObject({
      status: "pending",
      requestId: "req-1",
      url: "https://approval.test/req-1",
      metadata: { adapter: "telegram" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("github");
    expect(body.text).toContain("delete_repo");
    expect(body.text).not.toContain("raw-token");
    expect(body.text).not.toContain("raw-password");
    expect(body.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe("fentaris:a:req-1");
    expect(body.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toBe("fentaris:d:req-1");
  });

  it("returns existing store decisions without sending another Telegram message", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore({ "req-2": "approved" });
    const approval = telegramApproval({
      botToken: "bot-token",
      chatId: "chat-1",
      fetch: fetchMock,
      store,
      requestId: "req-2",
    }).approval;

    await expect(approval?.(request(), context())).resolves.toMatchObject({
      status: "approved",
      requestId: "req-2",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores callback decisions and answers Telegram callback queries", async () => {
    const fetchMock = okFetch();
    const decisions = new Map<string, TelegramApprovalDecision>();
    const store = {
      get: (requestId: string) => decisions.get(requestId),
      set: (requestId: string, decision: TelegramApprovalDecision) => {
        decisions.set(requestId, decision);
      },
    };

    const result = await handleTelegramApprovalCallback(
      { callback_query: { id: "callback-1", data: "fentaris:d:req-3" } },
      { botToken: "bot-token", store, fetch: fetchMock, apiBaseUrl: "https://telegram.test" },
    );

    expect(result).toEqual({ handled: true, requestId: "req-3", decision: "denied" });
    expect(decisions.get("req-3")).toBe("denied");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      callback_query_id: "callback-1",
      text: "Denied",
    });
  });

  it("ignores unrelated Telegram callbacks", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();

    await expect(
      handleTelegramApprovalCallback(
        { callback_query: { id: "callback-1", data: "other:data" } },
        { botToken: "bot-token", store, fetch: fetchMock },
      ),
    ).resolves.toEqual({ handled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
