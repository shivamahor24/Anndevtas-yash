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

const MIGRATION_VERSION_KEY = "pos_storage_version";
const CURRENT_VERSION = "2.0.0_clean_slate";

(function runStorageMigration() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const current = localStorage.getItem(MIGRATION_VERSION_KEY);
    if (current !== CURRENT_VERSION) {
      console.log("[Storage Migration] Purging legacy cached orders to align with clean server baseline...");
      localStorage.removeItem(KEYS.ORDERS);
      localStorage.setItem(KEYS.LAST_ORDER_NUMBER, "0");
      localStorage.removeItem("pos_sync_queue");
      localStorage.setItem(MIGRATION_VERSION_KEY, CURRENT_VERSION);
    }
  } catch (e) {
    console.warn("Storage migration check failed:", e);
  }
})();

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
    is_deleted: Boolean(order.is_deleted || order.deleted || order.deleted_at),
    deleted_at: order.deleted_at || null,
    deleted_by: order.deleted_by || null,
    deletion_reason: order.deletion_reason || order.reason || "",
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

      const isDel = Boolean(existing.is_deleted || order.is_deleted);
      const delAt = order.deleted_at || existing.deleted_at || null;
      const delBy = order.deleted_by || existing.deleted_by || null;
      const delReason = order.deletion_reason || existing.deletion_reason || "";

      const merged = {
        ...existing,
        ...order,
        id: existing.id || order.id,
        server_id: existing.server_id || order.server_id,
        billNumber: existing.billNumber || order.billNumber,
        orderNumber: existing.orderNumber || order.orderNumber,
        receipt_no: existing.receipt_no || order.receipt_no,
        items: chosenItems,
        grandTotal: chosenTotal,
        total: chosenTotal,
        createdAt: existing.createdAt || order.createdAt,
        paid_at: existing.paid_at || order.paid_at,
        customerName: order.customerName || existing.customerName || "",
        customerPhone: order.customerPhone || existing.customerPhone || "",
        tableNumber: order.tableNumber || existing.tableNumber || "",
        is_deleted: isDel,
        deleted_at: delAt,
        deleted_by: delBy,
        deletion_reason: delReason,
        updatedAt: new Date().toISOString(),
      };
      orderMap.set(primaryKey, merged);
    }
  });

  // Return sorted descending (newest bill number first)
  return Array.from(orderMap.values()).sort((a, b) => {
    const aNum = canonicalBillNumber(a.billNumber || a.orderNumber || a.receipt_no);
    const bNum = canonicalBillNumber(b.billNumber || b.orderNumber || b.receipt_no);
    if (aNum !== bNum) return bNum - aNum;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}


/**
 * Deprecated: Order numbers are permanent historical identifiers.
 * This function is preserved for interface compatibility but is strictly a no-op.
 * NEVER modifies, shifts, or recalculates order numbers.
 */
export function healSequenceGaps(ordersList) {
  return Array.isArray(ordersList) ? ordersList : [];
}

// ----------------------------------------------------
// Order Storage Operations
// ----------------------------------------------------

/**
 * Returns all raw orders from localStorage without status filtering.
 */
function getAllOrdersRaw() {
  try {
    const raw = localStorage.getItem(KEYS.ORDERS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = parsed?.data !== undefined ? parsed.data : parsed;
    if (!Array.isArray(list)) return [];
    return deduplicateOrders(list);
  } catch (e) {
    console.error("offlineStorage.getAllOrdersRaw failed:", e);
    return [];
  }
}

/**
 * Returns the next simple sequential Bill Number starting from 1 (#1, #2, #3...) or continuing the sequence.
 * Always continues from the highest bill number ever assigned (active or deleted).
 * NEVER reuses numbers from deleted orders.
 */
export function getNextOrderNumber() {
  try {
    const allOrders = getAllOrdersRaw();
    let maxBillNum = 0;
    allOrders.forEach((o) => {
      const num = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
      if (num > maxBillNum) maxBillNum = num;
    });

    if (allOrders.length === 0) {
      localStorage.setItem(KEYS.LAST_ORDER_NUMBER, "0");
      return 1;
    }

    const storedLast = canonicalBillNumber(localStorage.getItem(KEYS.LAST_ORDER_NUMBER) || 0);
    const nextNum = Math.max(maxBillNum, storedLast) + 1;
    localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(nextNum));
    return nextNum;
  } catch (e) {
    console.warn("Error calculating next bill number:", e);
    return 1;
  }
}

/**
 * Retrieves active (non-deleted) orders by default.
 * Pass { includeDeleted: true } to receive all orders including archived/deleted.
 */
export function getOrders(options = {}) {
  try {
    const all = getAllOrdersRaw();
    if (options.includeDeleted) {
      return all;
    }
    return all.filter((o) => !o.is_deleted && !o.deleted_at);
  } catch (e) {
    console.error("offlineStorage.getOrders failed:", e);
    throw new Error(`Unable to load orders from storage: ${e.message}`);
  }
}

/**
 * Retrieves only soft-deleted/archived orders.
 */
export function getDeletedOrders() {
  try {
    const all = getAllOrdersRaw();
    return all.filter((o) => Boolean(o.is_deleted || o.deleted_at));
  } catch (e) {
    console.error("offlineStorage.getDeletedOrders failed:", e);
    return [];
  }
}

export function getOrderById(orderId) {
  if (!orderId) return null;
  const all = getAllOrdersRaw();
  const searchKey = String(orderId).trim();
  const searchNum = canonicalBillNumber(searchKey);

  return all.find(
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

  // Load existing raw orders safely (including soft-deleted)
  let currentOrders = getAllOrdersRaw();

  // Check if order already exists in storage
  const existingIndex = currentOrders.findIndex((o) =>
    String(o.id) === String(normalized.id) ||
    (o.server_id && normalized.server_id && String(o.server_id) === String(normalized.server_id))
  );

  if (existingIndex >= 0) {
    const existing = currentOrders[existingIndex];
    currentOrders[existingIndex] = {
      ...existing,
      ...normalized,
      id: existing.id || normalized.id,
      server_id: existing.server_id || normalized.server_id,
      billNumber: existing.billNumber || normalized.billNumber,
      orderNumber: existing.orderNumber || normalized.orderNumber,
      receipt_no: existing.receipt_no || normalized.receipt_no,
      is_deleted: Boolean(existing.is_deleted || normalized.is_deleted),
      deleted_at: existing.deleted_at || normalized.deleted_at,
      deleted_by: existing.deleted_by || normalized.deleted_by,
      deletion_reason: existing.deletion_reason || normalized.deletion_reason,
      updatedAt: new Date().toISOString(),
    };
  } else {
    currentOrders.unshift(normalized);
  }

  // Deduplicate orders without modifying any sequence numbers
  const deduplicated = deduplicateOrders(currentOrders);
  save(KEYS.ORDERS, deduplicated);

  // Keep LAST_ORDER_NUMBER strictly monotonic (never decrement)
  const storedLast = canonicalBillNumber(localStorage.getItem(KEYS.LAST_ORDER_NUMBER) || 0);
  if (billNumber > storedLast) {
    localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(billNumber));
  }

  const savedVerification = getOrderById(normalized.id) || normalized;

  // Emit events for reactive cross-component synchronization
  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: savedVerification }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: savedVerification }));
  } catch (_) {}

  return savedVerification;
}

