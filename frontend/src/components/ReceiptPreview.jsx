import React, { useMemo } from "react";
import { Plus, Minus, Trash2 } from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import { getCurrentToken } from "../lib/tokenManager";
import { safeNumber, safeFixed } from "../lib/utils";

function getItemSubItems(item, t, menuList = []) {
  if (!item) return [];

  const tr = (key) => (t && typeof t === 'function' ? t(key) : key);
  const result = [];

  const parseItemStr = (str) => {
    if (!str) return null;
    const trimmed = String(str).trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(.+?)\s*(?:\((\d+)\))?$/);
    if (!match) return null;
    const name = match[1].trim();
    const qty = match[2] ? parseInt(match[2], 10) : 1;
    return { name, qty };
  };

  // 1. Check explicit item.rules array:
  const rules = item.rules || (typeof item.rules === 'string' ? (() => { try { return JSON.parse(item.rules); } catch (e) { return null; } })() : null);
  if (Array.isArray(rules) && rules.length > 0) {
    rules.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const name = r.name || r.item_name || r.title || r.label || "";
      const qty = Number(r.qty || r.quantity || r.count || 1);
      if (name) {
        result.push(`${tr(name)} (${qty})`);
      }
    });
  }

  // 2. Process thali_selections / selections if rules array was not present or empty
  if (result.length === 0) {
    const selObj = item.thali_selections || item.selections;
    if (selObj) {
      let parsedObj = selObj;
      if (typeof selObj === 'string') {
        try {
          if (selObj.startsWith('{') || selObj.startsWith('[')) {
            parsedObj = JSON.parse(selObj);
          }
        } catch (e) { }
      }

      if (typeof parsedObj === 'object' && parsedObj !== null && !Array.isArray(parsedObj)) {
        Object.entries(parsedObj).forEach(([ruleLabel, items]) => {
          if (!items) return;
          const itemArr = Array.isArray(items) ? items : [items];
          const counts = new Map();
          itemArr.forEach((it) => {
            if (!it) return;
            if (typeof it === 'string') {
              const p = parseItemStr(it);
              if (p && p.name) counts.set(p.name, (counts.get(p.name) || 0) + p.qty);
            } else if (typeof it === 'object' && (it.name || it.label)) {
              const n = it.name || it.label;
              const q = Number(it.qty || it.count || 1);
              counts.set(n, (counts.get(n) || 0) + q);
            }
          });
          for (const [itemName, q] of counts.entries()) {
            result.push(`${tr(itemName)} (${q})`);
          }
        });
      } else if (Array.isArray(parsedObj)) {
        parsedObj.forEach((it) => {
          if (typeof it === 'string') {
            const p = parseItemStr(it);
            if (p) result.push(`${tr(p.name)} (${p.qty})`);
          }
        });
      }
    }
  }

  // 3. Process thali_groups fallback if still empty
  if (result.length === 0) {
    const groups = item.thali_groups || item.thali_rules || (item.menu_item && item.menu_item.thali_groups);
    if (Array.isArray(groups) && groups.length > 0) {
      groups.forEach((g) => {
        if (!g) return;
        const name = g.name || g.label || g.category_name;
        const count = Number(g.count || g.qty || 1);
        if (name && typeof name === 'string' && !name.match(/^[0-9a-fA-F-]{16,}$/)) {
          result.push(`${tr(name)} (${count})`);
        }
      });
    }
  }

  // 4. Menu list fallback if still empty
  if (result.length === 0 && Array.isArray(menuList) && menuList.length > 0) {
    const mId = item.menu_item_id || item.id;
    const foundMenu = menuList.find(m => m.id === mId || (m.name && m.name.toLowerCase() === (item.name || '').toLowerCase()));
    if (foundMenu && Array.isArray(foundMenu.thali_groups)) {
      foundMenu.thali_groups.forEach((g) => {
        if (!g) return;
        const name = g.name || g.label || g.category_name;
        const count = Number(g.count || g.qty || 1);
        if (name && typeof name === 'string' && !name.match(/^[0-9a-fA-F-]{16,}$/)) {
          result.push(`${tr(name)} (${count})`);
        }
      });
    }
  }

  // 5. Process fixedInclusions / thali_extras (e.g. "salad" or "Roti (4), Rice, Salad")
  const fixedInclusions = item.fixedInclusions || item.thali_extras || item.extras || (item.menu_item && item.menu_item.thali_extras);
  if (fixedInclusions && typeof fixedInclusions === 'string' && fixedInclusions.trim()) {
    const trimmed = fixedInclusions.trim();
    const formattedStr = trimmed.split(',').map(s => {
      const p = parseItemStr(s);
      if (!p) return tr(s.trim());
      return p.qty > 1 ? `${tr(p.name)} (${p.qty})` : tr(p.name);
    }).join(', ');
    if (formattedStr && !result.includes(formattedStr)) {
      result.push(formattedStr);
    }
  }

  // 6. Extra bread
  if (item.extra_bread && Number(item.extra_bread) > 0) {
    const breadName = tr("Extra Roti");
    const breadQty = Number(item.extra_bread);
    result.push(`${breadName} (${breadQty})`);
  }

  return result;
}

