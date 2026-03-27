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
import { Database, Globe, History, Plus, Router, Wallet, AlertTriangle, CalendarDays, BarChart3, ScanSearch, RefreshCw, Wifi, Pencil, Trash2, Check, X, Play, Pause } from "lucide-react";

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
 * - /api/router/devices reads /tmp/dhcp.leases, enriches with `ip neigh`, and adds OUI vendor lookup
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


function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function isExpired(plan, now = new Date()) {
  return new Date(plan.validUntil).getTime() < now.getTime();
}

function isActive(plan, now = new Date()) {
  return !isExpired(plan, now) && Number(plan.remainingGb) > 0 && plan.status !== "paused";
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
    deviceUsage: [],
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
  if (plan.status === "paused") return "paused";
  return "active";
}

function allocateUsageFIFO(plans, totalRouterGb) {
  // Active plans are consumed first (FIFO by createdAt), then paused plans (FIFO by createdAt)
  const activeSorted = [...plans]
    .filter((p) => p.status !== "paused")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const pausedSorted = [...plans]
    .filter((p) => p.status === "paused")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const orderedPlans = [...activeSorted, ...pausedSorted];
  let remainingToAllocate = Number(totalRouterGb || 0);

  const nextPlans = orderedPlans.map((p) => {
    const cap = Number(p.purchasedGb || 0);
    const used = Math.min(cap, Math.max(0, remainingToAllocate));
    const remaining = Math.max(0, cap - used);
    remainingToAllocate = Math.max(0, remainingToAllocate - cap);
    const computedStatus =
      remaining <= 0 ? "depleted" : isExpired(p) ? "expired" : p.status === "paused" ? "paused" : "active";
    return {
      ...p,
      remainingGb: Number(remaining.toFixed(3)),
      usedGb: Number(used.toFixed(3)),
      status: computedStatus,
    };
  });

  return nextPlans;
}

