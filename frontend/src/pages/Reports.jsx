import React, { useCallback, useEffect, useState } from "react";
import api, { API, tokenStore } from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Download, FileSpreadsheet, FileText, BarChart3, Sparkles, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../context/LanguageContext";
import { safeArray } from "../lib/safeArray";
import { offlineStorage, getOrders } from "../lib/offlineStorage";

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

import { safeNumber, safeFixed } from "../lib/utils";
import * as XLSX from "xlsx";

export default function Reports() {
  const { t } = useLanguage();
  const [tab, setTab] = useState("sales");
  const [periodKey, setPeriodKey] = useState("week");
  const [customFrom, setCustomFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [salesRows, setSalesRows] = useState([]);
  const [productRows, setProductRows] = useState([]);
  const [thaliRows, setThaliRows] = useState([]);
  const [thaliPicks, setThaliPicks] = useState([]);

  const salesTotals = React.useMemo(() => {
    return salesRows.reduce(
      (acc, r) => {
        acc.count += 1;
        acc.subtotal += safeNumber(r.subtotal);
        acc.cgst += safeNumber(r.cgst);
        acc.sgst += safeNumber(r.sgst);
        acc.tax += safeNumber(r.tax);
        acc.total += safeNumber(r.total);
        const mode = (r.payment_mode || "cash").toLowerCase();
        if (mode === "cash") acc.cash += safeNumber(r.total);
        else if (mode === "upi") acc.upi += safeNumber(r.total);
        else if (mode === "card") acc.card += safeNumber(r.total);
        else acc.other += safeNumber(r.total);
        return acc;
      },
      { count: 0, subtotal: 0, cgst: 0, sgst: 0, tax: 0, total: 0, cash: 0, upi: 0, card: 0, other: 0 }
    );
  }, [salesRows]);

  const productTotals = React.useMemo(() => {
    return productRows.reduce(
      (acc, r) => {
        acc.count += 1;
        acc.qty += safeNumber(r.qty);
        acc.revenue += safeNumber(r.revenue);
        return acc;
      },
      { count: 0, qty: 0, revenue: 0 }
    );
  }, [productRows]);

  const thaliTotals = React.useMemo(() => {
    return thaliRows.reduce(
      (acc, r) => {
        acc.count += 1;
        acc.qty += safeNumber(r.qty);
        acc.revenue += safeNumber(r.revenue);
        return acc;
      },
      { count: 0, qty: 0, revenue: 0 }
    );
  }, [thaliRows]);

  const fromIso = periodKey === "custom" ? toIso(customFrom) : toIso(new Date(Date.now() - PERIODS.find(p => p.key === periodKey).days * 86400000));
  const toIsoStr = periodKey === "custom" ? toIso(customTo, true) : toIso(new Date(), true);

  const fetch = useCallback(async () => {
    try {
      // 1. Single Source of Truth: Read all saved orders from centralized offlineStorage
      const allOrders = offlineStorage.getOrders();

      // Filter orders within the selected ISO range
      const filteredOrders = allOrders.filter((o) => {
        const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
        if (!rawDate) return false;
        const dIso = new Date(rawDate).toISOString();
        return dIso >= fromIso && dIso <= toIsoStr;
      });

      // 2. Compute Sales Rows
      const sRows = filteredOrders.map((o) => {
        const subtotal = safeNumber(o.subtotal);
        const taxVal = safeNumber(o.tax !== undefined ? o.tax : (safeNumber(o.cgst) + safeNumber(o.sgst)));
        const cgstVal = safeNumber(o.cgst !== undefined ? o.cgst : (taxVal / 2));
        const sgstVal = safeNumber(o.sgst !== undefined ? o.sgst : (taxVal - cgstVal));
        const total = safeNumber(o.grandTotal !== undefined ? o.grandTotal : o.total);
        return {
          id: o.id,
          receipt_no: o.billNumber || o.orderNumber || o.receipt_no || "—",
          paid_at: o.paid_at || o.createdAt || o.created_at,
          payment_mode: (o.paymentMethod || o.payment_mode || "cash").toLowerCase(),
          subtotal,
          cgst: cgstVal,
          sgst: sgstVal,
          tax: taxVal,
          total,
        };
      });

      // 3. Compute Product Rows
      const itemMap = new Map();
      filteredOrders.forEach((o) => {
        const items = Array.isArray(o.items) ? o.items : [];
        items.forEach((it) => {
          const name = it.name || "Item";
          const qty = safeNumber(it.quantity || it.qty, 1);
          const price = safeNumber(it.price, 0);
          const ebCharge = safeNumber(it.extra_bread_charge, 0);
          const rev = safeNumber(it.revenue !== undefined ? it.revenue : (it.total !== undefined ? it.total : (price * qty + ebCharge * qty)));
          if (!itemMap.has(name)) {
            itemMap.set(name, { name, qty: 0, revenue: 0 });
          }
          const cur = itemMap.get(name);
          cur.qty += qty;
          cur.revenue += rev;
        });
      });
      const pRows = Array.from(itemMap.values()).sort((a, b) => b.revenue - a.revenue);

      // 4. Compute Thali Rows & Selections
      const thaliMap = new Map();
      const picksMap = new Map();
      filteredOrders.forEach((o) => {
        const items = Array.isArray(o.items) ? o.items : [];
        items.forEach((it) => {
          const isThali = Boolean(it.is_thali || it.category === "THALI" || it.category_name === "THALI" || (it.name && it.name.toLowerCase().includes("thali")));
          if (isThali) {
            const name = it.name || "Thali";
            const qty = safeNumber(it.quantity || it.qty, 1);
            const price = safeNumber(it.price, 0);
            const ebCharge = safeNumber(it.extra_bread_charge, 0);
            const rev = safeNumber(it.revenue !== undefined ? it.revenue : (it.total !== undefined ? it.total : (price * qty + ebCharge * qty)));
            if (!thaliMap.has(name)) {
              thaliMap.set(name, { name, qty: 0, revenue: 0 });
            }
            const cur = thaliMap.get(name);
            cur.qty += qty;
            cur.revenue += rev;

            // Aggregate selection picks
            if (it.thali_selections && typeof it.thali_selections === "object") {
              Object.values(it.thali_selections).forEach((val) => {
                const arr = Array.isArray(val) ? val : [val];
                arr.forEach((subName) => {
                  if (typeof subName === "string" && subName.trim()) {
                    const clean = subName.trim();
                    picksMap.set(clean, (picksMap.get(clean) || 0) + qty);
                  }
                });
              });
            }
          }
        });
      });
      const tRows = Array.from(thaliMap.values()).sort((a, b) => b.revenue - a.revenue);
      const picksList = Array.from(picksMap.entries()).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);

      setSalesRows(sRows);
      setProductRows(pRows);
      setThaliRows(tRows);
      setThaliPicks(picksList);
    } catch (e) {
      console.error("Report calculation error:", e);
      setSalesRows([]);
      setProductRows([]);
      setThaliRows([]);
      setThaliPicks([]);
    }
  }, [fromIso, toIsoStr]);

  useEffect(() => {
    fetch();

    const handleOrdersChange = () => {
      fetch();
    };

    window.addEventListener("ordersUpdated", handleOrdersChange);
    window.addEventListener("pos_orders_changed", handleOrdersChange);
    return () => {
      window.removeEventListener("ordersUpdated", handleOrdersChange);
      window.removeEventListener("pos_orders_changed", handleOrdersChange);
    };
  }, [fetch]);

  const downloadClientCsv = () => {
    let csvContent = "";
    if (tab === "sales") {
      csvContent = "Bill Number,Date,Payment Mode,Subtotal,CGST,SGST,Total Tax,Total\n";
      salesRows.forEach((r) => {
        csvContent += `${r.receipt_no},"${new Date(r.paid_at).toLocaleDateString("en-IN")}",${r.payment_mode},${safeFixed(r.subtotal)},${safeFixed(r.cgst)},${safeFixed(r.sgst)},${safeFixed(r.tax)},${safeFixed(r.total)}\n`;
      });
      if (salesRows.length > 0) {
        csvContent += `TOTAL,${salesTotals.count} Bills,—,${safeFixed(salesTotals.subtotal)},${safeFixed(salesTotals.cgst)},${safeFixed(salesTotals.sgst)},${safeFixed(salesTotals.tax)},${safeFixed(salesTotals.total)}\n`;
        csvContent += `\n`;
        csvContent += `"--- AGGREGATE TOTALS SUMMARY ---"\n`;
        csvContent += `"Total Number of Bills",${salesTotals.count}\n`;
        csvContent += `"Total Taxable Amount (Subtotal)",${safeFixed(salesTotals.subtotal)}\n`;
        csvContent += `"Total CGST Collected",${safeFixed(salesTotals.cgst)}\n`;
        csvContent += `"Total SGST Collected",${safeFixed(salesTotals.sgst)}\n`;
        csvContent += `"Total Tax Collected",${safeFixed(salesTotals.tax)}\n`;
        csvContent += `"Total Amount Collected (Gross Sales)",${safeFixed(salesTotals.total)}\n`;
        csvContent += `\n`;
        csvContent += `"--- PAYMENT MODE BREAKDOWN ---"\n`;
        csvContent += `"Total Cash Collected",${safeFixed(salesTotals.cash)}\n`;
        csvContent += `"Total UPI Collected",${safeFixed(salesTotals.upi)}\n`;
        csvContent += `"Total Card Collected",${safeFixed(salesTotals.card)}\n`;
      }
    } else if (tab === "products") {
      csvContent = "Sr,Item,Qty Sold,Revenue\n";
      productRows.forEach((r, i) => {
        csvContent += `${i + 1},"${r.name}",${safeNumber(r.qty)},${safeFixed(r.revenue)}\n`;
      });
      if (productRows.length > 0) {
        csvContent += `TOTAL,${productTotals.count} Items,${safeNumber(productTotals.qty)},${safeFixed(productTotals.revenue)}\n`;
        csvContent += `\n`;
        csvContent += `"--- AGGREGATE TOTALS SUMMARY ---"\n`;
        csvContent += `"Total Number of Items",${productTotals.count}\n`;
        csvContent += `"Total Quantity Sold",${safeNumber(productTotals.qty)}\n`;
        csvContent += `"Total Revenue Collected",${safeFixed(productTotals.revenue)}\n`;
      }
    } else {
      csvContent = "Sr,Thali,Qty Sold,Revenue\n";
      thaliRows.forEach((r, i) => {
        csvContent += `${i + 1},"${r.name}",${safeNumber(r.qty)},${safeFixed(r.revenue)}\n`;
      });
      if (thaliRows.length > 0) {
        csvContent += `TOTAL,${thaliTotals.count} Thalis,${safeNumber(thaliTotals.qty)},${safeFixed(thaliTotals.revenue)}\n`;
        csvContent += `\n`;
        csvContent += `"--- AGGREGATE TOTALS SUMMARY ---"\n`;
        csvContent += `"Total Number of Thalis",${thaliTotals.count}\n`;
        csvContent += `"Total Quantity Sold",${safeNumber(thaliTotals.qty)}\n`;
        csvContent += `"Total Revenue Collected",${safeFixed(thaliTotals.revenue)}\n`;
      }
    }
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${tab}_report_${fromIso.slice(0, 10)}_to_${toIsoStr.slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast.success(`${t("exported") || "Exported"} CSV`);
  };

  const downloadClientXlsx = () => {
    let data = [];
    let summaryRows = [];
    if (tab === "sales") {
      data = salesRows.map((r) => ({
        "Bill Number": r.receipt_no,
        "Date": new Date(r.paid_at).toLocaleDateString("en-IN"),
        "Payment Mode": (r.payment_mode || "cash").toUpperCase(),
        "Subtotal": Number(safeFixed(r.subtotal)),
        "CGST": Number(safeFixed(r.cgst)),
        "SGST": Number(safeFixed(r.sgst)),
        "Total Tax": Number(safeFixed(r.tax)),
        "Total": Number(safeFixed(r.total)),
      }));
      if (salesRows.length > 0) {
        data.push({
          "Bill Number": "TOTAL",
          "Date": `${salesTotals.count} Bills`,
          "Payment Mode": "—",
          "Subtotal": Number(safeFixed(salesTotals.subtotal)),
          "CGST": Number(safeFixed(salesTotals.cgst)),
          "SGST": Number(safeFixed(salesTotals.sgst)),
          "Total Tax": Number(safeFixed(salesTotals.tax)),
          "Total": Number(safeFixed(salesTotals.total)),
        });
        summaryRows = [
          [],
          ["--- AGGREGATE TOTALS SUMMARY ---"],
          ["Total Number of Bills", salesTotals.count],
          ["Total Subtotal (Taxable Amount)", Number(safeFixed(salesTotals.subtotal))],
          ["Total CGST Collected", Number(safeFixed(salesTotals.cgst))],
          ["Total SGST Collected", Number(safeFixed(salesTotals.sgst))],
          ["Total Tax Collected", Number(safeFixed(salesTotals.tax))],
          ["Total Amount Collected (Gross Sales)", Number(safeFixed(salesTotals.total))],
          [],
          ["--- PAYMENT MODE BREAKDOWN ---"],
          ["Total Cash Collected", Number(safeFixed(salesTotals.cash))],
          ["Total UPI Collected", Number(safeFixed(salesTotals.upi))],
          ["Total Card Collected", Number(safeFixed(salesTotals.card))],
        ];
      }
    } else if (tab === "products") {
      data = productRows.map((r, i) => ({
        "Sr": i + 1,
        "Item": r.name,
        "Qty Sold": safeNumber(r.qty),
        "Revenue": Number(safeFixed(r.revenue)),
      }));
      if (productRows.length > 0) {
        data.push({
          "Sr": "TOTAL",
          "Item": `${productTotals.count} Items`,
          "Qty Sold": safeNumber(productTotals.qty),
          "Revenue": Number(safeFixed(productTotals.revenue)),
        });
        summaryRows = [
          [],
          ["--- AGGREGATE TOTALS SUMMARY ---"],
          ["Total Number of Items", productTotals.count],
          ["Total Quantity Sold", safeNumber(productTotals.qty)],
          ["Total Revenue Collected", Number(safeFixed(productTotals.revenue))],
        ];
      }
    } else {
      data = thaliRows.map((r, i) => ({
        "Sr": i + 1,
        "Thali": r.name,
        "Qty Sold": safeNumber(r.qty),
        "Revenue": Number(safeFixed(r.revenue)),
      }));
      if (thaliRows.length > 0) {
        data.push({
          "Sr": "TOTAL",
          "Thali": `${thaliTotals.count} Thalis`,
          "Qty Sold": safeNumber(thaliTotals.qty),
          "Revenue": Number(safeFixed(thaliTotals.revenue)),
        });
        summaryRows = [
          [],
          ["--- AGGREGATE TOTALS SUMMARY ---"],
          ["Total Number of Thalis", thaliTotals.count],
          ["Total Quantity Sold", safeNumber(thaliTotals.qty)],
          ["Total Revenue Collected", Number(safeFixed(thaliTotals.revenue))],
        ];
      }
    }
    const ws = XLSX.utils.json_to_sheet(data);
    if (summaryRows.length > 0) {
      XLSX.utils.sheet_add_aoa(ws, summaryRows, { origin: -1 });
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tab.toUpperCase());
    XLSX.writeFile(wb, `${tab}_report_${fromIso.slice(0, 10)}_to_${toIsoStr.slice(0, 10)}.xlsx`);
    toast.success(`${t("exported") || "Exported"} Excel`);
  };

  const download = (fmt) => {
    if (fmt === "xlsx") {
      downloadClientXlsx();
    } else {
      downloadClientCsv();
    }
  };

  return (
    <div className="h-full bg-[#FFFDF9] rounded-[20px] md:rounded-[28px] lg:rounded-[32px] border border-[#F4E6D7] shadow-lg p-4 sm:p-5 md:p-6 lg:p-8 flex flex-col overflow-hidden">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-[15px] uppercase tracking-[0.1em] font-bold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">Analytics</div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900">{t("nav_reports") || "Reports"}</h1>
        </div>
        <div className="flex gap-2 items-center">
          <Button onClick={() => download("csv")} variant="outline" className="text-white border-[#F4E6D7] bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-[#FFF8F2] rounded-xl cursor-pointer" data-testid="export-csv">
            <FileText className="w-4 h-4 mr-2" /> {t("export_csv") || "Export CSV"}
          </Button>
          <Button onClick={() => download("xlsx")} className="bg-gradient-to-r from-[#78A61A] to-[#5F9210] hover:brightness-105 rounded-xl cursor-pointer" data-testid="export-excel">
            <FileSpreadsheet className="w-4 h-4 mr-2" /> {t("export_excel") || "Export Excel"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-7 p-2 bg-[#FFF8F2] border border-[#F4E6D7] rounded-full" data-testid="report-tabs">
          {REPORT_TABS.map(tTab => {
            let label = tTab.label;
            if (tTab.key === "sales") label = t("tab_sales") || "Daily Sales";
            if (tTab.key === "products") label = t("tab_products") || "Products";
            if (tTab.key === "thalis") label = t("tab_thali") || "Thalis";
            return (
              <button key={tTab.key} onClick={() => setTab(tTab.key)} data-testid={`report-${tTab.key}`}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all cursor-pointer ${tab === tTab.key ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white" : "text-muted-foreground hover:text-foreground"
                  }`}>
                <tTab.icon className="w-3.5 h-3.5" /> {label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-7 p-2 bg-[#FFF8F2] border border-[#F4E6D7] rounded-full" data-testid="period-tabs">
          {PERIODS.map(p => {
            let label = p.label;
            if (p.key === "today") label = t("today") || "Today";
            if (p.key === "week") label = t("last_7_days") || "Last 7 days";
            if (p.key === "month") label = t("last_30_days") || "Last 30 days";
            if (p.key === "custom") label = t("custom_range") || "Custom Range";
            return (
              <button key={p.key} onClick={() => setPeriodKey(p.key)} data-testid={`rperiod-${p.key}`}
                className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all cursor-pointer ${periodKey === p.key ? "bg-gradient-to-r from-[#78A61A] to-[#5F9210] text-white" : "text-muted-foreground hover:text-foreground"
                  }`}>
                {label}
              </button>
            );
          })}
        </div>

        {periodKey === "custom" && (
          <div className="flex gap-2 items-center">
            <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="w-40" data-testid="custom-from" />
            <span className="text-muted-foreground text-xs">{t("to") || "to"}</span>
            <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="w-40" data-testid="custom-to" />
          </div>
        )}
      </div>

      <Card className="flex-1 overflow-hidden rounded-2xl border-[#F4E6D7] bg-white flex flex-col">
        <div className="flex-1 overflow-y-auto">
          {tab === "sales" && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-semibold tracking-[0.18em]">
                <tr>
                  <th className="text-left px-4 py-3">BILL NUMBER</th>
                  <th className="text-left px-4 py-3">{t("date_col") || "Date & Time"}</th>
                  <th className="text-left px-4 py-3">{t("payment_col") || "Payment"}</th>
                  <th className="text-right px-4 py-3">{t("subtotal") || "Subtotal"}</th>
                  <th className="text-right px-4 py-3">CGST</th>
                  <th className="text-right px-4 py-3">SGST</th>
                  <th className="text-right px-4 py-3">Total Tax</th>
                  <th className="text-right px-4 py-3">{t("total") || "Total"}</th>
                </tr>
              </thead>
              <tbody data-testid="sales-table">
                {salesRows.map(o => {
                  let paymentModeLabel = (o.payment_mode || "cash").toUpperCase();
                  if (o.payment_mode === "cash") paymentModeLabel = t("cash") || "CASH";
                  if (o.payment_mode === "upi") paymentModeLabel = t("upi") || "UPI";
                  if (o.payment_mode === "card") paymentModeLabel = t("card") || "CARD";
                  return (
                    <tr key={o.id || o.receipt_no} className="border-t border-border hover:bg-[#FFF8F2]">
                      <td className="px-4 py-3 font-mono font-semibold">#{o.receipt_no}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(o.paid_at).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 uppercase text-xs font-mono font-bold">{paymentModeLabel}</td>
                      <td className="px-4 py-3 text-right font-mono">₹{safeFixed(o.subtotal)}</td>
                      <td className="px-4 py-3 text-right font-mono">₹{safeFixed(o.cgst)}</td>
                      <td className="px-4 py-3 text-right font-mono">₹{safeFixed(o.sgst)}</td>
                      <td className="px-4 py-3 text-right font-mono">₹{safeFixed(o.tax)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">₹{safeFixed(o.total)}</td>
                    </tr>
                  );
                })}
                {salesRows.length === 0 && <tr><td colSpan="8" className="text-center text-muted-foreground py-10">{t("no_sales_in_period") || "No sales found for this period"}</td></tr>}
              </tbody>
              {salesRows.length > 0 && (
                <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-b-2 border-[#FF8A3D] shadow-[0_-4px_12px_rgba(0,0,0,0.06)]" data-testid="sales-total-row">
                  <tr className="border-t-2 border-b-2 border-[#FF8A3D]">
                    <td className="px-4 py-3.5 font-mono font-black tracking-wider text-[#FF6B00] text-sm">TOTAL :</td>
                    <td className="px-4 py-3.5 text-xs font-bold text-slate-800">{salesTotals.count} {salesTotals.count === 1 ? (t("bill") || "Bill") : (t("bills") || "Bills")}</td>
                    <td className="px-4 py-3.5 text-xs font-mono text-slate-400">—</td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-slate-900">₹{safeFixed(salesTotals.subtotal)}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-slate-900">₹{safeFixed(salesTotals.cgst)}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-slate-900">₹{safeFixed(salesTotals.sgst)}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-slate-900">₹{safeFixed(salesTotals.tax)}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(salesTotals.total)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}

          {tab === "products" && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-semibold tracking-[0.18em]">
                <tr>
                  <th className="text-left px-4 py-3">Sr.</th>
                  <th className="text-left px-4 py-3">{t("item") || "Item"}</th>
                  <th className="text-right px-4 py-3">{t("qty_sold") || "Qty Sold"}</th>
                  <th className="text-right px-4 py-3">{t("revenue") || "Revenue"}</th>
                </tr>
              </thead>
              <tbody data-testid="products-table">
                {productRows.map((it, i) => (
                  <tr key={it.name} className="border-t border-[#F4E6D7] hover:bg-[#FFF8F2]">
                    <td className="px-4 py-3 font-mono text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">{t(it.name)}</td>
                    <td className="px-4 py-3 text-right font-mono">{safeNumber(it.qty)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">₹{safeFixed(it.revenue)}</td>
                  </tr>
                ))}
                {productRows.length === 0 && <tr><td colSpan="4" className="text-center text-muted-foreground py-10">{t("no_items_sold") || "No items sold"}</td></tr>}
              </tbody>
              {productRows.length > 0 && (
                <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-b-2 border-[#FF8A3D] shadow-[0_-4px_12px_rgba(0,0,0,0.06)]" data-testid="products-total-row">
                  <tr className="border-t-2 border-b-2 border-[#FF8A3D]">
                    <td className="px-4 py-3.5 font-mono font-black tracking-wider text-[#FF6B00] text-sm">TOTAL :</td>
                    <td className="px-4 py-3.5 text-xs font-bold text-slate-800">{productTotals.count} {productTotals.count === 1 ? (t("item") || "Item") : (t("items") || "Items")}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-slate-900">{safeNumber(productTotals.qty)}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(productTotals.revenue)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}

          {tab === "thalis" && (
            <div>
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-semibold tracking-[0.18em]">
                  <tr>
                    <th className="text-left px-4 py-3">Sr.</th>
                    <th className="text-left px-4 py-3">{t("thali") || "Thali"}</th>
                    <th className="text-right px-4 py-3">{t("qty_sold") || "Qty Sold"}</th>
                    <th className="text-right px-4 py-3">{t("revenue") || "Revenue"}</th>
                  </tr>
                </thead>
                <tbody data-testid="thalis-table">
                  {thaliRows.map((it, i) => (
                    <tr key={it.name} className="border-t border-border hover:bg-[#FFF8F2]">
                      <td className="px-4 py-3 font-mono text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-3 font-medium">{t(it.name)}</td>
                      <td className="px-4 py-3 text-right font-mono">{safeNumber(it.qty)}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold">₹{safeFixed(it.revenue)}</td>
                    </tr>
                  ))}
                  {thaliRows.length === 0 && <tr><td colSpan="4" className="text-center text-muted-foreground py-10">{t("no_thalis_sold") || "No thalis sold"}</td></tr>}
                </tbody>
                {thaliRows.length > 0 && (
                  <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-b-2 border-[#FF8A3D] shadow-[0_-4px_12px_rgba(0,0,0,0.06)]" data-testid="thalis-total-row">
                    <tr className="border-t-2 border-b-2 border-[#FF8A3D]">
                      <td className="px-4 py-3.5 font-mono font-black tracking-wider text-[#FF6B00] text-sm">TOTAL :</td>
                      <td className="px-4 py-3.5 text-xs font-bold text-slate-800">{thaliTotals.count} {thaliTotals.count === 1 ? (t("thali") || "Thali") : (t("thalis") || "Thalis")}</td>
                      <td className="px-4 py-3.5 text-right font-mono font-bold text-slate-900">{safeNumber(thaliTotals.qty)}</td>
                      <td className="px-4 py-3.5 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(thaliTotals.revenue)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
              {thaliPicks.length > 0 && (
                <div className="p-4 border-t border-border bg-sand-subtle">
                  <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2 font-semibold">{t("popular_thali_selections") || "Popular Thali Selections"}</div>
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

        {tab === "sales" && salesRows.length > 0 && (
          <div className="border-t border-[#F4E6D7] bg-[#FFF8F2] px-5 py-3 flex flex-wrap items-center justify-between gap-4 select-none" data-testid="aggregate-summary-bar">
            <div className="flex items-center gap-5 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Total Bills:</span>
                <span className="text-base font-black text-slate-900 font-mono">{salesTotals.count}</span>
              </div>
              <div className="h-4 w-px bg-[#F4E6D7] hidden sm:block" />
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Taxable Subtotal:</span>
                <span className="text-sm font-bold text-slate-900 font-mono">₹{safeFixed(salesTotals.subtotal)}</span>
              </div>
              <div className="h-4 w-px bg-[#F4E6D7] hidden sm:block" />
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Total Tax:</span>
                <span className="text-sm font-bold text-slate-900 font-mono">₹{safeFixed(salesTotals.tax)} <span className="text-[10px] text-slate-500 font-normal">(CGST: ₹{safeFixed(salesTotals.cgst)} + SGST: ₹{safeFixed(salesTotals.sgst)})</span></span>
              </div>
              <div className="h-4 w-px bg-[#F4E6D7] hidden md:block" />
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-md bg-white border border-[#F4E6D7] font-semibold text-slate-700">Cash: <strong className="font-mono text-slate-900">₹{safeFixed(salesTotals.cash)}</strong></span>
                <span className="px-2 py-0.5 rounded-md bg-white border border-[#F4E6D7] font-semibold text-slate-700">UPI: <strong className="font-mono text-slate-900">₹{safeFixed(salesTotals.upi)}</strong></span>
                {salesTotals.card > 0 && <span className="px-2 py-0.5 rounded-md bg-white border border-[#F4E6D7] font-semibold text-slate-700">Card: <strong className="font-mono text-slate-900">₹{safeFixed(salesTotals.card)}</strong></span>}
              </div>
            </div>
            <div className="flex items-baseline gap-2 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white px-3.5 py-1.5 rounded-xl shadow-sm">
              <span className="text-xs font-bold uppercase tracking-wider">Total Amount Collected:</span>
              <span className="text-lg font-black font-mono tracking-tight">₹{safeFixed(salesTotals.total)}</span>
            </div>
          </div>
        )}

        {tab === "products" && productRows.length > 0 && (
          <div className="border-t border-[#F4E6D7] bg-[#FFF8F2] px-5 py-3 flex flex-wrap items-center justify-between gap-4 select-none" data-testid="aggregate-summary-bar">
            <div className="flex items-center gap-5 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Total Items:</span>
                <span className="text-base font-black text-slate-900 font-mono">{productTotals.count}</span>
              </div>
              <div className="h-4 w-px bg-[#F4E6D7] hidden sm:block" />
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Total Qty Sold:</span>
                <span className="text-sm font-bold text-slate-900 font-mono">{safeNumber(productTotals.qty)}</span>
              </div>
            </div>
            <div className="flex items-baseline gap-2 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white px-3.5 py-1.5 rounded-xl shadow-sm">
              <span className="text-xs font-bold uppercase tracking-wider">Total Revenue:</span>
              <span className="text-lg font-black font-mono tracking-tight">₹{safeFixed(productTotals.revenue)}</span>
            </div>
          </div>
        )}

        {tab === "thalis" && thaliRows.length > 0 && (
          <div className="border-t border-[#F4E6D7] bg-[#FFF8F2] px-5 py-3 flex flex-wrap items-center justify-between gap-4 select-none" data-testid="aggregate-summary-bar">
            <div className="flex items-center gap-5 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Total Thalis:</span>
                <span className="text-base font-black text-slate-900 font-mono">{thaliTotals.count}</span>
              </div>
              <div className="h-4 w-px bg-[#F4E6D7] hidden sm:block" />
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Total Qty Sold:</span>
                <span className="text-sm font-bold text-slate-900 font-mono">{safeNumber(thaliTotals.qty)}</span>
              </div>
            </div>
            <div className="flex items-baseline gap-2 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white px-3.5 py-1.5 rounded-xl shadow-sm">
              <span className="text-xs font-bold uppercase tracking-wider">Total Revenue:</span>
              <span className="text-lg font-black font-mono tracking-tight">₹{safeFixed(thaliTotals.revenue)}</span>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