export function updateOrder(orderId, updates) {
  if (!orderId) throw new Error("Order ID is required to update order");
  const orders = getAllOrdersRaw();
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
  // Preserve permanent bill number, or adopt authoritative canonical receipt_no from server
  const targetBillNumber = updates.receipt_no || updates.billNumber || updates.orderNumber || existing.billNumber || existing.orderNumber || existing.receipt_no;

  const updatedOrder = normalizeOrder({
    ...existing,
    ...updates,
    billNumber: targetBillNumber,
    orderNumber: targetBillNumber,
    receipt_no: targetBillNumber,
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

/**
 * Soft-deletes an order.
 * Marks the order as deleted and archives it in Deleted Orders.
 * IMMUTABLE ORDER NUMBERS:
 * - The original bill number remains permanently on the deleted order.
 * - Subsequent orders are NEVER shifted or renumbered.
 * - Sequence counter is NEVER decremented.
 */
export function deleteOrder(orderId, auditInfo = {}) {
  if (!orderId) return false;
  const allOrders = getAllOrdersRaw();
  const searchKey = String(orderId).trim();
  const searchNum = canonicalBillNumber(searchKey);

  const targetIdx = allOrders.findIndex(
    (o) =>
      String(o.id) === searchKey ||
      String(o.server_id) === searchKey ||
      (searchNum > 0 && (o.billNumber === searchNum || o.orderNumber === searchNum || o.receipt_no === searchNum))
  );

  if (targetIdx < 0) {
    console.warn(`deleteOrder: Order ${orderId} not found in offline storage.`);
    return false;
  }

  const targetOrder = allOrders[targetIdx];
  const now = new Date().toISOString();

  // Soft delete: retain full order data and attach audit trail
  const updatedDeletedOrder = {
    ...targetOrder,
    is_deleted: true,
    deleted_at: auditInfo.deleted_at || now,
    deleted_by: auditInfo.deleted_by || auditInfo.user || "Admin",
    deletion_reason: auditInfo.deletion_reason || auditInfo.reason || "Deleted by owner",
    updatedAt: now,
  };

  allOrders[targetIdx] = updatedDeletedOrder;

  const deduplicated = deduplicateOrders(allOrders);
  save(KEYS.ORDERS, deduplicated);

  // CRITICAL: NEVER shift any bill numbers!
  // CRITICAL: NEVER decrement LAST_ORDER_NUMBER!

  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: updatedDeletedOrder }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: updatedDeletedOrder }));
  } catch (_) {}

  return updatedDeletedOrder;
}

