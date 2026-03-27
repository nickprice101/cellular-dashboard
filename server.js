/**
 * Cellular Dashboard – Router API Server
 *
 * Serves the built React app and exposes two API endpoints:
 *
 *   GET /api/router/usage   – total bytes transferred on the WAN interface
 *                             via `vnstat --json -i <iface>`
 *
 *   GET /api/router/devices – connected LAN clients via
 *                             /tmp/dhcp.leases + `ip neigh` + `iw dev station dump`
 *                             + OUI vendor lookup
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
 * Look up the vendor name from a MAC address using a local OUI map.
 * The OUI is the first three octets of the MAC (e.g. "AA:BB:CC").
 */
function guessVendorFromMac(mac) {
  const oui = String(mac || "").toUpperCase().slice(0, 8);
  const OUI_MAP = {
    "00:00:0C": "Cisco",
    "00:01:42": "Cisco",
    "00:05:69": "VMware",
    "00:0C:29": "VMware",
    "00:0E:58": "Sonos",
    "00:11:32": "Synology",
    "00:17:88": "Philips Hue",
    "00:1A:11": "Google",
    "00:1D:AA": "Sony",
    "00:1E:58": "D-Link",
    "00:21:70": "Raspberry Pi",
    "00:22:6B": "Belkin",
    "00:25:00": "Apple",
    "00:26:BB": "Apple",
    "00:50:F2": "Microsoft",
    "00:9A:CD": "Huawei",
    "00:E0:4C": "Realtek",
    "04:8C:16": "Apple",
    "04:D3:B0": "Apple",
    "08:00:27": "VirtualBox",
    "0C:4D:E9": "Intel",
    "10:02:B5": "Apple",
    "10:9A:DD": "Apple",
    "14:10:9F": "Samsung",
    "18:3D:A2": "Apple",
    "18:65:90": "Apple",
    "1C:1B:B5": "Apple",
    "1C:57:DC": "Apple",
    "20:AB:37": "Apple",
    "24:5B:A7": "Apple",
    "28:6A:BA": "Apple",
    "28:CF:E9": "Apple",
    "2C:AB:33": "Apple",
    "30:9C:23": "Apple",
    "3C:15:C2": "Apple",
    "3C:52:82": "Samsung",
    "3C:D0:F8": "Apple",
    "40:30:04": "Apple",
    "40:98:AD": "Apple",
    "48:43:7C": "Apple",
    "4C:57:CA": "Apple",
    "50:DE:06": "Apple",
    "54:4E:90": "Apple",
    "54:60:09": "Apple",
    "54:AE:27": "Apple",
    "58:55:CA": "Apple",
    "5C:CF:7F": "Espressif",
    "60:03:08": "Apple",
    "60:33:4B": "Apple",
    "60:F8:1D": "Apple",
    "64:9A:BE": "Apple",
    "68:96:7B": "Apple",
    "70:56:81": "Apple",
    "74:8F:3C": "Apple",
    "74:E5:43": "Apple",
    "78:31:C1": "Apple",
    "78:4F:43": "Apple",
    "7C:6D:62": "Apple",
    "80:BE:05": "Apple",
    "84:8E:96": "Samsung",
    "88:C9:D0": "Apple",
    "8C:85:90": "Apple",
    "90:84:0D": "Apple",
    "94:E9:79": "Apple",
    "98:5A:EB": "Apple",
    "9C:20:7B": "Apple",
    "A0:99:9B": "Apple",
    "A4:5E:60": "Apple",
    "A8:51:AB": "Apple",
    "AC:61:EA": "Apple",
    "AC:87:A3": "Apple",
    "B0:6E:BF": "Apple",
    "B4:8B:19": "Apple",
    "B8:27:EB": "Raspberry Pi",
    "B8:E8:56": "Apple",
    "BC:3A:EA": "Apple",
    "C0:9F:42": "Apple",
    "C4:2C:03": "Apple",
    "C4:61:8B": "Apple",
    "C8:69:CD": "Apple",
    "CC:29:F5": "Apple",
    "D0:03:4B": "Apple",
    "D0:81:7A": "Apple",
    "D4:61:9D": "Apple",
    "D8:6C:63": "Apple",
    "DC:2B:2A": "Raspberry Pi",
    "DC:A6:32": "Intel",
    "E0:5F:45": "Apple",
    "E4:25:E7": "Apple",
    "E4:CE:8F": "Apple",
    "E8:8D:28": "Apple",
    "EC:35:86": "Apple",
    "F0:18:98": "Apple",
    "F0:D1:A9": "Apple",
    "F4:0F:24": "Apple",
    "F8:1E:DF": "Apple",
    "F8:27:93": "Apple",
    "FC:01:7C": "Apple",
    "FC:E9:98": "Apple",
    // Samsung
    "00:07:AB": "Samsung",
    "00:12:47": "Samsung",
    "00:15:99": "Samsung",
    "00:16:6B": "Samsung",
    "00:16:6C": "Samsung",
    "00:17:C9": "Samsung",
    "00:17:D5": "Samsung",
    "00:18:AF": "Samsung",
    "00:1A:8A": "Samsung",
    "00:1B:98": "Samsung",
    "00:1C:43": "Samsung",
    "00:1D:25": "Samsung",
    "00:1E:E1": "Samsung",
    "00:1F:CC": "Samsung",
    "00:21:19": "Samsung",
    "00:23:39": "Samsung",
    "00:23:99": "Samsung",
    "00:24:54": "Samsung",
    "00:24:91": "Samsung",
    "00:25:38": "Samsung",
    "00:26:37": "Samsung",
    // Google
    "3C:5A:B4": "Google",
    "A4:77:33": "Google",
    "F4:F5:D8": "Google",
    // Amazon
    "00:FC:8B": "Amazon",
    "10:AE:60": "Amazon",
    "34:D2:70": "Amazon",
    "40:B4:CD": "Amazon",
    "44:65:0D": "Amazon",
    "68:37:E9": "Amazon",
    "74:75:48": "Amazon",
    "84:D6:D0": "Amazon",
    "A0:02:DC": "Amazon",
    "B4:7C:9C": "Amazon",
    "FC:65:DE": "Amazon",
    // TP-Link
    "00:27:19": "TP-Link",
    "14:CC:20": "TP-Link",
    "18:A6:F7": "TP-Link",
    "1C:3B:F3": "TP-Link",
    "28:28:5D": "TP-Link",
    "30:DE:4B": "TP-Link",
    "50:3E:AA": "TP-Link",
    "54:A7:03": "TP-Link",
    "60:32:B1": "TP-Link",
    "64:70:02": "TP-Link",
    "80:EA:96": "TP-Link",
    "8C:21:0A": "TP-Link",
    "90:F6:52": "TP-Link",
    "A0:F3:C1": "TP-Link",
    "B0:4E:26": "TP-Link",
    "C0:06:C3": "TP-Link",
    "D8:07:B6": "TP-Link",
    "E8:94:F6": "TP-Link",
    "F4:EC:38": "TP-Link",
    // Netgear
    "00:09:5B": "Netgear",
    "00:0F:B5": "Netgear",
    "00:14:6C": "Netgear",
    "00:18:4D": "Netgear",
    "00:1B:2F": "Netgear",
    "00:1E:2A": "Netgear",
    "00:1F:33": "Netgear",
    "00:22:3F": "Netgear",
    "00:24:B2": "Netgear",
    "00:26:F2": "Netgear",
    "10:0D:7F": "Netgear",
    "2C:30:33": "Netgear",
    "4C:60:DE": "Netgear",
    "6C:B0:CE": "Netgear",
    "84:1B:5E": "Netgear",
    "A0:40:A0": "Netgear",
    "C0:3F:0E": "Netgear",
    "E0:46:9A": "Netgear",
    // Huawei
    "00:18:82": "Huawei",
    "00:1E:10": "Huawei",
    "00:22:A1": "Huawei",
    "00:25:9E": "Huawei",
    "00:34:FE": "Huawei",
    "04:02:1F": "Huawei",
    "04:BD:88": "Huawei",
    "08:00:87": "Huawei",
    "0C:37:DC": "Huawei",
    "10:1B:54": "Huawei",
    "28:31:52": "Huawei",
    "30:D1:7E": "Huawei",
    "38:F8:89": "Huawei",
    "40:4D:8E": "Huawei",
    "48:00:31": "Huawei",
    "4C:8B:EF": "Huawei",
    "54:51:1B": "Huawei",
    "58:2A:F7": "Huawei",
    "68:A0:F6": "Huawei",
    "70:72:3C": "Huawei",
    "78:1D:BA": "Huawei",
    "80:FB:06": "Huawei",
    "88:E3:AB": "Huawei",
    "90:17:AC": "Huawei",
    "A0:08:6F": "Huawei",
    "AC:E2:15": "Huawei",
    "B8:BC:1B": "Huawei",
    "C4:07:2F": "Huawei",
    "C8:51:95": "Huawei",
    "D4:6E:5C": "Huawei",
    "DC:D2:FC": "Huawei",
    "E8:08:8B": "Huawei",
    "F4:C7:14": "Huawei",
    "FC:48:EF": "Huawei",
    // Xiaomi
    "00:9E:C8": "Xiaomi",
    "0C:1D:AF": "Xiaomi",
    "10:2A:B3": "Xiaomi",
    "14:F6:5A": "Xiaomi",
    "18:59:36": "Xiaomi",
    "20:82:C0": "Xiaomi",
    "28:6C:07": "Xiaomi",
    "34:80:B3": "Xiaomi",
    "38:A4:ED": "Xiaomi",
    "3C:BD:D8": "Xiaomi",
    "40:31:3C": "Xiaomi",
    "58:44:98": "Xiaomi",
    "64:09:80": "Xiaomi",
    "68:DF:DD": "Xiaomi",
    "6C:5C:14": "Xiaomi",
    "74:23:44": "Xiaomi",
    "78:11:DC": "Xiaomi",
    "7C:1D:D9": "Xiaomi",
    "8C:BE:BE": "Xiaomi",
    "98:FA:E3": "Xiaomi",
    "9C:99:A0": "Xiaomi",
    "A0:86:C6": "Xiaomi",
    "AC:C1:EE": "Xiaomi",
    "B0:E2:35": "Xiaomi",
    "C4:0B:CB": "Xiaomi",
    "D4:97:0B": "Xiaomi",
    "E4:46:DA": "Xiaomi",
    "F0:B4:29": "Xiaomi",
    "F4:8B:32": "Xiaomi",
    "F8:A4:5F": "Xiaomi",
    // GL.iNet
    "94:83:C4": "GL.iNet",
    "64:64:4A": "GL.iNet",
    "E4:95:6E": "GL.iNet",
  };
  return OUI_MAP[oui] || "Unknown vendor";
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
      const normalizedMac = mac.toUpperCase();
      return {
        mac: normalizedMac,
        ip,
        hostname: hostname && hostname !== "*" ? hostname : "",
        vendor: guessVendorFromMac(normalizedMac),
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

/**
 * Return a Set of MAC addresses currently associated with any WiFi interface.
 * Uses `iw dev` to discover interfaces then `iw dev <iface> station dump` for each.
 * Falls back to an empty Set when `iw` is unavailable.
 */
async function getWifiStations() {
  const macs = new Set();
  try {
    const { stdout: devOut } = await execFileAsync("iw", ["dev"], { timeout: 5_000 });
    const ifaces = [];
    for (const line of devOut.split(/\r?\n/)) {
      const m = line.match(/^\s+Interface\s+(\S+)/);
      if (m) ifaces.push(m[1]);
    }
    await Promise.all(
      ifaces.map(async (iface) => {
        try {
          const { stdout } = await execFileAsync("iw", ["dev", iface, "station", "dump"], {
            timeout: 5_000,
          });
          for (const line of stdout.split(/\r?\n/)) {
            const m = line.match(/^Station\s+([0-9a-f:]+)\s+/i);
            if (m) macs.add(m[1].toUpperCase());
          }
        } catch {
          // interface may not support station dump – skip
        }
      })
    );
  } catch {
    // iw not available – fall back gracefully
  }
  return macs;
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
    const [leaseDevices, neighMap, wifiStations] = await Promise.all([
      parseDhcpLeases(),
      getIpNeighMap(),
      getWifiStations(),
    ]);

    // Merge: prefer DHCP data; enrich with ip neigh state and vendor lookup
    const byMac = new Map();
    leaseDevices.forEach((d) => byMac.set(d.mac, { ...d, connected: false }));

    // Add any neighbours not already in leases.
    // Only REACHABLE/DELAY/PROBE indicate current activity – STALE means the
    // kernel cache is stale and the device may have disconnected already.
    neighMap.forEach(({ mac, state }, ip) => {
      const neighConnected = /^(REACHABLE|DELAY|PROBE)$/i.test(state);
      if (!byMac.has(mac)) {
        byMac.set(mac, {
          mac,
          ip,
          hostname: "",
          vendor: guessVendorFromMac(mac),
          lastSeen: new Date().toISOString(),
          source: "neigh",
          connected: neighConnected,
        });
      } else {
        const existing = byMac.get(mac);
        byMac.set(mac, {
          ...existing,
          ip: existing.ip || ip,
          neighState: state,
          connected: existing.connected || neighConnected,
        });
      }
    });

    // WiFi station dump is the authoritative source for currently-associated
    // wireless clients – mark any known device as connected if it is associated.
    wifiStations.forEach((mac) => {
      if (byMac.has(mac)) {
        byMac.set(mac, { ...byMac.get(mac), connected: true });
      } else {
        byMac.set(mac, {
          mac,
          ip: "",
          hostname: "",
          vendor: guessVendorFromMac(mac),
          lastSeen: new Date().toISOString(),
          source: "wifi",
          connected: true,
        });
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
