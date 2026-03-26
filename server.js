/**
 * Cellular Dashboard – Router API Server
 *
 * Serves the built React app and exposes two API endpoints:
 *
 *   GET /api/router/usage   – total bytes transferred on the WAN interface
 *                             via `vnstat --json -i <iface>`
 *
 *   GET /api/router/devices – connected LAN clients via
 *                             /tmp/dhcp.leases + `ip neigh`
 *
 * Start with:  node server.js
 * Default port: 3001  (override with PORT env var)
 */

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { rateLimit } from "express-rate-limit";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3001;

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Limits each IP to 120 requests per minute to prevent abuse.
const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ── Static files (production build) ─────────────────────────────────────────
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run vnstat --json -i <iface> and return cumulative total in GB.
 * Adds rx + tx from the "total" traffic field.
 */
async function getVnstatTotalGb(iface = "wwan0") {
  const { stdout } = await execFileAsync("vnstat", ["--json", "-i", iface], {
    timeout: 10_000,
  });
  const data = JSON.parse(stdout);

  // vnstat ≥2.x structure: data.interfaces[0].traffic.total.{rx,tx}  (bytes)
  const ifaces = data.interfaces || [];
  const entry = ifaces.find((i) => i.name === iface) || ifaces[0];
  if (!entry) throw new Error(`Interface ${iface} not found in vnstat output`);

  const total = entry.traffic?.total ?? {};
  const rxBytes = Number(total.rx ?? 0);
  const txBytes = Number(total.tx ?? 0);
  const totalGb = (rxBytes + txBytes) / 1_073_741_824; // bytes → GB
  return Number(totalGb.toFixed(6));
}

/**
 * Parse /tmp/dhcp.leases into an array of device objects.
 * Each line: <expiry-epoch> <mac> <ip> <hostname> <client-id>
 */
async function parseDhcpLeases(leasesPath = "/tmp/dhcp.leases") {
  let text;
  try {
    text = await readFile(leasesPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 4) return null;
      const [expiry, mac, ip, hostname] = parts;
      return {
        mac: mac.toUpperCase(),
        ip,
        hostname: hostname && hostname !== "*" ? hostname : "",
        lastSeen: expiry ? new Date(Number(expiry) * 1000).toISOString() : new Date().toISOString(),
        source: "dhcp",
      };
    })
    .filter(Boolean);
}

/**
 * Run `ip neigh` and return a map of ip → { mac, state }.
 */
async function getIpNeighMap() {
  try {
    const { stdout } = await execFileAsync("ip", ["neigh"], { timeout: 5_000 });
    const map = new Map();
    stdout.split(/\r?\n/).forEach((line) => {
      // e.g. "192.168.1.5 dev br-lan lladdr aa:bb:cc:dd:ee:ff REACHABLE"
      const m = line.match(/^(\S+)\s+.*lladdr\s+([0-9a-f:]+)\s+(\S+)/i);
      if (m) {
        map.set(m[1], { mac: m[2].toUpperCase(), state: m[3] });
      }
    });
    return map;
  } catch {
    return new Map();
  }
}

// ── API: usage ───────────────────────────────────────────────────────────────

app.get("/api/router/usage", async (req, res) => {
  const iface = String(req.query.iface || "wwan0").replace(/[^a-zA-Z0-9_.-]/g, "");
  try {
    const totalGb = await getVnstatTotalGb(iface);
    res.json({ totalGb, iface, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[usage]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── API: devices ─────────────────────────────────────────────────────────────

app.get("/api/router/devices", async (req, res) => {
  try {
    const [leaseDevices, neighMap] = await Promise.all([parseDhcpLeases(), getIpNeighMap()]);

    // Merge: prefer DHCP data; enrich with ip neigh state
    const byMac = new Map();
    leaseDevices.forEach((d) => byMac.set(d.mac, { ...d }));

    // Add any neighbours not already in leases
    neighMap.forEach(({ mac, state }, ip) => {
      if (!byMac.has(mac)) {
        byMac.set(mac, { mac, ip, hostname: "", lastSeen: new Date().toISOString(), source: "neigh" });
      } else {
        const existing = byMac.get(mac);
        byMac.set(mac, { ...existing, ip: existing.ip || ip, neighState: state });
      }
    });

    const devices = Array.from(byMac.values());
    res.json({ devices, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[devices]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Cellular Dashboard server running on http://localhost:${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  GET /api/router/usage    – vnstat total usage`);
  console.log(`  GET /api/router/devices  – DHCP leases + ip neigh`);
});
