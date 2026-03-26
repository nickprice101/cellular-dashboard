import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Database, Globe, History, Plus, Router, Wallet, AlertTriangle, CalendarDays, BarChart3, ScanSearch, RefreshCw, Wifi } from "lucide-react";

/**
 * Mobile Data Dashboard
 *
 * Single-file React dashboard for tracking router data usage against purchased plans.
 *
 * Storage model:
 * - localStorage persists plans, settings, device usage samples and usage snapshots.
 * - FIFO consumption: oldest active plan is depleted first.
 * - When adding a new plan and an active plan has remaining data, the user can choose:
 *   - add to current plan
 *   - start a new plan session
 *
 * Integration with the router:
 * - /api/router/usage  shells out to: vnstat --json -i wwan0
 * - /api/router/devices reads /tmp/dhcp.leases and enriches with `ip neigh`
 * The UI falls back gracefully when the endpoints are not reachable.
 */

const STORAGE_KEY = "mobile-data-dashboard-v1";
const DEFAULT_POLLING_MINUTES = 15;
const COUNTRY_OPTIONS = [
  "Netherlands",
  "Belgium",
  "France",
  "Germany",
  "Spain",
  "Italy",
  "United Kingdom",
  "Switzerland",
  "Austria",
  "Portugal",
  "Greece",
  "Turkey",
  "United States",
  "Canada",
  "Japan",
  "Thailand",
  "Australia",
  "Other",
];

const PIE_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--primary))",
  "hsl(var(--secondary))",
  "hsl(var(--muted-foreground))",
];

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function fmtMoney(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
}

function fmtGB(v) {
  const n = Number(v || 0);
  if (n >= 1024) return `${(n / 1024).toFixed(2)} TB`;
  if (n >= 1) return `${n.toFixed(2)} GB`;
  return `${(n * 1024).toFixed(0)} MB`;
}

function mibToGb(mib) {
  return Number(mib || 0) / 1024;
}

function gbToMib(gb) {
  return Number(gb || 0) * 1024;
}

function daysBetween(startIso, endIso) {
  const a = new Date(startIso);
  const b = new Date(endIso);
  const ms = b.getTime() - a.getTime();
  return Math.max(1, Math.ceil(ms / 86400000));
}

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function isExpired(plan, now = new Date()) {
  return new Date(plan.validUntil).getTime() < now.getTime();
}

