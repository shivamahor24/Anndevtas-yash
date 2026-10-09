import React, { useCallback, useEffect, useState, useMemo, useRef } from "react";
import api, { API } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  FileSpreadsheet,
  FileText,
  BarChart3,
  Sparkles,
  ShoppingBag,
  ChevronDown,
  ChevronRight,
  Printer,
  Calendar,
  Layers,
  List
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../context/LanguageContext";
import { offlineStorage, canonicalBillNumber } from "../lib/offlineStorage";
import { safeNumber, safeFixed } from "../lib/utils";
import * as XLSX from "xlsx";

const REPORT_TABS = [
  { key: "sales", label: "Daily Sales", icon: ShoppingBag },
  { key: "products", label: "Products", icon: BarChart3 },
  { key: "thalis", label: "Thalis", icon: Sparkles },
];

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "Last 7 days" },
  { key: "month", label: "Last 30 days" },
  { key: "custom", label: "Custom Range" },
];

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

const formatDisplayDate = (dStr) => {
  if (!dStr) return "";
  const parts = dStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dStr;
};

const getPresetRange = (key) => {
  const now = new Date();
  const todayStr = getLocalDateString(now);
  if (key === "today") {
    return { fromStr: todayStr, toStr: todayStr };
  }
  if (key === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return { fromStr: getLocalDateString(d), toStr: todayStr };
  }
  if (key === "month") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    return { fromStr: getLocalDateString(d), toStr: todayStr };
  }
  return { fromStr: todayStr, toStr: todayStr };
};

