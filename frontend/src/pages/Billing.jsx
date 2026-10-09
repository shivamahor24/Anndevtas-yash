import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import api from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Search,
  Banknote,
  CreditCard,
  Smartphone,
  Printer,
  ChefHat,
  ShoppingCart,
  X,
  Soup,
  UtensilsCrossed,
  Package,
  Sparkles,
  Flame,
  Leaf,
  Eye,
  CheckCircle2,
  RotateCcw
} from "lucide-react";
import { toast } from "sonner";
import { printReceipt } from "../lib/receipt";
import ThaliBuilder from "../components/ThaliBuilder";
import { useCart } from "../lib/useCart";
import { CartLine } from "../components/CartLine";
import { MenuTile } from "../components/MenuTile";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import ReceiptPreview from "../components/ReceiptPreview";
import { offlineStorage } from "../lib/offlineStorage";
import { syncQueue } from "../lib/syncQueue";
import { useOnlineStatus } from "../lib/offlineManager";
import { getCurrentToken, incrementToken } from "../lib/tokenManager";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { safeNumber, safeFixed } from "../lib/utils";

// Horizontal category tabs requested
// const CATEGORY_TABS = [
//   "ALL ITEMS",
//   "THALI",
//   "SABJI",
//   "DAL",
//   "RICE",
//   "BREAD",
//   "DRINKS",
// ];