function isActive(plan, now = new Date()) {
  return !isExpired(plan, now) && Number(plan.remainingGb) > 0;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function seedState() {
  const today = new Date();
  const start = today.toISOString();
  const validUntil = addDays(start, 30);
  return {
    plans: [
      {
        id: uid("plan"),
        name: "Example EU 50 GB",
        country: "France",
        provider: "EIOT Club",
        sessionType: "new",
        purchasedGb: 50,
        remainingGb: 50,
        validFrom: start,
        validUntil,
        cost: 39.99,
        notes: "Sample plan",
        createdAt: start,
        status: "active",
      },
    ],
    routerUsage: {
      totalGb: 0.33,
      updatedAt: today.toISOString(),
    },
    deviceUsage: [
      { id: uid("dev"), mac: "AA:BB:CC:DD:EE:01", name: "Phone", hostname: "iphone", usedGb: 0.18 },
      { id: uid("dev"), mac: "AA:BB:CC:DD:EE:02", name: "Laptop", hostname: "macbook", usedGb: 0.09 },
      { id: uid("dev"), mac: "AA:BB:CC:DD:EE:03", name: "Tablet", hostname: "ipad", usedGb: 0.06 },
    ],
    usageSnapshots: [
      { at: today.toISOString(), totalGb: 0.33 },
    ],
    settings: {
      interfaceName: "wwan0",
      providerName: "EIOT Club",
      pollingMinutes: DEFAULT_POLLING_MINUTES,
    },
  };
}

function getDisplayPlanStatus(plan) {
  if (Number(plan.remainingGb) <= 0) return "depleted";
  if (isExpired(plan)) return "expired";
  return "active";
}

function allocateUsageFIFO(plans, totalRouterGb) {
  const sorted = [...plans].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let remainingToAllocate = Number(totalRouterGb || 0);

  const nextPlans = sorted.map((p) => {
    const cap = Number(p.purchasedGb || 0);
    const used = Math.min(cap, Math.max(0, remainingToAllocate));
    const remaining = Math.max(0, cap - used);
    remainingToAllocate = Math.max(0, remainingToAllocate - cap);
    return {
      ...p,
      remainingGb: Number(remaining.toFixed(3)),
      usedGb: Number(used.toFixed(3)),
      status: remaining <= 0 ? "depleted" : isExpired(p) ? "expired" : "active",
    };
  });

  return nextPlans;
}

function getCurrentPlan(plans) {
  const activeSorted = [...plans]
    .filter((p) => Number(p.remainingGb) > 0)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return activeSorted[0] || null;
}

function getProjectedRunoutDate(plan, snapshots) {
  if (!plan || Number(plan.remainingGb) <= 0) return null;
  if (!snapshots || snapshots.length < 2) return null;

  const ordered = [...snapshots].sort((a, b) => new Date(a.at) - new Date(b.at));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const days = Math.max(1 / 24, (new Date(last.at) - new Date(first.at)) / 86400000);
  const delta = Number(last.totalGb) - Number(first.totalGb);
  if (delta <= 0) return null;

  const burnPerDay = delta / days;
  if (burnPerDay <= 0) return null;

  const daysLeft = Number(plan.remainingGb) / burnPerDay;
  const runout = new Date(Date.now() + daysLeft * 86400000);
  return { burnPerDay, runout };
}

function percentOf(a, b) {
  if (!b) return 0;
  return Math.min(100, Math.max(0, (Number(a) / Number(b)) * 100));
}

function DevicePieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, value, name }) {
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" className="text-[10px] font-medium">
      {`${name}\n${(percent * 100).toFixed(0)}% · ${fmtGB(value)}`}
    </text>
  );
}

function normalizeMac(mac) {
  return String(mac || "").trim().toUpperCase();
}

function guessVendorFromMac(mac) {
  const oui = normalizeMac(mac).slice(0, 8);
  const map = {
    "28:CF:E9": "Apple",
    "3C:52:82": "Samsung",
    "B8:27:EB": "Raspberry Pi",
    "DC:A6:32": "Intel",
  };
  return map[oui] || "Unknown vendor";
}

function parseDhcpLeases(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 4) return null;
      const [expiry, mac, ip, hostname] = parts;
      return {
        id: uid("dev"),
        mac: normalizeMac(mac),
        ip: ip || "",
        hostname: hostname && hostname !== "*" ? hostname : "",
        name: "",
        vendor: guessVendorFromMac(mac),
        lastSeen: expiry ? new Date(Number(expiry) * 1000).toISOString() : new Date().toISOString(),
        usedGb: 0,
        source: "dhcp",
      };
    })
    .filter(Boolean);
}

function mergeDetectedDevices(existing, detected) {
  const byMac = new Map();
  existing.forEach((device) => byMac.set(normalizeMac(device.mac), { ...device }));

  detected.forEach((device) => {
    const mac = normalizeMac(device.mac);
    const current = byMac.get(mac);

    if (current) {
      byMac.set(mac, {
        ...current,
        ip: device.ip || current.ip || "",
        hostname: device.hostname || current.hostname || "",
        vendor: device.vendor || current.vendor || "",
        lastSeen: device.lastSeen || current.lastSeen || "",
        source: device.source || current.source || "auto",
      });
    } else {
      byMac.set(mac, { ...device, mac });
    }
  });

  return Array.from(byMac.values()).filter((d) => d.mac);
}

