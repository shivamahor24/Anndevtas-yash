import React from "react";
import { Sparkles, Plus } from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import { safeFixed } from "../lib/utils";

function MenuTileComponent({ item, onClick, menuMode = "dining", gstRate = 5.0, displayedPrice }) {
  const { t } = useLanguage();

  const stockColor =
    item.current_stock <= 0
      ? "bg-red-100 text-red-600"
      : item.current_stock <= (item.reorder_level || 10)
      ? "bg-amber-100 text-amber-700"
      : "bg-emerald-100 text-emerald-700";

  const isParcel = menuMode === "parcel";
  const rawPrice = Number(item.price || 0);
  const priceToShow = displayedPrice !== undefined ? displayedPrice : rawPrice;

  return (
    <button
      onClick={onClick}
      data-testid={`menu-item-${item.id}`}
      style={{ overflow: "hidden" }}
      className="
        group
        relative
        overflow-hidden
        h-[155px] sm:h-[165px] flex flex-col justify-between
        w-full
        rounded-[20px] sm:rounded-[24px]
        border
        border-orange-100
        bg-white
        p-3.5 sm:p-4
        text-left
        shadow-2xs
        hover:shadow-md
        transition-all
        duration-200
        hover:border-orange-200
        active:scale-[0.98]
        touch-manipulation
      "
    >
      {/* Header Badge & Stock */}
      <div className="flex items-center justify-between relative z-10 w-full">
        {item.is_thali ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-500 to-brand-600 px-2.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.12em] text-white">
            <Sparkles className="h-2.5 w-2.5" />
            THALI
          </span>
        ) : (
          <span className="rounded-full bg-[#F0F8DC] px-2.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.15em] text-[#6B9A1F]">
            {(item.category_name || item.category || "ITEM").toUpperCase()}
          </span>
        )}

        {item.current_stock !== null && item.current_stock !== undefined && (
          <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-bold ${stockColor}`}>
            {item.current_stock % 1 !== 0
              ? safeFixed(item.current_stock, 3)
              : item.current_stock}
          </span>
        )}
      </div>

      {/* Item Title */}
      <div className="relative z-10 my-1 flex-1 flex flex-col justify-center min-h-0">
        <h3
          className={`
            font-bold text-slate-900 tracking-tight leading-snug
            ${
              (item.name || "").length > 25
                ? "text-[13px]"
                : (item.name || "").length > 15
                ? "text-[14px]"
                : "text-[15px] sm:text-[16px]"
            }
          `}
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflowWrap: "break-word",
            wordBreak: "break-word",
            whiteSpace: "normal",
            maxHeight: "38px",
            overflow: "hidden"
          }}
        >
          {t(item.name)}
        </h3>
      </div>

      {/* Bottom Price & Touch Add Button */}
      <div className="relative z-10 mt-auto flex w-full items-center justify-between pt-1 border-t border-dashed border-orange-100/80">
        <div>
          <div className="text-[9px] uppercase tracking-[0.15em] text-slate-400 font-semibold flex items-center gap-1">
            <span>Price</span>
            <span className={isParcel ? "text-amber-600 font-bold" : "text-slate-400"}>
              {isParcel ? "(Incl. GST)" : "(Excl. GST)"}
            </span>
          </div>
          <div className="text-[19px] sm:text-[21px] font-black tracking-tight text-brand-600 leading-tight">
            ₹{priceToShow}
          </div>
        </div>

        <div
          className="
            flex
            h-9
            w-9
            items-center
            justify-center
            rounded-full
            bg-gradient-to-br
            from-brand-400
            to-brand-600
            text-white
            shadow-xs
            transition-all
            duration-200
            group-hover:scale-105
            shrink-0
          "
        >
          <Plus className="h-4.5 w-4.5" />
        </div>
      </div>

      {/* Watermark */}
      <div
        className="
        pointer-events-none
        absolute
        bottom-8
        right-0
        opacity-[0.1]
        text-[80px]
        select-none
        -scale-x-100"
      >
      🌿
      </div>
    </button>
  );
}

export const MenuTile = React.memo(MenuTileComponent);