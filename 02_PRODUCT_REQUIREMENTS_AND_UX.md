# PrintGo V2 — Product Requirements and UX

**Status:** Finalized initial product scope  
**Primary UX rule:** A first-time customer and a non-technical shop owner should understand the system without training.

---

# 1. UX principles

PrintGo should feel like a print-shop product, not an engineering dashboard.

Use:

- simple language
- large obvious buttons
- clear status indicators
- minimal required fields
- sensible defaults
- immediate validation
- clear next action
- mobile-first customer interface
- responsive admin interface
- no technical jargon in customer-facing errors

Avoid:

- raw database IDs
- Cloudflare/R2/D1 terminology in the UI
- unexplained error codes
- long setup forms for customers
- hidden pricing
- too many screens
- unnecessary account registration
- confusing printer terminology

---

# 2. Customer flow

Target flow:

```text
Open PrintGo
   |
   v
Enter name + phone
   |
   v
Select PDF
   |
   v
Choose print settings
   |
   v
Review price
   |
   v
Pay
   |
   v
Receive job code
   |
   v
Track status
   |
   v
Collect print
```

A customer should normally complete the flow in a few simple screens.

---

# 3. Customer landing screen

Show:

- shop name/logo
- clear heading: "Upload your PDF to print"
- service availability
- simple privacy/retention note
- "Start Printing" or direct upload action

When online printing is OFF:

```text
Online printing is temporarily unavailable.
Please contact the shop or try again later.
```

No upload button.
No payment option.

---

# 4. Customer identity

Required:

- name
- phone number

Optional:

- print instructions/description

Do not require:

- email
- password
- customer account registration

Phone validation should be friendly and suited to the shop's configured market.

---

# 5. PDF upload

Initial product accepts PDF only.

Show:

- selected filename
- file size
- configured maximum size
- remove/change file action

If file is too large:

```text
This PDF is too large.

Maximum allowed size: 25 MB

Please compress the PDF and try again.

[Compress PDF with iLovePDF]
```

Also show:

> iLovePDF is an external website. Your document will be processed outside this print shop's system.

Never automatically send the file to an external compression provider.

---

# 6. Print settings

The settings UI should be visual and easy.

Recommended fields:

## Pages

- All pages
- Custom pages/range

Examples:

- `1-5`
- `1,3,7-10`

Validate before payment.

## Copies

Use:

- minus button
- number
- plus button

## Colour

- Black & White
- Colour

Only show options supported/enabled by the configured printer/shop.

## Paper size

Examples:

- A4
- A3

Only show configured sizes.

## Sides

- Single-sided
- Double-sided

If duplex is unavailable, do not show it as a selectable option.

## Instructions

Optional short text.

Example:

- "Staple after printing"
- "Please keep pages in order"

Use a reasonable character limit.

---

# 7. Price display

Price should update after valid settings are selected.

Show a simple breakdown, for example:

```text
Printing                 Rs. 30
File service charge      Rs.  5
--------------------------------
Total                    Rs. 35
```

Avoid forcing the customer to understand the internal pricing formula.

Before payment, show a final review card:

- job summary
- pages
- copies
- colour/B&W
- paper size
- sides
- total
- customer name
- phone

Then:

```text
[Pay Rs. 35]
```

---

# 8. File-size service charge

Admin-configurable bands:

```text
<= 2 MB
> 2 MB to 5 MB
> 5 MB to 10 MB
> 10 MB to 25 MB
```

Each band has a configurable rupee amount.

The shop can configure a lower maximum than 25 MB.

Example admin UI:

```text
PDF Size Charges

Up to 2 MB          Rs. 2
2–5 MB              Rs. 4
5–10 MB             Rs. 6
10–25 MB            Rs. 10

Maximum PDF size    25 MB

[Save Changes]
```

The UI should make clear that a tier above the configured maximum will not be used.

---

# 9. Payment experience

Before payment creation, re-check:

- online printing enabled
- agent heartbeat valid
- printer available enough to accept new work
- order still valid
- PDF still present
- calculated amount

After payment:

Show a success screen with a large job code.

Example:

```text
Payment successful

Your print job code

PG-8F42K7

Keep this code until you collect your print.

Status: Waiting to print

[Track Job]
```

Do not show "paid" until the backend has verified the payment.

---

# 10. Customer tracking portal

No login required.

The private tracking URL/token authorizes access.

Show:

- job code
- customer first name or configured display name
- payment status
- print status
- submitted time
- print summary
- shop message/contact info if configured

Friendly statuses:

```text
Payment received
Waiting for printer
Printing
Printing paused — printer needs attention
Printed
Completed
```

Avoid showing internal states such as `CLAIMED` unless useful.

If a technical failure occurs, customer-facing wording should be calm:

```text
The printer needs attention.
The shop has been notified.
```

Admin can see the technical reason.

---

# 11. Job Identification Sheet

Enabled by default unless the shop disables it.

Purpose:

- makes finished stacks easy to identify
- reduces mix-ups at the counter

Print exactly one sheet per order.

Recommended content:

- large job code
- customer name
- masked phone
- pages/copies summary
- colour/B&W
- paper size
- single/double-sided
- amount paid
- short instruction
- submission time

Do not print a full phone number by default.

Admin setting:

```text
Identification sheet: ON/OFF
Placement: FIRST/LAST
```

Placement is selected during setup based on how the shop's printer stacks finished pages.

The identification sheet is a shop operational sheet and is not separately charged to the customer unless future pricing policy explicitly changes.

---

# 12. Admin portal structure

Keep the navigation short and understandable.

Recommended initial sections:

1. Dashboard
2. Live Orders
3. Order History
4. Failed Jobs
5. Printer
6. Pricing
7. Reports
8. Shop Settings
9. Security

