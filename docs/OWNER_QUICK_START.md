# PrintGo owner quick start

This guide describes the candidate workflow. Your technician must finish Windows and printer acceptance before live shop use.

1. Open the **shop Admin bookmark supplied by your technician**. Each shop has its own deployment; there is no universal PrintGo Admin address.
2. Install the approved **PrintGo-Setup.exe** on the PC connected to your printer, under the Windows account that will operate the shop. Your technician supplies the reviewed installer; no Node installation or terminal is needed.
3. In Admin → Printer, create a pairing code and choose **Connect This PC Automatically**. If the browser cannot open it, use **Copy Connection Link** and paste it into Control Center → Pair / Re-pair PC. Do not share that link.
4. Select and enable your physical production printer in Admin. Check paper, power and printer readiness. Explicitly request one diagnostic page and confirm exactly one sheet emerges.
5. Set shop name/logo and identification-sheet preferences in Shop Settings. FIRST/LAST affects where the ID sheet belongs; confirm actual tray ordering with the technician.
6. Open online orders only after the technician confirms readiness. Use Admin Live Orders to track work and match the customer job code at pickup. A completed software state does not replace checking physical output.

For paper jams or offline printers, inspect the printer and follow the existing Admin recovery instructions. Do not send a second print just because the first is slow. Do not clear the queue or restart the PC while a job is uncertain. Contact your technician with the job code.

Control Center → **Start PrintGo** starts an absent Agent. It defers if the Agent runs or a print remains unresolved. Restart, re-pair and upgrades require technician maintenance; they must not interrupt a submitted print. Closing Control Center does not stop the Agent.

For support, use **Create Support Package** and confirm it succeeds. The candidate ZIP exports anonymous system/printer status and approved timing records; other log text is omitted. Send it only to your agreed technician after review. Do not send PDFs, credential files, pairing links or screenshots showing customer details. No built-in support email address is assumed.
