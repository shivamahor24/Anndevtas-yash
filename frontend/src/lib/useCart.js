import { useCallback, useEffect, useMemo, useState } from "react";
import { offlineStorage } from "./offlineStorage";

// Cart state + memoized totals + line operations with offline persistence.
export function useCart() {
  const [cart, setCart] = useState(() => {
    try {
      return offlineStorage.getCart();
    } catch {
      return [];
    }
  });

  const [discount, setDiscount] = useState(0);

  // Sync to offlineStorage whenever cart changes
  useEffect(() => {
    try {
      offlineStorage.saveCart(cart);
    } catch (e) {
      console.warn("Error saving cart:", e);
    }
  }, [cart]);

  const addLine = useCallback((line) => {
    setCart((c) => {
      const lineQty = Number(line.qty || line.quantity || 1);
      if (!line.is_thali) {
        const pId = line.menu_item_id || line.productId || line.id;
        const idx = c.findIndex((x) => (x.menu_item_id === pId || x.productId === pId || x.id === pId) && !x.is_thali);
        if (idx >= 0) {
          const next = [...c];
          const newQty = (next[idx].qty || next[idx].quantity || 1) + lineQty;
          next[idx] = {
            ...next[idx],
            qty: newQty,
            quantity: newQty,
          };
          return next;
        }
      }
      return [
        ...c,
        {
          ...line,
          quantity: lineQty,
          qty: lineQty,
          _key: line._key || `${line.menu_item_id || line.productId || line.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      ];
    });
  }, []);

  const updateQty = useCallback((keyOrId, delta) => {
    setCart((c) => {
      const nextCart = [];
      for (const item of c) {
        const match = item._key === keyOrId || item.id === keyOrId || item.menu_item_id === keyOrId || item.productId === keyOrId;
        if (match) {
          const currentQty = Number(item.qty || item.quantity || 1);
          const newQty = currentQty + delta;
          // If quantity reaches zero or below, remove the item
          if (newQty > 0) {
            nextCart.push({
              ...item,
              qty: newQty,
              quantity: newQty,
            });
          }
        } else {
          nextCart.push(item);
        }
      }
      return nextCart;
    });
  }, []);

  const removeLine = useCallback((keyOrId) => {
    setCart((c) =>
      c.filter(
        (x) =>
          x._key !== keyOrId &&
          x.id !== keyOrId &&
          x.menu_item_id !== keyOrId &&
          x.productId !== keyOrId
      )
    );
  }, []);

  const clear = useCallback(() => {
    setCart([]);
    setDiscount(0);
    offlineStorage.clearCart();
  }, []);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, x) => {
      const q = Number(x.qty || x.quantity || 1);
      const itemTotal = Number(x.price || 0) * q;
      const extraBreadTotal = (Number(x.extra_bread_charge) || 0) * q;
      return s + itemTotal + extraBreadTotal;
    }, 0);

    const cgst = cart.reduce((s, x) => {
      const q = Number(x.qty || x.quantity || 1);
      const itemTotal = Number(x.price || 0) * q;
      const extraBreadTotal = (Number(x.extra_bread_charge) || 0) * q;
      const rate = x.cgst_rate !== undefined ? Number(x.cgst_rate) : (x.tax_rate !== undefined ? Number(x.tax_rate) / 2 : 2.5);
      return s + (itemTotal + extraBreadTotal) * (rate / 100);
    }, 0);

    const sgst = cart.reduce((s, x) => {
      const q = Number(x.qty || x.quantity || 1);
      const itemTotal = Number(x.price || 0) * q;
      const extraBreadTotal = (Number(x.extra_bread_charge) || 0) * q;
      const rate = x.sgst_rate !== undefined ? Number(x.sgst_rate) : (x.tax_rate !== undefined ? Number(x.tax_rate) / 2 : 2.5);
      return s + (itemTotal + extraBreadTotal) * (rate / 100);
    }, 0);

    const tax = cgst + sgst;
    const d = Number(discount) || 0;
    const total = Math.max(0, subtotal + tax - d);
    return { subtotal, cgst, sgst, tax, total, discount: d };
  }, [cart, discount]);

  return { cart, setCart, discount, setDiscount, addLine, updateQty, removeLine, clear, totals };
}

export default useCart;