function getCurrentPlan(plans) {
  const activeSorted = [...plans]
    .filter((p) => isActive(p))
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
  const [activeTab, setActiveTab] = useState("overview");
  const [leaseText, setLeaseText] = useState("");
  const [isDetectingDevices, setIsDetectingDevices] = useState(false);
  const [deviceDetectMessage, setDeviceDetectMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [editingDeviceId, setEditingDeviceId] = useState(null);
  const [editingName, setEditingName] = useState("");
  const [showManualAddForm, setShowManualAddForm] = useState(false);
  const [manualAddForm, setManualAddForm] = useState({ mac: "", name: "", ip: "" });

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

  // Show manual devices always; auto-detected devices only when connected or they have consumed data
  const visibleDevices = useMemo(
    () =>
      state.deviceUsage.filter(
        (d) => d.source === "manual" || d.connected || Number(d.usedGb || 0) > 0
      ),
    [state.deviceUsage]
  );

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
            usedGb: 0,
            source: "auto",
            connected: device.connected ?? true,
          }))
        : [];

      setState((prev) => {
        // Reset all existing devices to not-connected, then update/add from detected
        const byMac = new Map(
          prev.deviceUsage.map((d) => [normalizeMac(d.mac), { ...d, connected: false }])
        );

        detected.forEach((device) => {
          const mac = device.mac;
          if (byMac.has(mac)) {
            // Update connection status and network info but preserve name/source
            const current = byMac.get(mac);
            byMac.set(mac, {
              ...current,
              ip: device.ip || current.ip || "",
              hostname: device.hostname || current.hostname || "",
              lastSeen: device.lastSeen || current.lastSeen || "",
              connected: device.connected ?? true,
            });
          } else {
            // Only add genuinely new devices not already in the list
            byMac.set(mac, device);
          }
        });

        return {
          ...prev,
          // Remove non-connected auto-detected devices that have never consumed data
          deviceUsage: Array.from(byMac.values()).filter(
            (d) => d.mac && (d.source === "manual" || d.connected || Number(d.usedGb || 0) > 0)
          ),
        };
      });

      setDeviceDetectMessage(`Scanned router: ${detected.length} device${detected.length === 1 ? "" : "s"} found online.`);
    } catch {
      setState((prev) => ({
        ...prev,
        // On failure, mark all disconnected and prune auto devices with no usage
        deviceUsage: prev.deviceUsage
          .map((d) => ({ ...d, connected: false }))
          .filter((d) => d.source === "manual" || Number(d.usedGb || 0) > 0),
      }));
      setDeviceDetectMessage("Router device endpoint not reachable. Paste /tmp/dhcp.leases below to import devices manually.");
    } finally {
      setIsDetectingDevices(false);
    }
  }

  function importDevicesFromLeases() {
    const detected = parseDhcpLeases(leaseText);

    setState((prev) => {
      const byMac = new Map(
        prev.deviceUsage.map((d) => [normalizeMac(d.mac), { ...d, connected: false }])
      );

      detected.forEach((device) => {
        const mac = device.mac;
        if (byMac.has(mac)) {
          const current = byMac.get(mac);
          byMac.set(mac, {
            ...current,
            ip: device.ip || current.ip || "",
            hostname: device.hostname || current.hostname || "",
            lastSeen: device.lastSeen || current.lastSeen || "",
            connected: true,
          });
        } else {
          byMac.set(mac, { ...device, connected: true });
        }
      });

      return {
        ...prev,
        deviceUsage: Array.from(byMac.values()).filter((d) => d.mac),
      };
    });

    setDeviceDetectMessage(`Imported ${detected.length} device${detected.length === 1 ? "" : "s"} from DHCP leases.`);
  }

  function removeDevice(id) {
    setState((prev) => ({
      ...prev,
      deviceUsage: prev.deviceUsage.filter((d) => d.id !== id),
    }));
  }

  function startRenameDevice(id, currentName) {
    setEditingDeviceId(id);
    setEditingName(currentName);
  }

  function saveDeviceName(id) {
    setState((prev) => ({
      ...prev,
      deviceUsage: prev.deviceUsage.map((d) => {
        if (d.id !== id) return d;
        const nameChanged = editingName !== (d.name || "");
        return {
          ...d,
          name: editingName,
          source: nameChanged ? "manual" : d.source,
        };
      }),
    }));
    setEditingDeviceId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingDeviceId(null);
    setEditingName("");
  }

  function cancelManualAdd() {
    setShowManualAddForm(false);
    setManualAddForm({ mac: "", name: "", ip: "" });
  }

  function addManualDevice() {
    const mac = normalizeMac(manualAddForm.mac);
    if (!mac) return;
    setState((prev) => {
      const exists = prev.deviceUsage.some((d) => normalizeMac(d.mac) === mac);
      if (exists) return prev;
      return {
        ...prev,
        deviceUsage: [
          ...prev.deviceUsage,
          {
            id: uid("dev"),
            mac,
            ip: manualAddForm.ip || "",
            name: manualAddForm.name || "",
            hostname: "",
            vendor: guessVendorFromMac(mac),
            lastSeen: new Date().toISOString(),
            usedGb: 0,
            source: "manual",
            connected: false,
          },
        ],
      };
    });
    setManualAddForm({ mac: "", name: "", ip: "" });
    setShowManualAddForm(false);
  }

  function removePlan(id) {
    setState((prev) => ({
      ...prev,
      plans: prev.plans.filter((p) => p.id !== id),
    }));
  }

  function pausePlan(id) {
    setState((prev) => ({
      ...prev,
      plans: prev.plans.map((p) => (p.id === id ? { ...p, status: "paused" } : p)),
    }));
  }

  function activatePlan(id) {
    setState((prev) => ({
      ...prev,
      plans: prev.plans.map((p) => {
        if (p.id === id) return { ...p, status: "active" };
        // Pause any currently active plans so only one is active at a time
        if (p.status === "active") return { ...p, status: "paused" };
        return p;
      }),
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

    setState((prev) => ({
      ...prev,
      plans: [...prev.plans, plan],
      deviceUsage: prev.deviceUsage.map((d) => ({ ...d, usedGb: 0 })),
    }));
    setDialogOpen(false);
    resetPurchaseForm();
  }

  function applyPendingPlan(mode) {
    if (!pendingPlan) return;

    if (mode === "add") {
      setState((prev) => {
        const current = getCurrentPlan(allocateUsageFIFO(prev.plans, prev.routerUsage.totalGb));
        if (!current) return {
          ...prev,
          plans: [...prev.plans, { ...pendingPlan, sessionType: "new" }],
          deviceUsage: prev.deviceUsage.map((d) => ({ ...d, usedGb: 0 })),
        };
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
      setState((prev) => {
        const current = getCurrentPlan(prev.plans);
        const updatedPlans = current
          ? prev.plans.map((p) => (p.id === current.id ? { ...p, status: "paused" } : p))
          : prev.plans;
        return {
          ...prev,
          plans: [...updatedPlans, { ...pendingPlan, sessionType: "new" }],
          deviceUsage: prev.deviceUsage.map((d) => ({ ...d, usedGb: 0 })),
        };
      });
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
                There is still active data on the current plan. Would you like to add this purchase to the current plan or start a new session? Starting a new session will pause the current plan.
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

        <Tabs
          value={activeTab}
          onValueChange={(tab) => {
            setActiveTab(tab);
            if (tab === "devices") autoDetectDevices();
          }}
          className="space-y-4"
        >
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
                      .sort((a, b) => {
                        const order = { active: 0, paused: 1, expired: 2, depleted: 3 };
                        const aO = order[getDisplayPlanStatus(a)] ?? 4;
                        const bO = order[getDisplayPlanStatus(b)] ?? 4;
                        if (aO !== bO) return aO - bO;
                        return new Date(b.createdAt) - new Date(a.createdAt);
                      })
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
                            <Badge
                              variant={
                                getDisplayPlanStatus(plan) === "active"
                                  ? "default"
                                  : getDisplayPlanStatus(plan) === "paused"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {getDisplayPlanStatus(plan)}
                            </Badge>
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
                <CardDescription>Manage sequential data purchases and how they are consumed over time. Active plans are consumed first; paused plans queue behind them.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {plans
                  .slice()
                  .sort((a, b) => {
                    const order = { active: 0, paused: 1, expired: 2, depleted: 3 };
                    const aO = order[getDisplayPlanStatus(a)] ?? 4;
                    const bO = order[getDisplayPlanStatus(b)] ?? 4;
                    if (aO !== bO) return aO - bO;
                    return new Date(a.createdAt) - new Date(b.createdAt);
                  })
                  .map((plan, idx) => (
                    <div key={plan.id} className="rounded-2xl border p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium">{idx + 1}. {plan.name}</h3>
                            <Badge
                              variant={
                                getDisplayPlanStatus(plan) === "active"
                                  ? "default"
                                  : getDisplayPlanStatus(plan) === "paused"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {getDisplayPlanStatus(plan)}
                            </Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {plan.country || "No country"} · {plan.provider || "No provider"} · Created {fmtDate(plan.createdAt)}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {getDisplayPlanStatus(plan) === "active" && (
                            <Button variant="outline" size="sm" onClick={() => pausePlan(plan.id)}>
                              <Pause className="mr-1.5 h-3.5 w-3.5" />
                              Pause
                            </Button>
                          )}
                          {getDisplayPlanStatus(plan) === "paused" && (
                            <Button variant="outline" size="sm" onClick={() => activatePlan(plan.id)}>
                              <Play className="mr-1.5 h-3.5 w-3.5" />
                              Activate
                            </Button>
                          )}
                          <Button variant="outline" size="sm" onClick={() => removePlan(plan.id)}>Remove</Button>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Purchased</div><div className="mt-1 font-medium">{fmtGB(plan.purchasedGb)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Used</div><div className="mt-1 font-medium">{fmtGB(plan.usedGb || 0)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Remaining</div><div className="mt-1 font-medium">{fmtGB(plan.remainingGb)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Validity</div><div className="mt-1 font-medium">{fmtDate(plan.validFrom)} → {fmtDate(plan.validUntil)}</div></div>
                        <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Price</div><div className="mt-1 font-medium">{fmtMoney(plan.cost)}</div></div>
                      </div>
                      {plan.notes && <div className="mt-3 text-sm text-muted-foreground">Notes: {plan.notes}</div>}
                    </div>
                  ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="devices" className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {currentPlan && (
              <Card className="xl:col-span-2 rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" />Data usage by device</CardTitle>
                  <CardDescription>Pie chart shows each device’s usage and percentage for the current active plan.</CardDescription>
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
            )}

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>Devices (MAC-based)</CardTitle>
                <CardDescription>
                  Auto-detect reads <code>/tmp/dhcp.leases</code>, <code>ip neigh</code>, and OUI vendor lookup from the router. <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-500" />connected</span> · <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-red-500" />not connected</span>. Manual devices persist across sessions.
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

                <div className="space-y-2">
                  {visibleDevices.map((device) => {
                    const isEditing = editingDeviceId === device.id;
                    const displayName = device.name || device.hostname || autoNameFromMac(device.mac);
                    const isManual = device.source === "manual";
                    return (
                      <div key={device.id} className="flex items-center gap-3 rounded-xl border p-3">
                        <div
                          className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${device.connected ? "bg-green-500" : "bg-red-500"}`}
                          title={device.connected ? "Connected" : "Not connected"}
                        />
                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <Input
                                className="h-7 text-sm"
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveDeviceName(device.id);
                                  if (e.key === "Escape") cancelRename();
                                }}
                              />
                              <Button size="sm" className="h-7 px-2" onClick={() => saveDeviceName(device.id)} title="Save name">
                                <Check className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={cancelRename} title="Cancel">
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <div className="truncate text-sm font-medium">{displayName}</div>
                          )}
                          <div className="truncate text-xs text-muted-foreground">
                            {device.mac}{device.ip ? ` · ${device.ip}` : ""}{device.hostname && device.name !== device.hostname ? ` · ${device.hostname}` : ""}{device.vendor && device.vendor !== "Unknown vendor" ? ` · ${device.vendor}` : ""}
                          </div>
                        </div>
                        <Badge variant="outline" className="flex-shrink-0 text-xs">
                          {isManual ? "manual" : "auto"}
                        </Badge>
                        {!isEditing && (
                          <div className="flex flex-shrink-0 gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => startRenameDevice(device.id, device.name || "")}
                              title="Rename device"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {isManual && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                onClick={() => removeDevice(device.id)}
                                title="Remove device"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {showManualAddForm ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3">
                    <Input
                      className="h-8 min-w-[180px] flex-1 text-sm"
                      placeholder="MAC (AA:BB:CC:DD:EE:FF)"
                      value={manualAddForm.mac}
                      onChange={(e) => setManualAddForm((f) => ({ ...f, mac: e.target.value.toUpperCase() }))}
                    />
                    <Input
                      className="h-8 min-w-[140px] flex-1 text-sm"
                      placeholder="Name (optional)"
                      value={manualAddForm.name}
                      onChange={(e) => setManualAddForm((f) => ({ ...f, name: e.target.value }))}
                    />
                    <Input
                      className="h-8 min-w-[120px] flex-1 text-sm"
                      placeholder="IP (optional)"
                      value={manualAddForm.ip}
                      onChange={(e) => setManualAddForm((f) => ({ ...f, ip: e.target.value }))}
                    />
                    <Button size="sm" onClick={addManualDevice} disabled={!manualAddForm.mac.trim()}>Add</Button>
                    <Button size="sm" variant="outline" onClick={cancelManualAdd}>Cancel</Button>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full" onClick={() => setShowManualAddForm(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add manual device
                  </Button>
                )}
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
                  <strong>GET /api/router/devices</strong> — reads <code>/tmp/dhcp.leases</code>, enriches entries with <code>ip neigh</code> (for live connection state), and adds OUI-based vendor lookup.
                  Returns <code>{`{ devices: [{ mac, ip, hostname, vendor, lastSeen, source, connected }] }`}</code>.
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
