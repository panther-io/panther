import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalResult,
  MiddlewareContext,
  ToolCallRequest,
  ToolPermissionOptions,
} from "@fentaris/core";

export type TelegramApprovalDecision = "approved" | "denied";

export type TelegramApprovalStore = {
  get(requestId: string): TelegramApprovalDecision | undefined | Promise<TelegramApprovalDecision | undefined>;
  set(requestId: string, decision: TelegramApprovalDecision): void | Promise<void>;
};

export type TelegramApprovalOptions = {
  botToken: string;
  chatId: string | number;
  store?: TelegramApprovalStore;
  apiBaseUrl?: string | URL;
  fetch?: typeof fetch;
  requestId?: string | ((request: ToolCallRequest, context: MiddlewareContext) => string);
  approvalUrl?: string | ((requestId: string, request: ToolCallRequest, context: MiddlewareContext) => string | undefined);
  reason?: string;
  title?: string;
  includeArguments?: boolean;
  maxArgumentLength?: number;
  failOpen?: boolean;
};

export type TelegramCallbackHandlerOptions = {
  botToken: string;
  store: TelegramApprovalStore;
  apiBaseUrl?: string | URL;
  fetch?: typeof fetch;
};

type TelegramCallbackUpdate = {
  callback_query?: {
    id?: string;
    data?: string;
  };
};

const approvePrefix = "fentaris:a:";
const denyPrefix = "fentaris:d:";
const defaultApiBaseUrl = "https://api.telegram.org";

/**
 * Create a Fentaris policy approval handler backed by Telegram inline buttons.
 * @pk
 */
export function telegramApproval(options: TelegramApprovalOptions): Pick<ToolPermissionOptions, "approval"> {
  validateOptions(options);
  const store = options.store ?? createInMemoryTelegramApprovalStore();
  const fetchImpl = options.fetch ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? defaultApiBaseUrl;

  return {
    approval: async (request, context): Promise<ApprovalResult> => {
      const requestId = resolveRequestId(options.requestId, request, context);
      const existingDecision = await store.get(requestId);
      if (existingDecision) {
        return {
          status: existingDecision,
          reason: existingDecision === "approved" ? undefined : options.reason ?? "Telegram approval denied",
          requestId,
        };
      }

      try {
        await sendApprovalMessage({
          botToken: options.botToken,
          chatId: options.chatId,
          apiBaseUrl,
          fetch: fetchImpl,
          requestId,
          text: formatApprovalMessage(requestId, request, context, options),
        });
      } catch (error) {
        context.log.error("Telegram approval request failed", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          serverName: request.serverName,
          toolName: request.toolName,
        });

        return options.failOpen
          ? { status: "approved", reason: "Telegram approval failed open", requestId }
          : {
              status: "denied",
              reason: "Telegram approval request failed",
              requestId,
              metadata: { adapter: "telegram" },
            };
      }

      return {
        status: "pending",
        requestId,
        url: resolveApprovalUrl(options.approvalUrl, requestId, request, context),
        reason: options.reason ?? "Telegram approval is pending",
        metadata: { adapter: "telegram" },
      };
    },
  };
}

/**
 * Create an in-memory decision store suitable for local development and tests.
 * @pk
 */
export function createInMemoryTelegramApprovalStore(initial: Record<string, TelegramApprovalDecision> = {}): TelegramApprovalStore {
  const decisions = new Map<string, TelegramApprovalDecision>(Object.entries(initial));
  return {
    get(requestId) {
      return decisions.get(requestId);
    },
    set(requestId, decision) {
      decisions.set(requestId, decision);
    },
  };
}

/**
 * Handle a Telegram callback_query update and persist the approve/deny decision.
 * @pk
 */
export async function handleTelegramApprovalCallback(
  update: unknown,
  options: TelegramCallbackHandlerOptions,
): Promise<{ handled: boolean; requestId?: string; decision?: TelegramApprovalDecision }> {
  validateCallbackOptions(options);
  const callback = (update as TelegramCallbackUpdate | undefined)?.callback_query;
  const parsed = parseCallbackData(callback?.data);
  if (!parsed) {
    return { handled: false };
  }

  await options.store.set(parsed.requestId, parsed.decision);

  if (callback?.id) {
    await answerCallbackQuery({
      botToken: options.botToken,
      apiBaseUrl: options.apiBaseUrl ?? defaultApiBaseUrl,
      fetch: options.fetch ?? fetch,
      callbackQueryId: callback.id,
      text: parsed.decision === "approved" ? "Approved" : "Denied",
    });
  }

  return { handled: true, requestId: parsed.requestId, decision: parsed.decision };
}

