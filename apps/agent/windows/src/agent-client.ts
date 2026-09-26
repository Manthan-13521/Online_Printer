import type {
  AgentHeartbeatData,
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
  AgentPairData,
  AgentPairRequest,
  AgentPairResponse,
  AgentReportCommandRequest,
  AgentReportCommandResponse,
} from "@printgo/api-contract";

export class AgentAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAuthError";
  }
}

export class AgentApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export class AgentClient {
  async pair(
    serverUrl: string,
    pairCode: string,
    displayName: string,
  ): Promise<AgentPairData> {
    const cleanUrl = serverUrl.replace(/\/$/u, "");
    const payload: AgentPairRequest = {
      pairCode,
      displayName,
    };

    let response: Response;
    try {
      response = await fetch(`${cleanUrl}/api/agent/pair`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      throw new AgentApiError(
        "NETWORK_ERROR",
        0,
        `Failed to connect to PrintGo server at ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const data = (await response.json()) as AgentPairResponse;
    if (!data.ok) {
      throw new AgentApiError(
        data.error.code ?? "PAIRING_FAILED",
        response.status,
        data.error.message ?? "Agent pairing failed.",
      );
    }
    if (!response.ok) {
      throw new AgentApiError(
        "PAIRING_FAILED",
        response.status,
        `Agent pairing failed with HTTP status ${response.status}`,
      );
    }

    return data.data;
  }

  async sendHeartbeat(
    serverUrl: string,
    agentId: string,
    agentSecret: string,
    report: AgentHeartbeatRequest,
  ): Promise<AgentHeartbeatData> {
    const cleanUrl = serverUrl.replace(/\/$/u, "");

    let response: Response;
    try {
      response = await fetch(`${cleanUrl}/api/agent/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agentSecret}`,
          "X-PrintGo-Agent-Id": agentId,
        },
        body: JSON.stringify(report),
      });
    } catch (err: unknown) {
      throw new AgentApiError(
        "NETWORK_ERROR",
        0,
        `Heartbeat network failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 401) {
      throw new AgentAuthError(
        "Agent authentication failed (agent may have been revoked).",
      );
    }

    const data = (await response.json()) as AgentHeartbeatResponse;
    if (!data.ok) {
      throw new AgentApiError(
        data.error.code ?? "HEARTBEAT_FAILED",
        response.status,
        data.error.message ?? "Heartbeat rejected by server.",
      );
    }
    if (!response.ok) {
      throw new AgentApiError(
        "HEARTBEAT_FAILED",
        response.status,
        `Heartbeat failed with HTTP status ${response.status}`,
      );
    }

    return data.data;
  }

  async reportCommand(
    serverUrl: string,
    agentId: string,
    agentSecret: string,
    commandId: string,
    report: AgentReportCommandRequest,
  ): Promise<void> {
    const cleanUrl = serverUrl.replace(/\/$/u, "");
    let response: Response;
    try {
      response = await fetch(
        `${cleanUrl}/api/agent/commands/${encodeURIComponent(commandId)}/report`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${agentSecret}`,
            "X-PrintGo-Agent-Id": agentId,
          },
          body: JSON.stringify(report),
        },
      );
    } catch (err: unknown) {
      throw new AgentApiError(
        "NETWORK_ERROR",
        0,
        `Command report network failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 401) {
      throw new AgentAuthError(
        "Agent authentication failed while reporting command.",
      );
    }

    const data = (await response.json()) as AgentReportCommandResponse;
    if (!data.ok) {
      throw new AgentApiError(
        data.error.code ?? "REPORT_FAILED",
        response.status,
        data.error.message ?? "Command report rejected by server.",
      );
    }
  }
}
