// offlineManager.js
// Provides a React hook to track online/offline status and auto-trigger sync.

import { useState, useEffect, useCallback } from "react";
import api from "./api";
import { syncQueue } from "./syncQueue";
import { offlineStorage } from "./offlineStorage";
import { toast } from "sonner";

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
}

/**
 * Sync hook — monitors online status and replays queued orders when connected.
 * Returns { syncStatus, pendingCount, triggerSync }
 * syncStatus: "idle" | "syncing" | "synced" | "error"
 */
export function useSyncManager(onSynced) {
  const isOnline = useOnlineStatus();
  const [syncStatus, setSyncStatus] = useState("idle");
  const [pendingCount, setPendingCount] = useState(syncQueue.count());

  // Refresh pendingCount whenever the queue might have changed
  const refreshCount = useCallback(() => {
    setPendingCount(syncQueue.count());
  }, []);

  const triggerSync = useCallback(async () => {
    const queue = syncQueue.getQueue();
    if (!queue.length || !isOnline) return;

    setSyncStatus("syncing");
    let successCount = 0;
    let failCount = 0;

    for (const entry of queue) {
      try {
        if (entry.type === "delete") {
          let targetId = entry.orderId;
          // 1. If targetId is a local ID (ord_...), check if offlineStorage has mapped a server_id
          if (String(targetId).startsWith("ord_")) {
            try {
              const localOrder = offlineStorage.getOrderById(targetId) ||
                (offlineStorage.getAllOrdersRaw ? offlineStorage.getAllOrdersRaw().find((o) => o.id === targetId || o.server_id === targetId) : null);
              if (localOrder?.server_id) {
                targetId = localOrder.server_id;
              }
            } catch (_) {}
          }

          try {
            await api.delete(`/orders/${targetId}`, { data: entry.payload });
          } catch (delErr) {
            if (delErr.response?.status === 404) {
              // The order was not found by targetId on the server.
              // Try fallback by receipt_no if available in payload
              const rNo = entry.payload?.receipt_no;
              let foundAndDeleted = false;
              if (rNo) {
                try {
                  await api.delete(`/orders/${rNo}`, { data: entry.payload });
                  foundAndDeleted = true;
                } catch (_) {}
              }

              if (!foundAndDeleted) {
                // If the order never existed on the server (e.g. offline order deleted before sync
                // or already deleted/purged), the desired deletion state on the server is already satisfied.
                console.log(`[SYNC] Order ${entry.orderId} does not exist on server (404); deletion already satisfied.`);
              }
            } else {
              // Real network/server failure (500, network drop, etc.) -> rethrow to keep queued
              throw delErr;
            }
          }
        } else {
          const res = await api.post("/orders", entry.payload);
          if (res?.data?.id && entry.payload?.id) {
            try {
              offlineStorage.updateOrder(entry.payload.id, {
                server_id: res.data.id,
                receipt_no: res.data.receipt_no,
                billNumber: res.data.receipt_no,
                orderNumber: res.data.receipt_no,
              });
            } catch (_) {}
          }
        }
        syncQueue.remove(entry.id);
        successCount++;
      } catch (e) {
        failCount++;
        console.warn("sync failed for entry", entry.id, e);
      }
    }

    refreshCount();

    if (successCount > 0 && failCount === 0) {
      setSyncStatus("synced");
      toast.success(`✅ Synced ${successCount} offline order${successCount > 1 ? "s" : ""} to server.`);
      if (onSynced) onSynced();
      setTimeout(() => setSyncStatus("idle"), 4000);
    } else if (failCount > 0) {
      setSyncStatus("error");
      toast.error(`${failCount} order(s) failed to sync. Will retry next time.`);
      setTimeout(() => setSyncStatus("idle"), 5000);
    } else {
      setSyncStatus("idle");
    }
  }, [isOnline, onSynced, refreshCount]);

  // Auto-trigger sync when we come back online
  useEffect(() => {
    if (isOnline && syncQueue.count() > 0) {
      // Small delay to ensure the network is stable
      const timer = setTimeout(() => triggerSync(), 1500);
      return () => clearTimeout(timer);
    }
  }, [isOnline, triggerSync]);

  return { isOnline, syncStatus, pendingCount, refreshCount, triggerSync };
}
