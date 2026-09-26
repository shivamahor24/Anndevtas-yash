import React, { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
// eslint-disable-next-line no-unused-vars
import { Check, Sparkles, ShieldCheck, ChevronDown, ChevronRight, Plus, Minus, Info } from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import { safeNumber, safeFixed } from "../lib/utils";

function translateExtras(extrasStr, t) {
  if (!extrasStr) return [];
  return extrasStr
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^(.+?)\s*(?:\((\d+)\))?$/);
      if (!match) return { name: t(trimmed), qty: null };
      const name = match[1].trim();
      const qty = match[2] ? match[2] : null;
      return { name: t(name), qty };
    })
    .filter(Boolean);
}

export default function ThaliBuilder({ open, onClose, thali, thaliItem, menu, categories, onAdd }) {
  const currentThali = thali || thaliItem;
  const isOpen = open !== undefined ? Boolean(open) : Boolean(currentThali);
  const [picks, setPicks] = useState({});
  const [breadConsumed, setBreadConsumed] = useState(0);
  const [thaliQty, setThaliQty] = useState(1);
  const [openGroups, setOpenGroups] = useState([]);
  const { t } = useLanguage();

  useEffect(() => {
    if (!isOpen || !currentThali) return;

    setPicks(currentThali.thali_selections || {});
    setThaliQty(currentThali.qty || currentThali.quantity || 1);
    setOpenGroups(
      (currentThali.thali_groups || []).map(g => g.category_id)
    );
    setBreadConsumed(currentThali.bread_consumed || currentThali.included_bread_count || 0);
  }, [isOpen, currentThali]);

  if (!isOpen || !currentThali) return null;

  const groups = currentThali.thali_groups || currentThali.thali_rules || [];
  const extrasList = translateExtras(currentThali.thali_extras || currentThali.fixedInclusions, t);

  const handleQtyChange = (delta) => {
    setThaliQty((prev) => {
      const next = Math.max(1, prev + delta);
      if (currentThali?.included_bread_count) {
        setBreadConsumed(currentThali.included_bread_count * next);
      }
      setPicks(p => {
        const np = { ...p };
        let changed = false;
        groups.forEach(g => {
          const max = g.count * next;
          if ((np[g.category_id] || []).length > max) {
            np[g.category_id] = np[g.category_id].slice(-max);
            changed = true;
          }
        });
        return changed ? np : p;
      });
      return next;
    });
  };

  const addPick = (catId, itemName, max) => {
    setPicks((p) => {
      const cur = p[catId] || [];
      if (cur.length >= max) {
        return { ...p, [catId]: [...cur.slice(1), itemName] };
      }
      return { ...p, [catId]: [...cur, itemName] };
    });
  };

  const removePick = (catId, itemName) => {
    setPicks((p) => {
      const cur = p[catId] || [];
      const idx = cur.lastIndexOf(itemName);
      if (idx === -1) return p;
      const nextArr = [...cur];
      nextArr.splice(idx, 1);
      return { ...p, [catId]: nextArr };
    });
  };

  const allFilled = groups.every((g) => (picks[g.category_id] || []).length === g.count * thaliQty);

  const includedBread = (currentThali.included_bread_count || 0) * thaliQty;
  const extraBreadPrice = currentThali.extra_bread_price || 10;
  const breadMode = currentThali.bread_mode || "fixed";
  const isUnlimited = breadMode === "unlimited";

  const extraBread = isUnlimited ? 0 : Math.max(0, breadConsumed - includedBread);
  const extraBreadCharge = extraBread * extraBreadPrice;
  const totalPrice = (currentThali.price * thaliQty) + extraBreadCharge;

  const handleAdd = () => {
    const selections = {};
    const rulesList = [];

    groups.forEach((g) => {
      const label = g.label || g.category_id || "Item";
      const pickedItems = picks[g.category_id] || [];
      selections[label] = pickedItems;

      if (pickedItems.length > 0) {
        const counts = new Map();
        pickedItems.forEach(it => counts.set(it, (counts.get(it) || 0) + 1));
        for (const [itemName, q] of counts.entries()) {
          rulesList.push({
            category: label,
            name: itemName,
            qty: q * thaliQty
          });
        }
      } else {
        rulesList.push({
          category: label,
          name: label,
          qty: (g.count || 1) * thaliQty
        });
      }
    });

    onAdd({
      id: currentThali.id,
      menu_item_id: currentThali.id,
      name: currentThali.name,
      price: currentThali.price,
      qty: thaliQty,
      tax_rate: 5.0,
      is_thali: true,
      rules: rulesList,
      thali_groups: groups,
      thali_selections: selections,
      thali_extras: currentThali.thali_extras || currentThali.fixedInclusions || "",
      fixedInclusions: currentThali.thali_extras || currentThali.fixedInclusions || "",
      bread_consumed: breadConsumed,
      extra_bread: extraBread,
      extra_bread_charge: extraBreadCharge,
      current_stock: currentThali.current_stock,
    });
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-[#FFFDF9] border border-[#F4E6D7] rounded-3xl p-0 overflow-hidden shadow-2xl" data-testid="thali-builder">
        {/* Header */}
        <div className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white p-5 sm:p-6 relative">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="bg-white/20 text-white text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-0.5 rounded-full flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  THALI RULES & CUSTOMIZATION
                </span>
              </div>
              <DialogTitle className="font-display text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                {t(currentThali.name)}
              </DialogTitle>
              <p className="text-white/80 text-xs sm:text-sm font-medium">
                Configure thali rules, item choices, inclusions, and extra rotis
              </p>
            </div>

            {/* Quantity Controls */}
            <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-2 flex flex-col items-center shrink-0">
              <span className="text-[10px] uppercase font-extrabold tracking-wider text-white/90 mb-1">
                Quantity
              </span>
              <div className="flex items-center gap-2 bg-white text-slate-800 rounded-xl p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => handleQtyChange(-1)}
                  disabled={thaliQty <= 1}
                  className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-40 flex items-center justify-center font-bold text-slate-700 transition-all"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="font-mono font-extrabold text-base w-6 text-center">
                  {thaliQty}
                </span>
                <button
                  type="button"
                  onClick={() => handleQtyChange(1)}
                  className="w-7 h-7 rounded-lg bg-orange-100 hover:bg-orange-200 text-[#FF6B00] flex items-center justify-center font-bold transition-all"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-5 max-h-[62vh] overflow-y-auto">
          {/* Fixed Inclusions Badges */}
          {extrasList.length > 0 && (
            <div className="bg-[#FFF5ED] border border-[#FCD9BD] rounded-2xl p-4 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-[#D95B00]">
                <ShieldCheck className="w-4 h-4" />
                <span>Fixed Inclusions (Included in Thali)</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {extrasList.map((ex, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 bg-white border border-[#FAD0AE] text-slate-800 text-xs font-bold px-3 py-1.5 rounded-xl shadow-2xs"
                  >
                    <span>{ex.name}</span>
                    {ex.qty && (
                      <span className="bg-[#FF6B00] text-white text-[10px] font-black px-1.5 py-0.2 rounded-md">
                        {ex.qty}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Rule Groups */}
          {groups.length > 0 ? (
            <div className="space-y-4">
              <div className="text-xs font-extrabold uppercase tracking-wider text-slate-500 flex items-center justify-between">
                <span>Select Items per Rule</span>
                <span className="text-[11px] font-medium text-slate-400">
                  Tap to expand / collapse
                </span>
              </div>

              {groups.map((g) => {
                const availableItems = (menu || []).filter(
                  (m) => m.category_id === g.category_id && m.available && !m.is_thali
                );
                const chosen = picks[g.category_id] || [];
                const targetMax = g.count * thaliQty;
                const isComplete = chosen.length === targetMax;
                const isGroupOpen = openGroups.includes(g.category_id);

                return (
                  <div
                    key={g.category_id}
                    data-testid={`thali-group-${g.category_id}`}
                    className={`border rounded-2xl transition-all overflow-hidden bg-white ${
                      isComplete
                        ? "border-emerald-200 shadow-2xs"
                        : "border-[#F4E6D7] shadow-2xs"
                    }`}
                  >
                    {/* Group Header */}
                    <div
                      onClick={() =>
                        setOpenGroups((prev) =>
                          prev.includes(g.category_id)
                            ? prev.filter((id) => id !== g.category_id)
                            : [...prev, g.category_id]
                        )
                      }
                      className="p-3.5 sm:p-4 flex items-center justify-between cursor-pointer hover:bg-[#FFFBF7] transition-colors"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs ${
                          isGroupOpen ? "bg-orange-100 text-[#FF6B00]" : "bg-slate-100 text-slate-500"
                        }`}>
                          {isGroupOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </div>
                        <div>
                          <h4 className="font-bold text-sm text-slate-800 uppercase tracking-tight">
                            {t(g.label) || "Rule Group"}
                          </h4>
                          <p className="text-[11px] text-slate-500 font-medium">
                            Choose {g.count * thaliQty} item{g.count * thaliQty > 1 ? "s" : ""}
                          </p>
                        </div>
                      </div>

                      <div
                        className={`text-xs font-mono font-bold px-3 py-1 rounded-full flex items-center gap-1.5 ${
                          isComplete
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : "bg-amber-50 text-amber-700 border border-amber-200"
                        }`}
                      >
                        {isComplete && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        <span>
                          {chosen.length} / {targetMax} Picked
                        </span>
                      </div>
                    </div>

                    {/* Items Grid */}
                    {isGroupOpen && (
                      <div className="p-3.5 sm:p-4 pt-0 border-t border-slate-100 bg-[#FFFDF9]">
                        {availableItems.length === 0 ? (
                          <div className="text-xs text-slate-400 py-3 px-4 border border-dashed border-slate-200 rounded-xl text-center mt-3">
                            No items available for this rule today
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 mt-3">
                            {availableItems.map((it) => {
                              const countInChosen = chosen.filter((x) => x === it.name).length;
                              const isSelected = countInChosen > 0;
                              return (
                                <div
                                  key={it.id}
                                  data-testid={`thali-pick-${it.id}`}
                                  onClick={() => addPick(g.category_id, it.name, targetMax)}
                                  className={`cursor-pointer p-3 rounded-xl border transition-all text-left flex flex-col justify-between ${
                                    isSelected
                                      ? "border-[#FF6B00] bg-[#FFF3E7] shadow-2xs"
                                      : "border-[#EFE5DA] bg-white hover:border-[#FF8A3D] hover:bg-[#FFFBF7]"
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-1 min-h-[32px]">
                                    <span className="text-xs font-bold text-slate-800 leading-tight">
                                      {t(it.name)}
                                    </span>
                                    {isSelected && (
                                      <span className="bg-[#FF6B00] text-white text-[10px] font-extrabold w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                                        {countInChosen}
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                                    <span className="text-[10px] font-mono text-slate-500 font-semibold">
                                      Available
                                    </span>

                                    {isSelected && (
                                      <div
                                        className="flex items-center gap-1.5 bg-white rounded-lg border border-orange-200 px-1 py-0.5"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <button
                                          type="button"
                                          onClick={() => removePick(g.category_id, it.name)}
                                          className="w-5 h-5 flex items-center justify-center text-[#FF6B00] hover:bg-orange-50 rounded font-bold"
                                        >
                                          −
                                        </button>
                                        <span className="font-mono font-bold text-xs text-[#FF6B00]">
                                          {countInChosen}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => addPick(g.category_id, it.name, targetMax)}
                                          className="w-5 h-5 flex items-center justify-center text-[#FF6B00] hover:bg-orange-50 rounded font-bold"
                                        >
                                          +
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center space-y-1">
              <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-slate-700">
                <Info className="w-4 h-4 text-[#FF6B00]" />
                <span>Standard Complete Thali Package</span>
              </div>
              <p className="text-xs text-slate-500">
                Includes all fixed inclusions and default items prepared according to today's menu.
              </p>
            </div>
          )}

          {/* Bread Consumption Section */}
          {includedBread > 0 && (
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🍞</span>
                  <div>
                    <h4 className="font-bold text-xs uppercase tracking-wider text-amber-900">
                      Roti / Bread Consumption
                    </h4>
                    <p className="text-[11px] text-amber-700 font-medium">
                      {includedBread} Rotis included in this order
                    </p>
                  </div>
                </div>

                {isUnlimited && (
                  <span className="bg-emerald-100 text-emerald-800 text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-full border border-emerald-200">
                    ∞ Unlimited Bread
                  </span>
                )}
              </div>

              {!isUnlimited && (
                <div className="flex items-center justify-between pt-2 border-t border-amber-200/60 text-xs">
                  <div className="space-y-0.5">
                    <span className="font-bold text-slate-800">Total Rotis Consumed:</span>
                    {extraBread > 0 && (
                      <p className="text-[11px] text-amber-800 font-semibold">
                        +{extraBread} Extra Roti (₹{extraBreadPrice}/roti) = +₹{safeFixed(extraBreadCharge)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 bg-white border border-amber-200 rounded-xl p-1 shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setBreadConsumed(Math.max(0, breadConsumed - 1))}
                      className="w-7 h-7 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 flex items-center justify-center font-bold transition-all"
                    >
                      −
                    </button>
                    <span className="font-mono font-extrabold text-base w-8 text-center text-slate-800">
                      {breadConsumed}
                    </span>
                    <button
                      type="button"
                      onClick={() => setBreadConsumed(breadConsumed + 1)}
                      className="w-7 h-7 rounded-lg bg-amber-500 hover:bg-amber-600 text-white flex items-center justify-center font-bold transition-all"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 border-t border-[#F4E6D7] bg-white flex items-center justify-between gap-4">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
              Total Order Price
            </div>
            <div className="font-mono font-black text-2xl text-[#FF6B00]">
              ₹{safeFixed(totalPrice)}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              className="border-slate-200 hover:bg-slate-50 text-slate-700 font-bold rounded-xl px-5"
              data-testid="thali-cancel"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!allFilled}
              className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:brightness-105 text-white font-extrabold rounded-xl px-6 shadow-md shadow-orange-500/20 disabled:opacity-50"
              data-testid="thali-confirm"
            >
              <Check className="w-4 h-4 mr-1.5" />
              {t("add_to_bill")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
