import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  IdentityMetadata,
  ProxyExposureHandle,
  ProxyExposureTransport,
  ProxyRuntime,
  ResolvedSubject,
  UserContext,
} from "../types.js";

/**
 * Options for stdio downstream proxy exposure.
 * @pk
 */
export type StdioProxyExposureTransportOptions = {
  user?: UserContext | (() => UserContext | Promise<UserContext>);
};

/**
 * Stdio MCP downstream proxy exposure.
 * @pk
 */
export class StdioProxyExposureTransport implements ProxyExposureTransport {
  private readonly options: StdioProxyExposureTransportOptions;

  /**
   * Create a stdio proxy exposure transport.
   * @pk
   */
  constructor(options: StdioProxyExposureTransportOptions = {}) {
    this.options = options;
  }

  async listen(runtime: ProxyRuntime): Promise<ProxyExposureHandle> {
    const resolved = await this.resolveUser(runtime);
    const sdkServer = runtime.createSdkServer(resolved.user, resolved.identity, resolved.subject) as McpSdkServer;
    const transport = new StdioServerTransport();

    await sdkServer.connect(transport);
    await runtime.emitSessionStart({
      user: resolved.user,
      identity: resolved.identity,
      log: runtime.logger.child({ userId: resolved.user.id, transport: "stdio" }),
    });

    transport.onclose = () => {
      void runtime.emitSessionEnd({
        user: resolved.user,
        identity: resolved.identity,
        log: runtime.logger.child({ userId: resolved.user.id, transport: "stdio" }),
      });
    };

    return {
      close: async () => {
        await transport.close();
        await sdkServer.close();
      },
    };
  }

  private async resolveUser(
    runtime: ProxyRuntime,
  ): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    if (!this.options.user) {
      return runtime.resolveStdioUser();
    }

    const user = typeof this.options.user === "function" ? await this.options.user() : this.options.user;
    return { user };
  }
}
