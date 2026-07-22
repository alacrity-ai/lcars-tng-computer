# SOP — TV-room kiosk (the wall on the LAN)

The living-room PC (TV as monitor) runs the LCARS wall in Chrome; all compute
(Claude session, API server, TTS) stays on the office box. Only port **5173**
is exposed — the wall talks same-origin through the vite proxy, so the control
API (:3789) and TTS sidecar (:3790) stay loopback-only on purpose (they are
unauthenticated).

## One-time setup (office box, Windows side)

The stack runs inside WSL2, which is NAT'd — LAN machines can't reach it until
Windows forwards the port. In an **elevated** PowerShell on the office PC:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1
```

It adds a portproxy (`0.0.0.0:5173 → 127.0.0.1:5173`, riding WSL2's localhost
forwarding so it survives WSL restarts and IP changes), opens the firewall
(Private profile), and prints the URL(s) to use on the TV. Undo with `-Remove`.

> **Alternative:** WSL2 *mirrored networking* (`.wslconfig` →
> `networkingMode=mirrored`, Win11 22H2+) makes WSL share the host's LAN
> interfaces and needs no portproxy — but it changes networking for every WSL
> distro on the box. The portproxy is the surgical option; don't mix both.

Worth doing while you're there: give the office PC a **DHCP reservation** in
the router so the TV bookmark never goes stale.

## Bring-up (every time — usually already true)

1. Office box: `make dev` (vite now binds `0.0.0.0`; check with `make lan`).
2. TV PC: Chrome → `http://<office-windows-ip>:5173` (bookmark it) → **F11**.
3. Tap/click the **ENGAGE** overlay once — that single gesture is what Chrome
   needs to allow TTS audio and chimes for the rest of the session. It
   reappears after any refresh; one tap each time. (The office `make kiosk`
   Chromium launches with the autoplay flag, so it never shows the overlay.)

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page won't load from the TV | `make lan` on the office box: is vite on `0.0.0.0:5173`? Did `expose-lan.ps1` run as admin? Is the Windows network profile **Private** (the firewall rule is Private-only)? |
| Loaded fine yesterday, dead today | Office PC's LAN IP changed — re-run `expose-lan.ps1` to print the current IP, update the bookmark, add a DHCP reservation. |
| Wall renders, no sound | The ENGAGE tap was missed or a refresh happened — tap the screen once. A persistent "Audio muted by browser" badge means the same thing. |
| Wall says "Link offline" | The wall lost its WS to the vite proxy — server or vite died on the office box; `make health` there. |
| Two walls talking at once | The hub broadcasts to every connected display, so an open office tab + the TV both speak. Close the office kiosk/tab when the TV room is the wall. |
| Hostname (not IP) refused by vite | Vite whitelists hostnames: start with `TNG_ALLOWED_HOSTS=office-pc.local make dev`. IPs need nothing. |
