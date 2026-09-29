# PrintGo V2 — New Shop Installation & Onboarding Guide

This guide is for the **PrintGo Developer / System Integrator** onboarding a new physical print shop.

---

## 1. Prerequisites

Before starting, ensure you have:

1. **Shop Cloudflare Account**: Access credentials or API token for the shop's Cloudflare account.
2. **Shop Razorpay Account**: Live Key ID and Key Secret from the shop's Razorpay dashboard.
3. **Shop Details**: Shop name, contact phone, shop counter PC details, physical printer model.

---

## 2. Onboarding Workflow (Step-by-Step)

### Step 1: Authenticate with Shop Cloudflare Account

Log in to the shop's Cloudflare account on your deployment terminal:

```bash
npx wrangler login
```

Verify authentication:

```bash
npx wrangler whoami
```

### Step 2: Run Automated Shop Provisioning

Execute the automated provisioning wizard:

```bash
pnpm shop:provision
```

The wizard will guide you through:

- Entering Shop Name and Contact Phone.
- Creating the shop's isolated **Cloudflare D1** database (`printgo-production`).
- Applying all SQL schema migrations (`0001` through `0007`).
- Provisioning the private **Cloudflare R2** uploads bucket (`printgo-uploads-production`).
- Binding secure **Razorpay** API secrets (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
- Deploying the Cloudflare Worker API.
- Bootstrapping the shop owner's initial Admin account.
- Compiling and publishing the Customer and Admin PWAs to Cloudflare Pages.

### Step 3: Package the Windows Installer

Build the professional standalone installer:

```bash
pnpm build:agent:windows
pnpm package:installer
```

This generates:

- `installer/dist/PrintGo-Setup.exe`
- `installer/dist/latest.json`

### Step 4: Install on Shop Counter PC

1. Copy or download `PrintGo-Setup.exe` onto the shop owner's Windows counter PC.
2. Double-click `PrintGo-Setup.exe`.
3. Follow the standard Windows setup wizard (defaults to `C:\Program Files\PrintGo`).
4. Keep the checkbox checked: _"Start PrintGo automatically when Windows starts"_.
5. Complete installation. The **PrintGo Control Center** opens automatically in the system tray.

### Step 5: Connect and Pair the PC

1. Log in to the shop's **Admin Portal** ([https://printgo-admin.pages.dev](https://printgo-admin.pages.dev)).
2. Navigate to **Printer** $\rightarrow$ Click **"Generate Pairing Code"**.
3. Click the single-click button: **`⚡ Connect This PC Automatically`**.
   - Windows will prompt to open the `printgo://` protocol.
   - The PrintGo Control Center pairs the computer automatically within 2 seconds.
     _(Manual fallback: Copy the 8-character code `XXXX-XXXX` and click "Pair / Re-pair PC" in the Control Center)._

### Step 6: Select Production Printer & Test Print

1. In Admin Portal $\rightarrow$ **Printer**, verify the shop's physical printer (e.g. _HP Laser MFP 131/133/135-138_) appears as `ONLINE`.
2. Click **"Set as Default Production Printer"**.
3. Click **"Test Print"**.
4. Physically confirm exactly 1 diagnostic test sheet prints from the paper tray.

### Step 7: Configure Pricing & Enable Online Printing

1. Navigate to **Pricing** $\rightarrow$ Set the shop's per-page rates and file-size surcharges.
2. Navigate to **Shop Settings** $\rightarrow$ Toggle **"Online Customer Orders: ON"**.

### Step 8: Verification Order

1. Open the Customer PWA on a mobile device or browser.
2. Upload a 1-page test PDF.
3. Complete a minimum-cost live payment (₹3.00).
4. Verify the order prints physically and live tracking updates to `COMPLETED`.

### Step 9: Hand Over to Shop Owner

Provide the shop owner with:

- Admin Portal URL and their initial login credentials.
- The 1-page **Owner Quick Start Guide** (`docs/OWNER_QUICK_START.md`).
