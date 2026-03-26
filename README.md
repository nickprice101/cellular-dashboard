# Cellular Dashboard

Cellular data usage tracker for my Slate 7 mobile router.

## Development

```bash
npm install
npm run dev        # Vite dev server (proxies /api → localhost:3001)
node server.js     # Backend API server (in a separate terminal)
```

## Production (Slate 7 router)

### One-time router setup

```bash
opkg update && opkg install node node-npm
mkdir -p /opt/cellular-dashboard
```

### Deploy

Push to `main` – GitHub Actions builds the app and deploys it to the router via SSH.

**Required secrets** (Settings → Secrets → Actions):

| Secret | Description |
|---|---|
| `ROUTER_HOST` | IP or hostname of the router (e.g. `192.168.8.1`) |
| `ROUTER_USER` | SSH user (default: `root`) |
| `ROUTER_SSH_KEY` | Private key (PEM) for passwordless SSH access |

### Manual deploy

```bash
npm run build
rsync -az dist/ server.js package.json package-lock.json root@192.168.8.1:/opt/cellular-dashboard/
ssh root@192.168.8.1 "cd /opt/cellular-dashboard && npm ci --omit=dev && node server.js &"
```

## API endpoints

| Endpoint | Source | Returns |
|---|---|---|
| `GET /api/router/usage` | `vnstat --json -i wwan0` | `{ totalGb, iface, updatedAt }` |
| `GET /api/router/devices` | `/tmp/dhcp.leases` + `ip neigh` | `{ devices: [...], updatedAt }` |

Without the backend: the UI loads, purchases/history persist in localStorage,
but live router usage and device auto-detect will not work.
