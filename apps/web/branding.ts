/** Keep install identity/scope stable while applying this deployment's shop name. */
export function applyShopBranding(shopName: string, admin = false): () => void {
  const title = admin ? `${shopName} — Admin` : shopName;
  document.title = title;
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link || typeof URL.createObjectURL !== "function")
    return () => undefined;
  const previous = link.href;
  const origin = window.location.origin;
  const startUrl = admin ? `${origin}/admin` : `${origin}/`;
  const blob = new Blob(
    [
      JSON.stringify({
        id: startUrl,
        name: title,
        short_name: shopName.slice(0, 24),
        start_url: startUrl,
        scope: `${origin}/`,
        display: "standalone",
        background_color: "#0f172a",
        theme_color: admin ? "#172554" : "#164e63",
        icons: [192, 512].map((size) => ({
          src: `${origin}/icon-${size}.png`,
          sizes: `${size}x${size}`,
          type: "image/png",
        })),
      }),
    ],
    { type: "application/manifest+json" },
  );
  const url = URL.createObjectURL(blob);
  link.href = url;
  return () => {
    link.href = previous;
    URL.revokeObjectURL(url);
  };
}
