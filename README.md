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
mkdir -p /www/mobile-data-dashboard
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

Run each step in order from your local machine (where you have the repo checked out):

**1. Install dependencies (first time, or after `package.json` changes)**

```bash
npm install
```

**2. Build the frontend**

```bash
npm run build
```

This produces a `dist/` folder in the project root.

**3. Copy files to the router**

```bash
rsync -az --delete dist/ root@192.168.8.1:/www/mobile-data-dashboard/dist/
rsync -az server.js package.json package-lock.json root@192.168.8.1:/www/mobile-data-dashboard/
```

**4. Install production Node dependencies on the router**

```bash
ssh root@192.168.8.1 "cd /www/mobile-data-dashboard && npm ci --omit=dev"
```

**5. Start (or restart) the server on the router**

```bash
ssh root@192.168.8.1 "pkill -f 'node server.js'; cd /www/mobile-data-dashboard && nohup node server.js > /var/log/cellular-dashboard.log 2>&1 &"
```

The dashboard will be available at `http://192.168.8.1:3001`.

### Auto-start on boot (procd init script)

Create `/etc/init.d/cellular-dashboard` on the router:

```sh
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=99
STOP=1

start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/node /www/mobile-data-dashboard/server.js
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}
```

Then enable and start it:

```bash
chmod +x /etc/init.d/cellular-dashboard
/etc/init.d/cellular-dashboard enable
/etc/init.d/cellular-dashboard start
```

## API endpoints

| Endpoint | Source | Returns |
|---|---|---|
| `GET /api/router/usage` | `vnstat --json -i wwan0` | `{ totalGb, iface, updatedAt }` |
| `GET /api/router/devices` | `/tmp/dhcp.leases` + `ip neigh` | `{ devices: [...], updatedAt }` |

Without the backend: the UI loads, purchases/history persist in localStorage,
but live router usage and device auto-detect will not work.
