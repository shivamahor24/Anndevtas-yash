import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Printer,
  Eye,
  Search,
  Trash2,
  RotateCcw,
  Repeat,
  RefreshCw,
  AlertCircle,
  Clock,
  UtensilsCrossed,
  Package,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { printReceipt } from "../lib/receipt";
import ReceiptPreview from "../components/ReceiptPreview";
import { useLanguage } from "../context/LanguageContext";
import { safeArray } from "../lib/safeArray";
import ConfirmDialog from "../components/ConfirmDialog";
import { toast } from "sonner";
import { syncQueue } from "../lib/syncQueue";
import { resetToken } from "../lib/tokenManager";
import { offlineStorage, getOrders, updateOrder, deleteOrder, resetOrders } from "../lib/offlineStorage";
import { safeNumber, safeFixed } from "../lib/utils";

export default function OrderHistory() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  // Synchronous initialization from offlineStorage for instant (0ms) zero-latency rendering
  const [orders, setOrders] = useState(() => {
    try {
      return offlineStorage.getOrders();
    } catch (e) {
      console.error("Initial orders load failed:", e);
      return [];
    }
  });
  const [settings, setSettings] = useState(() => {
    try {
      return offlineStorage.loadSettings() || null;
    } catch {
      return null;
    }
  });
  const [activeFilter, setActiveFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [refundTarget, setRefundTarget] = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Pagination state: default query per page is 25
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const getLocalDateString = (rawDate) => {
    if (!rawDate) return "";
    if (typeof rawDate === "string") {
      const trimmed = rawDate.trim();
      const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
      if (dmy) {
        return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
      }
      const ymd = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (ymd && !trimmed.includes("T")) {
        return `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
      }
    }
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

  // Reset pagination to page 1 whenever any filter or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [q, activeFilter, appliedSearchDate, from, to]);

  const handleFilterChange = (filterKey) => {
    setActiveFilter(filterKey);
    const { fromStr, toStr } = getFilterDateRange(filterKey);
    setFrom(fromStr);
    setTo(toStr);
    setSearchDate("");
    setAppliedSearchDate("");
    setCurrentPage(1);
  };

  const handleSearchDate = () => {
    setActiveFilter("all");
    setAppliedSearchDate(searchDate);
    setCurrentPage(1);
  };

  const fetchOrders = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      // 1. Instant zero-latency load from offline storage
      const localOrders = offlineStorage.getOrders();
      setOrders(localOrders);

      // 2. Fetch server-side orders to ensure full history across all dates
      try {
        const res = await api.get("/orders");
        if (Array.isArray(res.data) && res.data.length > 0) {
          res.data.forEach((serverOrder) => {
            try {
              offlineStorage.saveOrder(serverOrder);
            } catch (_) {}
          });
          const fresh = offlineStorage.getOrders();
          setOrders(fresh);
        }
      } catch (apiErr) {
        console.log("Server sync optional / offline:", apiErr.message);
      }
    } catch (err) {
      console.error("Failed to load order history from storage:", err);
      setError(err.message || "Unable to load order history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 1. Immediately ensure freshest data on mount
    fetchOrders();
    const cachedSettings = offlineStorage.loadSettings();
    if (cachedSettings) setSettings(cachedSettings);

    // 2. Real-time reactive synchronization (captures order placed from Billing or another tab)
    const handleOrdersChange = () => {
      try {
        const fresh = offlineStorage.getOrders();
        setOrders(fresh);
      } catch (e) {
        console.error("Failed to refresh orders from storage:", e);
      }
    };

    const handleStorageEvent = (e) => {
      if (!e || e.key === "pos_offline_orders") {
        handleOrdersChange();
      }
    };

    const handleSettingsUpdate = () => {
      const cached = offlineStorage.loadSettings();
      if (cached) setSettings(cached);
    };

    window.addEventListener("ordersUpdated", handleOrdersChange);
    window.addEventListener("pos_orders_changed", handleOrdersChange);
    window.addEventListener("storage", handleStorageEvent);
    window.addEventListener("settingsUpdated", handleSettingsUpdate);

    return () => {
      window.removeEventListener("ordersUpdated", handleOrdersChange);
      window.removeEventListener("pos_orders_changed", handleOrdersChange);
      window.removeEventListener("storage", handleStorageEvent);
      window.removeEventListener("settingsUpdated", handleSettingsUpdate);
    };
  }, [fetchOrders]);

  const filteredOrders = React.useMemo(() => {
    if (!Array.isArray(orders)) return [];
    let list = orders;

    // Search query filter (Order number, customer name, phone, item name, or date substring)
    if (q) {
      const query = q.trim().toLowerCase();
      list = list.filter((o) => {
        const oNum = String(o.billNumber || o.orderNumber || o.receipt_no || "");
        const cName = String(o.customerName || o.customer_name || "").toLowerCase();
        const cPhone = String(o.customerPhone || o.customer_phone || "");
        const rawDate = o.paid_at || o.createdAt || o.created_at || o.date || "";
        const dStr = getLocalDateString(rawDate);
        const itemMatch = Array.isArray(o.items) && o.items.some(it => String(it.name || "").toLowerCase().includes(query));
        return oNum.includes(query) || cName.includes(query) || cPhone.includes(query) || dStr.includes(query) || itemMatch;
      });
    }

    // Filter by exact single Search Order Date if applied
    if (appliedSearchDate) {
      list = list.filter((o) => {
        const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
        return getLocalDateString(rawDate) === appliedSearchDate;
      });
    }

    // Filter by custom From / To date pickers if selected
    if (from || to) {
      list = list.filter((o) => {
        const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
        if (!rawDate) return false;
        const dStr = getLocalDateString(rawDate);
        if (from && dStr < from) return false;
        if (to && dStr > to) return false;
        return true;
      });
    }

    if (activeFilter === "all" || appliedSearchDate || (from && to)) return list;

    const todayStr = getLocalDateString(new Date());

    return list.filter((o) => {
      const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
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
  }, [orders, q, activeFilter, appliedSearchDate, from, to]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const paginatedOrders = React.useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * pageSize;
    return filteredOrders.slice(startIndex, startIndex + pageSize);
  }, [filteredOrders, safeCurrentPage, pageSize]);

  const reprint = (o) => printReceipt({ order: o, settings });

  const handleRefundOrder = () => {
    if (!refundTarget) return;
    try {
      offlineStorage.updateOrder(refundTarget.id, {
        paymentStatus: "Refunded",
        orderStatus: "Refunded",
      });
      setOrders(offlineStorage.getOrders());
      toast.success(`Bill #${refundTarget.billNumber || refundTarget.orderNumber || refundTarget.receipt_no} marked as Refunded`);
    } catch (err) {
      console.error("Failed to refund order", err);
      toast.error("Failed to process refund");
    } finally {
      setRefundTarget(null);
    }
  };

  const handleReorder = (order) => {
    if (!order || !Array.isArray(order.items) || order.items.length === 0) {
      toast.error("No items found to reorder");
      return;
    }
    try {
      offlineStorage.saveCart(order.items);
      toast.success(`Items from Order #${order.billNumber || order.orderNumber || order.receipt_no} added to cart`);
      navigate("/");
    } catch (err) {
      console.error("Failed to reorder:", err);
      toast.error("Failed to reorder items");
    }
  };

  const handleDeleteOrder = async () => {
    if (!deleteTarget || !deleteTarget.id) return;
    try {
      offlineStorage.deleteOrder(deleteTarget.id);
      try {
        await api.delete(`/orders/${deleteTarget.id}`);
      } catch (_) {}
      setOrders(offlineStorage.getOrders());
      toast.success(t("order_deleted_success") || "Order deleted successfully");
    } catch (err) {
      console.error("Failed to delete order", err);
      toast.error("Failed to delete order");
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleResetOrders = async () => {
    try {
      offlineStorage.resetOrders();
      try {
        await api.delete("/orders/reset");
      } catch (_) {}
      setOrders([]);
      resetToken();
      if (syncQueue && typeof syncQueue.clear === "function") {
        syncQueue.clear();
      }
      toast.success(t("orders_reset_success") || "All order records deleted successfully");
    } catch (err) {
      console.error("Failed to reset orders", err);
      toast.error("Failed to delete order records");
    } finally {
      setShowResetConfirm(false);
    }
  };

  return (
    <div className="h-full bg-[#FFFDF9] rounded-[16px] sm:rounded-[20px] md:rounded-[24px] lg:rounded-[32px] border border-[#F4E6D7] shadow-lg p-3 sm:p-4 md:p-5 lg:p-8 flex flex-col overflow-hidden">
      <div className="mb-3 md:mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 md:gap-4 shrink-0">
        <div>
          <div className="text-[11px] sm:text-[12px] md:text-[13px] lg:text-[15px] uppercase tracking-[0.1em] font-bold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">History</div>
          <h1 className="font-display text-lg sm:text-xl md:text-2xl lg:text-3xl font-extrabold tracking-tight mt-0.5">{t("order_history") || "Order History"}</h1>
        </div>

        <div className="flex items-center gap-1.5 p-1 bg-[#FFF8F2] border border-[#F4E6D7] rounded-full self-start sm:self-auto max-w-full overflow-x-auto" data-testid="date-filter-buttons">
          <button
            type="button"
            onClick={() => handleFilterChange("all")}
            data-testid="filter-btn-all"
            className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap cursor-pointer ${
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
            className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap cursor-pointer ${
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
            className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap cursor-pointer ${
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
            className={`px-2.5 sm:px-3 md:px-3.5 py-1 md:py-1.5 text-[10px] sm:text-[11px] md:text-xs font-bold tracking-wider rounded-full transition-all duration-200 whitespace-nowrap cursor-pointer ${
              activeFilter === "month"
                ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                : "bg-white text-slate-600 hover:text-slate-900 border border-[#F4E6D7]"
            }`}
          >
            THIS MONTH
          </button>
        </div>
      </div>

      <Card className="p-2.5 sm:p-3 md:p-3.5 border-border shadow-none mb-3 md:mb-4 shrink-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2 md:gap-2.5 items-end">
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-from" />
          </div>
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1">{t("to") || "To"}</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-to" />
          </div>
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1 truncate">Search Bill Number</label>
            <div className="flex gap-1.5">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 5" className="min-w-0 flex-1 text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-q" />
              <Button onClick={fetchOrders} variant="outline" className="border-border shrink-0 px-2.5 md:px-3 h-8 md:h-9 cursor-pointer" data-testid="filter-go"><Search className="w-3.5 h-3.5 md:w-4 md:h-4" /></Button>
            </div>
          </div>
          <div className="min-w-0">
            <label className="text-[10px] md:text-xs uppercase tracking-wider font-semibold block mb-0.5 md:mb-1 truncate">Search Order Date</label>
            <div className="flex gap-1.5">
              <Input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)} className="min-w-0 flex-1 text-[11px] md:text-xs h-8 md:h-9" data-testid="filter-search-date" />
              <Button onClick={handleSearchDate} variant="outline" className="border-border shrink-0 px-2.5 md:px-3 h-8 md:h-9 cursor-pointer" data-testid="filter-date-go"><Search className="w-3.5 h-3.5 md:w-4 md:h-4" /></Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="flex-1 border-[#F4E6D7] bg-white rounded-[16px] md:rounded-[22px] lg:rounded-[26px] shadow-sm overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-auto min-h-0 w-full">
          <table className="w-full text-[11px] sm:text-xs md:text-[13px] lg:text-sm text-left min-w-[700px]">
            <thead className="sticky top-0 z-10 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white text-[10px] md:text-[11.5px] lg:text-[12.5px] uppercase tracking-[0.12em] font-semibold">
              <tr>
                <th className="text-left px-3 py-2.5">BILL NUMBER</th>
                <th className="text-left px-3 py-2.5">{t("date") || "Date & Time"}</th>
                <th className="text-left px-3 py-2.5">Order Type / Table</th>
                <th className="text-left px-3 py-2.5">{t("items_col") || "Items"}</th>
                <th className="text-left px-3 py-2.5">{t("payment_col") || "Payment"}</th>
                <th className="text-left px-3 py-2.5">Order Status</th>
                <th className="text-right px-3 py-2.5">{t("total") || "Total"}</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F4E6D7]" data-testid="orders-table">
              {/* Error State: Explicitly handle storage/database failure */}
              {error ? (
                <tr>
                  <td colSpan="8" className="py-12 text-center">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-red-50 text-red-500 flex items-center justify-center border border-red-100">
                        <AlertCircle className="w-6 h-6" />
                      </div>
                      <div>
                        <div className="text-base font-bold text-red-600">
                          Unable to load order history
                        </div>
                        <p className="text-xs text-slate-500 mt-1 max-w-sm">
                          {error}
                        </p>
                      </div>
                      <Button
                        onClick={fetchOrders}
                        data-testid="retry-orders-btn"
                        className="bg-[#FF6B00] hover:bg-[#E05D00] text-white text-xs font-bold px-4 py-2 rounded-xl flex items-center gap-1.5 shadow-md shadow-orange-500/20 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan="8" className="text-center text-muted-foreground py-12 text-xs md:text-sm">
                    {loading ? "Loading orders..." : (t("no_bills_yet") || "No bills yet")}
                  </td>
                </tr>
              ) : (
                paginatedOrders.map((o) => {
                  const orderNum = o.billNumber || o.orderNumber || o.receipt_no;
                  const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
                  const dateDisplay = rawDate
                    ? new Date(rawDate).toLocaleString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: true,
                      })
                    : "—";

                  const orderTypeStr = (o.orderType || o.order_type || "dining").toLowerCase();
                  const isDining = orderTypeStr === "dining";
                  const tableStr = o.tableNumber || o.table_number;

                  let pm = (o.paymentMethod || o.payment_mode || "cash").toUpperCase();
                  const pStatus = (o.paymentStatus || o.payment_status || "Paid");
                  const isRefunded = pStatus === "Refunded";

                  const oStatus = o.orderStatus || o.order_status || "Completed";
                  const orderItems = Array.isArray(o.items) ? o.items : [];
                  const totalItemsCount = orderItems.reduce((acc, i) => acc + Number(i.quantity || i.qty || 1), 0);
                  const itemsSummary = orderItems.map((i) => `${t(i.name)} ×${i.quantity || i.qty || 1}`).join(", ");
                  const grandTotal = safeNumber(o.grandTotal !== undefined ? o.grandTotal : (o.total !== undefined ? o.total : 0));

                  return (
                    <tr key={o.id} className="hover:bg-[#FFF8F2] transition-colors" data-testid={`order-row-${o.id}`}>
                      {/* Order Number */}
                      <td className="px-3 py-2.5 font-mono font-bold text-xs md:text-[13px] text-slate-800 whitespace-nowrap">
                        #{orderNum}
                      </td>

                      {/* Date & Time */}
                      <td className="px-3 py-2.5 text-muted-foreground text-[10.5px] md:text-xs whitespace-nowrap">
                        {dateDisplay}
                      </td>

                      {/* Order Type & Table */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                          {isDining ? (
                            <UtensilsCrossed className="w-3.5 h-3.5 text-[#FF6B00]" />
                          ) : (
                            <Package className="w-3.5 h-3.5 text-amber-600" />
                          )}
                          <span>{isDining ? "Dine-in" : "Parcel"}</span>
                          {tableStr && (
                            <span className="text-[10px] font-mono font-bold text-[#FF6B00] bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded">
                              Table {tableStr}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Items */}
                      <td className="px-3 py-2.5 min-w-[200px] max-w-[340px]">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9.5px] font-bold uppercase tracking-wider bg-orange-50 border border-orange-200 text-[#FF6B00] px-1.5 py-0.5 rounded shrink-0">
                              {totalItemsCount} {totalItemsCount === 1 ? "Item" : "Items"}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {orderItems.map((i, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center gap-1 text-[11px] bg-slate-100 text-slate-800 px-2 py-0.5 rounded-md font-medium border border-slate-200/60 shadow-2xs"
                                title={i.name}
                              >
                                <span className="truncate max-w-[140px]">{t(i.name)}</span>
                                <span className="font-bold text-[#FF6B00]">×{i.quantity || i.qty || 1}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>

                      {/* Payment Method & Payment Status */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <span className="text-[9.5px] uppercase tracking-wider font-mono font-bold px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700">
                            {pm}
                          </span>
                          <span
                            className={`text-[9.5px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                              isRefunded
                                ? "bg-amber-100 text-amber-800 border border-amber-300"
                                : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            }`}
                          >
                            {pStatus}
                          </span>
                        </div>
                      </td>

                      {/* Order Status */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className={`text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full ${
                            oStatus === "Completed"
                              ? "bg-emerald-100 text-emerald-800"
                              : oStatus === "Ready"
                              ? "bg-blue-100 text-blue-800"
                              : oStatus === "Preparing"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {oStatus}
                        </span>
                      </td>

                      {/* Total */}
                      <td className="px-3 py-2.5 text-right font-mono font-extrabold text-xs md:text-sm text-slate-900 whitespace-nowrap">
                        ₹{safeFixed(grandTotal)}
                      </td>

                      {/* Actions: View, Print, Refund, Reorder */}
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="flex justify-end items-center gap-1">
                          {/* View */}
                          <button
                            onClick={() => setView(o)}
                            className="p-1.5 hover:bg-orange-50 rounded-lg text-slate-600 hover:text-[#FF6B00] transition-colors cursor-pointer"
                            data-testid={`view-${o.id}`}
                            title="View Details"
                          >
                            <Eye className="w-3.5 h-3.5 md:w-4 md:h-4" />
                          </button>

                          {/* Print */}
                          <button
                            onClick={() => reprint(o)}
                            className="p-1.5 hover:bg-orange-50 rounded-lg text-slate-600 hover:text-[#FF6B00] transition-colors cursor-pointer"
                            data-testid={`reprint-${o.id}`}
                            title="Print Receipt"
                          >
                            <Printer className="w-3.5 h-3.5 md:w-4 md:h-4" />
                          </button>

                          {/* Refund */}
                          {!isRefunded && (
                            <button
                              onClick={() => setRefundTarget(o)}
                              className="p-1.5 hover:bg-amber-50 rounded-lg text-amber-600 hover:text-amber-700 transition-colors cursor-pointer"
                              data-testid={`refund-${o.id}`}
                              title="Refund Order"
                            >
                              <RotateCcw className="w-3.5 h-3.5 md:w-4 md:h-4" />
                            </button>
                          )}

                          {/* Reorder */}
                          <button
                            onClick={() => handleReorder(o)}
                            className="p-1.5 hover:bg-emerald-50 rounded-lg text-emerald-600 hover:text-emerald-700 transition-colors cursor-pointer"
                            data-testid={`reorder-${o.id}`}
                            title="Reorder Items"
                          >
                            <Repeat className="w-3.5 h-3.5 md:w-4 md:h-4" />
                          </button>

                          {/* Delete */}
                          <button
                            onClick={() => setDeleteTarget(o)}
                            className="p-1.5 hover:bg-red-50 rounded-lg text-red-500 hover:text-red-700 transition-colors cursor-pointer"
                            data-testid={`delete-${o.id}`}
                            title="Delete Order"
                          >
                            <Trash2 className="w-3.5 h-3.5 md:w-4 md:h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="border-t border-[#F4E6D7] bg-[#FFFDF9] px-3 sm:px-4 py-2.5 sm:py-3 flex flex-col sm:flex-row items-center justify-between gap-2.5 text-xs text-slate-600 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <span>
              Showing{" "}
              <span className="font-bold text-slate-800">
                {filteredOrders.length === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1}
              </span>
              {" "}–{" "}
              <span className="font-bold text-slate-800">
                {Math.min(safeCurrentPage * pageSize, filteredOrders.length)}
              </span>
              {" "}of{" "}
              <span className="font-bold text-[#FF6B00]">{filteredOrders.length}</span> bills
            </span>
            <span className="text-slate-300">|</span>
            <div className="flex items-center gap-1.5">
              <span>Per page:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="bg-white border border-[#F4E6D7] rounded-md px-2 py-0.5 font-semibold text-slate-700 focus:outline-none focus:border-[#FF6B00] cursor-pointer"
                data-testid="page-size-select"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* First Page */}
            <button
              onClick={() => setCurrentPage(1)}
              disabled={safeCurrentPage <= 1}
              className="p-1.5 rounded-lg border border-[#F4E6D7] bg-white text-slate-600 hover:bg-orange-50 hover:text-[#FF6B00] disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
              title="First Page"
              data-testid="pagination-first"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>

            {/* Previous Page */}
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={safeCurrentPage <= 1}
              className="px-2.5 py-1 rounded-lg border border-[#F4E6D7] bg-white text-slate-600 hover:bg-orange-50 hover:text-[#FF6B00] disabled:opacity-30 disabled:pointer-events-none transition-colors flex items-center gap-1 font-semibold cursor-pointer"
              data-testid="pagination-prev"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>

            {/* Page number indicators */}
            <div className="flex items-center gap-1 px-2 font-mono font-bold text-xs text-slate-700">
              <span>Page</span>
              <span className="text-[#FF6B00] px-1.5 py-0.5 bg-orange-50 rounded border border-orange-200">
                {safeCurrentPage}
              </span>
              <span>of</span>
              <span>{totalPages}</span>
            </div>

            {/* Next Page */}
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={safeCurrentPage >= totalPages}
              className="px-2.5 py-1 rounded-lg border border-[#F4E6D7] bg-white text-slate-600 hover:bg-orange-50 hover:text-[#FF6B00] disabled:opacity-30 disabled:pointer-events-none transition-colors flex items-center gap-1 font-semibold cursor-pointer"
              data-testid="pagination-next"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            {/* Last Page */}
            <button
              onClick={() => setCurrentPage(totalPages)}
              disabled={safeCurrentPage >= totalPages}
              className="p-1.5 rounded-lg border border-[#F4E6D7] bg-white text-slate-600 hover:bg-orange-50 hover:text-[#FF6B00] disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
              title="Last Page"
              data-testid="pagination-last"
            >
              <ChevronsRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </Card>

      {/* View Order Dialog */}
      {view && (
        <Dialog open={true} onOpenChange={(o) => !o && setView(null)}>
          <DialogContent className="w-[92vw] max-w-lg max-h-[90vh] overflow-y-auto flex flex-col bg-neutral-50 p-4 sm:p-6 border border-border rounded-[24px]">
            <DialogHeader className="w-full text-center mb-2">
              <DialogTitle className="font-display text-base md:text-lg text-neutral-800">
                {t("order_details") || "Order Details"} — Bill #{view.billNumber || view.orderNumber || view.receipt_no}
              </DialogTitle>
            </DialogHeader>

            {/* Complete Itemized Breakdown */}
            <div className="w-full bg-white rounded-xl p-3 border border-[#F4E6D7] mb-3 shadow-2xs text-xs space-y-2">
              <div className="font-bold text-slate-800 uppercase tracking-wider text-[11px] border-b pb-1.5 flex justify-between">
                <span>All Items in this Order ({Array.isArray(view.items) ? view.items.length : 0})</span>
                <span className="text-slate-500 font-normal">
                  {view.paid_at || view.createdAt || view.created_at ? new Date(view.paid_at || view.createdAt || view.created_at).toLocaleDateString('en-IN') : ""}
                </span>
              </div>
              <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto pr-1">
                {Array.isArray(view.items) && view.items.map((it, idx) => (
                  <div key={idx} className="py-1.5 flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 text-[12px]">{t(it.name)}</div>
                      {it.thali_selections && (
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {typeof it.thali_selections === 'string' ? it.thali_selections : Object.values(it.thali_selections).flat().join(', ')}
                        </div>
                      )}
                    </div>
                    <div className="text-right whitespace-nowrap">
                      <span className="font-bold text-[#FF6B00]">×{it.quantity || it.qty || 1}</span>
                      <span className="text-slate-500 ml-2 font-mono">₹{safeFixed(it.price * (it.quantity || it.qty || 1))}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t pt-2 flex justify-between font-bold text-slate-900 text-sm">
                <span>Grand Total</span>
                <span className="text-[#FF6B00] font-mono">₹{safeFixed(view.grandTotal || view.total)}</span>
              </div>
            </div>

            <div className="flex justify-center w-full">
              <ReceiptPreview order={view} settings={settings} />
            </div>
            <div className="flex gap-2 w-full mt-4">
              <Button onClick={() => reprint(view)} className="flex-1 bg-[#FF6B00] hover:bg-[#E05D00] text-white text-xs md:text-sm font-bold py-2.5 rounded-xl cursor-pointer" data-testid="dialog-reprint">
                <Printer className="w-4 h-4 mr-2" /> {t("reprint") || "Reprint Receipt"}
              </Button>
              <Button variant="outline" onClick={() => setView(null)} className="px-4 text-xs md:text-sm font-bold py-2.5 rounded-xl cursor-pointer">
                Close
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Confirm Refund Dialog */}
      <ConfirmDialog
        open={!!refundTarget}
        onClose={() => setRefundTarget(null)}
        onConfirm={handleRefundOrder}
        title="Refund this order?"
        message={`Are you sure you want to mark Bill #${refundTarget?.billNumber || refundTarget?.orderNumber || refundTarget?.receipt_no} as Refunded? Total amount: ₹${safeFixed(refundTarget?.grandTotal || refundTarget?.total)}.`}
        confirmText="Refund"
        cancelText="Cancel"
        variant="warning"
      />

      {/* Confirm Delete Dialog */}
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

      {/* Confirm Reset Dialog */}
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
