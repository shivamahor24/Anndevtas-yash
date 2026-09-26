// offlineStorage.js
// Centralized offline-first storage and order management service for Anndevta POS.

const KEYS = {
  MENU: "pos_offline_menu",
  CATEGORIES: "pos_offline_categories",
  SETTINGS: "pos_offline_settings",
  USER: "pos_offline_user",
  ORDERS: "pos_offline_orders",
  CART: "pos_cart",
  LAST_ORDER_NUMBER: "pos_last_order_num",
};

function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
    return true;
  } catch (e) {
    console.error(`offlineStorage.save failed for key "${key}":`, e);
    throw new Error(`Failed to save to local storage: ${e.message}`);
  }
}

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data !== undefined ? parsed.data : parsed;
  } catch (e) {
    console.error(`offlineStorage.load failed for key "${key}":`, e);
    throw new Error(`Corrupted storage data for "${key}": ${e.message}`);
  }
}

/**
 * Converts any order/receipt number into a clean, sequential, customer-facing Bill Number (1, 2, 3...).
 * Strictly eliminates 1000-series numbers (e.g. 1001 -> 1, 1005 -> 5).
 * Rejects internal UUIDs and timestamp order IDs.
 */
export function canonicalBillNumber(val) {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "string" && (val.startsWith("ord_") || val.includes("-") || val.length > 7)) {
    return 0;
  }
  const clean = String(val).trim();
  const withoutPrefix = clean.replace(/^(?:bill|bill\s*#|#)/i, "").trim();
  if (/[a-zA-Z_-]/.test(withoutPrefix)) return 0;
  const n = parseInt(withoutPrefix.replace(/[^0-9]/g, ""), 10);
  if (isNaN(n) || n <= 0) return 0;
  if (n >= 1001 && n < 2000) {
    return n - 1000;
  }
  return n;
}

/**
 * Safely parses any value into a finite number.
 * Returns the fallback (default 0) if the value is null, undefined, NaN, or non-numeric.
 */
export function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safely formats any numeric value to a fixed number of decimal places without throwing.
 */
export function safeFixed(value, digits = 2, fallback = 0) {
  return safeNumber(value, fallback).toFixed(digits);
}

/**
 * Normalizes an order to have both consistent modern schema and backward-compatible aliases.
 * Customer-facing bill number is always a clean sequential integer (1, 2, 3...).
 */
export function normalizeOrder(order) {
  if (!order || typeof order !== "object") return null;

  const rawNum = order.billNumber ?? order.orderNumber ?? order.receipt_no ?? 0;
  const billNum = canonicalBillNumber(rawNum);

  const nowStr = new Date().toISOString();
  const createdAt = order.createdAt || order.created_at || order.paid_at || nowStr;
  const updatedAt = order.updatedAt || order.updated_at || createdAt;
  const paidAt = order.paid_at || order.paidAt || createdAt;

  const rawItems = Array.isArray(order.items) ? order.items : [];
  const items = rawItems.map((item, idx) => {
    const pId = item.productId || item.menu_item_id || item.id || `item_${idx}`;
    const qty = safeNumber(item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 1), 1);
    const price = safeNumber(item.price, 0);
    const extraBreadCharge = safeNumber(item.extra_bread_charge, 0);
    const total = safeNumber(item.total !== undefined ? item.total : (price * qty + extraBreadCharge * qty), 0);
    const rev = safeNumber(item.revenue !== undefined ? item.revenue : total, 0);

    return {
      ...item,
      productId: pId,
      id: pId,
      menu_item_id: pId,
      name: item.name || "Item",
      quantity: qty,
      qty: qty,
      price: price,
      total: total,
      revenue: rev,
      cgst_rate: safeNumber(item.cgst_rate, 0),
      sgst_rate: safeNumber(item.sgst_rate, 0),
      tax_rate: safeNumber(item.tax_rate, 0),
      is_thali: Boolean(item.is_thali || item.category === "THALI" || item.category_name === "THALI"),
      extra_bread: safeNumber(item.extra_bread, 0),
      extra_bread_charge: extraBreadCharge,
      thali_selections: item.thali_selections || null,
      thali_extras: item.thali_extras || item.extras || "",
      fixedInclusions: item.fixedInclusions || item.thali_extras || item.extras || "",
      rules: item.rules || null,
      thali_groups: item.thali_groups || null,
    };
  });

  const subtotal = safeNumber(order.subtotal !== undefined ? order.subtotal : items.reduce((s, it) => s + it.total, 0), 0);
  const discount = safeNumber(order.discount, 0);
  const cgst = safeNumber(order.cgst, 0);
  const sgst = safeNumber(order.sgst, 0);
  const tax = safeNumber(order.tax !== undefined ? order.tax : (cgst + sgst), 0);
  const grandTotal = safeNumber(order.grandTotal !== undefined ? order.grandTotal : (order.total !== undefined ? order.total : Math.max(0, subtotal + tax - discount)), 0);

  const orderType = order.orderType || order.order_type || "dining";
  const tableNumber = order.tableNumber !== undefined ? String(order.tableNumber) : (order.table_number !== undefined ? String(order.table_number) : "");
  const customerName = order.customerName || order.customer_name || "";
  const customerPhone = order.customerPhone || order.customer_phone || "";
  const paymentMethod = order.paymentMethod || order.payment_mode || "cash";
  const paymentStatus = order.paymentStatus || (order.payment_status ? order.payment_status : "Paid");
  const orderStatus = order.orderStatus || (order.order_status ? order.order_status : "Completed");

  return {
    ...order,
    id: order.id || `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    server_id: order.server_id || (order.id && !String(order.id).startsWith("ord_") ? order.id : undefined),
    billNumber: billNum > 0 ? billNum : undefined,
    orderNumber: billNum > 0 ? billNum : undefined,
    receipt_no: billNum > 0 ? billNum : undefined,
    createdAt: createdAt,
    created_at: createdAt,
    updatedAt: updatedAt,
    updated_at: updatedAt,
    paid_at: paidAt,
    orderType: orderType,
    order_type: orderType,
    tableNumber: tableNumber,
    table_number: tableNumber,
    customerName: customerName,
    customer_name: customerName,
    customerPhone: customerPhone,
    customer_phone: customerPhone,
    items: items,
    subtotal: subtotal,
    discount: discount,
    cgst: cgst,
    sgst: sgst,
    tax: tax,
    grandTotal: grandTotal,
    total: grandTotal,
    paymentMethod: paymentMethod,
    payment_mode: paymentMethod,
    paymentStatus: paymentStatus,
    payment_status: paymentStatus,
    orderStatus: orderStatus,
    order_status: orderStatus,
    cashier: order.cashier || order.cashier_name || "Cashier",
    cashier_name: order.cashier_name || order.cashier || "Cashier",
    cashier_email: order.cashier_email || "",
    branchId: order.branchId || "main",
    token_no: order.token_no,
  };
}

/**
 * Deduplicates and merges multiple records representing the same order.
 * Dedupes strictly by permanent order ID or server_id, never by customer-facing bill numbers.
 * Preserves the actual order data from the valid record.
 */
export function deduplicateOrders(ordersList) {
  if (!Array.isArray(ordersList) || ordersList.length === 0) return [];

  const orderMap = new Map(); // Key: permanent unique order ID

  ordersList.forEach((raw) => {
    const order = normalizeOrder(raw);
    if (!order) return;

    // Use permanent unique internal order ID as primary key
    const primaryKey = String(order.id);

    if (!orderMap.has(primaryKey)) {
      orderMap.set(primaryKey, order);
    } else {
      const existing = orderMap.get(primaryKey);
      const hasBetterItems = Array.isArray(order.items) && order.items.length > (Array.isArray(existing.items) ? existing.items.length : 0);
      const chosenItems = hasBetterItems ? order.items : existing.items;
      const chosenTotal = (order.grandTotal && order.grandTotal > 0) ? order.grandTotal : existing.grandTotal;

      const merged = {
        ...existing,
        ...order,
        id: existing.id || order.id,
        server_id: existing.server_id || order.server_id,
        items: chosenItems,
        grandTotal: chosenTotal,
        total: chosenTotal,
        createdAt: existing.createdAt || order.createdAt,
        paid_at: existing.paid_at || order.paid_at,
        customerName: order.customerName || existing.customerName || "",
        customerPhone: order.customerPhone || existing.customerPhone || "",
        tableNumber: order.tableNumber || existing.tableNumber || "",
        updatedAt: new Date().toISOString(),
      };
      orderMap.set(primaryKey, merged);
    }
  });

  return Array.from(orderMap.values());
}


/**
 * Ensures that the list of orders forms a strictly continuous, gap-free, duplicate-free sequential bill number series.
 * Preserves the lowest starting bill number (e.g. 1, 2020, 2021) and ensures each subsequent order is exactly previous + 1.
 * Internal IDs and order data are preserved untouched.
 */
export function healSequenceGaps(ordersList) {
  if (!Array.isArray(ordersList) || ordersList.length === 0) return [];
  if (ordersList.length === 1) return ordersList;

  // Sort chronological / ascending by existing canonical bill number, fallback to createdAt
  const sorted = [...ordersList].sort((a, b) => {
    const aNum = canonicalBillNumber(a.billNumber || a.orderNumber || a.receipt_no);
    const bNum = canonicalBillNumber(b.billNumber || b.orderNumber || b.receipt_no);
    if (aNum > 0 && bNum > 0 && aNum !== bNum) return aNum - bNum;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });

  const baseNum = canonicalBillNumber(sorted[0].billNumber || sorted[0].orderNumber || sorted[0].receipt_no) || 1;

  sorted.forEach((order, index) => {
    const targetBillNum = baseNum + index;
    const currentNum = canonicalBillNumber(order.billNumber || order.orderNumber || order.receipt_no);
    if (currentNum !== targetBillNum) {
      order.billNumber = targetBillNum;
      order.orderNumber = targetBillNum;
      order.receipt_no = targetBillNum;
      order.updatedAt = new Date().toISOString();
    }
  });

  // Return sorted descending (newest bill first)
  return sorted.sort((a, b) => {
    const aNum = Number(a.billNumber || a.orderNumber || a.receipt_no || 0);
    const bNum = Number(b.billNumber || b.orderNumber || b.receipt_no || 0);
    if (aNum !== bNum) return bNum - aNum;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

// ----------------------------------------------------
// Order Storage Operations
// ----------------------------------------------------

/**
 * Returns the next simple sequential Bill Number starting from 1 (#1, #2, #3...) or continuing the sequence.
 * Always continues from the current highest bill number + 1.
 */
export function getNextOrderNumber() {
  try {
    const orders = getOrders();
    let maxBillNum = 0;
    orders.forEach((o) => {
      const num = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
      if (num > maxBillNum) maxBillNum = num;
    });

    const storedLast = canonicalBillNumber(localStorage.getItem(KEYS.LAST_ORDER_NUMBER) || 0);
    const nextNum = maxBillNum > 0 ? (maxBillNum + 1) : Math.max(storedLast, 0) + 1;
    localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(nextNum));
    return nextNum;
  } catch (e) {
    console.warn("Error calculating next bill number:", e);
    return 1;
  }
}

export function getOrders() {
  try {
    const raw = localStorage.getItem(KEYS.ORDERS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = parsed?.data !== undefined ? parsed.data : parsed;
    if (!Array.isArray(list)) return [];

    const deduplicated = deduplicateOrders(list);
    const sequenced = healSequenceGaps(deduplicated);

    // If existing duplicate data or gaps were healed, persist the clean array back
    if (sequenced.length !== list.length || JSON.stringify(sequenced) !== JSON.stringify(list)) {
      save(KEYS.ORDERS, sequenced);

      let maxBillNum = 0;
      sequenced.forEach((o) => {
        const num = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
        if (num > maxBillNum) maxBillNum = num;
      });
      localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(maxBillNum));
    }

    return sequenced;
  } catch (e) {
    console.error("offlineStorage.getOrders failed:", e);
    throw new Error(`Unable to load orders from storage: ${e.message}`);
  }
}

export function getOrderById(orderId) {
  if (!orderId) return null;
  const orders = getOrders();
  const searchKey = String(orderId).trim();
  const searchNum = canonicalBillNumber(searchKey);

  return orders.find(
    (o) =>
      String(o.id) === searchKey ||
      String(o.server_id) === searchKey ||
      (searchNum > 0 && (o.billNumber === searchNum || o.orderNumber === searchNum || o.receipt_no === searchNum))
  ) || null;
}

export function saveOrder(order) {
  if (!order || typeof order !== "object") {
    throw new Error("Invalid order object: order must be a valid object.");
  }
  if (!Array.isArray(order.items) || order.items.length === 0) {
    throw new Error("Cannot save order: Cart contains no items.");
  }

  // Ensure unique internal ID
  const orderId = order.id || `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Bill number MUST be permanently associated with the original order.
  // Never generate a new bill number if one already exists!
  let billNumber = canonicalBillNumber(order.billNumber || order.orderNumber || order.receipt_no);
  if (!billNumber || billNumber <= 0) {
    billNumber = getNextOrderNumber();
  }

  const normalized = normalizeOrder({
    ...order,
    id: orderId,
    billNumber: billNumber,
    orderNumber: billNumber,
    receipt_no: billNumber,
    createdAt: order.createdAt || order.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Load existing orders safely
  let currentOrders = [];
  try {
    currentOrders = getOrders();
  } catch (e) {
    currentOrders = [];
  }

  // Check if order already exists in storage (strictly by permanent order ID)
  const existingIndex = currentOrders.findIndex((o) =>
    String(o.id) === String(normalized.id)
  );

  if (existingIndex >= 0) {
    // Update existing record rather than creating a duplicate
    const existing = currentOrders[existingIndex];
    currentOrders[existingIndex] = {
      ...existing,
      ...normalized,
      id: existing.id || normalized.id,
      server_id: existing.server_id || normalized.server_id,
      billNumber: existing.billNumber || normalized.billNumber,
      orderNumber: existing.billNumber || normalized.billNumber,
      receipt_no: existing.billNumber || normalized.billNumber,
      updatedAt: new Date().toISOString(),
    };
  } else {
    currentOrders.unshift(normalized);
  }

  // Run deduplication and sequencing to guarantee continuous series
  const deduplicated = deduplicateOrders(currentOrders);
  const sequenced = healSequenceGaps(deduplicated);
  save(KEYS.ORDERS, sequenced);

  // Update LAST_ORDER_NUMBER so next checkout continues sequentially
  let maxBillNum = 0;
  sequenced.forEach((o) => {
    const num = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
    if (num > maxBillNum) maxBillNum = num;
  });
  localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(maxBillNum));

  // Verification step
  const savedVerification = getOrderById(normalized.id) || getOrderById(normalized.billNumber);
  if (!savedVerification) {
    throw new Error("Storage verification failed: order was not found in offline storage after write.");
  }

  // Emit events for reactive cross-component synchronization
  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: savedVerification }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: savedVerification }));
  } catch (_) {}

  return savedVerification;
}

