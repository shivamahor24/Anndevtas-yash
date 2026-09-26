import React, { useMemo } from "react";
import { Plus, Minus, Trash2, Sparkles } from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import { safeNumber, safeFixed } from "../lib/utils";

function translateExtras(extrasStr, t) {
  if (!extrasStr) return "";
  return extrasStr
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const match = trimmed.match(/^(.+?)\s*(?:\((\d+)\))?$/);
      if (!match) return trimmed;
      const name = match[1].trim();
      const qty = match[2] ? ` (${match[2]})` : "";
      return `${t(name)}${qty}`;
    })
    .join(", ");
}

function formatThaliSelections(selections, t) {
  if (!selections) return "";
  return Object.entries(selections)
    .map(([k, v]) => (v && v.length ? `${t(k)}: ${v.map((x) => t(x)).join(", ")}` : null))
    .filter(Boolean)
    .join(" · ");
}

function CartLineComponent({ line, onInc, onDec, onRemove, onEditThali }) {
  const { t } = useLanguage();
  const selectionsText = useMemo(() => formatThaliSelections(line.thali_selections, t), [line.thali_selections, t]);
  const translatedExtras = useMemo(() => translateExtras(line.thali_extras, t), [line.thali_extras, t]);

  return (
    <div className="border-b border-[#F4E6D7] pb-3 pt-1" data-testid={`cart-line-${line._key || line.id}`}>
      <div className="flex items-start justify-between gap-2">
        {/* Left Side: Info & Name */}
        <div className="flex-1 min-w-0 pr-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {line.is_thali && (
              <button
                type="button"
                onClick={() => onEditThali && onEditThali(line)}
                className="shrink-0 text-[9px] uppercase tracking-wider font-extrabold bg-[#FF6B00] hover:bg-[#E05D00] text-white px-2 py-0.5 rounded-md flex items-center gap-1 cursor-pointer transition-all shadow-2xs active:scale-95"
                title="Click to view or edit Thali rules"
              >
                <span>Rules</span>
                <Sparkles className="w-2.5 h-2.5" />
              </button>
            )}
            <span className="text-xs sm:text-sm font-extrabold text-slate-800 break-words leading-snug">
              {t(line.name)}
            </span>
          </div>

          {line.is_thali && selectionsText && (
            <div
              onClick={() => onEditThali && onEditThali(line)}
              className="text-[11px] text-slate-600 mt-1.5 leading-relaxed break-words bg-[#FFFBF7] hover:bg-[#FFF5ED] border border-[#F4E6D7]/80 hover:border-orange-300 p-2 rounded-xl cursor-pointer transition-all"
              title="Click to change selections"
            >
              {selectionsText}
            </div>
          )}

          {line.extra_bread > 0 && (
            <div className="text-[11px] text-amber-800 mt-1 font-medium bg-amber-50 border border-amber-200/60 px-2 py-0.5 rounded-md inline-block">
              🍞 {t("Extra Roti")} ({line.extra_bread}) · ₹{safeFixed(line.extra_bread_charge)}
            </div>
          )}

          <div className="text-xs text-slate-500 font-mono mt-1.5 flex flex-wrap items-center gap-1">
            <span className="font-semibold text-slate-700">₹{line.price}</span>
            <span>× {line.qty} =</span>
            <span className="font-bold text-[#FF6B00]">₹{safeFixed(safeNumber(line.price) * safeNumber(line.qty))}</span>
            {safeNumber(line.extra_bread_charge) > 0 && (
              <span className="text-amber-700 font-medium">+ ₹{safeFixed(line.extra_bread_charge)}</span>
            )}
          </div>

          {line.current_stock !== undefined && line.current_stock !== null && (
            <div className="text-[10px] text-emerald-700 font-semibold mt-1">
              Stock: {line.current_stock % 1 !== 0 ? safeFixed(line.current_stock, 3) + " kg" : line.current_stock}
            </div>
          )}
        </div>

        {/* Right Side: Quantity Buttons */}
        <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
          <button
            onClick={onDec}
            data-testid={`dec-${line._key}`}
            className="w-8 h-8 border border-[#F4E6D7] bg-white rounded-lg flex items-center justify-center text-slate-700 hover:bg-[#FFF3E7] hover:text-[#FF6B00] hover:border-[#FF8A3D] transition-all shadow-2xs active:scale-95 touch-manipulation"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <span className="w-6 text-center text-xs font-mono font-extrabold text-slate-800">{line.qty}</span>
          <button
            onClick={onInc}
            data-testid={`inc-${line._key}`}
            className="w-8 h-8 border border-[#F4E6D7] bg-white rounded-lg flex items-center justify-center text-slate-700 hover:bg-[#FFF3E7] hover:text-[#FF6B00] hover:border-[#FF8A3D] transition-all shadow-2xs active:scale-95 touch-manipulation"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onRemove}
            data-testid={`rm-${line._key}`}
            className="w-8 h-8 text-rose-500 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg flex items-center justify-center transition-all ml-0.5 active:scale-95 touch-manipulation"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export const CartLine = React.memo(CartLineComponent);
