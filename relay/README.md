# TabHelm relay

A ~150-line WebSocket relay that lets the TabHelm panel in **your** Chrome drive a TabHelm host (and its CLI agents) running **somewhere else** — a VPS, a dev box behind NAT, a container. Both sides connect *out* to the relay, so no inbound ports or SSH are needed on either machine. The relay forwards JSON messages and stores nothing.

## Deploy on Dokploy (or any Docker host)

1. **Create → Application → Git provider** (this repository, build path `relay`, Dockerfile build) or **Docker Compose** with:
   ```yaml
   services:
     relay:
       build: ./relay
       environment:
         RELAY_KEY: ${RELAY_KEY}
       expose: ["8080"]
       restart: unless-stopped
   ```
2. **Environment:** `RELAY_KEY=<a long random string>` — e.g. `openssl rand -base64 24`. Only hosts that know the key can register.
3. **Domain:** add `relay.yourdomain.com` → container port `8080`, HTTPS on (Dokploy's Traefik issues the certificate). The health check is `GET /`.

Check: `curl https://relay.yourdomain.com/` → `TabHelm relay: 0 host(s)`.

## Run a TabHelm host that uses the relay

On the machine where the agents live (Node 20+, TabHelm host installed with `install.sh`/`install.ps1` — registering it with a local Chrome is not needed):

```bash
cd ~/.tabhelm/app/host
npm run relay -- wss://relay.yourdomain.com --key <RELAY_KEY> --name my-vps
```

The host prints a pairing code such as `K7PM-3QWX` (also written to `~/.tabhelm/host.log`). It is valid for 10 minutes and single use. After pairing the host stores its session token in `~/.tabhelm/relay.json` and reconnects on its own; the code is not needed again. Keep the process running (`systemd`, `tmux`, or a Dokploy "Application" built from the `host/Dockerfile.agent` image if you want the agents on the VPS itself).

## Pair the extension

TabHelm panel → **Settings → Remote host**: relay URL (`wss://relay.yourdomain.com`), the code → **Connect**. From then on the panel talks to the remote host; its agents appear in the agent list. **Use local host** switches back; **Forget** drops the pairing.

## What the relay sees

Everything the panel and the host exchange: page snapshots, screenshots, tool results, your messages — in clear text inside TLS. It is your server; still, keep `RELAY_KEY` secret, do not share the relay with people you do not trust, and rotate the key if a code leaks (restart the host to get a new code).

## Protocol (for the curious)

- `wss://relay/host?key=RELAY_KEY[&token=…&name=…]` — a host registers. Reply `{type:"relay", role:"host", token, code}`. Control events: `client_connected`, `client_disconnected`.
- `wss://relay/client?code=XXXX-XXXX` or `?token=…` — the extension pairs or reconnects. Reply `{type:"relay", role:"client", token, hostOnline}`. Events: `host_connected`, `host_disconnected`.
- Every other text frame is forwarded verbatim to the other side. Max frame 2 MB; dead sockets are pinged every 30 s; 10 bad codes/keys per minute per IP.