export function updateOrder(orderId, updates) {
  if (!orderId) throw new Error("Order ID is required to update order");
  const orders = getOrders();
  const searchKey = String(orderId).trim();
  const searchNum = canonicalBillNumber(searchKey);

  const idx = orders.findIndex(
    (o) =>
      String(o.id) === searchKey ||
      String(o.server_id) === searchKey ||
      (searchNum > 0 && (o.billNumber === searchNum || o.orderNumber === searchNum || o.receipt_no === searchNum))
  );

  if (idx < 0) {
    throw new Error(`Order with ID ${orderId} not found in offline storage`);
  }

  const existing = orders[idx];
  // Preserve permanent bill number
  const originalBillNumber = existing.billNumber || existing.orderNumber || existing.receipt_no;

  const updatedOrder = normalizeOrder({
    ...existing,
    ...updates,
    billNumber: originalBillNumber,
    orderNumber: originalBillNumber,
    receipt_no: originalBillNumber,
    updatedAt: new Date().toISOString(),
  });

  orders[idx] = updatedOrder;
  const deduplicated = deduplicateOrders(orders);
  save(KEYS.ORDERS, deduplicated);

  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: updatedOrder }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: updatedOrder }));
  } catch (_) {}

  return updatedOrder;
}

export function deleteOrder(orderId) {
  if (!orderId) return false;
  const orders = getOrders();
  const searchKey = String(orderId).trim();
  const searchNum = canonicalBillNumber(searchKey);

  const targetIdx = orders.findIndex(
    (o) =>
      String(o.id) === searchKey ||
      String(o.server_id) === searchKey ||
      (searchNum > 0 && (o.billNumber === searchNum || o.orderNumber === searchNum || o.receipt_no === searchNum))
  );

  if (targetIdx < 0) {
    console.warn(`deleteOrder: Order ${orderId} not found in offline storage.`);
    return false;
  }

  const targetOrder = orders[targetIdx];
  const deletedBillNum = canonicalBillNumber(targetOrder.billNumber || targetOrder.orderNumber || targetOrder.receipt_no);

  // 1. Remove the deleted order record
  let remaining = orders.filter(
    (o) =>
      o.id !== targetOrder.id &&
      (!targetOrder.server_id || o.server_id !== targetOrder.server_id)
  );

  // 2. Decrease the customer-facing bill number by 1 for every bill that came after the deleted bill
  if (deletedBillNum > 0) {
    remaining.forEach((o) => {
      const bNum = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
      if (bNum > deletedBillNum) {
        const shifted = bNum - 1;
        o.billNumber = shifted;
        o.orderNumber = shifted;
        o.receipt_no = shifted;
        o.updatedAt = new Date().toISOString();
      }
    });
  }

  // 3. Heal any remaining sequence gaps to guarantee continuous 1, 2, 3... series
  remaining = healSequenceGaps(remaining);

  // 4. Update the latest order number counter based on current remaining orders
  let maxBillNum = 0;
  remaining.forEach((o) => {
    const num = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
    if (num > maxBillNum) maxBillNum = num;
  });
  localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(maxBillNum));

  // 5. Persist the updated orders to local storage
  save(KEYS.ORDERS, remaining);

  // 6. Broadcast event across all components (Order History, Reports, Dashboard)
  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: { deletedId: targetOrder.id, remaining } }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: { deletedId: targetOrder.id, remaining } }));
  } catch (_) {}

  return true;
}

