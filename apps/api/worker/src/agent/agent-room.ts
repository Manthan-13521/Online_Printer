export class AgentRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const webSocketPair = new WebSocketPair();
      const client = webSocketPair[0];
      const server = webSocketPair[1];

      this.state.acceptWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (url.pathname === "/wake" && request.method === "POST") {
      const websockets = this.state.getWebSockets();
      for (const ws of websockets) {
        try {
          ws.send(JSON.stringify({ type: "WAKE_UP" }));
        } catch {
          // Ignored
        }
      }
      return new Response("Woke up " + websockets.length + " agents", {
        status: 200,
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