export default function Reports() {
  const { t } = useLanguage();
  const { user: authUser } = useAuth();
  const [tab, setTab] = useState("sales");
  const [salesViewMode, setSalesViewMode] = useState("summary"); // "summary" (PDF format) or "detailed"
  const [periodKey, setPeriodKey] = useState("month");
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return getLocalDateString(d);
  });
  const [customTo, setCustomTo] = useState(() => getLocalDateString(new Date()));
  const [expandedDays, setExpandedDays] = useState({});

  const [restaurantInfo, setRestaurantInfo] = useState(() => {
    try {
      return offlineStorage.loadSettings() || null;
    } catch {
      return null;
    }
  });

  // currentUser comes from AuthContext — no redundant /auth/me call
  const currentUser = authUser || (() => {
    try { return offlineStorage.loadUser() || null; } catch { return null; }
  })();

  const [dailySummaryRows, setDailySummaryRows] = useState([]);
  const [allDetailedRows, setAllDetailedRows] = useState([]);
  const [productRows, setProductRows] = useState([]);
  const [thaliRows, setThaliRows] = useState([]);
  const [thaliPicks, setThaliPicks] = useState([]);
  const [loading, setLoading] = useState(false);

  // In-flight guard: prevents overlapping/recursive fetch calls
  const isFetchingRef = useRef(false);

  // Toggle accordion expand for a day's orders
  const toggleDayExpand = (dateKey) => {
    setExpandedDays((prev) => ({
      ...prev,
      [dateKey]: !prev[dateKey]
    }));
  };

  // Grand totals across all days
  const dailyTotals = useMemo(() => {
    return dailySummaryRows.reduce(
      (acc, r) => {
        acc.totalBills += safeNumber(r.totalBills);
        acc.itemsQty += safeNumber(r.itemsQty);
        acc.totalSales += safeNumber(r.totalSales);
        acc.sgstAmount += safeNumber(r.sgstAmount);
        acc.cgstAmount += safeNumber(r.cgstAmount);
        acc.totalTax += safeNumber(r.totalTax);
        acc.grossSales += safeNumber(r.grossSales);
        acc.cashSales += safeNumber(r.cashSales);
        acc.upiSales += safeNumber(r.upiSales);
        acc.cardSales += safeNumber(r.cardSales);
        acc.zomatoSales += safeNumber(r.zomatoSales);
        acc.swiggySales += safeNumber(r.swiggySales);
        return acc;
      },
      {
        totalBills: 0,
        itemsQty: 0,
        totalSales: 0,
        sgstAmount: 0,
        cgstAmount: 0,
        totalTax: 0,
        grossSales: 0,
        cashSales: 0,
        upiSales: 0,
        cardSales: 0,
        zomatoSales: 0,
        swiggySales: 0
      }
    );
  }, [dailySummaryRows]);

  const productTotals = useMemo(() => {
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

  const thaliTotals = useMemo(() => {
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

  const activeRange = useMemo(() => {
    if (periodKey === "custom") {
      return { fromStr: customFrom, toStr: customTo };
    }
    return getPresetRange(periodKey);
  }, [periodKey, customFrom, customTo]);


  // Pure function / callback to process orders into report tables without making network requests
  const processReportData = useCallback((combined, range) => {
    try {
      // 1. Filter orders using calendar date string (YYYY-MM-DD)
      const filteredOrders = (combined || []).filter((o) => {
        const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
        if (!rawDate) return false;
        const orderDateStr = getLocalDateString(rawDate);
        if (!orderDateStr) return false;
        return orderDateStr >= range.fromStr && orderDateStr <= range.toStr;
      });

      // 2. Group by Date for Daily Sales Summary (PDF Format)
      const dayMap = new Map();
      const allDetailed = [];

      filteredOrders.forEach((o) => {
        const rawDate = o.paid_at || o.createdAt || o.created_at || o.date;
        const dateKey = getLocalDateString(rawDate);
        if (!dayMap.has(dateKey)) {
          dayMap.set(dateKey, []);
        }
        dayMap.get(dateKey).push(o);

        // Flatten detailed rows
        const items = Array.isArray(o.items) ? o.items : [];
        const orderItemQty = items.reduce((sum, it) => sum + safeNumber(it.quantity || it.qty, 1), 0);
        const subtotal = safeNumber(o.subtotal);
        const taxVal = safeNumber(o.tax !== undefined ? o.tax : (safeNumber(o.cgst) + safeNumber(o.sgst)));
        const cgstVal = safeNumber(o.cgst !== undefined ? o.cgst : (taxVal / 2));
        const sgstVal = safeNumber(o.sgst !== undefined ? o.sgst : (taxVal - cgstVal));
        const gross = safeNumber(o.grandTotal !== undefined ? o.grandTotal : o.total);

        allDetailed.push({
          id: o.id || o.receipt_no,
          receipt_no: o.billNumber || o.orderNumber || o.receipt_no || "—",
          paid_at: rawDate,
          payment_mode: (o.paymentMethod || o.payment_mode || "cash").toLowerCase(),
          itemsCount: orderItemQty,
          items: items.map((it) => ({
            name: it.name || "Item",
            qty: safeNumber(it.quantity || it.qty, 1),
            price: safeNumber(it.price, 0),
            total: safeNumber(it.total !== undefined ? it.total : (safeNumber(it.price, 0) * safeNumber(it.quantity || it.qty, 1)))
          })),
          subtotal,
          cgst: cgstVal,
          sgst: sgstVal,
          tax: taxVal,
          total: gross
        });
      });

      const sortedDates = Array.from(dayMap.keys()).sort();

      const dailySummary = sortedDates.map((dateKey) => {
        const dayOrders = dayMap.get(dateKey);

        // Compute FROM-TO BILL NO
        const billNums = dayOrders
          .map((o) => {
            const canonical = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
            if (canonical > 0) return canonical;
            const num = parseInt(String(o.receipt_no || "").replace(/\D/g, ""), 10);
            return isNaN(num) ? 0 : num;
          })
          .filter((n) => n > 0)
          .sort((a, b) => a - b);

        let fromToBillNo = "—";
        if (billNums.length > 0) {
          const minBill = billNums[0];
          const maxBill = billNums[billNums.length - 1];
          fromToBillNo = minBill === maxBill ? `${minBill}` : `${minBill}-${maxBill}`;
        } else if (dayOrders.length > 0) {
          fromToBillNo = `${dayOrders.length} ${dayOrders.length === 1 ? "Bill" : "Bills"}`;
        }

        let dayItemsQty = 0;
        let daySubtotal = 0;
        let dayCgst = 0;
        let daySgst = 0;
        let dayTotalTax = 0;
        let dayGross = 0;
        let dayCash = 0;
        let dayUpi = 0;
        let dayCard = 0;
        let dayZomato = 0;
        let daySwiggy = 0;

        const dayBillDetails = dayOrders.map((o) => {
          const items = Array.isArray(o.items) ? o.items : [];
          const orderItemQty = items.reduce((sum, it) => sum + safeNumber(it.quantity || it.qty, 1), 0);
          dayItemsQty += orderItemQty;

          const subtotal = safeNumber(o.subtotal);
          const taxVal = safeNumber(o.tax !== undefined ? o.tax : (safeNumber(o.cgst) + safeNumber(o.sgst)));
          const cgstVal = safeNumber(o.cgst !== undefined ? o.cgst : (taxVal / 2));
          const sgstVal = safeNumber(o.sgst !== undefined ? o.sgst : (taxVal - cgstVal));
          const gross = safeNumber(o.grandTotal !== undefined ? o.grandTotal : o.total);
          const mode = (o.paymentMethod || o.payment_mode || "cash").toLowerCase();

          daySubtotal += subtotal;
          dayCgst += cgstVal;
          daySgst += sgstVal;
          dayTotalTax += taxVal;
          dayGross += gross;

          if (mode === "cash") dayCash += gross;
          else if (mode === "upi") dayUpi += gross;
          else if (mode === "card") dayCard += gross;
          else if (mode === "zomato") dayZomato += gross;
          else if (mode === "swiggy") daySwiggy += gross;
          else dayCash += gross;

          return {
            id: o.id || o.receipt_no,
            receipt_no: o.billNumber || o.orderNumber || o.receipt_no || "—",
            paid_at: o.paid_at || o.createdAt || o.created_at,
            payment_mode: mode,
            itemsCount: orderItemQty,
            items: items.map((it) => ({
              name: it.name || "Item",
              qty: safeNumber(it.quantity || it.qty, 1),
              price: safeNumber(it.price, 0),
              total: safeNumber(it.total !== undefined ? it.total : (safeNumber(it.price, 0) * safeNumber(it.quantity || it.qty, 1)))
            })),
            subtotal,
            cgst: cgstVal,
            sgst: sgstVal,
            tax: taxVal,
            total: gross
          };
        });

        return {
          dateKey,
          dateFormatted: formatDisplayDate(dateKey),
          fromToBillNo,
          totalBills: dayOrders.length,
          itemsQty: dayItemsQty,
          totalSales: daySubtotal,
          sgstAmount: daySgst,
          cgstAmount: dayCgst,
          totalTax: dayTotalTax,
          grossSales: dayGross,
          cashSales: dayCash,
          upiSales: dayUpi,
          cardSales: dayCard,
          zomatoSales: dayZomato,
          swiggySales: daySwiggy,
          orders: dayBillDetails
        };
      });

      setDailySummaryRows(dailySummary);
      setAllDetailedRows(allDetailed);

      // 3. Compute Product Rows with Unit Rates & Total Amounts
      const itemMap = new Map();
      filteredOrders.forEach((o) => {
        const items = Array.isArray(o.items) ? o.items : [];
        items.forEach((it) => {
          const name = it.name || "Item";
          const qty = safeNumber(it.quantity || it.qty, 1);
          const price = safeNumber(it.price, 0);
          const ebCharge = safeNumber(it.extra_bread_charge, 0);
          const rev = safeNumber(
            it.revenue !== undefined
              ? it.revenue
              : it.total !== undefined
              ? it.total
              : (price + ebCharge) * qty
          );
          if (!itemMap.has(name)) {
            itemMap.set(name, { name, qty: 0, revenue: 0, prices: [] });
          }
          const cur = itemMap.get(name);
          cur.qty += qty;
          cur.revenue += rev;
          if (price > 0) cur.prices.push(price);
        });
      });

      const pRows = Array.from(itemMap.values())
        .map((it) => {
          const unitRate = it.prices.length > 0 ? it.prices[0] : it.qty > 0 ? it.revenue / it.qty : 0;
          return {
            name: it.name,
            rate: unitRate,
            qty: it.qty,
            revenue: it.revenue
          };
        })
        .sort((a, b) => b.revenue - a.revenue);

      // 4. Compute Thali Rows & Selections
      const thaliMap = new Map();
      const picksMap = new Map();
      filteredOrders.forEach((o) => {
        const items = Array.isArray(o.items) ? o.items : [];
        items.forEach((it) => {
          const isThali = Boolean(
            it.is_thali ||
              it.category === "THALI" ||
              it.category_name === "THALI" ||
              (it.name && it.name.toLowerCase().includes("thali"))
          );
          if (isThali) {
            const name = it.name || "Thali";
            const qty = safeNumber(it.quantity || it.qty, 1);
            const price = safeNumber(it.price, 0);
            const ebCharge = safeNumber(it.extra_bread_charge, 0);
            const rev = safeNumber(
              it.revenue !== undefined
                ? it.revenue
                : it.total !== undefined
                ? it.total
                : (price + ebCharge) * qty
            );
            if (!thaliMap.has(name)) {
              thaliMap.set(name, { name, qty: 0, revenue: 0, prices: [] });
            }
            const cur = thaliMap.get(name);
            cur.qty += qty;
            cur.revenue += rev;
            if (price > 0) cur.prices.push(price);

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

      const tRows = Array.from(thaliMap.values())
        .map((it) => {
          const unitRate = it.prices.length > 0 ? it.prices[0] : it.qty > 0 ? it.revenue / it.qty : 0;
          return {
            name: it.name,
            rate: unitRate,
            qty: it.qty,
            revenue: it.revenue
          };
        })
        .sort((a, b) => b.revenue - a.revenue);

      const picksList = Array.from(picksMap.entries())
        .map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => b.qty - a.qty);

      setProductRows(pRows);
      setThaliRows(tRows);
      setThaliPicks(picksList);
    } catch (e) {
      console.error("Report calculation error:", e);
      setDailySummaryRows([]);
      setAllDetailedRows([]);
      setProductRows([]);
      setThaliRows([]);
      setThaliPicks([]);
    }
  }, []);

  const fetch = useCallback(async () => {
    // In-flight guard: if a fetch is already running, skip this call.
    // This prevents the event loop: saveOrder -> ordersUpdated -> fetch -> saveOrder -> ...
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setLoading(true);
    try {
      // 1. Load local orders immediately for instant render
      let combined = [];
      try {
        combined = offlineStorage.getOrders() || [];
      } catch (e) {
        console.error("Local storage read error:", e);
      }

      try {
        const [res, delRes] = await Promise.all([
          api.get("/orders"),
          api.get("/orders/deleted").catch(() => ({ data: [] })),
        ]);
        if (Array.isArray(res.data) && Array.isArray(delRes?.data)) {
          const activeList = res.data;
          const deletedWithFlag = delRes.data.map((o) => ({ ...o, is_deleted: true }));
          offlineStorage.saveOrdersBatch([...activeList, ...deletedWithFlag], {
            emit: false,
            syncWithServer: true,
          });
          combined = offlineStorage.getOrders() || [];
        }
      } catch (apiErr) {
        console.log("Server sync optional / offline:", apiErr.message);
      }

      // Fetch restaurant settings (use cached first, then server)
      try {
        const cachedSettings = offlineStorage.loadSettings();
        if (cachedSettings) setRestaurantInfo(cachedSettings);
        const sRes = await api.get("/settings");
        if (sRes.data) {
          setRestaurantInfo(sRes.data);
          offlineStorage.saveSettings(sRes.data);
        }
      } catch (_) {}

      // NOTE: currentUser now comes from AuthContext — no /auth/me call here.

      // 2. Compute report data from orders
      processReportData(combined, activeRange);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [activeRange, processReportData]);

  useEffect(() => {
    fetch();

    // Event listener: updates from Billing checkout or local order changes
    // Pure local recalculation — NEVER triggers another server fetch
    const handleOrdersChange = () => {
      try {
        const combined = offlineStorage.getOrders() || [];
        processReportData(combined, activeRange);
      } catch (e) {
        console.error("Reports handleOrdersChange error:", e);
      }
    };

    window.addEventListener("ordersUpdated", handleOrdersChange);
    window.addEventListener("pos_orders_changed", handleOrdersChange);
    return () => {
      window.removeEventListener("ordersUpdated", handleOrdersChange);
      window.removeEventListener("pos_orders_changed", handleOrdersChange);
    };
  }, [fetch, activeRange, processReportData]);

  // Excel Export: Multi-sheet workbook formatted exactly like the PDF
  const downloadClientXlsx = () => {
    const restaurantName = restaurantInfo?.restaurant_name || restaurantInfo?.name || "CHEERS (C G ROAD)";
    const fromFormatted = formatDisplayDate(activeRange.fromStr);
    const toFormatted = formatDisplayDate(activeRange.toStr);
    const now = new Date();
    const printTimestamp = `${formatDisplayDate(getLocalDateString(now))} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const printedBy = currentUser?.name || currentUser?.username || "BHUPENDRA";

    const wb = XLSX.utils.book_new();

    // -------------------------------------------------------------
    // SHEET 1: SALES SUMMARY REPORT (Exact PDF Format)
    // -------------------------------------------------------------
    const salesAoa = [
      [restaurantName.toUpperCase()],
      ["SALES SUMMARY REPORT"],
      [`From Date : ${fromFormatted} To : ${toFormatted}`],
      [],
      [
        "DATE",
        "FROM-TO BILL NO",
        "TOTAL SALES",
        "SGST AMOUNT",
        "CGST AMOUNT",
        "GROSS SALES",
        "CASH SALES",
        "ZOMATO SALES",
        "SWIGGY SALES"
      ]
    ];

    dailySummaryRows.forEach((r) => {
      salesAoa.push([
        r.dateFormatted,
        r.fromToBillNo,
        Number(safeFixed(r.totalSales)),
        Number(safeFixed(r.sgstAmount)),
        Number(safeFixed(r.cgstAmount)),
        Number(safeFixed(r.grossSales)),
        Number(safeFixed(r.cashSales)),
        Number(safeFixed(r.zomatoSales || 0)),
        Number(safeFixed(r.swiggySales || 0))
      ]);
    });

    salesAoa.push([
      "TOTAL :",
      "—",
      Number(safeFixed(dailyTotals.totalSales)),
      Number(safeFixed(dailyTotals.sgstAmount)),
      Number(safeFixed(dailyTotals.cgstAmount)),
      Number(safeFixed(dailyTotals.grossSales)),
      Number(safeFixed(dailyTotals.cashSales)),
      Number(safeFixed(dailyTotals.zomatoSales || 0)),
      Number(safeFixed(dailyTotals.swiggySales || 0))
    ]);

    salesAoa.push([]);
    salesAoa.push([
      `Print on ${printTimestamp} By ${printedBy}`,
      "", "", "", "", "", "", "",
      "Page No 1 Of 1"
    ]);

    const wsSales = XLSX.utils.aoa_to_sheet(salesAoa);
    wsSales["!cols"] = [
      { wch: 14 }, // DATE
      { wch: 18 }, // FROM-TO BILL NO
      { wch: 15 }, // TOTAL SALES
      { wch: 15 }, // SGST AMOUNT
      { wch: 15 }, // CGST AMOUNT
      { wch: 16 }, // GROSS SALES
      { wch: 15 }, // CASH SALES
      { wch: 16 }, // ZOMATO SALES
      { wch: 16 }  // SWIGGY SALES
    ];
    XLSX.utils.book_append_sheet(wb, wsSales, "SALES SUMMARY REPORT");

    // -------------------------------------------------------------
    // SHEET 2: ITEM SALES REPORT (Unit Rates, Quantities, & Total Amounts)
    // -------------------------------------------------------------
    const itemAoa = [
      [restaurantName.toUpperCase()],
      ["ITEM WISE SALES REPORT"],
      [`From Date : ${fromFormatted} To : ${toFormatted}`],
      [],
      ["SR NO", "ITEM NAME", "RATE (₹)", "QTY SOLD", "TOTAL AMOUNT (₹)"]
    ];

    productRows.forEach((r, i) => {
      itemAoa.push([
        i + 1,
        r.name,
        Number(safeFixed(r.rate)),
        safeNumber(r.qty),
        Number(safeFixed(r.revenue))
      ]);
    });

    itemAoa.push([
      "TOTAL :",
      `${productTotals.count} Items`,
      "",
      productTotals.qty,
      Number(safeFixed(productTotals.revenue))
    ]);

    itemAoa.push([]);
    itemAoa.push([`Print on ${printTimestamp} By ${printedBy}`]);

    const wsItems = XLSX.utils.aoa_to_sheet(itemAoa);
    wsItems["!cols"] = [
      { wch: 8 },  // SR NO
      { wch: 32 }, // ITEM NAME
      { wch: 14 }, // RATE (₹)
      { wch: 12 }, // QTY SOLD
      { wch: 18 }  // TOTAL AMOUNT (₹)
    ];
    XLSX.utils.book_append_sheet(wb, wsItems, "ITEM SALES REPORT");

    // -------------------------------------------------------------
    // SHEET 3: BILL WISE DETAILS
    // -------------------------------------------------------------
    const billAoa = [
      [restaurantName.toUpperCase()],
      ["BILL WISE DETAILED REPORT"],
      [`From Date : ${fromFormatted} To : ${toFormatted}`],
      [],
      [
        "BILL NO",
        "DATE & TIME",
        "ITEMS SOLD",
        "ITEMS QTY",
        "PAYMENT MODE",
        "TAXABLE (₹)",
        "CGST (₹)",
        "SGST (₹)",
        "TOTAL TAX (₹)",
        "GROSS TOTAL (₹)"
      ]
    ];

    let billCount = 0;
    dailySummaryRows.forEach((day) => {
      day.orders.forEach((o) => {
        billCount++;
        const itemDesc = (o.items || [])
          .map((it) => `${it.name} x${it.qty} (₹${safeFixed(it.price)})`)
          .join(", ");
        billAoa.push([
          o.receipt_no,
          new Date(o.paid_at).toLocaleString("en-IN"),
          itemDesc,
          o.itemsCount,
          (o.payment_mode || "cash").toUpperCase(),
          Number(safeFixed(o.subtotal)),
          Number(safeFixed(o.cgst)),
          Number(safeFixed(o.sgst)),
          Number(safeFixed(o.tax)),
          Number(safeFixed(o.total))
        ]);
      });
    });

    billAoa.push([
      "TOTAL :",
      `${billCount} Bills`,
      "",
      dailyTotals.itemsQty,
      "",
      Number(safeFixed(dailyTotals.totalSales)),
      Number(safeFixed(dailyTotals.sgstAmount)),
      Number(safeFixed(dailyTotals.cgstAmount)),
      Number(safeFixed(dailyTotals.totalTax)),
      Number(safeFixed(dailyTotals.grossSales))
    ]);

    const wsBills = XLSX.utils.aoa_to_sheet(billAoa);
    wsBills["!cols"] = [
      { wch: 12 }, // BILL NO
      { wch: 22 }, // DATE & TIME
      { wch: 45 }, // ITEMS SOLD
      { wch: 12 }, // ITEMS QTY
      { wch: 15 }, // PAYMENT MODE
      { wch: 14 }, // TAXABLE
      { wch: 12 }, // CGST
      { wch: 12 }, // SGST
      { wch: 14 }, // TOTAL TAX
      { wch: 16 }  // GROSS TOTAL
    ];
    XLSX.utils.book_append_sheet(wb, wsBills, "BILL WISE DETAILS");

    // -------------------------------------------------------------
    // SHEET 4: THALIS REPORT (if applicable)
    // -------------------------------------------------------------
    if (thaliRows.length > 0) {
      const thaliAoa = [
        [restaurantName.toUpperCase()],
        ["THALI SALES REPORT"],
        [`From Date : ${fromFormatted} To : ${toFormatted}`],
        [],
        ["SR NO", "THALI NAME", "RATE (₹)", "QTY SOLD", "TOTAL AMOUNT (₹)"]
      ];
      thaliRows.forEach((r, i) => {
        thaliAoa.push([
          i + 1,
          r.name,
          Number(safeFixed(r.rate)),
          safeNumber(r.qty),
          Number(safeFixed(r.revenue))
        ]);
      });
      thaliAoa.push([
        "TOTAL :",
        `${thaliTotals.count} Thalis`,
        "",
        thaliTotals.qty,
        Number(safeFixed(thaliTotals.revenue))
      ]);

      if (thaliPicks.length > 0) {
        thaliAoa.push([]);
        thaliAoa.push(["--- POPULAR THALI SELECTIONS ---"]);
        thaliAoa.push(["SELECTION ITEM", "TIMES ORDERED"]);
        thaliPicks.forEach((p) => {
          thaliAoa.push([p.name, p.qty]);
        });
      }

      const wsThalis = XLSX.utils.aoa_to_sheet(thaliAoa);
      wsThalis["!cols"] = [
        { wch: 8 },
        { wch: 30 },
        { wch: 14 },
        { wch: 12 },
        { wch: 18 }
      ];
      XLSX.utils.book_append_sheet(wb, wsThalis, "THALIS REPORT");
    }

    XLSX.writeFile(wb, `Sales_Summary_Report_${activeRange.fromStr}_to_${activeRange.toStr}.xlsx`);
    toast.success("Excel Report Downloaded Successfully");
  };

  // CSV Export: Exact PDF format
  const downloadClientCsv = () => {
    const restaurantName = restaurantInfo?.restaurant_name || restaurantInfo?.name || "CHEERS (C G ROAD)";
    const fromFormatted = formatDisplayDate(activeRange.fromStr);
    const toFormatted = formatDisplayDate(activeRange.toStr);
    const now = new Date();
    const printTimestamp = `${formatDisplayDate(getLocalDateString(now))} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const printedBy = currentUser?.name || currentUser?.username || "BHUPENDRA";

    let csvContent = "";
    if (tab === "sales") {
      csvContent += `"${restaurantName.toUpperCase()}"\n`;
      csvContent += `"SALES SUMMARY REPORT"\n`;
      csvContent += `"From Date : ${fromFormatted} To : ${toFormatted}"\n\n`;
      csvContent += "DATE,FROM-TO BILL NO,TOTAL SALES,SGST AMOUNT,CGST AMOUNT,GROSS SALES,CASH SALES,ZOMATO SALES,SWIGGY SALES\n";
      dailySummaryRows.forEach((r) => {
        csvContent += `"${r.dateFormatted}","${r.fromToBillNo}",${safeFixed(r.totalSales)},${safeFixed(r.sgstAmount)},${safeFixed(r.cgstAmount)},${safeFixed(r.grossSales)},${safeFixed(r.cashSales)},${safeFixed(r.zomatoSales || 0)},${safeFixed(r.swiggySales || 0)}\n`;
      });
      csvContent += `"TOTAL :","—",${safeFixed(dailyTotals.totalSales)},${safeFixed(dailyTotals.sgstAmount)},${safeFixed(dailyTotals.cgstAmount)},${safeFixed(dailyTotals.grossSales)},${safeFixed(dailyTotals.cashSales)},${safeFixed(dailyTotals.zomatoSales || 0)},${safeFixed(dailyTotals.swiggySales || 0)}\n\n`;
      csvContent += `"Print on ${printTimestamp} By ${printedBy}","","","","","","","","Page No 1 Of 1"\n`;
    } else if (tab === "products") {
      csvContent += `"${restaurantName.toUpperCase()}"\n`;
      csvContent += `"ITEM WISE SALES REPORT"\n`;
      csvContent += `"From Date : ${fromFormatted} To : ${toFormatted}"\n\n`;
      csvContent += "SR NO,ITEM NAME,RATE (Rs),QTY SOLD,TOTAL AMOUNT (Rs)\n";
      productRows.forEach((r, i) => {
        csvContent += `${i + 1},"${r.name}",${safeFixed(r.rate)},${safeNumber(r.qty)},${safeFixed(r.revenue)}\n`;
      });
      csvContent += `"TOTAL :","${productTotals.count} Items","",${safeNumber(productTotals.qty)},${safeFixed(productTotals.revenue)}\n`;
    } else {
      csvContent += `"${restaurantName.toUpperCase()}"\n`;
      csvContent += `"THALI SALES REPORT"\n`;
      csvContent += `"From Date : ${fromFormatted} To : ${toFormatted}"\n\n`;
      csvContent += "SR NO,THALI NAME,RATE (Rs),QTY SOLD,TOTAL AMOUNT (Rs)\n";
      thaliRows.forEach((r, i) => {
        csvContent += `${i + 1},"${r.name}",${safeFixed(r.rate)},${safeNumber(r.qty)},${safeFixed(r.revenue)}\n`;
      });
      csvContent += `"TOTAL :","${thaliTotals.count} Thalis","",${safeNumber(thaliTotals.qty)},${safeFixed(thaliTotals.revenue)}\n`;
    }

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Sales_Summary_${activeRange.fromStr}_to_${activeRange.toStr}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast.success("CSV Report Downloaded Successfully");
  };

  const exportPDF = () => {
    const now = new Date();
    const printTimestamp = `${formatDisplayDate(getLocalDateString(now))} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const printedBy = currentUser?.name || currentUser?.username || "BHUPENDRA";
    const bizName = (restaurantDisplayName || "CHEERS (C G ROAD)").toUpperCase();
    const fromFormatted = formatDisplayDate(activeRange.fromStr);
    const toFormatted = formatDisplayDate(activeRange.toStr);

    let rowsHtml = "";
    dailySummaryRows.forEach((r) => {
      rowsHtml += `
        <tr>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: left;">${r.dateFormatted}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: center; font-family: monospace;">${r.fromToBillNo}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right;">${safeFixed(r.totalSales)}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right;">${safeFixed(r.sgstAmount)}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right;">${safeFixed(r.cgstAmount)}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right; font-weight: 700;">${safeFixed(r.grossSales)}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right;">${safeFixed(r.cashSales)}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right;">${safeFixed(r.zomatoSales || 0)}</td>
          <td style="padding: 7px 10px; border-bottom: 1px solid #cbd5e1; text-align: right;">${safeFixed(r.swiggySales || 0)}</td>
        </tr>
      `;
    });

    const totalRowHtml = `
      <tr style="font-weight: bold; background: #f8fafc; border-top: 2px solid #0f172a; border-bottom: 2px solid #0f172a;">
        <td style="padding: 8px 10px; text-align: left;">TOTAL :</td>
        <td style="padding: 8px 10px; text-align: center;">—</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.totalSales)}</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.sgstAmount)}</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.cgstAmount)}</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.grossSales)}</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.cashSales)}</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.zomatoSales || 0)}</td>
        <td style="padding: 8px 10px; text-align: right;">${safeFixed(dailyTotals.swiggySales || 0)}</td>
      </tr>
    `;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Sales Summary Report - ${bizName}</title>
        <style>
          @page { size: landscape; margin: 12mm; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; font-size: 11px; color: #0f172a; margin: 0; padding: 20px; }
          .header { text-align: center; margin-bottom: 18px; }
          .header h1 { margin: 0 0 4px 0; font-size: 18px; font-weight: 800; letter-spacing: 0.05em; }
          .header h2 { margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #334155; }
          .header p { margin: 0; font-size: 11px; font-weight: 600; color: #64748b; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th { background: #f1f5f9; padding: 8px 10px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; border-top: 1px solid #94a3b8; border-bottom: 1px solid #94a3b8; }
          .footer { margin-top: 24px; display: flex; justify-content: space-between; font-size: 10.5px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 8px; }
          @media print {
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${bizName}</h1>
          <h2>SALES SUMMARY REPORT</h2>
          <p>From Date : ${fromFormatted} &nbsp;&nbsp;&nbsp;&nbsp; To : ${toFormatted}</p>
        </div>
        <table>
          <thead>
            <tr>
              <th style="text-align: left;">DATE</th>
              <th style="text-align: center;">FROM-TO BILL NO</th>
              <th style="text-align: right;">TOTAL SALES</th>
              <th style="text-align: right;">SGST AMOUNT</th>
              <th style="text-align: right;">CGST AMOUNT</th>
              <th style="text-align: right;">GROSS SALES</th>
              <th style="text-align: right;">CASH SALES</th>
              <th style="text-align: right;">ZOMATO SALES</th>
              <th style="text-align: right;">SWIGGY SALES</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="9" style="text-align: center; padding: 20px;">No sales records found for this period</td></tr>'}
            ${dailySummaryRows.length > 0 ? totalRowHtml : ''}
          </tbody>
        </table>
        <div class="footer">
          <div>Print on <strong>${printTimestamp}</strong> By <strong>${printedBy}</strong></div>
          <div>Page No 1 Of 1</div>
        </div>
      </body>
      </html>
    `;

    const popup = window.open('', '_blank');
    if (popup) {
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      setTimeout(() => {
        popup.focus();
        popup.print();
      }, 350);
    } else {
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document || iframe.contentDocument;
      if (doc) {
        doc.open();
        doc.write(html);
        doc.close();
        setTimeout(() => {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
          setTimeout(() => document.body.removeChild(iframe), 30000);
        }, 500);
      }
    }
  };

  const download = (fmt) => {
    if (fmt === "xlsx") {
      downloadClientXlsx();
    } else {
      downloadClientCsv();
    }
  };

  const restaurantDisplayName = restaurantInfo?.restaurant_name || restaurantInfo?.name || "CHEERS (C G ROAD)";
  const fromFormattedDate = formatDisplayDate(activeRange.fromStr);
  const toFormattedDate = formatDisplayDate(activeRange.toStr);
  const printTimestamp = `${formatDisplayDate(getLocalDateString(new Date()))} ${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
  const cashierDisplayName = currentUser?.name || currentUser?.username || "BHUPENDRA";

  return (
    <div className="h-full bg-[#FFFDF9] rounded-[20px] md:rounded-[28px] lg:rounded-[32px] border border-[#F4E6D7] shadow-lg p-4 sm:p-5 md:p-6 lg:p-8 flex flex-col overflow-hidden">
      {/* Top Header Bar */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[14px] uppercase tracking-[0.15em] font-extrabold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">
            {restaurantDisplayName}
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">
            {tab === "sales" ? "SALES SUMMARY REPORT" : tab === "products" ? "ITEM WISE SALES REPORT" : "THALI SALES REPORT"}
          </h1>
          <div className="text-xs font-semibold text-slate-500 mt-0.5">
            From Date : <span className="font-mono text-slate-800">{fromFormattedDate}</span> To : <span className="font-mono text-slate-800">{toFormattedDate}</span>
          </div>
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <Button
            onClick={exportPDF}
            className="bg-gradient-to-r from-[#2563EB] to-[#1D4ED8] hover:brightness-105 text-white rounded-xl cursor-pointer shadow-sm text-xs h-9 px-3.5"
            data-testid="export-pdf"
          >
            <Printer className="w-4 h-4 mr-1.5" /> Export PDF
          </Button>
          <Button
            onClick={() => download("csv")}
            variant="outline"
            className="text-white border-[#F4E6D7] bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-[#FFF8F2] rounded-xl cursor-pointer shadow-sm text-xs h-9 px-3.5"
            data-testid="export-csv"
          >
            <FileText className="w-4 h-4 mr-1.5" /> {t("export_csv") || "Export CSV"}
          </Button>
          <Button
            onClick={() => download("xlsx")}
            className="bg-gradient-to-r from-[#78A61A] to-[#5F9210] hover:brightness-105 text-white rounded-xl cursor-pointer shadow-sm text-xs h-9 px-3.5"
            data-testid="export-excel"
          >
            <FileSpreadsheet className="w-4 h-4 mr-1.5" /> {t("export_excel") || "Export Excel"}
          </Button>
        </div>
      </div>

      {/* Filter and Tab Selectors */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Report Category Tabs */}
          <div className="flex items-center gap-1 p-1 bg-[#FFF8F2] border border-[#F4E6D7] rounded-xl" data-testid="report-tabs">
            {REPORT_TABS.map((tTab) => {
              let label = tTab.label;
              if (tTab.key === "sales") label = t("tab_sales") || "Daily Sales";
              if (tTab.key === "products") label = t("tab_products") || "Products";
              if (tTab.key === "thalis") label = t("tab_thali") || "Thalis";
              return (
                <button
                  key={tTab.key}
                  onClick={() => setTab(tTab.key)}
                  data-testid={`report-${tTab.key}`}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
                    tab === tTab.key
                      ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                      : "text-slate-600 hover:text-slate-900 hover:bg-[#FCEEE2]"
                  }`}
                >
                  <tTab.icon className="w-3.5 h-3.5" /> {label}
                </button>
              );
            })}
          </div>

          {/* Time Period Tabs */}
          <div className="flex items-center gap-1 p-1 bg-[#FFF8F2] border border-[#F4E6D7] rounded-xl" data-testid="period-tabs">
            {PERIODS.map((p) => {
              let label = p.label;
              if (p.key === "today") label = t("today") || "Today";
              if (p.key === "week") label = t("last_7_days") || "Last 7 days";
              if (p.key === "month") label = t("last_30_days") || "Last 30 days";
              if (p.key === "custom") label = t("custom_range") || "Custom";
              return (
                <button
                  key={p.key}
                  onClick={() => setPeriodKey(p.key)}
                  data-testid={`rperiod-${p.key}`}
                  className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
                    periodKey === p.key
                      ? "bg-gradient-to-r from-[#78A61A] to-[#5F9210] text-white shadow-sm"
                      : "text-slate-600 hover:text-slate-900 hover:bg-[#FCEEE2]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Custom Date Inputs */}
          {periodKey === "custom" && (
            <div className="flex gap-1.5 items-center bg-[#FFF8F2] border border-[#F4E6D7] p-1 rounded-xl">
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-36 h-8 text-xs bg-white"
                data-testid="custom-from"
              />
              <span className="text-muted-foreground text-xs font-medium px-0.5">{t("to") || "to"}</span>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-36 h-8 text-xs bg-white"
                data-testid="custom-to"
              />
            </div>
          )}
        </div>

        {/* View Toggle for Sales tab: Daily Summary (PDF) vs Bill-Wise */}
        {tab === "sales" && (
          <div className="flex items-center gap-1 bg-[#FFF8F2] border border-[#F4E6D7] p-1 rounded-xl">
            <button
              onClick={() => setSalesViewMode("summary")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                salesViewMode === "summary"
                  ? "bg-white text-slate-900 shadow-sm border border-[#F4E6D7]"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-[#FF6B00]" /> Daily Summary (PDF)
            </button>
            <button
              onClick={() => setSalesViewMode("detailed")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                salesViewMode === "detailed"
                  ? "bg-white text-slate-900 shadow-sm border border-[#F4E6D7]"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <List className="w-3.5 h-3.5 text-[#78A61A]" /> Bill-Wise
            </button>
          </div>
        )}
      </div>

      {/* Main Table Card */}
      <Card className="flex-1 overflow-hidden rounded-2xl border-[#F4E6D7] bg-white flex flex-col shadow-sm">
        <div className="flex-1 overflow-y-auto">
          {/* TAB 1: DAILY SALES SUMMARY (Exact format from PDF) */}
          {tab === "sales" && salesViewMode === "summary" && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-bold tracking-[0.14em]">
                <tr>
                  <th className="text-left px-3.5 py-3">DATE</th>
                  <th className="text-left px-3.5 py-3">FROM-TO BILL NO</th>
                  <th className="text-right px-3.5 py-3">ITEMS QTY</th>
                  <th className="text-right px-3.5 py-3">TOTAL SALES</th>
                  <th className="text-right px-3.5 py-3">SGST AMOUNT</th>
                  <th className="text-right px-3.5 py-3">CGST AMOUNT</th>
                  <th className="text-right px-3.5 py-3">GROSS SALES</th>
                  <th className="text-right px-3.5 py-3">CASH SALES</th>
                  <th className="text-right px-3.5 py-3">UPI SALES</th>
                  <th className="text-right px-3.5 py-3">CARD SALES</th>
                  <th className="text-center px-3 py-3">BILLS</th>
                </tr>
              </thead>
              <tbody data-testid="sales-summary-table">
                {dailySummaryRows.map((r) => {
                  const isExpanded = !!expandedDays[r.dateKey];
                  return (
                    <React.Fragment key={r.dateKey}>
                      <tr
                        onClick={() => toggleDayExpand(r.dateKey)}
                        className={`border-t border-[#F4E6D7] hover:bg-[#FFF8F2] cursor-pointer transition-colors ${
                          isExpanded ? "bg-[#FFF4E8]" : ""
                        }`}
                      >
                        <td className="px-3.5 py-3 font-semibold text-slate-900 font-mono flex items-center gap-1.5">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-[#FF6B00]" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                          )}
                          {r.dateFormatted}
                        </td>
                        <td className="px-3.5 py-3 font-mono text-slate-700 font-bold">{r.fromToBillNo}</td>
                        <td className="px-3.5 py-3 text-right font-mono font-bold text-slate-900">{r.itemsQty}</td>
                        <td className="px-3.5 py-3 text-right font-mono font-semibold text-slate-800">₹{safeFixed(r.totalSales)}</td>
                        <td className="px-3.5 py-3 text-right font-mono text-slate-600">₹{safeFixed(r.sgstAmount)}</td>
                        <td className="px-3.5 py-3 text-right font-mono text-slate-600">₹{safeFixed(r.cgstAmount)}</td>
                        <td className="px-3.5 py-3 text-right font-mono font-black text-slate-900">₹{safeFixed(r.grossSales)}</td>
                        <td className="px-3.5 py-3 text-right font-mono font-semibold text-emerald-700">₹{safeFixed(r.cashSales)}</td>
                        <td className="px-3.5 py-3 text-right font-mono font-semibold text-blue-700">₹{safeFixed(r.upiSales)}</td>
                        <td className="px-3.5 py-3 text-right font-mono font-semibold text-purple-700">₹{safeFixed(r.cardSales)}</td>
                        <td className="px-3 py-3 text-center">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#FFF0E0] text-[#FF6B00] border border-[#F4D2BA]">
                            {r.totalBills} {r.totalBills === 1 ? "Bill" : "Bills"}
                          </span>
                        </td>
                      </tr>

                      {/* Expandable nested view of bills on that date */}
                      {isExpanded && (
                        <tr className="bg-[#FFFDF9] border-t border-b border-[#F4E6D7]">
                          <td colSpan="11" className="p-3 pl-8">
                            <div className="bg-white border border-[#F4E6D7] rounded-xl overflow-hidden shadow-inner">
                              <div className="bg-[#FFF8F2] px-4 py-2 border-b border-[#F4E6D7] flex items-center justify-between text-[11px] font-bold text-slate-700">
                                <span>Itemized Bills for {r.dateFormatted} ({r.totalBills} Orders)</span>
                                <span className="text-[#FF6B00]">Total Items Sold: {r.itemsQty}</span>
                              </div>
                              <table className="w-full text-xs">
                                <thead className="bg-[#FFFBF7] text-slate-500 text-[10px] uppercase font-bold border-b border-[#F4E6D7]">
                                  <tr>
                                    <th className="text-left px-3 py-2">Bill #</th>
                                    <th className="text-left px-3 py-2">Time</th>
                                    <th className="text-left px-3 py-2">Items (Name x Qty @ Rate)</th>
                                    <th className="text-right px-3 py-2">Items Qty</th>
                                    <th className="text-left px-3 py-2">Payment</th>
                                    <th className="text-right px-3 py-2">Subtotal</th>
                                    <th className="text-right px-3 py-2">Tax</th>
                                    <th className="text-right px-3 py-2">Gross Total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.orders.map((o) => (
                                    <tr key={o.id || o.receipt_no} className="border-t border-[#F8EFE6] hover:bg-[#FFFDF9]">
                                      <td className="px-3 py-2 font-mono font-bold text-slate-900">#{o.receipt_no}</td>
                                      <td className="px-3 py-2 text-slate-500 text-[11px]">
                                        {new Date(o.paid_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="flex flex-wrap gap-1">
                                          {o.items.map((it, idx) => (
                                            <span key={idx} className="inline-block px-1.5 py-0.5 rounded bg-[#FFF5EA] border border-[#F4D8C4] text-[10px] text-slate-800 font-medium">
                                              {it.name} <strong className="font-mono text-[#FF6B00]">×{it.qty}</strong> <span className="text-slate-500 font-mono">(₹{safeFixed(it.price)})</span>
                                            </span>
                                          ))}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">{o.itemsCount}</td>
                                      <td className="px-3 py-2 font-mono uppercase text-[10px] font-bold text-slate-700">{o.payment_mode}</td>
                                      <td className="px-3 py-2 text-right font-mono text-slate-700">₹{safeFixed(o.subtotal)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-slate-600">₹{safeFixed(o.tax)}</td>
                                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">₹{safeFixed(o.total)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {dailySummaryRows.length === 0 && (
                  <tr>
                    <td colSpan="11" className="text-center text-muted-foreground py-12">
                      {loading ? "Loading reports..." : t("no_sales_in_period") || "No sales found for this period"}
                    </td>
                  </tr>
                )}
              </tbody>

              {/* TOTAL ROW (Exact format from PDF) */}
              {dailySummaryRows.length > 0 && (
                <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-b-2 border-[#FF8A3D] shadow-[0_-4px_12px_rgba(0,0,0,0.06)]" data-testid="sales-total-row">
                  <tr className="border-t-2 border-b-2 border-[#FF8A3D]">
                    <td className="px-3.5 py-3 font-mono font-black tracking-wider text-[#FF6B00] text-sm">TOTAL :</td>
                    <td className="px-3.5 py-3 text-xs font-bold text-slate-800">{dailyTotals.totalBills} Bills</td>
                    <td className="px-3.5 py-3 text-right font-mono font-black text-slate-900 text-sm">{dailyTotals.itemsQty}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-slate-900">₹{safeFixed(dailyTotals.totalSales)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-slate-900">₹{safeFixed(dailyTotals.sgstAmount)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-slate-900">₹{safeFixed(dailyTotals.cgstAmount)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(dailyTotals.grossSales)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-emerald-800">₹{safeFixed(dailyTotals.cashSales)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-blue-800">₹{safeFixed(dailyTotals.upiSales)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-purple-800">₹{safeFixed(dailyTotals.cardSales)}</td>
                    <td className="px-3 py-3"></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}

          {/* TAB 1 ALTERNATE: DETAILED BILL WISE */}
          {tab === "sales" && salesViewMode === "detailed" && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-bold tracking-[0.14em]">
                <tr>
                  <th className="text-left px-3.5 py-3">BILL #</th>
                  <th className="text-left px-3.5 py-3">DATE & TIME</th>
                  <th className="text-left px-3.5 py-3">ITEMS (QTY @ RATE)</th>
                  <th className="text-right px-3.5 py-3">ITEMS QTY</th>
                  <th className="text-left px-3.5 py-3">PAYMENT</th>
                  <th className="text-right px-3.5 py-3">TAXABLE</th>
                  <th className="text-right px-3.5 py-3">CGST</th>
                  <th className="text-right px-3.5 py-3">SGST</th>
                  <th className="text-right px-3.5 py-3">TOTAL</th>
                </tr>
              </thead>
              <tbody>
                {allDetailedRows.map((o) => (
                  <tr key={o.id || o.receipt_no} className="border-t border-[#F4E6D7] hover:bg-[#FFF8F2]">
                    <td className="px-3.5 py-3 font-mono font-bold text-slate-900">#{o.receipt_no}</td>
                    <td className="px-3.5 py-3 text-slate-500 font-mono">{new Date(o.paid_at).toLocaleString("en-IN")}</td>
                    <td className="px-3.5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {o.items.map((it, idx) => (
                          <span key={idx} className="inline-block px-1.5 py-0.5 rounded bg-[#FFF5EA] border border-[#F4D8C4] text-[10px] text-slate-800 font-medium">
                            {it.name} <strong className="font-mono text-[#FF6B00]">×{it.qty}</strong> (₹{safeFixed(it.price)})
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-slate-800">{o.itemsCount}</td>
                    <td className="px-3.5 py-3 uppercase font-mono font-bold text-slate-700">{o.payment_mode}</td>
                    <td className="px-3.5 py-3 text-right font-mono">₹{safeFixed(o.subtotal)}</td>
                    <td className="px-3.5 py-3 text-right font-mono">₹{safeFixed(o.cgst)}</td>
                    <td className="px-3.5 py-3 text-right font-mono">₹{safeFixed(o.sgst)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold text-slate-900">₹{safeFixed(o.total)}</td>
                  </tr>
                ))}
                {allDetailedRows.length === 0 && (
                  <tr>
                    <td colSpan="9" className="text-center text-muted-foreground py-12">
                      {loading ? "Loading..." : "No orders found"}
                    </td>
                  </tr>
                )}
              </tbody>
              {allDetailedRows.length > 0 && (
                <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-[#FF8A3D]">
                  <tr>
                    <td className="px-3.5 py-3 font-mono font-black text-[#FF6B00]">TOTAL :</td>
                    <td className="px-3.5 py-3 font-bold text-slate-800">{allDetailedRows.length} Bills</td>
                    <td className="px-3.5 py-3"></td>
                    <td className="px-3.5 py-3 text-right font-mono font-black">{dailyTotals.itemsQty}</td>
                    <td className="px-3.5 py-3"></td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold">₹{safeFixed(dailyTotals.totalSales)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold">₹{safeFixed(dailyTotals.sgstAmount)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-bold">₹{safeFixed(dailyTotals.cgstAmount)}</td>
                    <td className="px-3.5 py-3 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(dailyTotals.grossSales)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}

          {/* TAB 2: PRODUCTS REPORT (With Unit Rate, Qty Sold, and Total Amount) */}
          {tab === "products" && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-bold tracking-[0.14em]">
                <tr>
                  <th className="text-left px-4 py-3">SR NO</th>
                  <th className="text-left px-4 py-3">{t("item") || "ITEM NAME"}</th>
                  <th className="text-right px-4 py-3">RATE / UNIT PRICE (₹)</th>
                  <th className="text-right px-4 py-3">{t("qty_sold") || "QTY SOLD"}</th>
                  <th className="text-right px-4 py-3">TOTAL AMOUNT (₹)</th>
                </tr>
              </thead>
              <tbody data-testid="products-table">
                {productRows.map((it, i) => (
                  <tr key={it.name} className="border-t border-[#F4E6D7] hover:bg-[#FFF8F2]">
                    <td className="px-4 py-3 font-mono text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-3 font-semibold text-slate-900">{t(it.name)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-slate-700">₹{safeFixed(it.rate)}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">{safeNumber(it.qty)}</td>
                    <td className="px-4 py-3 text-right font-mono font-black text-slate-900">₹{safeFixed(it.revenue)}</td>
                  </tr>
                ))}
                {productRows.length === 0 && (
                  <tr>
                    <td colSpan="5" className="text-center text-muted-foreground py-12">
                      {loading ? "Loading..." : t("no_items_sold") || "No items sold"}
                    </td>
                  </tr>
                )}
              </tbody>
              {productRows.length > 0 && (
                <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-b-2 border-[#FF8A3D]" data-testid="products-total-row">
                  <tr className="border-t-2 border-b-2 border-[#FF8A3D]">
                    <td className="px-4 py-3.5 font-mono font-black tracking-wider text-[#FF6B00] text-sm">TOTAL :</td>
                    <td className="px-4 py-3.5 text-xs font-bold text-slate-800">
                      {productTotals.count} {productTotals.count === 1 ? t("item") || "Item" : t("items") || "Items"}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-slate-400">—</td>
                    <td className="px-4 py-3.5 text-right font-mono font-black text-slate-900 text-sm">{safeNumber(productTotals.qty)}</td>
                    <td className="px-4 py-3.5 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(productTotals.revenue)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}

          {/* TAB 3: THALIS REPORT */}
          {tab === "thalis" && (
            <div>
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 text-white bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-[11px] uppercase font-bold tracking-[0.14em]">
                  <tr>
                    <th className="text-left px-4 py-3">SR NO</th>
                    <th className="text-left px-4 py-3">{t("thali") || "THALI NAME"}</th>
                    <th className="text-right px-4 py-3">RATE / UNIT PRICE (₹)</th>
                    <th className="text-right px-4 py-3">{t("qty_sold") || "QTY SOLD"}</th>
                    <th className="text-right px-4 py-3">TOTAL AMOUNT (₹)</th>
                  </tr>
                </thead>
                <tbody data-testid="thalis-table">
                  {thaliRows.map((it, i) => (
                    <tr key={it.name} className="border-t border-[#F4E6D7] hover:bg-[#FFF8F2]">
                      <td className="px-4 py-3 font-mono text-muted-foreground">{i + 1}</td>
                      <td className="px-4 py-3 font-semibold text-slate-900">{t(it.name)}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-slate-700">₹{safeFixed(it.rate)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">{safeNumber(it.qty)}</td>
                      <td className="px-4 py-3 text-right font-mono font-black text-slate-900">₹{safeFixed(it.revenue)}</td>
                    </tr>
                  ))}
                  {thaliRows.length === 0 && (
                    <tr>
                      <td colSpan="5" className="text-center text-muted-foreground py-12">
                        {loading ? "Loading..." : t("no_thalis_sold") || "No thalis sold"}
                      </td>
                    </tr>
                  )}
                </tbody>
                {thaliRows.length > 0 && (
                  <tfoot className="sticky bottom-0 z-10 bg-[#FFF5EA] border-t-2 border-b-2 border-[#FF8A3D]" data-testid="thalis-total-row">
                    <tr className="border-t-2 border-b-2 border-[#FF8A3D]">
                      <td className="px-4 py-3.5 font-mono font-black tracking-wider text-[#FF6B00] text-sm">TOTAL :</td>
                      <td className="px-4 py-3.5 text-xs font-bold text-slate-800">
                        {thaliTotals.count} {thaliTotals.count === 1 ? t("thali") || "Thali" : t("thalis") || "Thalis"}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-slate-400">—</td>
                      <td className="px-4 py-3.5 text-right font-mono font-black text-slate-900 text-sm">{safeNumber(thaliTotals.qty)}</td>
                      <td className="px-4 py-3.5 text-right font-mono font-black text-[#FF6B00] text-base">₹{safeFixed(thaliTotals.revenue)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>

              {thaliPicks.length > 0 && (
                <div className="p-4 border-t border-[#F4E6D7] bg-[#FFF8F2]">
                  <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-2.5 font-bold">
                    {t("popular_thali_selections") || "Popular Thali Selections"}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {thaliPicks.slice(0, 20).map((p) => (
                      <span key={p.name} className="text-xs px-2.5 py-1 rounded-md bg-white border border-[#F4D8C4] shadow-2xs">
                        {t(p.name)} <span className="font-mono text-[#FF6B00] font-bold">×{p.qty}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom PDF-Style Print Status & Info Bar */}
        <div className="border-t border-[#F4E6D7] bg-[#FFF8F2] px-5 py-2.5 flex flex-wrap items-center justify-between text-[11px] text-slate-500 font-mono select-none">
          <div>
            Print on <span className="font-semibold text-slate-800">{printTimestamp}</span> By <span className="font-semibold text-slate-800">{cashierDisplayName}</span>
          </div>
          <div>
            Page No <span className="font-semibold text-slate-800">1</span> Of <span className="font-semibold text-slate-800">1</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