function getGroupedThaliItems(selections, extras, t) {
  return getItemSubItems({ thali_selections: selections, thali_extras: extras }, t);
}

export default function ReceiptPreview({
  order: propOrder,
  settings,
  menu,
  editable = false,
  onInc = null,
  onDec = null,
  onRemove = null,
  cart,
  totals,
  customerName,
  tokenNo,
  menuMode,
}) {
  const { t } = useLanguage();

  const order = useMemo(() => {
    if (propOrder) {
      if (propOrder.receipt_no === undefined && (propOrder.token_no === undefined || propOrder.token_no === null)) {
        return {
          ...propOrder,
          token_no: tokenNo !== undefined ? tokenNo : getCurrentToken(),
        };
      }
      return propOrder;
    }
    if (cart) {
      return {
        items: cart.map(item => ({
          ...item,
          qty: item.qty || item.quantity,
          menu_item_id: item.id
        })),
        subtotal: totals?.subtotal || 0,
        tax: totals?.tax || 0,
        total: totals?.total || 0,
        discount: totals?.discount || 0,
        customer_name: customerName,
        token_no: tokenNo !== undefined ? tokenNo : getCurrentToken(),
      };
    }
    return null;
  }, [propOrder, cart, totals, customerName, tokenNo]);

  const isParcel = (order?.order_type === "parcel") || (menuMode === "parcel");

  const calculatedTotal = useMemo(() => {
    if (!order || !Array.isArray(order.items)) return 0;
    return order.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.qty || item.quantity || 0)), 0);
  }, [order]);

  if (!order) return null;

  const dt = new Date(order.paid_at || order.created_at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;

  let hours = dt.getHours();
  const minutes = pad(dt.getMinutes());
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const timeStr = `${pad(hours)}:${minutes} ${ampm}`;

  // Read configurations
  const prefix = settings?.receipt_prefix || '';
  const paddingCount = Number(settings?.receipt_padding) || 6;

  // Format customer-facing Bill Number: simple sequential number (#1, #2, #3...)
  const rawBillNum = order.billNumber ?? order.orderNumber ?? order.receipt_no;
  let cleanBillNum = null;
  if (rawBillNum !== undefined && rawBillNum !== null && rawBillNum !== "") {
    const num = parseInt(String(rawBillNum).replace(/[^0-9]/g, ""), 10);
    if (!isNaN(num) && num > 0) {
      cleanBillNum = (num >= 1001 && num < 2000) ? num - 1000 : num;
    }
  }
  const receiptNoFormatted = cleanBillNum !== null ? `#${cleanBillNum}` : "#—";

  const taxLabel = settings?.tax_label || 'GST';
  const gstRate = settings?.gst_rate ?? 5.0;

  const subtotalVal = calculatedTotal;
  const gstVal = subtotalVal * (gstRate / 100);
  const totalWithGst = subtotalVal + gstVal;

  // Render receipt header template
  const renderHeader = () => {
    let alignClass = "text-center";
    let flexJustify = "justify-center";
    if (settings?.header_alignment === "left") {
      alignClass = "text-left";
      flexJustify = "justify-start";
    } else if (settings?.header_alignment === "right") {
      alignClass = "text-right";
      flexJustify = "justify-end";
    }

    const renderAddress = (addr) => {
      if (!addr) return null;
      const lines = String(addr).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      return (
        <div className={`text-[11px] text-[#333] ${alignClass} w-full leading-tight my-0.5`}>
          {lines.map((line, idx) => (
            <div key={idx}>{line}</div>
          ))}
        </div>
      );
    };

    if (settings?.header_template === "compact") {
      return (
        <div className={alignClass}>
          <div className="font-bold text-sm tracking-wide uppercase mb-0.5">{settings?.name || "ANNDEVTA THALI HOUSE"}</div>
          {settings?.phone && settings.phone.trim() && <div className="text-[11px] text-[#333] mb-0.5">PH: {settings.phone.trim()}</div>}
          {settings?.gstin && settings.gstin.trim() && <div className="text-[11px] text-[#333]">GSTIN: {settings.gstin.trim()}</div>}
          {settings?.fssai && settings.fssai.trim() && <div className="text-[11px] text-[#333]">FSSAI: {settings.fssai.trim()}</div>}
        </div>
      );
    }

    if (settings?.header_template === "modern") {
      return (
        <div className={alignClass}>
          <div className={`flex ${flexJustify} mb-1`}>
            <span className="border border-black px-1.5 py-0.5 font-bold tracking-wider text-[11px] bg-black text-[#fdfbf7] rounded-sm">ΨΦ</span>
          </div>
          <div className="font-bold text-sm tracking-wide uppercase mb-0.5">{settings?.name || "ANNDEVTA THALI HOUSE"}</div>
          {renderAddress(settings?.address)}
          {settings?.phone && settings.phone.trim() && <div className="text-[11px] text-[#333] mb-0.5">PH: {settings.phone.trim()}</div>}
          {settings?.gstin && settings.gstin.trim() && <div className="text-[11px] text-[#333]">GSTIN: {settings.gstin.trim()}</div>}
          {settings?.fssai && settings.fssai.trim() && <div className="text-[11px] text-[#333]">FSSAI: {settings.fssai.trim()}</div>}
        </div>
      );
    }

    // Classic Template (Default)
    return (
      <div className={alignClass}>
        <div className="font-bold text-sm tracking-wide uppercase mb-0.5">{settings?.name || "ANNDEVTA THALI HOUSE"}</div>
        {renderAddress(settings?.address)}
        {settings?.phone && settings.phone.trim() && <div className="text-[11px] text-[#333] mb-0.5">PH: {settings.phone.trim()}</div>}
        {settings?.gstin && settings.gstin.trim() && <div className="text-[11px] text-[#333]">GSTIN: {settings.gstin.trim()}</div>}
        {settings?.fssai && settings.fssai.trim() && <div className="text-[11px] text-[#333]">FSSAI: {settings.fssai.trim()}</div>}
      </div>
    );
  };
  return (
    <div className="receipt-wrapper">
      {isParcel && (
      <>
      {/* FIRST CONTAINER: Kitchen Receipt - 300px symmetrical thermal layout */}
      <div id="kitchen-receipt-print" className="kitchen-receipt-container w-[300px] mx-auto bg-[#fdfbf7] p-[10px] shadow-md border border-[#e6e4de] font-mono leading-normal text-[#000] text-[12px] box-border">
        {/* Restaurant Name */}
        <div className="text-center">
          <div className="font-bold text-xs tracking-wide uppercase mb-0.5">{(settings?.name || "ANNDEVTA THALI HOUSE").toUpperCase()}</div>
        </div>

        <div className="my-1.5 border-t border-black" />

        {/* Kitchen Metadata */}
        <div className="space-y-0.5 text-[11px] font-medium">
          {(order.token_no !== undefined && order.token_no !== null) && (
            <div className="flex justify-between items-center">
              <span>TOKEN NO:</span>
              <span className="font-bold text-xs">#{order.token_no}</span>
            </div>
          )}
          {/* <div className="flex justify-between items-center">
            <span>BILL NO:</span>
            <span className="font-bold">{receiptNoFormatted}</span>
          </div> */}
          <div className="flex justify-between items-center">
          <span>{dateStr}</span>
          <span>{timeStr}</span>
          </div>
          {order.notes && (
            <div className="flex justify-between items-center text-[#d32f2f] font-bold">
              <span>NOTES:</span>
              <span>{order.notes}</span>
            </div>
          )}
        </div>

        {/* Title */}
        <div className="my-1.5 border-t border-dashed border-black" />
        <div className="text-center font-extrabold tracking-widest text-xs bg-black text-white py-0.5 rounded-xs">KITCHEN / COUPON RECEIPT</div>
        <div className="my-1.5 border-t border-dashed border-black" />

        {/* Items List (No Prices) */}
        <div className="space-y-2 my-2">
          {Array.isArray(order?.items) && order.items.map((line, idx) => {
            const key = line._key || `${line.menu_item_id}-${idx}`;
            const subItems = getItemSubItems(line, t, menu);
            return (
              <div key={key}>
                <div className="font-bold text-[13px]">
                  {t(line.name)}
                </div>
                <div className="font-bold text-[11px] text-[#111]">
                  Qty: {line.qty}
                </div>
                {Array.isArray(subItems) && subItems.length > 0 && (
                  <div className="text-[11px] text-[#333] pl-2 mt-0.5 leading-snug">
                    {subItems.map((sel, sIdx) => (
                      <div key={sIdx}>• {sel}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer Banner */}
        <div className="mt-3 my-1 border-t border-black" />
        {/* <div className="text-center font-extrabold text-xs tracking-widest uppercase my-0.5">KITCHEN COPY</div> */}
        {/* <div className="my-1 border-t border-black" /> */}
      </div>
      </>
    )}

      {/* Vertical spacing between preview blocks */}
      {/* <div className="h-6 select-none print:hidden" /> */}

      {/* SECOND CONTAINER: Customer Receipt - 300px symmetrical thermal layout */}
      <div className="receipt-container w-[300px] mx-auto bg-[#fdfbf7] p-[10px] shadow-md border border-[#e6e4de] font-mono leading-normal text-[#000] text-[12px] box-border">
        {/* Header */}
        {renderHeader()}

        <div className="my-2 border-t border-black" />

        {/* Bill Info Metadata */}
        <div className="space-y-0.5 text-[11px]">
          <div className="flex justify-between items-center font-bold pb-1 border-b border-dashed border-black/20">
            <span>Order Type:</span>
            <span className={order.order_type === "parcel" || isParcel ? "text-amber-800" : "text-slate-800"}>
              {(order.order_type === "parcel" || isParcel) ? "PARCEL / TAKEAWAY" : "DINE-IN"}
            </span>
          </div>
          {(order.token_no !== undefined && order.token_no !== null) && (
            <div className="flex justify-between items-center pt-0.5">
              <span>Token No:</span>
              <span className="font-bold">#{order.token_no}</span>
            </div>
          )}
          <div className="flex justify-between items-center">
            <span>{t("bill_no")}:</span>
            <span>{receiptNoFormatted}</span>
          </div>
          <div className="flex justify-between items-center">
          <span>{dateStr}</span>
          <span>{timeStr}</span>
          
          </div>
          {order.customer_name && (
            <div className="flex justify-between items-center">
              <span>{t("customer")}:</span>
              <span>{order.customer_name}</span>
            </div>
          )}
          {order.customer_phone && (
            <div className="flex justify-between items-center">
              <span>{t("phone")}:</span>
              <span>{order.customer_phone}</span>
            </div>
          )}
        </div>

        {/* Items Title */}
        <div className="my-2 border-t border-dashed border-black" />
        <div className="text-center font-bold tracking-wider text-[11px]">ITEMS</div>
        <div className="my-1.5 border-t border-dashed border-black" />

        {/* Items List */}
        <div className="space-y-1.5">
          {Array.isArray(order?.items) && order.items.map((line, idx) => {
            const key = line._key || `${line.menu_item_id}-${idx}`;
            const subItems = getItemSubItems(line, t, menu);
            return (
              <div key={key} className="group relative">
                <div className="flex justify-between font-bold">
                  <span>{t(line.name)}</span>
                  <span>Rs.{safeFixed(safeNumber(line.price) * safeNumber(line.qty))}</span>
                </div>
                <div className="flex justify-between text-[11px] text-[#333]">
                  <span>{safeNumber(line.qty)} x Rs.{safeFixed(line.price)}</span>
                </div>

                {/* Sub-items / Addons list */}
                {Array.isArray(subItems) && subItems.length > 0 && (
                  <div className="text-[10px] text-[#555] pl-2.5 mt-0.5 leading-tight" data-testid={`thali-selections-${key}`}>
                    {subItems.map((sel, sIdx) => (
                      <div key={sIdx}>• {sel}</div>
                    ))}
                  </div>
                )}

                {/* Editable Counter Controls */}
                {editable && (
                  <div className="mt-1.5 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => onDec && onDec(key)} data-testid={`dec-${key}`}
                      className="w-5 h-5 border border-border rounded flex items-center justify-center bg-white hover:bg-sand-subtle"><Minus className="w-3 h-3 text-neutral-600" /></button>
                    <span className="w-6 text-center text-xs font-mono font-bold">{line.qty}</span>
                    <button onClick={() => onInc && onInc(key)} data-testid={`inc-${key}`}
                      className="w-5 h-5 border border-border rounded flex items-center justify-center bg-white hover:bg-sand-subtle"><Plus className="w-3 h-3 text-neutral-600" /></button>
                    <button onClick={() => onRemove && onRemove(key)} data-testid={`rm-${key}`}
                      className="w-5 h-5 text-destructive hover:bg-destructive/10 rounded flex items-center justify-center ml-1"><Trash2 className="w-3 h-3" /></button>
                  </div>
                )}
              </div>
            );
          })}
          {order.items.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-3">{t("no_items_in_cart")}</div>
          )}
        </div>

        <div className="my-2 border-t border-dashed border-black" />

        {/* Pricing Summary */}
        <div className="space-y-1 text-[#000]">
          <div className="flex justify-between">
            <span>{t("subtotal")}{isParcel ? " (Incl. GST)" : ""}</span>
            <span>Rs.{safeFixed(order.subtotal)}</span>
          </div>
          {settings?.show_gst !== false && (() => {
            const cgstRate = order.cgst_rate ?? settings?.cgst_rate ?? ((settings?.gst_rate ?? 5.0) / 2);
            const sgstRate = order.sgst_rate ?? settings?.sgst_rate ?? ((settings?.gst_rate ?? 5.0) / 2);
            const isParcelOrder = (order.order_type === "parcel" || isParcel);

            let cgstVal = order.cgst;
            let sgstVal = order.sgst;

            if (cgstVal === undefined || sgstVal === undefined) {
              const sub = safeNumber(order.subtotal);
              const totalRate = safeNumber(cgstRate) + safeNumber(sgstRate);
              if (isParcelOrder) {
                if (totalRate > 0) {
                  const base = sub / (1 + totalRate / 100);
                  const taxAmt = sub - base;
                  cgstVal = taxAmt * (cgstRate / totalRate);
                  sgstVal = taxAmt * (sgstRate / totalRate);
                } else {
                  cgstVal = 0;
                  sgstVal = 0;
                }
              } else {
                cgstVal = sub * (cgstRate / 100);
                sgstVal = sub * (sgstRate / 100);
              }
            }

            return (
              <>
                <div className="flex justify-between">
                  <span>CGST ({cgstRate}%{isParcelOrder ? " incl." : ""})</span>
                  <span>Rs.{safeFixed(cgstVal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>SGST ({sgstRate}%{isParcelOrder ? " incl." : ""})</span>
                  <span>Rs.{safeFixed(sgstVal)}</span>
                </div>
              </>
            );
          })()}
          {safeNumber(order.discount) > 0 && (
            <div className="flex justify-between text-[#d32f2f]">
              <span>{t("discount")}</span>
              <span>-Rs.{safeFixed(order.discount)}</span>
            </div>
          )}
        </div>

        <div className="my-2 border-t border-dashed border-black" />

        <div className="flex justify-between font-extrabold text-sm py-0.5">
          <span>{t("total_uppercase")}</span>
          <span>Rs.{safeFixed(order.total !== undefined ? order.total : order.grandTotal)}</span>
        </div>

        <div className="my-2 border-t border-dashed border-black" />

        {/* Payment details */}
        {/* {settings?.show_payment !== false && order.payment_mode && (
          <div className="flex justify-between items-center font-bold text-[11px] uppercase mb-1">
            <span>{t("payment")}:</span>
            <span>
              {
                order.payment_mode === "cash" ? t("cash") :
                  order.payment_mode === "upi" ? t("upi") :
                    order.payment_mode === "card" ? t("card") : order.payment_mode
              }
            </span>
          </div>
        )} */}

        {/* Footer message */}
        <div className="text-center font-bold uppercase text-[11px] mt-2">
          {
            (!settings?.footer_msg ||
              settings.footer_msg === "Thank you! Please visit again." ||
              settings.footer_msg === "Thank you for dining with us!")
              ? `${t("thank_you")}! ${t("visit_again")}`
              : settings.footer_msg
          }
        </div>

        {/* <div className="text-center text-[10px] text-[#444] mt-1">{dateStr} {timeStr}</div> */}

        <div className="my-2 border-t border-dashed border-black" />
        <div className="text-center text-[9px] text-[#666]">
          <div className="font-semibold">Powered by Career Craftly</div>
          <div className="text-[8.5px] mt-0.5">Crafting Digital Success, Intelligently</div>
        </div>
        <div className="mt-2 border-t border-black" />
      </div>
    </div>
  );
}
