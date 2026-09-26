import type {
  AgentHeartbeatData,
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
  AgentPairData,
  AgentPairRequest,
  AgentPairResponse,
  AgentPrintJob,
  AgentPrintStepResponse,
  AgentReportPrintStepRequest,
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

export function normalizeAgentServerUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AgentApiError(
      "INVALID_SERVER_URL",
      0,
      "PrintGo server URL is invalid.",
    );
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new AgentApiError(
      "INSECURE_SERVER_URL",
      0,
      "PrintGo Agent requires HTTPS except for a loopback development server.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentApiError(
      "INVALID_SERVER_URL",
      0,
      "PrintGo server URL must not contain credentials, query parameters, or a fragment.",
    );
  }
  if (url.pathname !== "/") {
    throw new AgentApiError(
      "INVALID_SERVER_URL",
      0,
      "PrintGo server URL must be an origin without a path.",
    );
  }
  return url.origin;
}

export class AgentClient {
  private async printStepRequest(
    serverUrl: string,
    agentId: string,
    agentSecret: string,
    job: AgentPrintJob,
    action: "start" | "submitted" | "result",
    payload: Record<string, unknown>,
  ): Promise<AgentPrintStepResponse> {
    const cleanUrl = normalizeAgentServerUrl(serverUrl);
    let response: Response;
    try {
      response = await fetch(
        `${cleanUrl}/api/agent/print-jobs/${encodeURIComponent(job.orderId)}/steps/${encodeURIComponent(job.currentStep.stepId)}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${agentSecret}`,
            "X-PrintGo-Agent-Id": agentId,
          },
          body: JSON.stringify(payload),
        },
      );
    } catch (error) {
      throw new AgentApiError(
        "NETWORK_ERROR",
        0,
        `Print-step network failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401)
      throw new AgentAuthError(
        "Agent authentication failed while updating a print step.",
      );
    const data = (await response.json()) as AgentPrintStepResponse;
    if (!response.ok || !data.ok) {
      throw new AgentApiError(
        data.ok ? "PRINT_STEP_FAILED" : data.error.code,
        response.status,
        data.ok ? "Print step update failed." : data.error.message,
      );
    }
    return data;
  }

  startPrintStep(
    serverUrl: string,
    agentId: string,
    agentSecret: string,
    job: AgentPrintJob,
  ) {
    return this.printStepRequest(
      serverUrl,
      agentId,
      agentSecret,
      job,
      "start",
      { claimId: job.claimId },
    );
  }

  submitPrintStep(
    serverUrl: string,
    agentId: string,
    agentSecret: string,
    job: AgentPrintJob,
    spoolerJobId: string,
  ) {
    return this.printStepRequest(
      serverUrl,
      agentId,
      agentSecret,
      job,
      "submitted",
      { claimId: job.claimId, spoolerJobId },
    );
  }

  reportPrintStep(
    serverUrl: string,
    agentId: string,
    agentSecret: string,
    job: AgentPrintJob,
    report: Omit<AgentReportPrintStepRequest, "claimId">,
  ) {
    return this.printStepRequest(
      serverUrl,
      agentId,
      agentSecret,
      job,
      "result",
      { claimId: job.claimId, ...report },
    );
  }

  async pair(
    serverUrl: string,
    pairCode: string,
    displayName: string,
  ): Promise<AgentPairData> {
    const cleanUrl = normalizeAgentServerUrl(serverUrl);
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
    const cleanUrl = normalizeAgentServerUrl(serverUrl);

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
    const cleanUrl = normalizeAgentServerUrl(serverUrl);
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