/**
 * Restores a soft-deleted order back to the active orders section.
 * - Clears is_deleted, deleted_at, deleted_by, deletion_reason.
 * - Preserves original billNumber and order sequence position.
 */
export function restoreOrder(orderId) {
  if (!orderId) return false;
  const allOrders = getAllOrdersRaw();
  const searchKey = String(orderId).trim();
  const searchNum = canonicalBillNumber(searchKey);

  const targetIdx = allOrders.findIndex(
    (o) =>
      String(o.id) === searchKey ||
      String(o.server_id) === searchKey ||
      (searchNum > 0 && (o.billNumber === searchNum || o.orderNumber === searchNum || o.receipt_no === searchNum))
  );

  if (targetIdx < 0) {
    console.warn(`restoreOrder: Order ${orderId} not found in offline storage.`);
    return false;
  }

  const targetOrder = allOrders[targetIdx];
  const updatedRestoredOrder = {
    ...targetOrder,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    deletion_reason: null,
    updatedAt: new Date().toISOString(),
  };

  allOrders[targetIdx] = updatedRestoredOrder;
  const deduplicated = deduplicateOrders(allOrders);
  save(KEYS.ORDERS, deduplicated);

  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: updatedRestoredOrder }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: updatedRestoredOrder }));
  } catch (_) {}

  return updatedRestoredOrder;
}

/**
 * Soft-deletes all currently active orders.
 * Retains permanent bill numbers and attaches audit metadata.
 */
export function deleteAllOrders(auditInfo = {}) {
  const allOrders = getAllOrdersRaw();
  const now = new Date().toISOString();
  const deleter = auditInfo.deleted_by || auditInfo.user || "Admin";
  const reason = auditInfo.deletion_reason || auditInfo.reason || "Bulk deleted by user";

  let count = 0;
  const updated = allOrders.map((o) => {
    if (!o.is_deleted) {
      count++;
      return {
        ...o,
        is_deleted: true,
        deleted_at: auditInfo.deleted_at || now,
        deleted_by: deleter,
        deletion_reason: reason,
        updatedAt: now,
      };
    }
    return o;
  });

  save(KEYS.ORDERS, updated);

  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: { action: "bulk_delete", count } }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: { action: "bulk_delete", count } }));
  } catch (_) {}

  return count;
}

