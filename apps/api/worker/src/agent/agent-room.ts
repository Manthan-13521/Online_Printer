export class AgentRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const role = url.searchParams.get("role") || "agent";
      const requestedProtocols = request.headers.get("Sec-WebSocket-Protocol");

      // Safe subprotocol negotiation: never blindly echo arbitrary strings.
      // Support standard 'printgo-agent-v1' or legacy authenticated single token.
      let negotiatedProtocol: string | undefined;
      if (requestedProtocols) {
        const protocols = requestedProtocols.split(",").map((p) => p.trim());
        if (protocols.includes("printgo-agent-v1")) {
          negotiatedProtocol = "printgo-agent-v1";
        } else if (
          role === "agent" &&
          protocols.length === 1 &&
          Boolean(protocols[0] && protocols[0].length > 0)
        ) {
          negotiatedProtocol = protocols[0];
        }
      }

      const webSocketPair = new WebSocketPair();
      const client = webSocketPair[0];
      const server = webSocketPair[1];

      this.state.acceptWebSocket(server, [role]);

      const responseInit: ResponseInit = {
        status: 101,
        webSocket: client,
      };
      if (negotiatedProtocol) {
        responseInit.headers = {
          "Sec-WebSocket-Protocol": negotiatedProtocol,
        };
      }

      return new Response(null, responseInit);
    }

    if (url.pathname === "/wake" && request.method === "POST") {
      // 1. Wake connected Windows Agents immediately for order claiming
      const agentSockets = this.state.getWebSockets("agent");
      for (const ws of agentSockets) {
        try {
          ws.send(JSON.stringify({ type: "WAKE_UP" }));
        } catch {
          // Ignored
        }
      }

      // 2. Also notify connected Admin PWAs of new ready order
      const adminSockets = this.state.getWebSockets("admin");
      for (const ws of adminSockets) {
        try {
          ws.send(JSON.stringify({ type: "ADMIN_ORDER_UPDATE" }));
        } catch {
          // Ignored
        }
      }

      return new Response("Woke up " + agentSockets.length + " agents", {
        status: 200,
      });
    }

    if (url.pathname === "/notify-admin" && request.method === "POST") {
      let payload: Record<string, unknown> = { type: "ADMIN_ORDER_UPDATE" };
      try {
        const rawBody: unknown = await request.json();
        if (rawBody && typeof rawBody === "object") {
          payload = { ...payload, ...(rawBody as Record<string, unknown>) };
        }
      } catch {
        // Use default payload
      }

      // Strictly broadcast to Admin sockets only; never send admin updates to agent sockets
      const adminSockets = this.state.getWebSockets("admin");
      const msg = JSON.stringify(payload);
      for (const ws of adminSockets) {
        try {
          ws.send(msg);
        } catch {
          // Ignored
        }
      }

      return new Response("Notified " + adminSockets.length + " admins", {
        status: 200,
      });
    }

    if (url.pathname === "/probe" && request.method === "POST") {
      return this.handleProbe(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleProbe(request: Request): Promise<Response> {
    const raw: unknown = await request.json();
    const body = raw as { printerId?: string };
    const agentSockets = this.state.getWebSockets("agent");
    const socketsToSend =
      agentSockets.length > 0 ? agentSockets : this.state.getWebSockets();
    const msg = JSON.stringify({
      type: "PROBE_PRINTER",
      printerId: body.printerId ?? null,
    });
    for (const ws of socketsToSend) {
      try {
        ws.send(msg);
      } catch {
        // Ignored
      }
    }
    return new Response("Probed " + socketsToSend.length + " agents", {
      status: 200,
    });
  }
}
