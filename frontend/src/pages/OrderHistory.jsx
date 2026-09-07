import React, { useCallback, useEffect, useState } from "react";
import api from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Printer, Eye, Search, Trash2, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { printReceipt } from "../lib/receipt";
import ReceiptPreview from "../components/ReceiptPreview";
import { useLanguage } from "../context/LanguageContext";
import { safeArray } from "../lib/safeArray";
import ConfirmDialog from "../components/ConfirmDialog";
import { toast } from "sonner";
import { syncQueue } from "../lib/syncQueue";
import { resetToken } from "../lib/tokenManager";

export default function OrderHistory() {
  const { t } = useLanguage();
  const [orders, setOrders] = useState([]);
  const [settings, setSettings] = useState(null);
  const [activeFilter, setActiveFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const getLocalDateString = (rawDate) => {
    if (!rawDate) return "";
    const d = new Date(rawDate);
    if (isNaN(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const getFilterDateRange = (filterKey) => {
    const now = new Date();
    const todayStr = getLocalDateString(now);

    if (filterKey === "all") {
      return { fromStr: "", toStr: "" };
    } else if (filterKey === "today") {
      return { fromStr: todayStr, toStr: todayStr };
    } else if (filterKey === "week") {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { fromStr: getLocalDateString(d), toStr: todayStr };
    } else if (filterKey === "month") {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { fromStr: getLocalDateString(d), toStr: todayStr };
    }

    return { fromStr: "", toStr: "" };
  };

  const [from, setFrom] = useState(() => getFilterDateRange("all").fromStr);
  const [to, setTo] = useState(() => getFilterDateRange("all").toStr);
  const [q, setQ] = useState("");
  const [searchDate, setSearchDate] = useState("");
  const [appliedSearchDate, setAppliedSearchDate] = useState("");
  const [view, setView] = useState(null);

  const handleFilterChange = (filterKey) => {
    setActiveFilter(filterKey);
    const { fromStr, toStr } = getFilterDateRange(filterKey);
    setFrom(fromStr);
    setTo(toStr);
    setSearchDate("");
    setAppliedSearchDate("");
  };

  const handleSearchDate = () => {
    setAppliedSearchDate(searchDate);
  };

  const fetchOrders = useCallback(async () => {
    const params = {};
    if (q) params.q = q;
    try {
      const offlineSettings = offlineStorage.loadSettings() || {};
      const [{ data }, s] = await Promise.all([
        api.get("/orders", { params }),
        api.get("/settings"),
      ]);
      setOrders(safeArray(data));
      const mergedSettings = {
        ...offlineSettings,
        ...(s?.data || {}),
        fssai: (s?.data && s.data.fssai !== undefined && s.data.fssai !== null)
          ? s.data.fssai
          : (offlineSettings.fssai || ""),
      };
      setSettings(mergedSettings);
      offlineStorage.saveSettings(mergedSettings);
    } catch (err) {
      console.error("Failed to load orders", err);
      setOrders([]);
      const cached = offlineStorage.loadSettings();
      if (cached) setSettings(cached);
    }
  }, [q]);

  useEffect(() => {
    fetchOrders();
    const handleSettingsUpdate = () => {
      const cached = offlineStorage.loadSettings();
      if (cached) setSettings(cached);
    };
    window.addEventListener("settingsUpdated", handleSettingsUpdate);
    return () => {
      window.removeEventListener("settingsUpdated", handleSettingsUpdate);
    };
  }, [fetchOrders]);

  const filteredOrders = React.useMemo(() => {
    if (!Array.isArray(orders)) return [];
    let list = orders;

    // Filter by exact single Search Order Date if applied
    if (appliedSearchDate) {
      list = list.filter((o) => {
        const rawDate = o.paid_at || o.created_at || o.date;
        return getLocalDateString(rawDate) === appliedSearchDate;
      });
    }

    // Filter by custom From / To date pickers if selected
    if (from || to) {
      list = list.filter((o) => {
        const rawDate = o.paid_at || o.created_at || o.date;
        if (!rawDate) return false;
        const dStr = getLocalDateString(rawDate);
        if (from && dStr < from) return false;
        if (to && dStr > to) return false;
        return true;
      });
    }

    if (activeFilter === "all") return list;

    const todayStr = getLocalDateString(new Date());

    return list.filter((o) => {
      const rawDate = o.paid_at || o.created_at || o.date;
      if (!rawDate) return false;
      const dStr = getLocalDateString(rawDate);

      if (activeFilter === "today") {
        return dStr === todayStr;
      }
      if (activeFilter === "week") {
        const now = new Date();
        const weekStartStr = getLocalDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
        return dStr >= weekStartStr && dStr <= todayStr;
      }
      if (activeFilter === "month") {
        const now = new Date();
        const monthStartStr = getLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1));
        return dStr >= monthStartStr && dStr <= todayStr;
      }
      return true;
    });
  }, [orders, activeFilter, appliedSearchDate, from, to]);

  const reprint = (o) => printReceipt({ order: o, settings });

  const handleDeleteOrder = async () => {
    if (!deleteTarget || !deleteTarget.id) return;
    try {
      await api.delete(`/orders/${deleteTarget.id}`);
      setOrders((prev) => prev.filter((o) => o.id !== deleteTarget.id));
      toast.success(t("order_deleted_success") || "Order deleted successfully");
    } catch (err) {
      console.error("Failed to delete order", err);
      toast.error(err.response?.data?.detail || "Failed to delete order");
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleResetOrders = async () => {
    try {
      await api.delete("/orders/reset");
      setOrders([]);
      resetToken();
      if (syncQueue && typeof syncQueue.clear === "function") {
        syncQueue.clear();
      }
      toast.success(t("orders_reset_success") || "All order records deleted successfully");
    } catch (err) {
      console.error("Failed to reset orders", err);
      toast.error(err.response?.data?.detail || "Failed to delete order records");
    } finally {
      setShowResetConfirm(false);
    }
  };


  return (
    <div className="h-full bg-[#FFFDF9] rounded-[16px] sm:rounded-[20px] md:rounded-[24px] lg:rounded-[32px] border border-[#F4E6D7] shadow-lg p-3 sm:p-4 md:p-5 lg:p-8 flex flex-col overflow-hidden">
      <div className="mb-3 md:mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 md:gap-4 shrink-0">
        <div>
          <div className="text-[11px] sm:text-[12px] md:text-[13px] lg:text-[15px] uppercase tracking-[0.1em] font-bold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">History</div>
          <h1 className="font-display text-lg sm:text-xl md:text-2xl lg:text-3xl font-extrabold tracking-tight mt-0.5">{t("order_history")}</h1>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap">
          <div className="flex items-center gap-1.5 p-1 bg-[#FFF8F2] border border-[#F4E6D7] rounded-full self-start sm:self-auto max-w-full overflow-x-auto" data-testid="date-filter-buttons">
            <button
              type="button"
              onClick={() => handleFilterChange("all")}
              data-testid="filter-btn-all"
              className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap ${
                activeFilter === "all"
                  ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                  : "bg-white text-slate-600 hover:text-slate-900 border border-[#F4E6D7]"
              }`}
            >
              ALL
            </button>
            <button
              type="button"
              onClick={() => handleFilterChange("today")}
              data-testid="filter-btn-today"
              className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap ${
                activeFilter === "today"
                  ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                  : "bg-white text-slate-600 hover:text-slate-900 border border-[#F4E6D7]"
              }`}
            >
              TODAY
            </button>
            <button
              type="button"
              onClick={() => handleFilterChange("week")}
              data-testid="filter-btn-week"
              className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap ${
                activeFilter === "week"
                  ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                  : "bg-white text-slate-600 hover:text-slate-900 border border-[#F4E6D7]"
              }`}
            >
              THIS WEEK
            </button>
            <button
              type="button"
              onClick={() => handleFilterChange("month")}
              data-testid="filter-btn-month"
              className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap ${
                activeFilter === "month"
                  ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                  : "bg-white text-slate-600 hover:text-slate-900 border border-[#F4E6D7]"
              }`}
            >
              THIS MONTH
            </button>
          </div>

          <Button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            data-testid="reset-history-btn"
            variant="outline"
            className="group relative overflow-hidden border border-red-200/90 bg-gradient-to-r from-red-500/10 via-rose-500/10 to-red-600/10 hover:from-red-600 hover:to-rose-600 text-red-600 hover:text-white font-bold text-[10px] sm:text-[11px] md:text-xs h-7 sm:h-8 md:h-9 px-3 sm:px-4 rounded-full flex items-center gap-1.5 shrink-0 shadow-xs hover:shadow-md hover:shadow-red-500/25 transition-all duration-300 active:scale-95"
          >
            <RotateCcw className="w-3.5 h-3.5 md:w-4 md:h-4 transition-transform duration-500 group-hover:-rotate-180" />
            <span>Reset</span>
          </Button>
        </div>
      </div>

      <Card className="p-2.5 sm:p-3 md:p-3.5 border-border shadow-none mb-3 md:mb-4 shrink-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2 md:gap-2.5 items-end">
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-from" />
          </div>
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1">{t("to")}</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-to" />
          </div>
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1 truncate">{t("search_receipt_placeholder")}</label>
            <div className="flex gap-1.5">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 42" className="min-w-0 flex-1 text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-q" />
              <Button onClick={fetchOrders} variant="outline" className="border-border shrink-0 px-2.5 md:px-3 h-8 md:h-9" data-testid="filter-go"><Search className="w-3.5 h-3.5 md:w-4 md:h-4" /></Button>
            </div>
          </div>
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1 truncate">Search Order Date</label>
            <div className="flex gap-1.5">
              <Input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)} className="min-w-0 flex-1 text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-search-date" />
              <Button onClick={handleSearchDate} variant="outline" className="border-border shrink-0 px-2.5 md:px-3 h-8 md:h-9" data-testid="filter-date-go"><Search className="w-3.5 h-3.5 md:w-4 md:h-4" /></Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="flex-1 border-[#F4E6D7] bg-white rounded-[16px] md:rounded-[22px] lg:rounded-[26px] shadow-sm overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-auto min-h-0 w-full">
          <table className="w-full text-[11px] sm:text-xs md:text-[13px] lg:text-sm text-left min-w-[480px] sm:min-w-[540px] md:min-w-[580px]">
            <thead className="sticky top-0 z-10 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white text-[10px] md:text-[11.5px] lg:text-[13px] uppercase tracking-[0.15em] font-semibold">
              <tr>
                <th className="text-left px-2.5 md:px-3.5 py-2 md:py-2.5">{t("receipt_no_col")}</th>
                <th className="text-left px-2.5 md:px-3.5 py-2 md:py-2.5">{t("date")} / {t("time")}</th>
                <th className="text-left px-2.5 md:px-3.5 py-2 md:py-2.5">{t("items_col")}</th>
                <th className="text-left px-2.5 md:px-3.5 py-2 md:py-2.5">{t("payment_col")}</th>
                <th className="text-right px-2.5 md:px-3.5 py-2 md:py-2.5">{t("total")}</th>
                <th className="px-2.5 md:px-3.5 py-2 md:py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F4E6D7]" data-testid="orders-table">
              {Array.isArray(filteredOrders) && filteredOrders.map(o => {
                let pm = o.payment_mode;
                if (o.payment_mode === "cash") pm = t("cash");
                if (o.payment_mode === "upi") pm = t("upi");
                if (o.payment_mode === "card") pm = t("card");
                const orderItems = Array.isArray(o.items) ? o.items : [];
                return (
                  <tr key={o.id} className="hover:bg-[#FFF8F2] transition-colors" data-testid={`order-row-${o.id}`}>
                    <td className="px-2.5 md:px-3.5 py-2 md:py-2.5 font-mono font-semibold text-xs md:text-[13px]">#{o.receipt_no}</td>
                    <td className="px-2.5 md:px-3.5 py-2 md:py-2.5 text-muted-foreground text-[10px] md:text-xs whitespace-nowrap">{new Date(o.paid_at).toLocaleString('en-IN')}</td>
                    <td className="px-2.5 md:px-3.5 py-2 md:py-2.5 text-[11px] md:text-xs max-w-[160px] md:max-w-[220px] truncate" title={orderItems.map(i => `${t(i.name)} ×${i.qty}`).join(", ")}>{orderItems.map(i => `${t(i.name)} ×${i.qty}`).join(", ")}</td>
                    <td className="px-2.5 md:px-3.5 py-2 md:py-2.5 whitespace-nowrap"><span className="text-[9px] md:text-[10px] uppercase tracking-wider font-mono px-1.5 md:px-2 py-0.5 rounded-md bg-sand-subtle border border-border">{pm}</span></td>
                    <td className="px-2.5 md:px-3.5 py-2 md:py-2.5 text-right font-mono font-bold text-xs md:text-sm whitespace-nowrap">₹{o.total}</td>
                    <td className="px-2.5 md:px-3.5 py-2 md:py-2.5 text-right whitespace-nowrap">
                      <div className="flex justify-end items-center gap-0.5">
                        <button onClick={() => setView(o)} className="p-1 md:p-1.5 hover:bg-sand-subtle rounded-md text-slate-600" data-testid={`view-${o.id}`} title="View Details"><Eye className="w-3.5 h-3.5 md:w-4 md:h-4" /></button>
                        <button onClick={() => reprint(o)} className="p-1 md:p-1.5 hover:bg-sand-subtle rounded-md text-terracota" data-testid={`reprint-${o.id}`} title="Reprint Receipt"><Printer className="w-3.5 h-3.5 md:w-4 md:h-4" /></button>
                        <button onClick={() => setDeleteTarget(o)} className="p-1 md:p-1.5 hover:bg-red-50 rounded-md text-red-500 hover:text-red-700 transition-colors" data-testid={`delete-${o.id}`} title="Delete Order"><Trash2 className="w-3.5 h-3.5 md:w-4 md:h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredOrders.length === 0 && <tr><td colSpan="6" className="text-center text-muted-foreground py-10 text-xs md:text-sm">{t("no_bills_yet")}</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {view && (
        <Dialog open={true} onOpenChange={(o) => !o && setView(null)}>
          <DialogContent className="w-[92vw] max-w-md max-h-[90vh] overflow-y-auto flex flex-col items-center bg-neutral-50 p-4 sm:p-6 border border-border rounded-[20px]">
            <DialogHeader className="w-full text-center mb-1">
              <DialogTitle className="font-display text-base md:text-lg text-neutral-700">{t("order_details")}</DialogTitle>
            </DialogHeader>
            <div className="flex justify-center w-full">
              <ReceiptPreview order={view} settings={settings} />
            </div>
            <Button onClick={() => reprint(view)} className="w-full mt-4 bg-terracota hover:bg-terracota-hover text-white text-xs md:text-sm" data-testid="dialog-reprint">
              <Printer className="w-4 h-4 mr-2" /> {t("reprint")}
            </Button>
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteOrder}
        title="Delete this order?"
        message="Are you sure you want to permanently remove this order from Order History? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />

      <ConfirmDialog
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetOrders}
        title="Reset Order History"
        message="Are you sure you want to delete all order records?"
        confirmText="Reset"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