/**
 * Restores all soft-deleted orders back to active status.
 * Retains original canonical numbers and sequence positions.
 */
export function restoreAllOrders() {
  const allOrders = getAllOrdersRaw();
  const now = new Date().toISOString();

  let count = 0;
  const updated = allOrders.map((o) => {
    if (o.is_deleted) {
      count++;
      return {
        ...o,
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
        deletion_reason: null,
        updatedAt: now,
      };
    }
    return o;
  });

  save(KEYS.ORDERS, updated);

  try {
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: { action: "bulk_restore", count } }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: { action: "bulk_restore", count } }));
  } catch (_) {}

  return count;
}

export function resetOrders() {
  try {
    save(KEYS.ORDERS, []);
    localStorage.removeItem(KEYS.LAST_ORDER_NUMBER);
    window.dispatchEvent(new CustomEvent("ordersUpdated", { detail: { action: "reset" } }));
    window.dispatchEvent(new CustomEvent("pos_orders_changed", { detail: { action: "reset" } }));
    return true;
  } catch (e) {
    console.error("Failed to reset orders:", e);
    throw e;
  }
}

/**
 * Batch-saves an array of orders in a single localStorage read+write cycle.
 * Use this for server hydration to avoid the N saveOrder() → N events → N fetch() loop.
 *
 * Options:
 *   emit: boolean (default true) — whether to dispatch ordersUpdated/pos_orders_changed.
 *         Set to false when hydrating from server so the page does NOT react to its own write.
 *
 * Guarantees:
 *   - Reads existing orders exactly once
 *   - Merges all incoming orders (preserving offline-only orders)
 *   - Deduplicates by stable order ID
 *   - Preserves immutable bill/receipt numbers
 *   - Preserves soft-deleted orders
 *   - Writes localStorage exactly once
 *   - Emits events at most once (or zero times if emit:false)
 */
