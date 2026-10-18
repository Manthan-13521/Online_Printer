export interface WhatsAppFloatingButtonProps {
  phone: string;
  shopName?: string;
  customMessage?: string;
}

export function formatWhatsAppUrl(
  phone: string,
  shopName?: string,
  customMessage?: string,
): string {
  const digits = phone.replace(/[^0-9]/g, "");
  // Standard Indian 10-digit mobile number prefix with 91 if no country code
  const fullNumber = digits.length === 10 ? `91${digits}` : digits;
  const greeting = shopName ? `Hello ${shopName}` : "Hello";
  const defaultMsg = `${greeting}, I wanted to print some documents, but online printing is currently unavailable. Could you please assist?`;
  const text = customMessage || defaultMsg;
  return `https://wa.me/${fullNumber}?text=${encodeURIComponent(text)}`;
}

export function WhatsAppFloatingButton({
  phone,
  shopName,
  customMessage,
}: WhatsAppFloatingButtonProps) {
  if (!phone || !phone.trim()) return null;

  const url = formatWhatsAppUrl(phone, shopName, customMessage);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="pg-whatsapp-floating-btn"
      aria-label="Chat on WhatsApp"
      title="Chat on WhatsApp"
    >
      <svg
        className="pg-whatsapp-icon"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0 0 12.04 2m.01 1.67c2.2 0 4.26.86 5.82 2.41a8.163 8.163 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.17 8.17 0 0 1-1.25-4.36c0-4.54 3.7-8.24 8.24-8.24m4.52 11.66c-.25.7-.72 1.3-1.34 1.68-.48.29-1.07.45-1.68.45-.63 0-1.47-.18-2.6-.66-1.55-.65-2.76-1.63-3.83-3.11-.74-1.02-1.3-2.19-1.3-3.32 0-1.2.49-2.28 1.35-2.88.22-.16.48-.25.75-.25.19 0 .38.04.56.12.23.1.48.58.64.96.17.41.36.88.39.95.04.09.07.19.07.29 0 .15-.09.32-.24.51-.12.15-.25.32-.36.44-.12.13-.23.25-.11.47.3.56.76 1.15 1.32 1.69.7.67 1.49 1.14 2.15 1.44.2.09.38.08.5-.06.15-.17.38-.49.53-.7.13-.18.29-.22.46-.15.17.07 1.13.53 1.32.63.2.09.33.15.38.24.06.1.06.59-.19 1.29z" />
      </svg>
      <span>Chat on WhatsApp</span>
    </a>
  );
}