Do not create an Owner/Staff section in V1.

Do not create a QR-code page.

---

# 13. Admin dashboard

The admin home page should answer these questions immediately:

- Is online printing ON?
- Is the Agent online?
- Is the printer okay?
- Are jobs waiting?
- Did any jobs fail?
- How much revenue today?
- What are the latest orders?

Example:

```text
PrintGo

Online Printing        ON
Printer                Online
Agent                  Connected

Today
Orders                 37
Waiting                 3
Printing                1
Completed              31
Needs Attention         2
Revenue              Rs. 1,482

Recent Orders
PG-1827  Rahul   Rs. 20   Completed
PG-1828  Priya   Rs. 46   Printing
PG-1829  Arjun   Rs. 12   Waiting
```

Use clear status badges.

---

# 14. Online Printing control

Prominent admin control:

```text
Accept Online Printing

[ ON ]
```

Turning OFF should require a small confirmation:

```text
Pause new online print orders?

Existing paid jobs will continue.
Customers will not be able to upload or pay.

[Cancel] [Pause Printing]
```

Turning ON can be immediate if printer/agent checks pass.

If the printer/agent is not ready, explain what must be fixed.

---

# 15. Live Orders

Show active jobs first.

Useful columns/cards:

- job code
- customer name
- masked/full admin phone display depending policy
- amount
- print settings summary
- status
- created time
- printer
- action if required

Mobile admin layout should use cards rather than a wide table when needed.

---

# 16. Order details

Before PDF deletion, admin can see:

- job code
- customer name
- phone
- original filename
- file size
- payment status
- Razorpay reference
- amount
- print settings
- instructions
- timeline/events
- PDF available status
- retry/manual-print options when relevant

After the PDF retention period:

```text
File deleted automatically
```

Do not show a broken download button.

Keep commercial/order history.

---

# 17. Failed Jobs

This page must be operational, not just informational.

Example:

```text
PG-48391
Rahul
Rs. 42

Needs attention

Reason:
Paper out

Printer:
Canon G3010
```

Depending on failure type, actions may include:

- Retry
- Download PDF
- Print Manually

For paper jam/no-paper/offline where the original spool job still exists, do not create a duplicate print job.

The admin message should say something like:

```text
The current Windows print job is paused.
Fix the printer problem first.
PrintGo will continue monitoring it.
```

For a confirmed failed job:

```text
Automatic retry failed.

[Retry Again]
[Download PDF]
[Print Manually]
```

---

# 18. Printer page

Show:

- configured printer
- Agent connection
- latest heartbeat
- printer availability
- reported problem
- supported/configured capabilities
- identification-sheet settings

Example:

```text
Printer
Canon G3010

Status: Online
Agent: Connected
Last update: 8 seconds ago

Colour: Yes
Duplex: No
Paper: A4

Identification Sheet: ON
Placement: Last Page
```

Do not promise detailed ink/toner information if the Windows driver does not expose it reliably.

---

# 19. Pricing page

Admin should be able to change pricing without developer help.

Possible controls:

- A4 B&W
- A4 Colour
- A3 B&W
- A3 Colour
- single/double-sided pricing behavior
- copies behavior
- minimum order, if enabled
- file-size service charges
- maximum PDF size

Use clear forms with examples.

Show a "Preview Calculation" feature if easy to implement:

```text
Example order:
10 A4 B&W pages
2 copies
4 MB PDF

Estimated total: Rs. XX
```

This is a UX helper only; backend pricing remains authoritative.

---

# 20. Reports

Initial reports can stay simple:

- today's orders
- today's revenue
- date-range orders
- date-range revenue
- completed
- failed/attention
- B&W vs colour counts
- page/copy totals where tracked

Avoid building an accounting system in V1.

---

# 21. Shop Settings

Include:

- shop name
- logo
- contact phone
- address
- customer-facing notice
- collection instructions
- maximum PDF size
- optional terms/privacy text
- PWA/site identity where practical

---

# 22. Security page

Initial version:

- change admin password
- log out
- log out all sessions if supported
- view Agent pairing/status
- regenerate/re-pair Agent through a controlled flow

No role management in V1.

---

# 23. PDF retention UX

Rules:

```text
Unpaid upload:
10 minutes

Payment failed/cancelled:
30 minutes

Completed:
12 hours after completion

Paid unresolved failure:
maximum 24 hours
```

Before deletion, admin sees file availability.

After deletion:

- PDF unavailable
- order metadata remains
- deletion is clear in timeline/status

Customer-facing UI does not need to expose all internal cleanup timestamps unless useful.

---

# 24. Friendly error-writing rules

Prefer:

```text
Your PDF is larger than this shop allows.
Please compress it and try again.
```

Not:

```text
HTTP 413 PAYLOAD_TOO_LARGE
```

Prefer:

```text
The printer is temporarily unavailable.
Please try again shortly.
```

Not:

```text
AGENT_HEARTBEAT_EXPIRED
```

Prefer:

```text
We could not confirm the payment yet.
Please do not pay again. Checking payment status...
```

Not:

```text
Webhook pending
```

Admin can receive technical details separately.

---

# 25. Accessibility/usability basics

Use:

- readable font sizes
- strong contrast
- large tap targets
- labels in addition to icons
- disabled-state explanations
- loading indicators
- prevention of duplicate Pay clicks
- prevention of duplicate Retry clicks
- clear confirmation for destructive actions
- responsive design
- keyboard-friendly admin controls where practical

---

# 26. Initial scope exclusions

Do not add in V1:

- Owner/Staff roles
- QR-code page
- customer accounts
- native mobile apps
- loyalty/coupons
- delivery
- WhatsApp bot
- multi-shop control center
- inventory/accounting suite
- document conversion/editing

The V1 experience must remain focused on reliable online printing.