export function saveOrdersBatch(orders, options = {}) {
  if (!Array.isArray(orders)) return;
  const { emit = true, syncWithServer = false } = options;
  if (!syncWithServer && orders.length === 0) return;

  // --- 1. Read existing storage once ---
  let currentOrders = getAllOrdersRaw();

  // --- 2. Build a fast-lookup map of existing orders by ID and server_id ---
  const existingById = new Map();
  const existingByServerId = new Map();
  currentOrders.forEach((o) => {
    existingById.set(String(o.id), o);
    if (o.server_id) existingByServerId.set(String(o.server_id), o);
  });

  // --- 3. Merge each incoming order ---
  const incomingNormalized = [];
  orders.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    if (!Array.isArray(raw.items) || raw.items.length === 0) return;

    const normalized = normalizeOrder(raw);
    if (!normalized) return;

    // Resolve existing record by ID or server_id
    let existing =
      existingById.get(String(normalized.id)) ||
      (normalized.server_id ? existingByServerId.get(String(normalized.server_id)) : null);

    if (existing) {
      // Merge: adopt canonical receipt_no from incoming server data, or preserve existing
      const canonicalNum = normalized.receipt_no || normalized.billNumber || normalized.orderNumber ||
                           existing.billNumber || existing.orderNumber || existing.receipt_no;
      const billNum = canonicalBillNumber(canonicalNum);

      const merged = {
        ...existing,
        ...normalized,
        id: existing.id || normalized.id,
        server_id: existing.server_id || normalized.server_id,
        billNumber: billNum > 0 ? billNum : (existing.billNumber || normalized.billNumber),
        orderNumber: billNum > 0 ? billNum : (existing.orderNumber || normalized.orderNumber),
        receipt_no: billNum > 0 ? billNum : (existing.receipt_no || normalized.receipt_no),
        is_deleted: Boolean(existing.is_deleted || normalized.is_deleted),
        deleted_at: existing.deleted_at || normalized.deleted_at || null,
        deleted_by: existing.deleted_by || normalized.deleted_by || null,
        deletion_reason: existing.deletion_reason || normalized.deletion_reason || '',
        createdAt: existing.createdAt || normalized.createdAt,
        paid_at: existing.paid_at || normalized.paid_at,
        updatedAt: new Date().toISOString(),
      };
      incomingNormalized.push(merged);
    } else {
      // New order: assign bill number if missing
      let billNum = canonicalBillNumber(normalized.billNumber || normalized.orderNumber || normalized.receipt_no);
      if (!billNum || billNum <= 0) {
        // Compute next order number once we know the existing maximum
        const allNums = currentOrders.map((o) =>
          canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no)
        ).filter((n) => n > 0);
        const storedLast = canonicalBillNumber(localStorage.getItem(KEYS.LAST_ORDER_NUMBER) || 0);
        billNum = Math.max(...allNums, storedLast, 0) + 1;
        localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(billNum));
      }
      incomingNormalized.push({
        ...normalized,
        billNumber: billNum,
        orderNumber: billNum,
        receipt_no: billNum,
      });
    }
  });

  // --- 4. Merge into current list ---
  let merged = [];
  if (syncWithServer) {
    // Reconcile with server: server records take precedence, while preserving any pending offline creations
    let pendingUnsynced = [];
    try {
      const q = (typeof window !== "undefined" && window.localStorage)
        ? JSON.parse(localStorage.getItem("pos_sync_queue") || "[]")
        : [];
      const pendingIds = new Set(
        Array.isArray(q)
          ? q.map((item) => String(item.order_id || item.id || item.order?.id || "")).filter(Boolean)
          : []
      );
      pendingUnsynced = currentOrders.filter((o) => {
        const idStr = String(o.id || "");
        return pendingIds.has(idStr);
      });
    } catch (_) {
      pendingUnsynced = [];
    }

    const mergedMap = new Map();
    incomingNormalized.forEach((o) => mergedMap.set(String(o.id), o));
    pendingUnsynced.forEach((o) => {
      if (!mergedMap.has(String(o.id))) {
        mergedMap.set(String(o.id), o);
      }
    });
    merged = deduplicateOrders(Array.from(mergedMap.values()));
  } else {
    const mergedMap = new Map();
    currentOrders.forEach((o) => mergedMap.set(String(o.id), o));
    incomingNormalized.forEach((o) => mergedMap.set(String(o.id), o));
    merged = deduplicateOrders(Array.from(mergedMap.values()));
  }

  // --- 5. Update LAST_ORDER_NUMBER ---
  let maxBillNum = 0;
  merged.forEach((o) => {
    const n = canonicalBillNumber(o.billNumber || o.orderNumber || o.receipt_no);
    if (n > maxBillNum) maxBillNum = n;
  });

  if (syncWithServer) {
    localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(maxBillNum));
  } else {
    const storedLast = canonicalBillNumber(localStorage.getItem(KEYS.LAST_ORDER_NUMBER) || 0);
    const finalLast = Math.max(maxBillNum, storedLast);
    localStorage.setItem(KEYS.LAST_ORDER_NUMBER, String(finalLast));
  }

  // --- 6. Write localStorage exactly once ---
  save(KEYS.ORDERS, merged);

  // --- 7. Emit events at most once ---
  if (emit) {
    try {
      window.dispatchEvent(new CustomEvent('ordersUpdated', { detail: { action: 'batch_sync' } }));
      window.dispatchEvent(new CustomEvent('pos_orders_changed', { detail: { action: 'batch_sync' } }));
    } catch (_) {}
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
  saveOrdersBatch,
  getOrders,
  getDeletedOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
  deleteAllOrders,
  restoreOrder,
  restoreAllOrders,
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
