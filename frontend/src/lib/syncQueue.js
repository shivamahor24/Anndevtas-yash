// syncQueue.js
// Manages a persistent queue of orders created while offline.
// When connectivity is restored, the queue is replayed to the backend.

const QUEUE_KEY = "pos_sync_queue";

function getQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn("syncQueue.saveQueue failed:", e);
  }
}

export const syncQueue = {
  /** Add an order payload to the offline queue */
  enqueue(orderPayload) {
    const queue = getQueue();
    const entry = {
      id: `offline_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      payload: orderPayload,
      createdAt: new Date().toISOString(),
    };
    queue.push(entry);
    saveQueue(queue);
    return entry;
  },

  /** Add a delete operation to the offline queue */
  enqueueDelete(orderId, payload = {}) {
    const queue = getQueue();
    const entry = {
      id: `offline_del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: "delete",
      orderId,
      payload,
      createdAt: new Date().toISOString(),
    };
    queue.push(entry);
    saveQueue(queue);
    return entry;
  },

  /** Get all pending offline orders */
  getQueue,

  /** Remove a specific entry by id (after successful sync) */
  remove(id) {
    const queue = getQueue().filter((e) => e.id !== id);
    saveQueue(queue);
  },

  /** Clear the whole queue */
  clear() {
    localStorage.removeItem(QUEUE_KEY);
  },

  /** Number of pending orders waiting to sync */
  count() {
    return getQueue().length;
  },
};