export default function Billing() {
  const [categories, setCategories] = useState(() => {
    try {
      const cached = offlineStorage.loadCategories();
      return Array.isArray(cached) && cached.length > 0 ? cached : [];
    } catch {
      return [];
    }
  });
  const [menu, setMenu] = useState(() => {
    try {
      const cached = offlineStorage.loadMenu();
      return Array.isArray(cached) && cached.length > 0 ? cached : [];
    } catch {
      return [];
    }
  });
  const [settings, setSettings] = useState(null);
  const [activeCat, setActiveCat] = useState("ALL ITEMS");
  const [search, setSearch] = useState("");
  const [thaliFor, setThaliFor] = useState(null);
  const [activeTab, setActiveTab] = useState("cart"); // "cart" or "receipt"
  const [menuMode, setMenuMode] = useState("dining"); // No auto-selected menu mode by default
  const [showCartMobile, setShowCartMobile] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cart, setCart] = useState(() => {
    try {
      return offlineStorage.getCart();
    } catch {
      return [];
    }
  });
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [currentToken, setCurrentToken] = useState(getCurrentToken());

  const cgstRate = useMemo(() => {
    return settings?.cgst_rate ?? (settings?.gst_rate ? settings.gst_rate / 2 : 2.5);
  }, [settings]);

  const sgstRate = useMemo(() => {
    return settings?.sgst_rate ?? (settings?.gst_rate ? settings.gst_rate / 2 : 2.5);
  }, [settings]);

  // Compute Dining Menu and Parcel Menu lists from SINGLE SOURCE OF TRUTH
  const { diningItems, parcelItems } = useMemo(() => {
    const apiMenuList = Array.isArray(menu) ? menu : [];

    const checkIsThali = (item, catName) => {
      if (item.is_thali) return true;
      const c = (catName || item.category_name || item.category || "").toUpperCase();
      return c === "THALI";
    };

    const getEffectiveMenuType = (item, isThali) => {
      const type = item.menuType || item.menu_type;
      if (type && ["dining", "parcel", "both"].includes(type.toLowerCase())) {
        return type.toLowerCase();
      }
      return isThali ? "both" : "parcel";
    };

    // Single source map keying by item name (case-insensitive) to prevent duplicates
    const itemsMap = new Map();



    if (apiMenuList.length > 0) {
      apiMenuList.forEach((m) => {
        const catObj = Array.isArray(categories) ? categories.find(c => c.id === m.category_id) : null;
        const catName = catObj ? catObj.name.toUpperCase() : (m.category ? m.category.toUpperCase() : "GENERAL");
        const isThali = checkIsThali(m, catName);
        const menuType = getEffectiveMenuType(m, isThali);
        const key = m.name ? m.name.toLowerCase().trim() : m.id;

        itemsMap.set(key, {
          ...m,
          category_name: catName,
          category: catName,
          is_thali: isThali,
          menuType,
          menu_type: menuType,
          available: m.available !== false && m.available !== 0 && m.available !== "0" && m.available !== "false",
        });
      });
    }

    // SINGLE SOURCE ARRAY OF ALL UNIQUE ITEMS
    const singleSourceItems = Array.from(itemsMap.values());

    // Filter Dining Menu items from the SAME single source array:
    // Sirf items/thalis with menuType "dining" || "both"
    const dList = singleSourceItems.filter((item) => {
      const type = (item.type || item.menuType || item.menu_type || "").toLowerCase();
      return type === "dining" || type === "both";
    });

    // Filter Parcel Menu items from the SAME single source array:
    // Sirf items/thalis with menuType "parcel" || "both"
    const pList = singleSourceItems.filter((item) => {
      const type = (item.type || item.menuType || item.menu_type || "").toLowerCase();
      return type === "parcel" || type === "both";
    });

    return { diningItems: dList, parcelItems: pList };
  }, [menu, categories]);

  const menuItems = useMemo(() => {
    const map = new Map();
    diningItems.forEach((i) => map.set(i.id, i));
    parcelItems.forEach((i) => map.set(i.id, i));
    return Array.from(map.values());
  }, [diningItems, parcelItems]);

  const hasLoadedCart = useRef(false);
  const tokenAssignedRef = useRef(false);

  // Reset tokenAssignedRef when cart becomes empty
  useEffect(() => {
    if (cart.length === 0) {
      tokenAssignedRef.current = false;
    }
  }, [cart.length]);

  // Listen for token reset
  useEffect(() => {
    const handleTokenReset = () => {
      setCurrentToken(getCurrentToken());
      tokenAssignedRef.current = false;
    };
    window.addEventListener("tokenReset", handleTokenReset);
    return () => window.removeEventListener("tokenReset", handleTokenReset);
  }, []);

  // Persist cart to centralized offlineStorage whenever cart changes
  useEffect(() => {
    try {
      offlineStorage.saveCart(cart);
    } catch (e) {
      console.warn("Failed to save cart to storage:", e);
    }
  }, [cart]);

  const { user } = useAuth();
  const { language, changeLanguage, t } = useLanguage();
  const isOnline = useOnlineStatus();

  const addToCart = useCallback((item) => {
    console.log("Adding item:", item);

    const isThali = Boolean(
      item.is_thali ||
      item.category === "THALI" ||
      item.category_name === "THALI" ||
      (item.name && item.name.toLowerCase().includes("thali"))
    );

    // Enforce strict menu type matching for all items (including Thalis)
    const itemType = (item.type || item.menuType || item.menu_type || "").toLowerCase();
    if (menuMode && itemType) {
      if (itemType !== "both" && itemType !== menuMode) {
        console.warn(`Mismatch: Item type '${itemType}' does not match selected menu mode '${menuMode}'`);
        return;
      }
    }

    // Open Thali Rules & Customization modal for Thali items
    if (isThali) {
      setThaliFor(item);
      return;
    }

    if (cart.length === 0 && !tokenAssignedRef.current) {
      tokenAssignedRef.current = true;
      const nextTok = incrementToken();
      setCurrentToken(nextTok);
    }

    let parsedPrice = item.price;
    if (typeof parsedPrice === "string") {
      parsedPrice = parseFloat(parsedPrice.replace(/[^\d.]/g, "")) || 0;
    }

    const itemCategory = isThali ? "THALI" : (item.category_name || item.category || "GENERAL");

    const targetMode = menuMode || (itemType && itemType !== "both" ? itemType : "dining");

    // Per-item GST: if item has gst_enabled, use item_gst_rate; otherwise use global GST setting
    const itemHasGst = item.gst_enabled === true;
    const itemGstRate = itemHasGst ? (Number(item.item_gst_rate) || 0) : (cgstRate + sgstRate);
    const itemCgstRate = itemHasGst ? itemGstRate / 2 : cgstRate;
    const itemSgstRate = itemHasGst ? itemGstRate / 2 : sgstRate;

    // Both dining & parcel use raw parsedPrice (base price), with GST computed separately
    const finalPrice = parsedPrice;

    setCart((prev) => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i =>
          i.id === item.id
            ? { ...i, quantity: i.quantity + 1, qty: i.qty + 1, price: finalPrice, basePrice: parsedPrice, menuType: targetMode, category: itemCategory }
            : i
        );
      }
      return [...prev, {
        id: item.id,
        _key: item.id,
        name: item.name,
        price: finalPrice,
        basePrice: parsedPrice,
        category: itemCategory,
        is_thali: isThali,
        menuType: targetMode,
        quantity: 1,
        qty: 1,
        gst_enabled: itemHasGst,
        item_gst_rate: itemGstRate,
        cgst_rate: itemCgstRate,
        sgst_rate: itemSgstRate,
        rules: item.rules || null,
        thali_groups: item.thali_groups || item.thali_rules || item.rules || null,
        thali_selections: item.thali_selections || item.selections || null,
        thali_extras: item.thali_extras || item.extras || "",
        fixedInclusions: item.fixedInclusions || item.thali_extras || item.extras || "",
        sub_items: item.sub_items || item.subItems || item.included_items || item.includedItems || null,
        addons: item.addons || item.add_ons || item.addOns || null,
        included_items: item.included_items || item.includedItems || null,
        extra_bread: item.extra_bread || 0,
        extra_bread_charge: item.extra_bread_charge || 0,
      }];
    });

    toast.success(`Added ${item.name}`, {
      duration: 1500,
      icon: isThali ? "🍽️" : "📦",
    });
  }, [cart.length, menuMode, cgstRate, sgstRate]);

  const addLine = useCallback((line) => {
    const itemId = line.menu_item_id || line.id;

    if (cart.length === 0 && !tokenAssignedRef.current) {
      tokenAssignedRef.current = true;
      const nextTok = incrementToken();
      setCurrentToken(nextTok);
    }

    setCart((prev) => {
      const selectionsStr = JSON.stringify(line.thali_selections || {});
      const extrasStr = line.thali_extras || "";
      const lineMatchKey = `${itemId}-${selectionsStr}-${extrasStr}`;

      const existing = prev.find(
        (i) =>
          i._matchKey === lineMatchKey ||
          (i.id === itemId &&
            JSON.stringify(i.thali_selections || {}) === selectionsStr &&
            (i.thali_extras || "") === extrasStr)
      );

      if (existing) {
        return prev.map((i) =>
          i === existing
            ? {
                ...i,
                quantity: i.quantity + line.qty,
                qty: i.qty + line.qty,
                extra_bread: (i.extra_bread || 0) + (line.extra_bread || 0),
                extra_bread_charge: (i.extra_bread_charge || 0) + (line.extra_bread_charge || 0),
              }
            : i
        );
      }

      const uniqueKey = `${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let rawPrice = line.price;
      if (typeof rawPrice === "string") {
        rawPrice = parseFloat(rawPrice.replace(/[^\d.]/g, "")) || 0;
      }
      const finalPrice = rawPrice;

      return [
        ...prev,
        {
          id: itemId,
          _key: uniqueKey,
          _matchKey: lineMatchKey,
          menu_item_id: itemId,
          name: line.name,
          price: finalPrice,
          basePrice: rawPrice,
          category: "THALI",
          is_thali: true,
          quantity: line.qty,
          qty: line.qty,
          rules: line.rules || null,
          thali_groups: line.thali_groups || line.thali_rules || null,
          thali_selections: line.thali_selections,
          thali_extras: line.thali_extras,
          fixedInclusions: line.fixedInclusions || line.thali_extras || "",
          sub_items: line.sub_items || line.subItems || line.included_items || line.includedItems || null,
          addons: line.addons || line.add_ons || line.addOns || null,
          included_items: line.included_items || line.includedItems || null,
          bread_consumed: line.bread_consumed,
          extra_bread: line.extra_bread,
          extra_bread_charge: line.extra_bread_charge,
          current_stock: line.current_stock,
        },
      ];
    });
  }, [cart.length]);

  const updateQty = useCallback((keyOrId, delta) => {
    setCart((prev) =>
      prev
        .map((i) => {
          if (i._key === keyOrId || i.id === keyOrId || i.menu_item_id === keyOrId || i.productId === keyOrId) {
            const currentQty = i.quantity || i.qty || 1;
            const nextQty = currentQty + delta;
            if (nextQty <= 0) return null;
            return { ...i, quantity: nextQty, qty: nextQty };
          }
          return i;
        })
        .filter(Boolean)
    );
  }, []);

  const removeLine = useCallback((keyOrId) => {
    setCart((prev) => prev.filter((i) => i._key !== keyOrId && i.id !== keyOrId && i.menu_item_id !== keyOrId && i.productId !== keyOrId));
  }, []);

  const clear = useCallback(() => {
    setCart([]);
    setDiscount(0);
    offlineStorage.clearCart();
  }, []);

  const subtotal = useMemo(() => {
    return cart.reduce((sum, item) => {
      const lineItemTotal = item.price * item.quantity;
      const extraBreadTotal = (item.extra_bread_charge || 0) * item.quantity;
      return sum + lineItemTotal + extraBreadTotal;
    }, 0);
  }, [cart]);

  const isParcel = menuMode === "parcel";

  const cgst = useMemo(() => {
    return cart.reduce((sum, item) => {
      const lineTotal = item.price * item.quantity;
      const extraTotal = (item.extra_bread_charge || 0) * item.quantity;
      const gross = lineTotal + extraTotal;
      const cRate = item.cgst_rate !== undefined ? item.cgst_rate : cgstRate;
      const sRate = item.sgst_rate !== undefined ? item.sgst_rate : sgstRate;
      const totalRate = cRate + sRate;

      if (isParcel) {
        if (totalRate > 0) {
          const base = gross / (1 + totalRate / 100);
          const taxAmt = gross - base;
          return sum + taxAmt * (cRate / totalRate);
        }
        return sum;
      } else {
        return sum + gross * (cRate / 100);
      }
    }, 0);
  }, [cart, cgstRate, sgstRate, isParcel]);

  const sgst = useMemo(() => {
    return cart.reduce((sum, item) => {
      const lineTotal = item.price * item.quantity;
      const extraTotal = (item.extra_bread_charge || 0) * item.quantity;
      const gross = lineTotal + extraTotal;
      const cRate = item.cgst_rate !== undefined ? item.cgst_rate : cgstRate;
      const sRate = item.sgst_rate !== undefined ? item.sgst_rate : sgstRate;
      const totalRate = cRate + sRate;

      if (isParcel) {
        if (totalRate > 0) {
          const base = gross / (1 + totalRate / 100);
          const taxAmt = gross - base;
          return sum + taxAmt * (sRate / totalRate);
        }
        return sum;
      } else {
        return sum + gross * (sRate / 100);
      }
    }, 0);
  }, [cart, cgstRate, sgstRate, isParcel]);

  const gst = useMemo(() => {
    return cgst + sgst;
  }, [cgst, sgst]);

  const total = useMemo(() => {
    if (isParcel) {
      return Math.max(0, subtotal - discount);
    } else {
      return Math.max(0, subtotal + gst - discount);
    }
  }, [subtotal, gst, discount, isParcel]);

  const refresh = useCallback(async () => {
    // Clear temporary local storage items
    try {
      localStorage.removeItem("pos_offline_menu");
      localStorage.removeItem("menuItems");
      localStorage.removeItem("temp_menu_items");
    } catch (e) {
      console.warn("Local storage cleanup exception:", e);
    }

    try {
      const offlineSettings = offlineStorage.loadSettings() || {};
      const [c, m, s] = await Promise.all([
        api.get("/categories"),
        api.get("/menu"),
        api.get("/settings"),
      ]);

      const mergedSettings = {
        ...offlineSettings,
        ...(s.data || {}),
        fssai: (s.data && s.data.fssai !== undefined && s.data.fssai !== null)
          ? s.data.fssai
          : (offlineSettings.fssai || ""),
      };

      setCategories(c.data);
      setMenu(m.data);
      setSettings(mergedSettings);

      offlineStorage.saveCategories(c.data);
      offlineStorage.saveMenu(m.data);
      offlineStorage.saveSettings(mergedSettings);

      if (
        mergedSettings &&
        mergedSettings.language &&
        !localStorage.getItem("pos_language")
      ) {
        changeLanguage(mergedSettings.language);
      }
    } catch (e) {
      console.log("Loaded clean default POS data or offline.");
      const cached = offlineStorage.loadSettings();
      if (cached) setSettings(cached);
      const cachedMenu = offlineStorage.loadMenu();
      if (Array.isArray(cachedMenu) && cachedMenu.length > 0) setMenu(cachedMenu);
      const cachedCats = offlineStorage.loadCategories();
      if (Array.isArray(cachedCats) && cachedCats.length > 0) setCategories(cachedCats);
    }
  }, [changeLanguage]);

  useEffect(() => {
    refresh();
    const handleSettingsUpdate = () => {
      const cached = offlineStorage.loadSettings();
      if (cached) setSettings(cached);
      refresh();
    };
    window.addEventListener("settingsUpdated", handleSettingsUpdate);
    return () => {
      window.removeEventListener("settingsUpdated", handleSettingsUpdate);
    };
  }, [refresh]);



  // Filter list by category tab & search query
  const filterList = useCallback((list) => {
    const q = search.trim().toLowerCase();
    const targetCat = activeCat.trim().toUpperCase();

    return list.filter((item) => {
      const isThaliItem = Boolean(
        item.is_thali ||
        (item.category_name && item.category_name.toUpperCase() === "THALI") ||
        (item.category && item.category.toUpperCase() === "THALI") ||
        (item.name && item.name.toLowerCase().includes("thali"))
      );

      let matchCat = false;
      if (targetCat === "ALL ITEMS" || targetCat === "ALL") {
        matchCat = true;
      } else if (targetCat === "THALI") {
        matchCat = isThaliItem;
      } else {
        matchCat = !isThaliItem && (
          (item.category_name && item.category_name.toUpperCase() === targetCat) ||
          (item.category && item.category.toUpperCase() === targetCat)
        );
      }

      const matchSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        (item.category_name && item.category_name.toLowerCase().includes(q));

      const isAvail = item.available !== false && item.available !== 0 && item.available !== "0" && item.available !== "false";
      return matchCat && matchSearch && isAvail;
    });
  }, [search, activeCat]);

  const filteredDining = useMemo(() => filterList(diningItems), [filterList, diningItems]);
  const filteredParcel = useMemo(() => filterList(parcelItems), [filterList, parcelItems]);
  const allFilteredItems = useMemo(() => filterList(Array.isArray(menu) ? menu : []), [filterList, menu]);
  const activeFilteredCategoryItems = useMemo(
    () => (menuMode === "dining" ? filteredDining : menuMode === "parcel" ? filteredParcel : allFilteredItems),
    [menuMode, filteredDining, filteredParcel, allFilteredItems]
  );

  const showGlobalMenus = true;

  const checkout = useCallback(async (mode) => {
    if (isSubmitting) return;
    if (!cart.length) {
      toast.error(t("no_items_in_cart") || "Cart is empty");
      return;
    }
    setIsSubmitting(true);
    try {
      const orderNum = offlineStorage.getNextOrderNumber();
      const currentToken = getCurrentToken();
      const orderType = menuMode || "dining";

      // Build complete item objects
      const items = cart.map((item) => {
        const q = Number(item.qty || item.quantity || 1);
        const p = Number(item.price || 0);
        const ebCharge = Number(item.extra_bread_charge || 0);
        const itemTotal = p * q + ebCharge * q;
        const pId = item.productId || item.menu_item_id || item.id;
        return {
          productId: pId,
          id: pId,
          menu_item_id: pId,
          name: item.name,
          quantity: q,
          qty: q,
          price: p,
          total: itemTotal,
          cgst_rate: item.cgst_rate ?? cgstRate,
          sgst_rate: item.sgst_rate ?? sgstRate,
          tax_rate: (item.cgst_rate ?? cgstRate) + (item.sgst_rate ?? sgstRate),
          is_thali: Boolean(item.is_thali || item.category === "THALI"),
          rules: item.rules || null,
          thali_groups: item.thali_groups || item.thali_rules || item.rules || null,
          thali_selections: item.thali_selections || item.selections || null,
          thali_extras: item.thali_extras || item.extras || "",
          fixedInclusions: item.fixedInclusions || item.thali_extras || item.extras || "",
          sub_items: item.sub_items || item.subItems || item.included_items || item.includedItems || null,
          addons: item.addons || item.add_ons || item.addOns || null,
          included_items: item.included_items || item.includedItems || null,
          extra_bread: Number(item.extra_bread || 0),
          extra_bread_charge: ebCharge,
        };
      });

      const now = new Date().toISOString();
      const newOrder = {
        id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        billNumber: orderNum,
        orderNumber: orderNum,
        receipt_no: orderNum,
        createdAt: now,
        created_at: now,
        updatedAt: now,
        updated_at: now,
        paid_at: now,
        orderType: orderType,
        order_type: orderType,
        tableNumber: tableNumber ? String(tableNumber).trim() : "",
        table_number: tableNumber ? String(tableNumber).trim() : "",
        customerName: customerName.trim(),
        customer_name: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customer_phone: customerPhone.trim(),
        items: items,
        subtotal: subtotal,
        discount: discount,
        cgst: cgst,
        sgst: sgst,
        tax: gst,
        grandTotal: total,
        total: total,
        paymentMethod: mode,
        payment_mode: mode,
        paymentStatus: "Paid",
        payment_status: "Paid",
        orderStatus: "Completed",
        order_status: "Completed",
        cashier: user?.name || user?.email || "Cashier",
        cashier_name: user?.name || user?.email || "Cashier",
        cashier_email: user?.email || "",
        branchId: "main",
        token_no: currentToken,
      };

      // 1. Save to centralized offline storage first (guarantees offline-first durability)
      const savedOrder = offlineStorage.saveOrder(newOrder);

      // 2. Verify save succeeded
      const verified = offlineStorage.getOrderById(savedOrder.id);
      if (!verified) {
        throw new Error("Failed to verify order storage");
      }

      // 3. Clear cart ONLY after successful saving
      clear();
      setCustomerName("");
      setCustomerPhone("");
      setTableNumber("");
      setShowCartMobile(false);

      // Increment token for next order
      incrementToken();
      setCurrentToken(getCurrentToken());

      // Success notification
      toast.success(`Bill #${savedOrder.billNumber || savedOrder.orderNumber} placed successfully! · ₹${safeFixed(savedOrder.grandTotal)} (${mode.toUpperCase()})`);

      // 5. Auto-print if enabled
      if (settings?.auto_print !== false) {
        try {
          await printReceipt({ order: savedOrder, settings, menuMode });
        } catch (printErr) {
          console.error("Auto-print error after checkout:", printErr);
        }
      }

      // 6. Background sync to server if online, or queue for sync
      const payload = {
        id: savedOrder.id,
        order_type: orderType,
        items: savedOrder.items.map((i) => ({
          menu_item_id: i.productId,
          name: i.name,
          price: i.price,
          qty: i.quantity,
          cgst_rate: i.cgst_rate,
          sgst_rate: i.sgst_rate,
          tax_rate: i.tax_rate,
          is_thali: i.is_thali,
          rules: i.rules,
          thali_groups: i.thali_groups,
          thali_selections: i.thali_selections,
          thali_extras: i.thali_extras,
          fixedInclusions: i.fixedInclusions,
          sub_items: i.sub_items,
          addons: i.addons,
          included_items: i.included_items,
          extra_bread: i.extra_bread,
          extra_bread_charge: i.extra_bread_charge,
        })),
        discount: discount,
        payment_mode: mode,
        customer_name: customerName.trim() || undefined,
        customer_phone: customerPhone.trim() || undefined,
        table_number: tableNumber.trim() || undefined,
        token_no: currentToken,
        receipt_no: orderNum,
        bill_number: orderNum,
      };

      if (isOnline) {
        api.post("/orders", payload)
          .then(({ data }) => {
            if (data?.id) {
              offlineStorage.updateOrder(savedOrder.id, {
                server_id: data.id,
                receipt_no: data.receipt_no,
                billNumber: data.receipt_no,
                orderNumber: data.receipt_no,
              });
            }
          })
          .catch((err) => {
            console.warn("Background server sync failed, queued offline:", err);
            syncQueue.enqueue(payload);
          });
      } else {
        syncQueue.enqueue(payload);
      }
    } catch (e) {
      console.error("Checkout failed:", e);
      toast.error(e.message || t("checkout_failed") || "Failed to process checkout");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    cart,
    cgstRate,
    sgstRate,
    menuMode,
    tableNumber,
    customerName,
    customerPhone,
    subtotal,
    discount,
    cgst,
    sgst,
    gst,
    total,
    user,
    settings,
    isOnline,
    clear,
    t,
  ]);

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 sm:gap-3 lg:gap-4 bg-[#FAF7F2] p-1 sm:p-2 overflow-hidden billing-responsive-scale container billing-page-container">
      {/* Main Section: Food Menus */}
      <div className="col-span-7 sm:col-span-7 lg:col-span-8 xl:col-span-8 2xl:col-span-9 flex flex-col h-full min-h-0 bg-[#FFFDF9] rounded-3xl shadow-sm border border-[#F2E8DC] p-3 sm:p-6 overflow-hidden main-content menu-section">

        {/* Header & Search */}
        <div className="flex flex-col gap-4 pb-4 border-b border-[#F5EFE6]">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-[#FF6B00]">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Thali billing counter </span>
              </div>
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mt-0.5">
                Tab to bill
              </h1>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-52 md:w-60 lg:w-80">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                data-testid="menu-search"
                placeholder="Search food items..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10 pr-9 bg-white border-[#EFE5DA] focus:border-[#FF6B00] rounded-xl text-slate-800 shadow-2xs"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Horizontal Category Tabs */}
          {/* <div className="flex items-center gap-2 overflow-x-auto pb-1.5 pt-1 scrollbar-none">
            {CATEGORY_TABS.map((tab) => {
              const isActive = activeCat.toUpperCase() === tab;
              return (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveCat(tab);
                    if (tab === "ALL ITEMS") {
                      setMenuMode(null);
                    }
                  }}
                  data-testid={`cat-${tab.toLowerCase().replace(/\s+/g, "-")}`}
                  className={`
                    px-3.5 py-2 rounded-full text-[11px] sm:text-xs font-extrabold tracking-wider transition-all duration-200 whitespace-nowrap border shadow-2xs select-none
                    ${isActive
                      ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-md shadow-orange-500/20 scale-[1.02]"
                      : "bg-white text-slate-600 border-[#EFE5DA] hover:bg-[#FFF5ED] hover:text-[#FF6B00] hover:border-orange-200"
                    }
                  `}
                >
                  {tab}
                </button>
              );
            })}
          </div> */}

          {/* Dining Menu & Parcel Menu Toggle Buttons (ONLY visible for ALL ITEMS or THALI) */}
          {/* {showGlobalMenus && ( */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setMenuMode("dining")}
                data-testid="toggle-dining-menu"
                className={`px-5 py-2.5 rounded-xl text-xs font-extrabold tracking-wider transition-all duration-200 border flex items-center gap-2 select-none ${menuMode === "dining"
                    ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-md shadow-orange-500/20"
                    : "bg-white text-slate-700 border-[#EFE5DA] hover:bg-[#FFF5ED] hover:text-[#FF6B00]"
                  }`}
              >
                <UtensilsCrossed className="w-4 h-4" />
                Dining Menu
              </button>

              <button
                onClick={() => setMenuMode("parcel")}
                data-testid="toggle-parcel-menu"
                className={`px-5 py-2.5 rounded-xl text-xs font-extrabold tracking-wider transition-all duration-200 border flex items-center gap-2 select-none ${menuMode === "parcel"
                    ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-md shadow-orange-500/20"
                    : "bg-white text-slate-700 border-[#EFE5DA] hover:bg-[#FFF5ED] hover:text-[#FF6B00]"
                  }`}
              >
                <Package className="w-4 h-4" />
                Parcel Menu
              </button>
            </div>
          {/* )} */}
        </div>

        {/* Scrollable Content: Dining Menu & Parcel Menu */}
        <div className="flex-1 min-h-0 overflow-y-auto pt-5 pr-1 space-y-8 scroll-behavior-smooth">

          {/* ALL ITEMS SECTION (WHEN NEITHER DINING NOR PARCEL MODE TOGGLE IS ACTIVE) */}
          {/* {showGlobalMenus && !menuMode && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-orange-100 text-[#FF6B00]">
                    <UtensilsCrossed className="w-4 h-4" />
                  </div>
                  <h2 className="font-display text-xl font-extrabold text-slate-900 tracking-tight">
                    All Items
                  </h2>
                </div>
                <span className="text-xs font-bold text-orange-800 bg-orange-50 border border-orange-200 px-3 py-1 rounded-full">
                  {allFilteredItems.length} Items Available
                </span>
              </div>

              {allFilteredItems.length === 0 ? (
                <div className="text-center py-10 text-slate-400 border border-dashed border-[#EFE5DA] rounded-2xl bg-white/60 text-sm">
                  No items match "{search || activeCat}"
                </div>
              ) : (
                <div
                  className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3"
                  data-testid="all-items-grid"
                >
                  {allFilteredItems.map((item) => (
                    <MenuTile
                      key={item.id}
                      item={item}
                      onClick={() => addToCart(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          )} */}

          {/* SECTION 1: DINING MENU (ONLY visible for ALL ITEMS or THALI) */}
          {showGlobalMenus && menuMode === "dining" && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-orange-100 text-[#FF6B00]">
                    <UtensilsCrossed className="w-4 h-4" />
                  </div>
                  <h2 className="font-display text-xl font-extrabold text-slate-900 tracking-tight">
                    Dining Menu
                  </h2>
                </div>
                <span className="text-xs font-bold text-orange-800 bg-orange-50 border border-orange-200 px-3 py-1 rounded-full">
                  {filteredDining.length} Items Available
                </span>
              </div>

              {filteredDining.length === 0 ? (
                <div className="text-center py-10 text-slate-500 border border-dashed border-[#EFE5DA] rounded-2xl bg-white/60 text-sm flex flex-col items-center gap-3">
                  <p>No Dining items match "{search || activeCat}" or items are marked inactive.</p>
                  <button
                    onClick={async () => {
                      try {
                        await api.post("/menu/enable-all");
                        refresh();
                        toast.success("All menu items enabled!");
                      } catch (err) {
                        toast.error("Failed to enable menu items");
                      }
                    }}
                    className="px-4 py-2 bg-[#FF6B00] text-white text-xs font-bold rounded-xl shadow-xs hover:bg-[#e05e00] transition-colors cursor-pointer"
                  >
                    Enable All Items
                  </button>
                </div>
              ) : (
                <div
                  className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3"
                  data-testid="dining-menu-grid"
                >
                  {filteredDining.map((item) => (
                    <MenuTile
                      key={item.id}
                      item={item}
                      menuMode={menuMode}
                      gstRate={cgstRate + sgstRate}
                      onClick={() => addToCart(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* SECTION 2: PARCEL MENU (ONLY visible for ALL ITEMS or THALI) */}
          {showGlobalMenus && menuMode === "parcel" && (
            <section className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-amber-100 text-amber-700">
                    <Package className="w-4 h-4" />
                  </div>
                  <h2 className="font-display text-xl font-extrabold text-slate-900 tracking-tight">
                    Parcel Menu
                  </h2>
                </div>
                <span className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full">
                  {filteredParcel.length} Items Available
                </span>
              </div>

              {filteredParcel.length === 0 ? (
                <div className="text-center py-10 text-slate-500 border border-dashed border-[#EFE5DA] rounded-2xl bg-white/60 text-sm flex flex-col items-center gap-3">
                  <p>No Parcel items match "{search || activeCat}" or items are marked inactive.</p>
                  <button
                    onClick={async () => {
                      try {
                        await api.post("/menu/enable-all");
                        refresh();
                        toast.success("All menu items enabled!");
                      } catch (err) {
                        toast.error("Failed to enable menu items");
                      }
                    }}
                    className="px-4 py-2 bg-[#FF6B00] text-white text-xs font-bold rounded-xl shadow-xs hover:bg-[#e05e00] transition-colors cursor-pointer"
                  >
                    Enable All Items
                  </button>
                </div>
              ) : (
                <div
                  className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3"
                  data-testid="parcel-menu-grid"
                >
                  {filteredParcel.map((item) => (
                    <MenuTile
                      key={item.id}
                      item={item}
                      menuMode={menuMode}
                      gstRate={cgstRate + sgstRate}
                      onClick={() => addToCart(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* SPECIFIC CATEGORY VIEW (FOR SABJI, DAL, RICE, BREAD, DRINKS) */}
          {!showGlobalMenus && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-xl font-extrabold text-slate-900 tracking-tight uppercase">
                  {activeCat}
                </h2>
                <span className="text-xs font-bold text-slate-700 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full">
                  {activeFilteredCategoryItems.length} Items
                </span>
              </div>

              {activeFilteredCategoryItems.length === 0 ? (
                <div className="text-center py-10 text-slate-400 border border-dashed border-[#EFE5DA] rounded-2xl bg-white/60 text-sm">
                  No items match "{search || activeCat}"
                </div>
              ) : (
                <div
                  className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3"
                  data-testid="category-menu-grid"
                >
                  {activeFilteredCategoryItems.map((item) => (
                    <MenuTile
                      key={item.id}
                      item={item}
                      menuMode={menuMode}
                      gstRate={cgstRate + sgstRate}
                      onClick={() => addToCart(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* Mobile Cart Backdrop */}
      {showCartMobile && (
        <div
          className="lg:hidden fixed inset-0 bg-black/40 z-30 backdrop-blur-sm transition-opacity duration-300"
          onClick={() => setShowCartMobile(false)}
        />
      )}

      {/* Active Bill Sidebar Column */}
      <div className={`cart-panel cart-section
        fixed inset-y-0 right-0 z-40
        w-full
        transform transition-transform duration-300
        sm:relative sm:translate-x-0 sm:inset-auto
        col-span-5 sm:col-span-5 lg:col-span-4 xl:col-span-4 2xl:col-span-3
        sm:w-auto
        bg-[#FFFDF9]
        rounded-[32px]
        shadow-sm
        border
        border-[#F4E6D7]
        overflow-hidden
        flex flex-col
        ${showCartMobile ? "translate-x-0" : "max-sm:translate-x-full"}`}
      >
        {/* Orange Header */}
        <div className="relative overflow-hidden p-5 bg-gradient-to-br from-[#FF8A3D] to-[#FF6B00] text-white">
          <div className="absolute top-4 right-2 w-12 h-12 rounded-full bg-white/15 pointer-events-none" />
          <div className="absolute top-16 right-6 w-10 h-10 rounded-full bg-white/15 pointer-events-none" />
          <div>
            <div className="text-xs font-extrabold uppercase tracking-widest text-white/90">
              ACTIVE BILL
            </div>
            <div className="font-display text-lg font-extrabold mt-0.5">
              {cart.length} {cart.length === 1 ? "Line in Order" : "Lines in Order"}
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <div className="bg-white/10 text-white/90 rounded-xl px-2.5 h-8 flex items-center text-xs select-none">
              <span>Token: <span className="font-extrabold text-white ml-1">#{currentToken}</span></span>
            </div>
            <div className="bg-white/15 text-white uppercase text-[10px] font-extrabold px-2.5 h-8 rounded-xl flex items-center select-none tracking-wider">
              {menuMode === "dining" ? "Dine-in" : "Parcel"}
            </div>
          </div>

          {/* Table No & Customer Inputs */}
          <div className="mt-2.5 grid grid-cols-2 gap-1.5 pt-2 border-t border-white/15">
            {menuMode === "dining" ? (
              <Input
                placeholder="Table No. (e.g. 05)"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                className="h-7 text-xs bg-white/10 border-white/20 text-white placeholder:text-white/60 focus:bg-white/20 rounded-lg px-2"
                data-testid="cart-table-no"
              />
            ) : (
              <Input
                placeholder="Customer Phone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                className="h-7 text-xs bg-white/10 border-white/20 text-white placeholder:text-white/60 focus:bg-white/20 rounded-lg px-2"
                data-testid="cart-customer-phone"
              />
            )}
            <Input
              placeholder="Customer Name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className="h-7 text-xs bg-white/10 border-white/20 text-white placeholder:text-white/60 focus:bg-white/20 rounded-lg px-2"
              data-testid="cart-customer-name"
            />
          </div>
        </div>

        {/* Tabs: CART LIST & RECEIPT PREVIEW */}
        <div className="flex border-b border-[#F4E6D7] bg-white">
          <button
            onClick={() => setActiveTab("cart")}
            className={`flex-1 py-3 text-xs font-extrabold tracking-wider border-b-2 text-center transition-all select-none ${activeTab === "cart"
                ? "border-[#FF6B00] text-[#FF6B00] bg-[#FFFBF7]"
                : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
          >
            CART LIST
          </button>
          <button
            onClick={() => setActiveTab("receipt")}
            className={`flex-1 py-3 text-xs font-extrabold tracking-wider border-b-2 text-center transition-all select-none ${activeTab === "receipt"
                ? "border-[#FF6B00] text-[#FF6B00] bg-[#FFFBF7]"
                : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
          >
            RECEIPT PREVIEW
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === "cart" ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-3 cart-items">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3 my-auto min-h-[220px]">
                <div className="w-16 h-16 rounded-full bg-orange-50 border border-orange-100 flex items-center justify-center text-[#FF6B00] shadow-2xs">
                  <ShoppingCart className="w-8 h-8 stroke-[1.75]" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-display text-base font-extrabold text-slate-800">
                    Your Cart is Empty
                  </h3>
                  <p className="text-xs text-slate-500 max-w-[240px] leading-relaxed">
                    Click '+' on any Dining or Parcel food card to add items to bill.
                  </p>
                </div>
              </div>
            ) : (
              cart.map((line) => (
                <CartLine
                  key={line._key || line.id}
                  line={line}
                  onInc={() => updateQty(line._key || line.id, 1)}
                  onDec={() => updateQty(line._key || line.id, -1)}
                  onRemove={() => removeLine(line._key || line.id)}
                  onEditThali={(thaliLine) => setThaliFor(thaliLine)}
                />
              ))
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 bg-slate-50">
            <ReceiptPreview
              cart={cart}
              totals={{ subtotal, cgst, sgst, tax: gst, total, discount }}
              settings={settings}
              customerName={customerName}
              tokenNo={currentToken}
              menu={menuItems}
              menuMode={menuMode}
            />
          </div>
        )}

        {/* Pricing Summary & Checkout Buttons */}
        <div className="p-4 border-t border-[#F5EFE6] bg-[#FFFDF9] space-y-3">
          <div className="space-y-2 text-xs text-slate-600">
            <div className="flex justify-between items-center">
              <span className="font-medium text-slate-600">{isParcel ? "Subtotal (Incl. GST)" : "Subtotal"}</span>
              <span className="font-mono font-bold text-slate-800">₹{safeFixed(subtotal)}</span>
            </div>
            <div className="flex justify-between items-center text-slate-500">
              <span>CGST ({cgstRate}%{isParcel ? " incl." : ""})</span>
              <span className="font-mono">₹{safeFixed(cgst)}</span>
            </div>
            <div className="flex justify-between items-center text-slate-500">
              <span>SGST ({sgstRate}%{isParcel ? " incl." : ""})</span>
              <span className="font-mono">₹{safeFixed(sgst)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="font-medium text-slate-600">Discount</span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-slate-400 text-xs">₹</span>
                <Input
                  type="number"
                  min="0"
                  value={discount || ""}
                  onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-20 h-7 text-right font-mono text-xs bg-white border-[#F4E6D7] rounded-lg focus:border-[#FF6B00]"
                />
              </div>
            </div>
            <div className="flex justify-between items-center text-base font-extrabold text-slate-900 pt-2.5 border-t border-dashed border-slate-200">
              <span>Total</span>
              <span className="font-mono text-xl font-black text-[#FF6B00]">₹{safeFixed(total)}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 pt-1">
            <button
              disabled={cart.length === 0 || isSubmitting}
              onClick={() => {
                setPaymentMethod("cash");
                checkout("cash");
              }}
              data-testid="pay-cash-btn"
              className={`flex items-center justify-center gap-1 py-2.5 px-1.5 sm:px-2.5 text-[11px] sm:text-xs font-bold rounded-full transition-all border select-none active:scale-95 ${
                cart.length === 0 || isSubmitting
                  ? "opacity-50 cursor-not-allowed bg-slate-100 text-slate-400 border-slate-200"
                  : paymentMethod === "cash"
                  ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-md shadow-orange-500/20"
                  : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              <Banknote className="w-3.5 h-3.5 shrink-0" />
              <span>{isSubmitting ? "..." : "CASH"}</span>
            </button>
            <button
              disabled={cart.length === 0 || isSubmitting}
              onClick={() => {
                setPaymentMethod("upi");
                checkout("upi");
              }}
              data-testid="pay-upi-btn"
              className={`flex items-center justify-center gap-1 py-2.5 px-1.5 sm:px-2.5 text-[11px] sm:text-xs font-bold rounded-full transition-all border select-none active:scale-95 ${
                cart.length === 0 || isSubmitting
                  ? "opacity-50 cursor-not-allowed bg-slate-100 text-slate-400 border-slate-200"
                  : paymentMethod === "upi"
                  ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-md shadow-orange-500/20"
                  : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              <span>{isSubmitting ? "..." : "UPI"}</span>
            </button>
            <button
              disabled={cart.length === 0 || isSubmitting}
              onClick={() => {
                setPaymentMethod("card");
                checkout("card");
              }}
              data-testid="pay-card-btn"
              className={`flex items-center justify-center gap-1 py-2.5 px-1.5 sm:px-2.5 text-[11px] sm:text-xs font-bold rounded-full transition-all border select-none active:scale-95 ${
                cart.length === 0 || isSubmitting
                  ? "opacity-50 cursor-not-allowed bg-slate-100 text-slate-400 border-slate-200"
                  : paymentMethod === "card"
                  ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-md shadow-orange-500/20"
                  : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              <CreditCard className="w-3.5 h-3.5 shrink-0" />
              <span>{isSubmitting ? "..." : "CARD"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Thali Builder Modal */}
      {thaliFor && (
        <ThaliBuilder
          thaliItem={thaliFor}
          menu={menu}
          categories={categories}
          onClose={() => setThaliFor(null)}
          onAdd={handleAddThaliOrder}
        />
      )}
    </div>
  );

  function handleAddThaliOrder(orderItemPayload) {
    addLine(orderItemPayload);
    toast.success(`Added ${orderItemPayload.name} to bill`, { icon: "🍽️" });
    setThaliFor(null);
  }
}