function validateOptions(options: TelegramApprovalOptions): void {
  if (!options.botToken.trim()) {
    throw new Error("Telegram approval botToken is required");
  }
  if (String(options.chatId).trim() === "") {
    throw new Error("Telegram approval chatId is required");
  }
}

function validateCallbackOptions(options: TelegramCallbackHandlerOptions): void {
  if (!options.botToken.trim()) {
    throw new Error("Telegram callback botToken is required");
  }
}

function resolveRequestId(
  configured: TelegramApprovalOptions["requestId"],
  request: ToolCallRequest,
  context: MiddlewareContext,
): string {
  const requestId = typeof configured === "function" ? configured(request, context) : configured ?? randomUUID();
  return requestId.length <= 54 ? requestId : createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

function resolveApprovalUrl(
  configured: TelegramApprovalOptions["approvalUrl"],
  requestId: string,
  request: ToolCallRequest,
  context: MiddlewareContext,
): string | undefined {
  return typeof configured === "function" ? configured(requestId, request, context) : configured;
}

async function sendApprovalMessage(options: {
  botToken: string;
  chatId: string | number;
  apiBaseUrl: string | URL;
  fetch: typeof fetch;
  requestId: string;
  text: string;
}): Promise<void> {
  const response = await options.fetch(telegramUrl(options.apiBaseUrl, options.botToken, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      text: options.text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `${approvePrefix}${options.requestId}` },
            { text: "Deny", callback_data: `${denyPrefix}${options.requestId}` },
          ],
        ],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with status ${response.status}`);
  }
}

async function answerCallbackQuery(options: {
  botToken: string;
  apiBaseUrl: string | URL;
  fetch: typeof fetch;
  callbackQueryId: string;
  text: string;
}): Promise<void> {
  const response = await options.fetch(telegramUrl(options.apiBaseUrl, options.botToken, "answerCallbackQuery"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: options.callbackQueryId,
      text: options.text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram answerCallbackQuery failed with status ${response.status}`);
  }
}

function telegramUrl(apiBaseUrl: string | URL, botToken: string, method: string): URL {
  const base = new URL(apiBaseUrl);
  const normalizedPath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  base.pathname = `${normalizedPath}bot${botToken}/${method}`;
  return base;
}

function formatApprovalMessage(
  requestId: string,
  request: ToolCallRequest,
  context: MiddlewareContext,
  options: TelegramApprovalOptions,
): string {
  const title = options.title ?? "Fentaris approval required";
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `Request: <code>${escapeHtml(requestId)}</code>`,
    `User: <code>${escapeHtml(context.subject?.id ?? context.user.id ?? "anonymous")}</code>`,
    `Server: <code>${escapeHtml(request.serverName)}</code>`,
    `Tool: <code>${escapeHtml(request.toolName)}</code>`,
  ];

  if (options.includeArguments !== false) {
    lines.push(
      "",
      "<b>Arguments</b>",
      `<pre>${escapeHtml(truncate(JSON.stringify(redactSensitive(request.arguments ?? {}), null, 2), options.maxArgumentLength ?? 1_500))}</pre>`,
    );
  }

  return lines.join("\n");
}

function parseCallbackData(data: string | undefined): { requestId: string; decision: TelegramApprovalDecision } | null {
  if (!data) {
    return null;
  }
  if (data.startsWith(approvePrefix)) {
    return { decision: "approved", requestId: data.slice(approvePrefix.length) };
  }
  if (data.startsWith(denyPrefix)) {
    return { decision: "denied", requestId: data.slice(denyPrefix.length) };
  }
  return null;
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      /(token|secret|password|authorization|api[-_]?key|credential)/i.test(key) ? "[REDACTED]" : redactSensitive(nested),
    ]),
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 15))}\n... truncated`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
