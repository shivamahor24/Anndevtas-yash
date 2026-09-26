import React, { useCallback, useEffect, useState } from "react";
import api from "../../lib/api";
import { Card } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
  Plus, ClipboardList, Truck, Package, CheckCircle2,
  XCircle, Clock, Send, ChevronRight
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../../context/LanguageContext";
import { safeNumber, safeFixed } from "../../lib/utils";

const PO_STATUS_STYLES = {
  draft: { label: "Draft", cls: "bg-gray-100 text-gray-600 border-gray-200", icon: Clock },
  ordered: { label: "Ordered", cls: "bg-blue-50 text-blue-600 border-blue-200", icon: Send },
  partial: { label: "Partial", cls: "bg-amber-50 text-amber-600 border-amber-200", icon: Package },
  received: { label: "Received", cls: "bg-forest-light text-forest border-forest/20", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", cls: "bg-red-50 text-red-500 border-red-200", icon: XCircle },
};

export default function PurchaseOrders() {
  const [orders, setOrders] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [createDialog, setCreateDialog] = useState(false);
  const [detailDialog, setDetailDialog] = useState(null);
  const [receiveDialog, setReceiveDialog] = useState(null);
  const { t } = useLanguage();

  // Create PO form
  const [poSupplier, setPoSupplier] = useState("");
  const [poItems, setPoItems] = useState([{ product_id: "", qty: 1, unit_cost: 0 }]);
  const [poNotes, setPoNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // GRN form
  const [grnItems, setGrnItems] = useState([]);
  const [grnNotes, setGrnNotes] = useState("");

  const fetch = useCallback(async () => {
    try {
      const params = {};
      if (statusFilter !== "all") params.status = statusFilter;
      const [poRes, supRes, menuRes] = await Promise.all([
        api.get("/inventory/purchase-orders", { params }),
        api.get("/inventory/suppliers"),
        api.get("/menu"),
      ]);
      setOrders(poRes.data);
      setSuppliers(supRes.data);
      setMenuItems(menuRes.data);
    } catch { toast.error("Failed to load purchase orders"); }
  }, [statusFilter]);

  useEffect(() => { fetch(); }, [fetch]);

  const addPoItem = () => setPoItems(p => [...p, { product_id: "", qty: 1, unit_cost: 0 }]);
  const removePoItem = (i) => setPoItems(p => p.filter((_, idx) => idx !== i));
  const updatePoItem = (i, field, value) => setPoItems(p => p.map((item, idx) => idx === i ? { ...item, [field]: value } : item));

  const createPO = async () => {
    if (!poSupplier) { toast.error("Please select a supplier"); return; }
    const validItems = poItems.filter(i => i.product_id && i.qty > 0);
    if (validItems.length === 0) { toast.error("Add at least one item"); return; }
    setBusy(true);
    try {
      await api.post("/inventory/purchase-orders", { supplier_id: poSupplier, items: validItems, notes: poNotes });
      toast.success("Purchase order created");
      setCreateDialog(false); setPoSupplier(""); setPoItems([{ product_id: "", qty: 1, unit_cost: 0 }]); setPoNotes("");
      fetch();
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed to create PO"); }
    finally { setBusy(false); }
  };

  const updateStatus = async (id, status) => {
    try {
      await api.patch(`/inventory/purchase-orders/${id}/status`, { status });
      toast.success(`PO status updated to ${status}`);
      fetch(); setDetailDialog(null);
    } catch (e) { toast.error(e?.response?.data?.detail || "Status update failed"); }
  };

  const openReceive = (po) => {
    setGrnItems((po.items || []).map(i => ({ product_id: i.product_id, qty_received: i.qty, product_name: i.product_name })));
    setGrnNotes("");
    setReceiveDialog(po);
  };

  const receiveGoods = async () => {
    if (!receiveDialog) return;
    setBusy(true);
    try {
      const validItems = grnItems.filter(i => i.qty_received > 0);
      await api.post(`/inventory/purchase-orders/${receiveDialog.id}/receive`, { items: validItems, notes: grnNotes });
      toast.success("Goods received successfully — stock updated");
      setReceiveDialog(null); fetch();
    } catch (e) { toast.error(e?.response?.data?.detail || "Receive failed"); }
    finally { setBusy(false); }
  };

  const statusTabs = [
    { key: "all", label: "All" },
    { key: "draft", label: "Draft" },
    { key: "ordered", label: "Ordered" },
    { key: "received", label: "Received" },
    { key: "cancelled", label: "Cancelled" },
  ];

  return (
    <div className="p-6 lg:p-10 max-w-6xl">
      <div className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{t("inv_module") || "Inventory Management"}</div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">{t("inv_purchase_orders") || "Purchase Orders"}</h1>
        </div>
        <Button onClick={() => setCreateDialog(true)} className="bg-terracota hover:bg-terracota-hover text-white">
          <Plus className="w-4 h-4 mr-2" /> New Purchase Order
        </Button>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 p-1 bg-white border border-border rounded-md mb-4 w-fit">
        {statusTabs.map(st => (
          <button key={st.key} onClick={() => setStatusFilter(st.key)}
            className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all ${statusFilter === st.key ? "bg-foreground text-white" : "text-muted-foreground hover:text-foreground"
              }`}>{st.label}</button>
        ))}
      </div>

      {/* PO List */}
      {orders.length === 0 ? (
        <Card className="p-12 text-center border-border shadow-none">
          <ClipboardList className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
          <div className="text-muted-foreground">No purchase orders found</div>
        </Card>
      ) : (
        <div className="space-y-3">
          {orders.map(po => {
            const st = PO_STATUS_STYLES[po.status] || PO_STATUS_STYLES.draft;
            const StIcon = st.icon;
            return (
              <Card key={po.id} className="p-4 border-border shadow-none hover:shadow-sm transition-shadow cursor-pointer"
                onClick={() => setDetailDialog(po)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${st.cls}`}>
                      <StIcon className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-display font-bold text-lg">PO #{po.po_number}</span>
                        <Badge variant="outline" className={`text-[10px] ${st.cls}`}>{st.label}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <Truck className="w-3 h-3" /> {po.supplier_name}
                        <span>·</span>
                        {new Date(po.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="font-mono text-lg font-bold">₹{po.total_amount?.toLocaleString("en-IN")}</div>
                      <div className="text-xs text-muted-foreground">{po.items?.length || 0} items</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create PO Dialog */}
      <Dialog open={createDialog} onOpenChange={setCreateDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-terracota" /> New Purchase Order
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Supplier *</Label>
              <select value={poSupplier} onChange={e => setPoSupplier(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-md border border-border bg-white text-sm">
                <option value="">Select supplier...</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Items</Label>
              <div className="space-y-2 mt-2">
                {poItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-sand-subtle rounded-lg">
                    <select value={item.product_id} onChange={e => updatePoItem(i, "product_id", e.target.value)}
                      className="flex-1 px-2 py-1.5 rounded-md border border-border bg-white text-sm">
                      <option value="">Select product...</option>
                      {menuItems.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <Input type="number" min="1" value={item.qty} onChange={e => updatePoItem(i, "qty", Number(e.target.value))}
                      className="w-20 text-sm" placeholder="Qty" />
                    <Input type="number" step="0.01" value={item.unit_cost} onChange={e => updatePoItem(i, "unit_cost", Number(e.target.value))}
                      className="w-24 text-sm" placeholder="Cost ₹" />
                    {poItems.length > 1 && (
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500" onClick={() => removePoItem(i)}>
                        <XCircle className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={addPoItem} className="mt-2 text-xs">
                <Plus className="w-3 h-3 mr-1" /> Add Item
              </Button>
            </div>
            <div>
              <Label>Notes</Label>
              <Input value={poNotes} onChange={e => setPoNotes(e.target.value)} className="mt-1" placeholder="Optional notes..." />
            </div>
            <Button onClick={createPO} disabled={busy} className="w-full bg-terracota hover:bg-terracota-hover text-white">
              Create Purchase Order
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* PO Detail Dialog */}
      <Dialog open={!!detailDialog} onOpenChange={() => setDetailDialog(null)}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">PO #{detailDialog?.po_number} — {detailDialog?.supplier_name}</DialogTitle>
          </DialogHeader>
          {detailDialog && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={`${PO_STATUS_STYLES[detailDialog.status]?.cls}`}>
                  {PO_STATUS_STYLES[detailDialog.status]?.label}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Created: {new Date(detailDialog.created_at).toLocaleDateString("en-IN")}
                </span>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead><tr className="bg-sand-subtle/50 text-left">
                    <th className="p-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Product</th>
                    <th className="p-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground text-right">Qty</th>
                    <th className="p-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground text-right">Cost</th>
                    <th className="p-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground text-right">Total</th>
                  </tr></thead>
                  <tbody>
                    {(detailDialog.items || []).map((it, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="p-2 font-medium">{it.product_name}</td>
                        <td className="p-2 text-right font-mono">{it.qty}</td>
                        <td className="p-2 text-right font-mono">₹{it.unit_cost}</td>
                        <td className="p-2 text-right font-mono font-semibold">₹{safeFixed(safeNumber(it.qty) * safeNumber(it.unit_cost))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border bg-sand-subtle/30">
                      <td colSpan={3} className="p-2 font-bold text-right">Total</td>
                      <td className="p-2 text-right font-mono font-bold text-terracota">₹{detailDialog.total_amount?.toLocaleString("en-IN")}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {detailDialog.notes && <div className="text-sm text-muted-foreground"><strong>Notes:</strong> {detailDialog.notes}</div>}
              <div className="flex gap-2">
                {detailDialog.status === "draft" && <>
                  <Button onClick={() => updateStatus(detailDialog.id, "ordered")} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"><Send className="w-4 h-4 mr-2" /> Mark Ordered</Button>
                  <Button onClick={() => updateStatus(detailDialog.id, "cancelled")} variant="outline" className="border-red-300 text-red-600">Cancel</Button>
                </>}
                {detailDialog.status === "ordered" && (
                  <Button onClick={() => { setDetailDialog(null); openReceive(detailDialog); }} className="flex-1 bg-forest hover:bg-forest-hover text-white">
                    <CheckCircle2 className="w-4 h-4 mr-2" /> Receive Goods
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Receive Goods (GRN) Dialog */}
      <Dialog open={!!receiveDialog} onOpenChange={() => setReceiveDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-forest" /> Receive Goods — PO #{receiveDialog?.po_number}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">Confirm quantities received. Stock will be updated automatically.</div>
            {grnItems.map((gi, i) => (
              <div key={i} className="flex items-center justify-between p-3 bg-sand-subtle rounded-lg">
                <span className="text-sm font-medium">{gi.product_name}</span>
                <Input type="number" min="0" value={gi.qty_received}
                  onChange={e => setGrnItems(items => items.map((it, idx) => idx === i ? { ...it, qty_received: Number(e.target.value) } : it))}
                  className="w-20 text-right" />
              </div>
            ))}
            <div>
              <Label>Notes</Label>
              <Input value={grnNotes} onChange={e => setGrnNotes(e.target.value)} className="mt-1" placeholder="GRN notes..." />
            </div>
            <Button onClick={receiveGoods} disabled={busy} className="w-full bg-forest hover:bg-forest-hover text-white">
              Confirm Receipt & Update Stock
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