export function resetOrders() {
  try {
    localStorage.removeItem(KEYS.ORDERS);
    localStorage.setItem(KEYS.LAST_ORDER_NUMBER, "0");
    window.dispatchEvent(new CustomEvent("ordersUpdated"));
    window.dispatchEvent(new CustomEvent("pos_orders_changed"));
    return true;
  } catch (e) {
    console.error("Failed to reset orders:", e);
    throw e;
  }
}

// ----------------------------------------------------
// Cart Storage Operations
// ----------------------------------------------------

export function getCart() {
  try {
    const raw = localStorage.getItem(KEYS.CART);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("Failed to load cart from storage:", e);
    return [];
  }
}

export function saveCart(cart) {
  try {
    if (!Array.isArray(cart) || cart.length === 0) {
      localStorage.removeItem(KEYS.CART);
    } else {
      localStorage.setItem(KEYS.CART, JSON.stringify(cart));
    }
  } catch (e) {
    console.warn("Failed to persist cart to storage:", e);
  }
}

export function clearCart() {
  try {
    localStorage.removeItem(KEYS.CART);
  } catch (_) {}
}

// ----------------------------------------------------
// Unified Storage Object & Aliases
// ----------------------------------------------------

export const offlineStorage = {
  // Menu & Settings
  saveMenu: (data) => save(KEYS.MENU, data),
  loadMenu: () => {
    const val = load(KEYS.MENU);
    return Array.isArray(val) ? val : [];
  },

  saveCategories: (data) => save(KEYS.CATEGORIES, data),
  loadCategories: () => {
    const val = load(KEYS.CATEGORIES);
    return Array.isArray(val) ? val : [];
  },

  saveSettings: (data) => save(KEYS.SETTINGS, data),
  loadSettings: () => load(KEYS.SETTINGS) || null,

  saveUser: (data) => save(KEYS.USER, data),
  loadUser: () => load(KEYS.USER) || null,

  clearAuth: () => {
    localStorage.removeItem(KEYS.USER);
  },

  clear: () => {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  },

  // Orders
  saveOrder,
  getOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
  resetOrders,
  getNextOrderNumber,
  canonicalBillNumber,
  healSequenceGaps,
  deduplicateOrders,
  normalizeOrder,
  safeNumber,
  safeFixed,

  // Cart
  getCart,
  saveCart,
  clearCart,
};

// Guarantee that any misspelling or legacy reference never throws ReferenceError
export const ofLineStorage = offlineStorage;
export const offLineStorage = offlineStorage;

// Attach globally for browser console resilience and global access
if (typeof window !== "undefined") {
  window.offlineStorage = offlineStorage;
  window.ofLineStorage = offlineStorage;
  window.offLineStorage = offlineStorage;
}

export default offlineStorage;
