import React, { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api";
import { Card } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
  Search, Plus, Minus, Settings2, Package, AlertTriangle,
  ArrowUpDown, Filter
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../../context/LanguageContext";

const STATUS_STYLES = {
  in_stock: { label: "In Stock", cls: "bg-forest-light/60 text-forest border-forest/30 shadow-sm backdrop-blur-sm" },
  low_stock: { label: "Low Stock", cls: "bg-amber-50/80 text-amber-700 border-amber-200 shadow-sm backdrop-blur-sm" },
  out_of_stock: { label: "Out of Stock", cls: "bg-red-50/80 text-red-600 border-red-200 shadow-sm backdrop-blur-sm" },
  untracked: { label: "Untracked", cls: "bg-gray-100/80 text-gray-500 border-gray-200 shadow-sm backdrop-blur-sm" },
};

export default function StockManagement() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  // debouncedSearch is the value actually sent to the API — 300ms after user stops typing
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState("name");
  const [sortDir, setSortDir] = useState(1);
  const { t } = useLanguage();
  const abortRef = useRef(null);

  // Dialogs
  const [addDialog, setAddDialog] = useState(null); // { item, type: "add" | "remove" }
  const [settingsDialog, setSettingsDialog] = useState(null);
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [invSettings, setInvSettings] = useState({});

  // Debounce: wait 300ms after user stops typing before updating debouncedSearch
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchItems = useCallback(async () => {
    // Cancel any in-flight request before starting a new one
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();
    try {
      const params = {};
      if (statusFilter !== "all") params.status = statusFilter;
      if (debouncedSearch) params.q = debouncedSearch;
      const { data } = await api.get("/inventory/stock", {
        params,
        signal: abortRef.current.signal,
      });
      setItems(data);
    } catch (e) {
      if (e.name === "CanceledError" || e.code === "ERR_CANCELED") return; // stale request, ignore
      toast.error("Failed to load stock data");
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const sorted = [...items].sort((a, b) => {
    const av = a[sortField] ?? "";
    const bv = b[sortField] ?? "";
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d * -1);
    else { setSortField(field); setSortDir(1); }
  };

  const handleStockChange = async () => {
    if (!addDialog || !qty || Number(qty) <= 0) return;
    try {
      const endpoint = addDialog.type === "add"
        ? `/inventory/stock/${addDialog.item.id}/add`
        : `/inventory/stock/${addDialog.item.id}/remove`;
      await api.post(endpoint, { qty: Number(qty), remarks });
      toast.success(`Stock ${addDialog.type === "add" ? "added" : "removed"} for ${addDialog.item.name}`);
      setAddDialog(null); setQty(""); setRemarks("");
      fetchItems();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Stock update failed");
    }
  };

  const handleSettingsSave = async () => {
    if (!settingsDialog) return;
    try {
      await api.patch(`/inventory/stock/${settingsDialog.id}`, invSettings);
      toast.success(`Inventory settings updated for ${settingsDialog.name}`);
      setSettingsDialog(null);
      fetchItems();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
  };

  const openSettings = (item) => {
    setInvSettings({
      current_stock: item.current_stock ?? 0,
      reorder_level: item.reorder_level ?? 10,
      min_stock: item.min_stock ?? 5,
      max_stock: item.max_stock ?? 1000,
      sku: item.sku ?? "",
      barcode: item.barcode ?? "",
      unit_cost: item.unit_cost ?? 0,
    });
    setSettingsDialog(item);
  };

  const statusTabs = [
    { key: "all", label: "All" },
    { key: "in_stock", label: "In Stock" },
    { key: "low_stock", label: "Low Stock" },
    { key: "out_of_stock", label: "Out of Stock" },
    { key: "untracked", label: "Untracked" },
  ];

  const SortHeader = ({ field, children }) => (
    <th className="pb-4 pt-4 pr-4 cursor-pointer select-none group/th" onClick={() => toggleSort(field)}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold group-hover/th:text-terracota transition-colors">
        {children}
        <ArrowUpDown className="w-3 h-3 opacity-40 group-hover/th:opacity-100 transition-opacity" />
      </div>
    </th>
  );

  return (
    <div className="p-6 lg:p-10 max-w-7xl">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{t("inv_module") || "Inventory Management"}</div>
        <h1 className="font-display text-3xl font-extrabold tracking-tight">{t("inv_stock") || "Stock Management"}</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-center gap-4 mb-6 bg-white/70 backdrop-blur-md p-2 rounded-2xl shadow-sm border border-border/60">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
          <Input placeholder="Search by name, SKU, or barcode..." value={search}
            onChange={e => setSearch(e.target.value)} className="pl-11 bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-[15px]" />
        </div>
        <div className="hidden sm:block w-[1px] h-8 bg-border/60"></div>
        <div className="flex items-center gap-1 w-full sm:w-auto overflow-x-auto pb-2 sm:pb-0 hide-scrollbar px-2">
          {statusTabs.map(st => (
            <button key={st.key} onClick={() => setStatusFilter(st.key)}
              className={`whitespace-nowrap px-4 py-2 text-xs font-bold uppercase tracking-wide rounded-xl transition-all duration-300 ${statusFilter === st.key ? "bg-foreground text-white shadow-md scale-105" : "text-muted-foreground hover:text-foreground hover:bg-sand-subtle"
                }`}>{st.label}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <Card className="border-border/60 shadow-sm rounded-2xl overflow-hidden bg-white/90 backdrop-blur-md">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left bg-sand-subtle/30">
                <SortHeader field="name"><span className="pl-6">Product</span></SortHeader>
                <SortHeader field="sku">SKU</SortHeader>
                <SortHeader field="current_stock">Stock</SortHeader>
                <th className="pb-4 pt-4 pr-4 text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">Status</th>
                <SortHeader field="reorder_level">Reorder Lvl</SortHeader>
                <SortHeader field="unit_cost">Cost</SortHeader>
                <SortHeader field="price">Price</SortHeader>
                <th className="pb-4 pt-4 text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold text-right pr-8">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-24 text-center">
                    <div className="flex flex-col items-center justify-center text-muted-foreground animate-in fade-in zoom-in-95 duration-500">
                      <Package className="w-16 h-16 mb-4 text-muted-foreground/20" />
                      <div className="font-display font-semibold text-xl text-foreground">No products found</div>
                      <div className="text-sm mt-1">Try adjusting your search or status filters.</div>
                    </div>
                  </td>
                </tr>
              ) : sorted.map((item, index) => {
                const status = STATUS_STYLES[item.stock_status] || STATUS_STYLES.untracked;
                return (
                  <tr key={item.id} className="group hover:bg-sand-subtle/40 transition-all duration-300 cursor-default animate-in fade-in slide-in-from-bottom-4" style={{ animationDelay: `${index * 30}ms`, animationFillMode: 'both' }}>
                    <td className="py-4 pr-4 pl-6">
                      <div className="font-semibold text-[15px] text-foreground group-hover:text-terracota transition-colors">{t(item.name)}</div>
                      {item.barcode && <div className="text-[11px] font-mono text-muted-foreground/70 mt-0.5">{item.barcode}</div>}
                    </td>
                    <td className="py-4 pr-4 font-mono text-xs text-muted-foreground">{item.sku || "—"}</td>
                    <td className="py-4 pr-4">
                      <span className="font-mono text-2xl font-extrabold tracking-tighter text-foreground">{item.current_stock ?? "—"}</span>
                    </td>
                    <td className="py-4 pr-4">
                      <Badge variant="outline" className={`px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${status.cls}`}>{status.label}</Badge>
                    </td>
                    <td className="py-4 pr-4 font-mono text-xs text-muted-foreground">{item.reorder_level ?? "—"}</td>
                    <td className="py-4 pr-4 font-mono text-xs text-muted-foreground">₹{item.unit_cost ?? 0}</td>
                    <td className="py-4 pr-4 font-mono text-sm font-medium">₹{item.price}</td>
                    <td className="py-4 text-right pr-6">
                      <div className="flex items-center justify-end gap-1.5 opacity-90 group-hover:opacity-100 transition-opacity">
                        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3.5 text-xs font-semibold bg-forest-light/40 text-forest hover:bg-forest-light hover:text-forest transition-all"
                          onClick={() => { setAddDialog({ item, type: "add" }); setQty(""); setRemarks(""); }}>
                          <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3.5 text-xs font-semibold bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 transition-all disabled:opacity-30 disabled:hover:bg-transparent"
                          onClick={() => { setAddDialog({ item, type: "remove" }); setQty(""); setRemarks(""); }}
                          disabled={!item.current_stock}>
                          <Minus className="w-3.5 h-3.5 mr-1.5" /> Remove
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:bg-sand-subtle hover:text-foreground transition-all ml-1"
                          onClick={() => openSettings(item)}>
                          <Settings2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add/Remove Stock Dialog */}
      <Dialog open={!!addDialog} onOpenChange={() => setAddDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">
              {addDialog?.type === "add" ? <><Plus className="w-5 h-5 inline mr-2 text-forest" />Add Stock</> : <><Minus className="w-5 h-5 inline mr-2 text-red-500" />Remove Stock</>}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-3 bg-sand-subtle rounded-lg">
              <div className="text-sm font-semibold">{t(addDialog?.item?.name)}</div>
              <div className="text-xs text-muted-foreground">Current stock: {addDialog?.item?.current_stock ?? "Not tracked"}</div>
            </div>
            <div>
              <Label>Quantity</Label>
              <Input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} placeholder="Enter quantity" className="mt-1" autoFocus />
            </div>
            <div>
              <Label>Remarks (optional)</Label>
              <Input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Reason for change..." className="mt-1" />
            </div>
            <Button onClick={handleStockChange} disabled={!qty || Number(qty) <= 0}
              className={addDialog?.type === "add" ? "w-full bg-forest hover:bg-forest-hover text-white" : "w-full bg-red-600 hover:bg-red-700 text-white"}>
              {addDialog?.type === "add" ? "Add Stock" : "Remove Stock"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Inventory Settings Dialog */}
      <Dialog open={!!settingsDialog} onOpenChange={() => setSettingsDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-terracota" /> Inventory Settings — {t(settingsDialog?.name)}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Current Stock</Label>
              <Input type="number" value={invSettings.current_stock ?? ""} onChange={e => setInvSettings(s => ({ ...s, current_stock: Number(e.target.value) }))} className="mt-1" />
            </div>
            <div>
              <Label>Reorder Level</Label>
              <Input type="number" value={invSettings.reorder_level} onChange={e => setInvSettings(s => ({ ...s, reorder_level: Number(e.target.value) }))} className="mt-1" />
            </div>
            <div>
              <Label>Min Stock</Label>
              <Input type="number" value={invSettings.min_stock} onChange={e => setInvSettings(s => ({ ...s, min_stock: Number(e.target.value) }))} className="mt-1" />
            </div>
            <div>
              <Label>Max Stock</Label>
              <Input type="number" value={invSettings.max_stock} onChange={e => setInvSettings(s => ({ ...s, max_stock: Number(e.target.value) }))} className="mt-1" />
            </div>
            <div>
              <Label>SKU</Label>
              <Input value={invSettings.sku} onChange={e => setInvSettings(s => ({ ...s, sku: e.target.value }))} className="mt-1" placeholder="e.g., PM-001" />
            </div>
            <div>
              <Label>Barcode</Label>
              <Input value={invSettings.barcode} onChange={e => setInvSettings(s => ({ ...s, barcode: e.target.value }))} className="mt-1" placeholder="e.g., 8901234567890" />
            </div>
            <div className="col-span-2">
              <Label>Unit Cost (₹)</Label>
              <Input type="number" step="0.01" value={invSettings.unit_cost} onChange={e => setInvSettings(s => ({ ...s, unit_cost: Number(e.target.value) }))} className="mt-1" />
            </div>
          </div>
          <Button onClick={handleSettingsSave} className="w-full bg-terracota hover:bg-terracota-hover text-white mt-2">
            Save Inventory Settings
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
