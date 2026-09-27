export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const targetUrl = new URL(
        url.pathname + url.search,
        "https://printgo-api.printgo-worker.workers.dev",
      );
      const headers = new Headers(request.headers);
      headers.set("Origin", "https://printgo-admin.pages.dev");
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
      });
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }
    return response;
  },
};