export default function MobileDataDashboard() {
  const [state, setState] = useState(() => loadState() || seedState());
  const [countryQuery, setCountryQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addModeOpen, setAddModeOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [purchaseForm, setPurchaseForm] = useState({
    name: "",
    provider: "EIOT Club",
    purchasedGb: "",
    validityDays: "30",
    validFrom: new Date().toISOString().slice(0, 10),
    country: "",
    cost: "",
    notes: "",
  });
  const [leaseText, setLeaseText] = useState("");
  const [isDetectingDevices, setIsDetectingDevices] = useState(false);
  const [deviceDetectMessage, setDeviceDetectMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  useEffect(() => {
    saveState(state);
  }, [state]);

  const plans = useMemo(
    () => allocateUsageFIFO(state.plans, state.routerUsage.totalGb),
    [state.plans, state.routerUsage.totalGb]
  );

  useEffect(() => {
    if (JSON.stringify(plans) !== JSON.stringify(state.plans)) {
      setState((prev) => ({ ...prev, plans }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.routerUsage.totalGb]);

  const currentPlan = useMemo(() => getCurrentPlan(plans), [plans]);
  const totalPurchasedGb = useMemo(() => plans.reduce((s, p) => s + Number(p.purchasedGb || 0), 0), [plans]);
  const totalRemainingGb = useMemo(() => plans.reduce((s, p) => s + Number(p.remainingGb || 0), 0), [plans]);
  const totalUsedGb = useMemo(() => Number(state.routerUsage.totalGb || 0), [state.routerUsage.totalGb]);
  const activePlans = useMemo(() => plans.filter((p) => isActive(p)), [plans]);
  const runoutProjection = useMemo(() => getProjectedRunoutDate(currentPlan, state.usageSnapshots), [currentPlan, state.usageSnapshots]);

  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return COUNTRY_OPTIONS;
    return COUNTRY_OPTIONS.filter((c) => c.toLowerCase().includes(q));
  }, [countryQuery]);

  const pieData = useMemo(() => {
    const total = state.deviceUsage.reduce((s, d) => s + Number(d.usedGb || 0), 0) || 1;
    return state.deviceUsage.map((d) => ({
      name: d.name || d.hostname || autoNameFromMac(d.mac),
      value: Number(d.usedGb || 0),
      percent: Number(d.usedGb || 0) / total,
    }));
  }, [state.deviceUsage]);

  const statusTone = currentPlan
    ? isExpired(currentPlan)
      ? "destructive"
      : Number(currentPlan.remainingGb) < Math.max(1, Number(currentPlan.purchasedGb) * 0.1)
        ? "warning"
        : "normal"
    : "warning";

  const syncRouterUsage = useCallback(async () => {
    setIsSyncing(true);
    setSyncError("");
    try {
      const response = await fetch(
        `/api/router/usage?iface=${encodeURIComponent(state.settings.interfaceName || "wwan0")}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const nextTotal = Number(payload.totalGb || 0);
      setState((prev) => ({
        ...prev,
        routerUsage: {
          ...prev.routerUsage,
          totalGb: nextTotal,
          updatedAt: new Date().toISOString(),
        },
        usageSnapshots: [
          ...prev.usageSnapshots,
          { at: new Date().toISOString(), totalGb: nextTotal },
        ].slice(-90),
      }));
    } catch (err) {
      setSyncError(`Router unreachable: ${err.message}. Usage data not updated.`);
    } finally {
      setIsSyncing(false);
    }
  }, [state.settings.interfaceName]);

  // Auto-poll the router on mount and on the configured interval
  useEffect(() => {
    syncRouterUsage();
    const minutes = Math.max(1, Number(state.settings.pollingMinutes) || DEFAULT_POLLING_MINUTES);
    const id = setInterval(syncRouterUsage, minutes * 60 * 1000);
    return () => clearInterval(id);
  }, [state.settings.pollingMinutes, syncRouterUsage]);

  function updateDeviceUsage(index, field, value) {
    setState((prev) => ({
      ...prev,
      deviceUsage: prev.deviceUsage.map((d, i) =>
        i === index
          ? {
              ...d,
              [field]: field === "usedGb" ? Number(value) : value,
            }
          : d
      ),
    }));
  }

  function autoNameFromMac(mac) {
    if (!mac) return "Unknown device";
    return `Device ${mac.slice(-5).replace(/:/g, "")}`;
  }

  async function autoDetectDevices() {
    setIsDetectingDevices(true);
    setDeviceDetectMessage("");

    try {
      const response = await fetch("/api/router/devices", { cache: "no-store" });
      if (!response.ok) throw new Error("Router device endpoint not available");

      const payload = await response.json();
      const detected = Array.isArray(payload.devices)
        ? payload.devices.map((device) => ({
            id: uid("dev"),
            mac: normalizeMac(device.mac),
            ip: device.ip || "",
            hostname: device.hostname || "",
            name: device.name || "",
            vendor: device.vendor || guessVendorFromMac(device.mac),
            lastSeen: device.lastSeen || new Date().toISOString(),
            usedGb: Number(device.usedGb || 0),
            source: device.source || "api",
          }))
        : [];

      setState((prev) => ({
        ...prev,
        deviceUsage: mergeDetectedDevices(prev.deviceUsage, detected),
      }));

      setDeviceDetectMessage(`Auto-detected ${detected.length} device${detected.length === 1 ? "" : "s"} from the router.`);
    } catch {
      setDeviceDetectMessage("Router device endpoint not reachable. Paste /tmp/dhcp.leases below to import devices manually.");
    } finally {
      setIsDetectingDevices(false);
    }
  }

  function importDevicesFromLeases() {
    const detected = parseDhcpLeases(leaseText);

    setState((prev) => ({
      ...prev,
      deviceUsage: mergeDetectedDevices(prev.deviceUsage, detected),
    }));

    setDeviceDetectMessage(`Imported ${detected.length} device${detected.length === 1 ? "" : "s"} from DHCP leases.`);
  }

  function addDeviceRow() {
    setState((prev) => ({
      ...prev,
      deviceUsage: [
        ...prev.deviceUsage,
        {
          id: uid("dev"),
          mac: "",
          ip: "",
          name: "",
          hostname: "",
          vendor: "",
          lastSeen: "",
          usedGb: 0,
          source: "manual",
        },
      ],
    }));
  }

  function removePlan(id) {
    setState((prev) => ({
      ...prev,
      plans: prev.plans.filter((p) => p.id !== id),
    }));
  }

  function buildPlan(form, sessionType) {
    const validFromIso = new Date(form.validFrom).toISOString();
    return {
      id: uid("plan"),
      name: form.name || `${form.country || "Data"} ${form.purchasedGb} GB`,
      country: form.country || "",
      provider: form.provider || "",
      sessionType,
      purchasedGb: Number(form.purchasedGb),
      remainingGb: Number(form.purchasedGb),
      validFrom: validFromIso,
      validUntil: addDays(validFromIso, Number(form.validityDays || 0)),
      cost: form.cost === "" ? null : Number(form.cost),
      notes: form.notes || "",
      createdAt: new Date().toISOString(),
      status: "active",
    };
  }

  function submitPurchase() {
    const activeWithRemaining = currentPlan && Number(currentPlan.remainingGb) > 0;
    const plan = buildPlan(purchaseForm, activeWithRemaining ? "pending" : "new");

    if (activeWithRemaining) {
      setPendingPlan(plan);
      setAddModeOpen(true);
      return;
    }

    setState((prev) => ({ ...prev, plans: [...prev.plans, plan] }));
    setDialogOpen(false);
    resetPurchaseForm();
  }

  function applyPendingPlan(mode) {
    if (!pendingPlan) return;

    if (mode === "add") {
      setState((prev) => {
        const current = getCurrentPlan(allocateUsageFIFO(prev.plans, prev.routerUsage.totalGb));
        if (!current) return { ...prev, plans: [...prev.plans, { ...pendingPlan, sessionType: "new" }] };
        return {
          ...prev,
          plans: prev.plans.map((p) =>
            p.id === current.id
              ? {
                  ...p,
                  purchasedGb: Number((Number(p.purchasedGb) + Number(pendingPlan.purchasedGb)).toFixed(3)),
                  remainingGb: Number((Number(p.remainingGb) + Number(pendingPlan.purchasedGb)).toFixed(3)),
                  validUntil: new Date(pendingPlan.validUntil) > new Date(p.validUntil) ? pendingPlan.validUntil : p.validUntil,
                  cost:
                    p.cost === null && pendingPlan.cost === null
                      ? null
                      : Number((Number(p.cost || 0) + Number(pendingPlan.cost || 0)).toFixed(2)),
                  notes: [p.notes, pendingPlan.notes].filter(Boolean).join(" | "),
                  country: pendingPlan.country || p.country,
                }
              : p
          ),
        };
      });
    } else {
      setState((prev) => ({ ...prev, plans: [...prev.plans, { ...pendingPlan, sessionType: "new" }] }));
    }

    setPendingPlan(null);
    setAddModeOpen(false);
    setDialogOpen(false);
    resetPurchaseForm();
  }

  function resetPurchaseForm() {
    setPurchaseForm({
      name: "",
      provider: state.settings.providerName || "EIOT Club",
      purchasedGb: "",
      validityDays: "30",
      validFrom: new Date().toISOString().slice(0, 10),
      country: "",
      cost: "",
      notes: "",
    });
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Mobile Data Dashboard</h1>
            <p className="text-muted-foreground">Plan-aware router data tracking with FIFO depletion, purchase history, and device usage insights.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => syncRouterUsage()} disabled={isSyncing}>
              <RefreshCw className={`mr-2 h-4 w-4${isSyncing ? " animate-spin" : ""}`} />
              {isSyncing ? "Syncing…" : "Sync usage"}
            </Button>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add data purchase
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Add data purchase</DialogTitle>
                  <DialogDescription>
                    Enter plan details. If existing data remains, you will be prompted to add to the current plan or start a new session.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Plan name</Label>
                    <Input value={purchaseForm.name} onChange={(e) => setPurchaseForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Spain 20 GB top-up" />
                  </div>
                  <div className="space-y-2">
                    <Label>Provider</Label>
                    <Input value={purchaseForm.provider} onChange={(e) => setPurchaseForm((f) => ({ ...f, provider: e.target.value }))} placeholder="EIOT Club" />
                  </div>
                  <div className="space-y-2">
                    <Label>Data purchased (GB)</Label>
                    <Input type="number" min="0" step="0.1" value={purchaseForm.purchasedGb} onChange={(e) => setPurchaseForm((f) => ({ ...f, purchasedGb: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Valid from</Label>
                    <Input type="date" value={purchaseForm.validFrom} onChange={(e) => setPurchaseForm((f) => ({ ...f, validFrom: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Validity period (days)</Label>
                    <Input type="number" min="1" value={purchaseForm.validityDays} onChange={(e) => setPurchaseForm((f) => ({ ...f, validityDays: e.target.value }))} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Country lookup</Label>
                    <Input value={countryQuery} onChange={(e) => setCountryQuery(e.target.value)} placeholder="Type to filter countries" />
                    <div className="max-h-28 overflow-auto rounded-xl border p-2">
                      <div className="flex flex-wrap gap-2">
                        {filteredCountries.map((country) => (
                          <Button key={country} type="button" size="sm" variant={purchaseForm.country === country ? "default" : "outline"} onClick={() => setPurchaseForm((f) => ({ ...f, country }))}>
                            <Globe className="mr-1 h-3.5 w-3.5" />
                            {country}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Cost (optional, EUR)</Label>
                    <Input type="number" min="0" step="0.01" value={purchaseForm.cost} onChange={(e) => setPurchaseForm((f) => ({ ...f, cost: e.target.value }))} placeholder="Optional" />
                  </div>
                  <div className="space-y-2">
                    <Label>Notes</Label>
                    <Input value={purchaseForm.notes} onChange={(e) => setPurchaseForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button onClick={submitPurchase} disabled={!purchaseForm.purchasedGb || !purchaseForm.validityDays || !purchaseForm.validFrom}>Save purchase</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Dialog open={addModeOpen} onOpenChange={setAddModeOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remaining data detected</DialogTitle>
              <DialogDescription>
                There is still active data on the current plan. Would you like to add this purchase to the current plan or start a new session?
              </DialogDescription>
            </DialogHeader>
            {currentPlan && (
              <div className="rounded-2xl border p-4 text-sm">
                <div className="font-medium">Current active plan: {currentPlan.name}</div>
                <div className="mt-1 text-muted-foreground">Remaining: {fmtGB(currentPlan.remainingGb)} · Expires: {fmtDate(currentPlan.validUntil)}</div>
              </div>
            )}
            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" onClick={() => applyPendingPlan("new")}>Start new session</Button>
              <Button onClick={() => applyPendingPlan("add")}>Add to current data</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription>Total tracked usage</CardDescription>
              <CardTitle className="text-2xl">{fmtGB(totalUsedGb)}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Updated {new Date(state.routerUsage.updatedAt).toLocaleString()}
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription>Total purchased</CardDescription>
              <CardTitle className="text-2xl">{fmtGB(totalPurchasedGb)}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Across {plans.length} purchase{plans.length === 1 ? "" : "s"}
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription>Total remaining</CardDescription>
              <CardTitle className="text-2xl">{fmtGB(totalRemainingGb)}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">FIFO depletion across active plans</CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription>Current active plan</CardDescription>
              <CardTitle className="text-lg">{currentPlan ? currentPlan.name : "No active plan"}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {currentPlan ? `${fmtGB(currentPlan.remainingGb)} remaining` : "Add a purchase to start tracking plan depletion."}
            </CardContent>
          </Card>
        </div>

        {currentPlan ? (
          <Alert className={statusTone === "warning" ? "border-amber-400/50" : statusTone === "destructive" ? "border-red-400/50" : ""}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Current plan status</AlertTitle>
            <AlertDescription>
              <div className="space-y-2">
                <div>
                  <span className="font-medium">{currentPlan.name}</span> in {currentPlan.country || "unspecified country"} has {fmtGB(currentPlan.remainingGb)} remaining of {fmtGB(currentPlan.purchasedGb)}.
                </div>
                <Progress value={percentOf(currentPlan.usedGb || 0, currentPlan.purchasedGb)} className="h-2" />
                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                  <span>Used: {fmtGB(currentPlan.usedGb || 0)}</span>
                  <span>Expires: {fmtDate(currentPlan.validUntil)}</span>
                  {runoutProjection ? (
                    <span>
                      Burn: {fmtGB(runoutProjection.burnPerDay)}/day · Projected runout: {runoutProjection.runout.toLocaleDateString()}
                    </span>
                  ) : (
                    <span>Need more usage history for runout forecast</span>
                  )}
                </div>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <Database className="h-4 w-4" />
            <AlertTitle>No active plan</AlertTitle>
            <AlertDescription>Add a purchase to begin plan-aware tracking.</AlertDescription>
          </Alert>
        )}

        {syncError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Sync error</AlertTitle>
            <AlertDescription>{syncError}</AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="grid w-full grid-cols-4 md:w-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="purchases">Purchases</TabsTrigger>
            <TabsTrigger value="devices">Devices</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2 rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" />Purchase history</CardTitle>
                <CardDescription>All data purchases are persisted across sessions, with FIFO depletion from the oldest remaining data first.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead>Country</TableHead>
                      <TableHead>Purchased</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead>Remaining</TableHead>
                      <TableHead>Validity</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plans
                      .slice()
                      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                      .map((plan) => (
                        <TableRow key={plan.id}>
                          <TableCell>
                            <div className="font-medium">{plan.name}</div>
                            <div className="text-xs text-muted-foreground">{plan.provider || "—"}</div>
                          </TableCell>
                          <TableCell>{plan.country || "—"}</TableCell>
                          <TableCell>{fmtGB(plan.purchasedGb)}</TableCell>
                          <TableCell>{fmtGB(plan.usedGb || 0)}</TableCell>
                          <TableCell>{fmtGB(plan.remainingGb)}</TableCell>
                          <TableCell>
                            <div>{fmtDate(plan.validFrom)}</div>
                            <div className="text-xs text-muted-foreground">to {fmtDate(plan.validUntil)}</div>
                          </TableCell>
                          <TableCell>{fmtMoney(plan.cost)}</TableCell>
                          <TableCell>
                            <Badge variant={getDisplayPlanStatus(plan) === "active" ? "default" : "secondary"}>{getDisplayPlanStatus(plan)}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Wallet className="h-5 w-5" />Cost summary</CardTitle>
                <CardDescription>Includes plans with optional cost data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="flex items-center justify-between">
                  <span>Total spend</span>
                  <span className="font-medium">{fmtMoney(plans.reduce((s, p) => s + Number(p.cost || 0), 0))}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Weighted cost per GB</span>
                  <span className="font-medium">
                    {totalPurchasedGb > 0 ? fmtMoney(plans.reduce((s, p) => s + Number(p.cost || 0), 0) / totalPurchasedGb) : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Used value</span>
                  <span className="font-medium">
                    {totalPurchasedGb > 0 ? fmtMoney((plans.reduce((s, p) => s + Number(p.cost || 0), 0) / totalPurchasedGb) * totalUsedGb) : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Remaining value</span>
                  <span className="font-medium">
                    {totalPurchasedGb > 0 ? fmtMoney((plans.reduce((s, p) => s + Number(p.cost || 0), 0) / totalPurchasedGb) * totalRemainingGb) : "—"}
                  </span>
                </div>
                <div className="rounded-xl border p-3 text-muted-foreground">
                  Cost is optional. Plans without cost still remain fully trackable in purchase history and depletion logic.
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="purchases" className="space-y-4">
            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><CalendarDays className="h-5 w-5" />Plan ledger</CardTitle>
                <CardDescription>Manage sequential data purchases and how they are consumed over time.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {plans
                  .slice()
                  .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
                  .map((plan, idx) => (
                    <div key={plan.id} className="rounded-2xl border p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium">{idx + 1}. {plan.name}</h3>
                            <Badge variant={getDisplayPlanStatus(plan) === "active" ? "default" : "secondary"}>{getDisplayPlanStatus(plan)}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {plan.country || "No country"} · {plan.provider || "No provider"} · Created {fmtDate(plan.createdAt)}
                          </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => removePlan(plan.id)}>Remove</Button>
                      </div>
                      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Purchased</div><div className="mt-1 font-medium">{fmtGB(plan.purchasedGb)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Used</div><div className="mt-1 font-medium">{fmtGB(plan.usedGb || 0)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Remaining</div><div className="mt-1 font-medium">{fmtGB(plan.remainingGb)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Validity</div><div className="mt-1 font-medium">{fmtDate(plan.validFrom)} → {fmtDate(plan.validUntil)}</div></div>
                      </div>
                      {plan.notes && <div className="mt-3 text-sm text-muted-foreground">Notes: {plan.notes}</div>}
                    </div>
                  ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="devices" className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2 rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" />Data usage by device</CardTitle>
                <CardDescription>Pie chart shows each device’s total usage and percentage on the same chart.</CardDescription>
              </CardHeader>
              <CardContent className="h-[420px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={140}
                      labelLine={false}
                      label={({ percent, value, name }) => `${name}: ${(percent * 100).toFixed(0)}% · ${fmtGB(value)}`}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${entry.name}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => fmtGB(Number(value))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

                        <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>Devices (MAC-based)</CardTitle>
                <CardDescription>
                  Auto-detect devices from router leases when available, then use MAC address as the stable identity key.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={autoDetectDevices} disabled={isDetectingDevices}>
                      {isDetectingDevices ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
                      Auto-detect devices
                    </Button>
                    <Button variant="outline" onClick={importDevicesFromLeases} disabled={!leaseText.trim()}>
                      <Wifi className="mr-2 h-4 w-4" />
                      Import DHCP leases
                    </Button>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    For production on your router, the auto-detect endpoint should combine <code>/tmp/dhcp.leases</code>, <code>ip neigh</code>, and optional vendor lookup.
                  </div>

                  {deviceDetectMessage && (
                    <div className="rounded-xl border p-2 text-xs text-muted-foreground">
                      {deviceDetectMessage}
                    </div>
                  )}

                  <textarea
                    className="min-h-28 w-full rounded-xl border bg-background p-3 text-xs"
                    placeholder="Paste the contents of /tmp/dhcp.leases here for offline testing"
                    value={leaseText}
                    onChange={(e) => setLeaseText(e.target.value)}
                  />
                </div>

                {state.deviceUsage.map((device, idx) => (
                  <div key={device.id} className="grid grid-cols-1 gap-2 rounded-xl border p-3">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <Input
                        placeholder="MAC address (e.g. AA:BB:CC:DD:EE:FF)"
                        value={device.mac || ""}
                        onChange={(e) => updateDeviceUsage(idx, "mac", e.target.value.toUpperCase())}
                      />
                      <Input
                        placeholder="IP address"
                        value={device.ip || ""}
                        onChange={(e) => updateDeviceUsage(idx, "ip", e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <Input
                        placeholder="Device name (optional, overrides auto name)"
                        value={device.name || ""}
                        onChange={(e) => updateDeviceUsage(idx, "name", e.target.value)}
                      />
                      <Input
                        placeholder="Hostname (auto-detected)"
                        value={device.hostname || ""}
                        onChange={(e) => updateDeviceUsage(idx, "hostname", e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                      <Input
                        placeholder="Vendor"
                        value={device.vendor || ""}
                        onChange={(e) => updateDeviceUsage(idx, "vendor", e.target.value)}
                      />
                      <Input
                        placeholder="Last seen"
                        value={device.lastSeen ? new Date(device.lastSeen).toLocaleString() : ""}
                        readOnly
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={device.usedGb}
                        onChange={(e) => updateDeviceUsage(idx, "usedGb", e.target.value)}
                      />
                    </div>

                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>Display name: {device.name || device.hostname || autoNameFromMac(device.mac)}</span>
                      <span>Source: {device.source || "manual"}</span>
                    </div>
                  </div>
                ))}

                <Button variant="outline" className="w-full" onClick={addDeviceRow}>
                  Add device
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>Tracker settings</CardTitle>
                <CardDescription>These values are persisted locally and survive page reloads and sessions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Router interface</Label>
                  <Input value={state.settings.interfaceName} onChange={(e) => setState((prev) => ({ ...prev, settings: { ...prev.settings, interfaceName: e.target.value } }))} />
                </div>
                <div className="space-y-2">
                  <Label>Provider name</Label>
                  <Input value={state.settings.providerName} onChange={(e) => setState((prev) => ({ ...prev, settings: { ...prev.settings, providerName: e.target.value } }))} />
                </div>
                <div className="space-y-2">
                  <Label>Polling interval (minutes)</Label>
                  <Input type="number" min="1" value={state.settings.pollingMinutes} onChange={(e) => setState((prev) => ({ ...prev, settings: { ...prev.settings, pollingMinutes: Number(e.target.value) } }))} />
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>Router API endpoints</CardTitle>
                <CardDescription>Run <code>npm start</code> on the router to activate live data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div className="rounded-xl border p-3">
                  <strong>GET /api/router/usage</strong> — shells out to <code>vnstat --json -i wwan0</code> and returns <code>{`{ totalGb }`}</code>.
                  The UI polls this endpoint every <em>polling interval</em> minutes and on page load.
                </div>
                <div className="rounded-xl border p-3">
                  <strong>GET /api/router/devices</strong> — reads <code>/tmp/dhcp.leases</code> and enriches entries with <code>ip neigh</code>.
                  Returns <code>{`{ devices: [{ mac, ip, hostname, vendor, lastSeen, source }] }`}</code>.
                </div>
                <div className="rounded-xl border p-3">
                  Without the backend running: the UI still loads, purchases and history persist in localStorage, but router/device auto-detect will not be live.
                </div>
                <div className="rounded-xl border p-3">
                  FIFO depletion is built in: older remaining data is consumed first, then the next plan takes over automatically.
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
