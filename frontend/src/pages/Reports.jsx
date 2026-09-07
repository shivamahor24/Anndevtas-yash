import React, { useCallback, useEffect, useState } from "react";
import api, { API, tokenStore } from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Download, FileSpreadsheet, FileText, BarChart3, Sparkles, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../context/LanguageContext";
import { safeArray } from "../lib/safeArray";

const REPORT_TABS = [
  { key: "sales", label: "Daily Sales", icon: ShoppingBag },
  { key: "products", label: "Products", icon: BarChart3 },
  { key: "thalis", label: "Thalis", icon: Sparkles },
];

const PERIODS = [
  { key: "today", label: "Today", days: 0 },
  { key: "week", label: "Last 7 days", days: 7 },
  { key: "month", label: "Last 30 days", days: 30 },
  { key: "custom", label: "Custom" },
];

const toIso = (dt, endOfDay = false) => {
  const d = new Date(dt);
  if (endOfDay) d.setHours(23, 59, 59, 999); else d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export default function Reports() {
  const { t } = useLanguage();
  const [tab, setTab] = useState("sales");
  const [periodKey, setPeriodKey] = useState("week");
  const [customFrom, setCustomFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState([]);
  const [thaliPicks, setThaliPicks] = useState([]);

  const fromIso = periodKey === "custom" ? toIso(customFrom) : toIso(new Date(Date.now() - PERIODS.find(p => p.key === periodKey).days * 86400000));
  const toIsoStr = periodKey === "custom" ? toIso(customTo, true) : toIso(new Date(), true);

  const fetch = useCallback(async () => {
    try {
      const params = { from_date: fromIso, to_date: toIsoStr };
      if (tab === "sales") {
        const { data } = await api.get("/reports/sales", { params });
        setRows(safeArray(data)); setThaliPicks([]);
      } else if (tab === "products") {
        const { data } = await api.get("/reports/products", { params });
        setRows(safeArray(data)); setThaliPicks([]);
      } else {
        const { data } = await api.get("/reports/thalis", { params });
        setRows(safeArray(data?.thalis)); setThaliPicks(safeArray(data?.selection_picks));
      }
    } catch (e) {
      console.error("Report load failed", e);
      setRows([]);
      setThaliPicks([]);
    }
  }, [tab, fromIso, toIsoStr]);

  useEffect(() => { fetch(); }, [fetch]);

  const download = async (fmt) => {
    try {
      const token = await tokenStore.getAccess();
      const url = `${API}/reports/export/${tab}.${fmt}?from_date=${encodeURIComponent(fromIso)}&to_date=${encodeURIComponent(toIsoStr)}`;
      const res = await window.fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${tab}_${fromIso.slice(0, 10)}_${toIsoStr.slice(0, 10)}.${fmt}`;
      link.click();
      URL.revokeObjectURL(link.href);
      toast.success(`${t("exported")} ${fmt.toUpperCase()}`);
    } catch (e) {
      toast.error(e.message || "Export failed");
    }
  };

  return (
    <div className="h-full
    bg-[#FFFDF9]
    rounded-[20px] md:rounded-[28px] lg:rounded-[32px]
    border
    border-[#F4E6D7]
    shadow-lg
    p-4 sm:p-5 md:p-6 lg:p-8
    flex
    flex-col
    overflow-hidden
  ">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-[15px]
          uppercase
          tracking-[0.1em]
          font-bold
          bg-gradient-to-r
          from-[#FF8A3D] to-[#FF6B00]
          bg-clip-text
          text-transparent">Analytics</div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900">{t("nav_reports")}</h1>
        </div>
        <div className="flex gap-2 items-center">
          <Button onClick={() => download("csv")} variant="outline" className="text-white border-[#F4E6D7] bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-[#FFF8F2] rounded-xl" data-testid="export-csv">
            <FileText className="w-4 h-4 mr-2" /> {t("export_csv")}
          </Button>
          <Button onClick={() => download("xlsx")} className="bg-gradient-to-r from-[#78A61A] to-[#5F9210] hover:brightness-105 rounded-xl" data-testid="export-excel">
            <FileSpreadsheet className="w-4 h-4 mr-2" /> {t("export_excel")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-7 p-2 bg-[#FFF8F2] border border-[#F4E6D7] rounded-full" data-testid="report-tabs">
          {REPORT_TABS.map(tTab => {
            let label = tTab.label;
            if (tTab.key === "sales") label = t("tab_sales");
            if (tTab.key === "products") label = t("tab_products");
            if (tTab.key === "thalis") label = t("tab_thali");
            return (
              <button key={tTab.key} onClick={() => setTab(tTab.key)} data-testid={`report-${tTab.key}`}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all ${tab === tTab.key ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white" : "text-muted-foreground hover:text-foreground"
                  }`}>
                <tTab.icon className="w-3.5 h-3.5" /> {label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-7 p-2 bg-[#FFF8F2] border border-[#F4E6D7] rounded-full" data-testid="period-tabs">
          {PERIODS.map(p => {
            let label = p.label;
            if (p.key === "today") label = t("today");
            if (p.key === "week") label = t("last_7_days");
            if (p.key === "month") label = t("last_30_days");
            if (p.key === "custom") label = t("custom_range");
            return (
              <button key={p.key} onClick={() => setPeriodKey(p.key)} data-testid={`rperiod-${p.key}`}
                className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all ${periodKey === p.key ? "bg-gradient-to-r from-[#78A61A] to-[#5F9210] text-white" : "text-muted-foreground hover:text-foreground"
                  }`}>
                {label}
              </button>
            );
          })}
        </div>

        {periodKey === "custom" && (
          <div className="flex gap-2 items-center">
            <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-40" data-testid="custom-from" />
            <span className="text-muted-foreground text-xs">{t("to")}</span>
            <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-40" data-testid="custom-to" />
          </div>
        )}
      </div>

      <Card className="flex-1 flex flex-col min-h-0 rounded-[26px] border-[#F4E6D7] bg-white shadow-sm overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "sales" && (
          <table className="w-full text-sm">
            <thead className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white text-[13px] uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-4 py-3">{t("receipt_no_col")}</th>
                <th className="text-left px-4 py-3">{t("date_col")}</th>
                <th className="text-left px-4 py-3">{t("payment_col")}</th>
                <th className="text-right px-4 py-3">{t("subtotal")}</th>
                <th className="text-right px-4 py-3">CGST</th>
                <th className="text-right px-4 py-3">SGST</th>
                <th className="text-right px-4 py-3">Total Tax</th>
                <th className="text-right px-4 py-3">{t("total")}</th>
              </tr>
            </thead>
            <tbody data-testid="sales-table">
              {rows.map(o => {
                let paymentModeLabel = o.payment_mode;
                if (o.payment_mode === "cash") paymentModeLabel = t("cash");
                if (o.payment_mode === "upi") paymentModeLabel = t("upi");
                if (o.payment_mode === "card") paymentModeLabel = t("card");
                const taxVal = Number(o.tax || 0);
                const cgstVal = o.cgst !== undefined ? Number(o.cgst) : Number((taxVal / 2).toFixed(2));
                const sgstVal = o.sgst !== undefined ? Number(o.sgst) : Number((taxVal - cgstVal).toFixed(2));
                return (
                  <tr key={o.id} className="border-t border-border">
                    <td className="px-4 py-3 font-mono font-semibold">{o.receipt_no}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(o.paid_at).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 uppercase text-xs font-mono">{paymentModeLabel}</td>
                    <td className="px-4 py-3 text-right font-mono">₹{o.subtotal}</td>
                    <td className="px-4 py-3 text-right font-mono">₹{cgstVal.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-mono">₹{sgstVal.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-mono">₹{taxVal.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">₹{o.total}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan="8" className="text-center text-muted-foreground py-10">{t("no_sales_in_period")}</td></tr>}
            </tbody>
          </table>
        )}

        {tab === "products" && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 text-white border-[#F4E6D7] bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-[#FFF8F2] text-[11px] uppercase font-semibold tracking-[0.18em] text-slate-500">
              <tr>
                <th className="text-left px-4 py-3">Sr.</th>
                <th className="text-left px-4 py-3">{t("item")}</th>
                <th className="text-right px-4 py-3">{t("qty_sold")}</th>
                <th className="text-right px-4 py-3">{t("revenue")}</th>
              </tr>
            </thead>
            <tbody data-testid="products-table">
              {rows.map((it, i) => (
                <tr key={it.name} className="border-t border-[#F4E6D7] hover:bg-[#FFF8F2]">
                  <td className="px-4 py-3 font-mono text-muted-foreground">{i + 1}</td>
                  <td className="px-4 py-3 font-medium">{t(it.name)}</td>
                  <td className="px-4 py-3 text-right font-mono">{it.qty}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">₹{it.revenue}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan="4" className="text-center text-muted-foreground py-10">{t("no_items_sold")}</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "thalis" && (
          <div>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 text-white border-[#F4E6D7] bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-[#FFF8F2] text-[11px] uppercase font-semibold tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="text-left px-4 py-3">Sr.</th>
                  <th className="text-left px-4 py-3">{t("thali")}</th>
                  <th className="text-right px-4 py-3">{t("qty_sold")}</th>
                  <th className="text-right px-4 py-3">{t("revenue")}</th>
                </tr>
              </thead>
              <tbody data-testid="thalis-table">
                {rows.map((it, i) => (
                  <tr key={it.name} className="border-t border-border">
                    <td className="px-4 py-3 font-mono text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">{t(it.name)}</td>
                    <td className="px-4 py-3 text-right font-mono">{it.qty}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">₹{it.revenue}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan="4" className="text-center text-muted-foreground py-10">{t("no_thalis_sold")}</td></tr>}
              </tbody>
            </table>
            {thaliPicks.length > 0 && (
              <div className="p-4 border-t border-border bg-sand-subtle">
                <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2 font-semibold">{t("popular_thali_selections")}</div>
                <div className="flex flex-wrap gap-2">
                  {thaliPicks.slice(0, 20).map((p) => (
                    <span key={p.name} className="text-xs px-2.5 py-1 rounded-md bg-white border border-border">
                      {t(p.name)} <span className="font-mono text-muted-foreground">×{p.qty}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </Card>
    </div>
  );
}
