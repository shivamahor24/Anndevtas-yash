// Customer receipt printer (80mm / 58mm thermal POS compatible)
// Specifically optimized for RetSol RTP-80 80mm Thermal Receipt Printer (72mm active printhead / 576 dots)
import en from "../translations/en.json";
import gu from "../translations/gu.json";
import bilingual from "../translations/bilingual.json";
import { toast } from "sonner";
import { safeNumber, safeFixed } from "./utils";

const translations = { en, gu, bilingual };

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

function buildReceiptBlock({
  order,
  settings,
  t,
  tokenNo,
  receiptNoFormatted,
  dateStr,
  timeStr,
  safe,
  menu,
  menuMode
}) {
  const isParcelOrder = (order?.order_type === "parcel") || (menuMode === "parcel");
  const cgstRate =
    order.cgst_rate ??
    settings?.cgst_rate ??
    ((settings?.gst_rate ?? 5.0) / 2);

  const sgstRate =
    order.sgst_rate ??
    settings?.sgst_rate ??
    ((settings?.gst_rate ?? 5.0) / 2);

  const subtotalVal = Number(order.subtotal || 0) || (order.items || []).reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.qty || 1)), 0);
  const discountVal = Number(order.discount || 0);

  let cgstVal = order.cgst;
  let sgstVal = order.sgst;

  if (cgstVal === undefined || sgstVal === undefined) {
    const totalRate = cgstRate + sgstRate;
    if (isParcelOrder) {
      if (totalRate > 0) {
        const base = subtotalVal / (1 + totalRate / 100);
        const taxAmt = subtotalVal - base;
        cgstVal = taxAmt * (cgstRate / totalRate);
        sgstVal = taxAmt * (sgstRate / totalRate);
      } else {
        cgstVal = 0;
        sgstVal = 0;
      }
    } else {
      cgstVal = subtotalVal * (cgstRate / 100);
      sgstVal = subtotalVal * (sgstRate / 100);
    }
  }

  let finalTotal;
  if (isParcelOrder) {
    finalTotal = Math.max(0, subtotalVal - discountVal);
  } else if (order.total !== undefined && order.total !== null) {
    finalTotal = Number(order.total);
  } else {
    finalTotal = Math.max(0, subtotalVal + Number(cgstVal || 0) + Number(sgstVal || 0) - discountVal);
  }

  const formatAddressHTML = (addr) => {
    if (!addr) return "";
    return String(addr)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => safe(l))
      .join("<br/>");
  };

  // HEADER
  let headerHTML = "";
  let alignStyle = "center";
  if (settings?.header_alignment === "left") {
    alignStyle = "left";
  } else if (settings?.header_alignment === "right") {
    alignStyle = "right";
  }

  if (settings?.header_template === "compact") {
    headerHTML = `
      <div style="font-weight:800;font-size:15px;letter-spacing:0.02em;text-transform:uppercase;text-align:${alignStyle};margin-bottom:2px;">
        ${safe(settings?.name || "ANNDEVTA THALI HOUSE")}
      </div>
      ${settings?.phone && String(settings.phone).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};margin-bottom:1px;">PH: ${safe(String(settings.phone).trim())}</div>`
        : ""
      }
      ${settings?.gstin && String(settings.gstin).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};">
              GSTIN: ${safe(String(settings.gstin).trim())}
            </div>`
        : ""
      }
      ${settings?.fssai && String(settings.fssai).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};">
              FSSAI: ${safe(String(settings.fssai).trim())}
            </div>`
        : ""
      }
    `;
  } else if (settings?.header_template === "modern") {
    const badgeAlign = alignStyle === "left" ? "left" : alignStyle === "right" ? "right" : "center";
    headerHTML = `
      <div style="text-align:${badgeAlign};margin-bottom:4px;">
        <span style="border:1px solid #000;padding:1px 6px;font-weight:bold;letter-spacing:1px;font-size:11px;background:#000;color:#fff;border-radius:2px;display:inline-block;">ΨΦ</span>
      </div>
      <div style="font-weight:800;font-size:15px;letter-spacing:0.02em;text-transform:uppercase;text-align:${alignStyle};margin-bottom:2px;">
        ${safe(settings?.name || "ANNDEVTA THALI HOUSE")}
      </div>
      ${settings?.address && String(settings.address).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};line-height:1.3;margin:2px auto;">
              ${formatAddressHTML(settings.address)}
            </div>`
        : ""
      }
      ${settings?.phone && String(settings.phone).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};margin-bottom:1px;">
              PH: ${safe(String(settings.phone).trim())}
            </div>`
        : ""
      }
      ${settings?.gstin && String(settings.gstin).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};">
              GSTIN: ${safe(String(settings.gstin).trim())}
            </div>`
        : ""
      }
      ${settings?.fssai && String(settings.fssai).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};">
              FSSAI: ${safe(String(settings.fssai).trim())}
            </div>`
        : ""
      }
    `;
  } else {
    headerHTML = `
      <div style="font-weight:800;font-size:15px;letter-spacing:0.02em;text-transform:uppercase;text-align:${alignStyle};margin-bottom:2px;">
        ${safe(settings?.name || "ANNDEVTA THALI HOUSE")}
      </div>
      ${settings?.address && String(settings.address).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};line-height:1.3;margin:2px auto;">
              ${formatAddressHTML(settings.address)}
            </div>`
        : ""
      }
      ${settings?.phone && String(settings.phone).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};margin-bottom:1px;">
              PH: ${safe(String(settings.phone).trim())}
            </div>`
        : ""
      }
      ${settings?.gstin && String(settings.gstin).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};">
              GSTIN: ${safe(String(settings.gstin).trim())}
            </div>`
        : ""
      }
      ${settings?.fssai && String(settings.fssai).trim()
        ? `<div style="font-size:11.5px;color:#000;text-align:${alignStyle};">
              FSSAI: ${safe(String(settings.fssai).trim())}
            </div>`
        : ""
      }
    `;
  }

  // ITEMS (Full usable 72mm width 2-column table layout)
  const itemsHTML = (order.items || [])
    .map((i) => {
      const lineTotal = safeFixed(
        safeNumber(i.price) *
        safeNumber(i.qty)
      );

      const subItems = getItemSubItems(i, t, menu);
      const subline = subItems.map(
        (sel) => `• ${safe(sel)}`
      );

      return `
        <table class="receipt-row-table" style="margin-bottom:4px;">
          <tr>
            <td style="width:64%;text-align:left;vertical-align:top;font-weight:bold;font-size:12.5px;padding-right:4px;word-break:break-word;">
              ${safe(t(i.name))}
            </td>
            <td style="width:36%;text-align:right;vertical-align:top;font-weight:bold;font-size:12.5px;padding-right:1px;white-space:nowrap;font-variant-numeric:tabular-nums;">
              ₹${lineTotal}
            </td>
          </tr>
          <tr>
            <td colspan="2" style="text-align:left;font-size:11px;color:#111;padding:0 0 1px 0;">
              ${safeNumber(i.qty)} x ₹${safeFixed(i.price)}
            </td>
          </tr>
          ${subline.length > 0
          ? `
                <tr>
                  <td colspan="2" style="text-align:left;font-size:10.5px;color:#333;padding-left:6px;line-height:1.25;">
                    ${subline.join("<br/>")}
                  </td>
                </tr>
              `
          : ""
        }
        </table>
      `;
    })
    .join("");

  // RECEIPT
  return `
    <div class="receipt-container">

      <!-- HEADER -->
      <div style="text-align:${alignStyle};width:100%;">
        ${headerHTML}
      </div>

      <div class="separator-solid"></div>

      <!-- BILL INFO TABLE -->
      <table class="receipt-row-table" style="font-size:11.5px;margin:2px 0;">
        <tr>
          <td style="width:46%;text-align:left;font-weight:bold;padding:1px 0;">Order Type:</td>
          <td style="width:54%;text-align:right;font-weight:bold;padding:1px 1px 1px 0;white-space:nowrap;">
            ${(order.order_type === "parcel") ? "PARCEL / TAKEAWAY" : "DINE-IN"}
          </td>
        </tr>

        ${tokenNo !== undefined && tokenNo !== null
      ? `
              <tr>
                <td style="width:46%;text-align:left;font-weight:bold;font-size:12.5px;padding:2px 0;">Token No:</td>
                <td style="width:54%;text-align:right;font-weight:900;font-size:16px;padding:2px 1px 2px 0;white-space:nowrap;">
                  #${tokenNo}
                </td>
              </tr>
            `
      : ""
    }

        <tr>
          <td style="width:46%;text-align:left;padding:1px 0;">${t("bill_no")}:</td>
          <td style="width:54%;text-align:right;font-weight:bold;padding:1px 1px 1px 0;white-space:nowrap;">
            ${receiptNoFormatted}
          </td>
        </tr>

        <tr>
          <td style="width:50%;text-align:left;padding:1px 0;">${dateStr}</td>
          <td style="width:50%;text-align:right;padding:1px 1px 1px 0;white-space:nowrap;">${timeStr}</td>
        </tr>

        ${order.customer_name
      ? `
              <tr>
                <td style="width:35%;text-align:left;padding:1px 0;">${t("customer")}:</td>
                <td style="width:65%;text-align:right;padding:1px 1px 1px 0;word-break:break-word;">
                  ${safe(order.customer_name)}
                </td>
              </tr>
            `
      : ""
    }

        ${order.customer_phone
      ? `
              <tr>
                <td style="width:35%;text-align:left;padding:1px 0;">${t("phone")}:</td>
                <td style="width:65%;text-align:right;padding:1px 1px 1px 0;white-space:nowrap;">
                  ${safe(order.customer_phone)}
                </td>
              </tr>
            `
      : ""
    }
      </table>

      <!-- ITEMS HEADER -->
      <div class="separator-dashed"></div>

      <div style="text-align:center;font-weight:bold;letter-spacing:1px;font-size:11.5px;width:100%;">
        ITEMS
      </div>

      <div class="separator-dashed"></div>

      <!-- ITEMS LIST -->
      <div style="width:100%;">
        ${itemsHTML}
      </div>

      <div class="separator-dashed"></div>

      <!-- SUMMARY TABLE -->
      <table class="receipt-row-table" style="font-size:12px;margin:2px 0;">
        <tr>
          <td style="width:58%;text-align:left;padding:1.5px 0;">
            ${t("subtotal")}${isParcelOrder ? " (Incl. GST)" : ""}
          </td>
          <td style="width:42%;text-align:right;font-weight:bold;padding:1.5px 1px 1.5px 0;white-space:nowrap;font-variant-numeric:tabular-nums;">
            ₹${safeFixed(order.subtotal)}
          </td>
        </tr>

        ${settings?.show_gst !== false
      ? `
                <tr>
                  <td style="width:58%;text-align:left;padding:1.5px 0;">
                    CGST (${cgstRate}%${isParcelOrder ? " incl." : ""})
                  </td>
                  <td style="width:42%;text-align:right;padding:1.5px 1px 1.5px 0;white-space:nowrap;font-variant-numeric:tabular-nums;">
                    ₹${safeFixed(cgstVal)}
                  </td>
                </tr>

                <tr>
                  <td style="width:58%;text-align:left;padding:1.5px 0;">
                    SGST (${sgstRate}%${isParcelOrder ? " incl." : ""})
                  </td>
                  <td style="width:42%;text-align:right;padding:1.5px 1px 1.5px 0;white-space:nowrap;font-variant-numeric:tabular-nums;">
                    ₹${safeFixed(sgstVal)}
                  </td>
                </tr>
              `
      : ""
    }

        ${safeNumber(order.discount) > 0
      ? `
              <tr>
                <td style="width:58%;text-align:left;padding:1.5px 0;">
                  ${t("discount")}
                </td>
                <td style="width:42%;text-align:right;padding:1.5px 1px 1.5px 0;white-space:nowrap;font-variant-numeric:tabular-nums;">
                  -₹${safeFixed(order.discount)}
                </td>
              </tr>
            `
      : ""
    }
      </table>

      <div class="separator-dashed"></div>

      <!-- TOTAL TABLE -->
      <table class="receipt-row-table" style="margin:2px 0;">
        <tr>
          <td style="width:45%;text-align:left;font-size:15px;font-weight:800;padding:2px 0;">
            ${t("total_uppercase")}
          </td>
          <td style="width:55%;text-align:right;font-size:15px;font-weight:800;padding:2px 1px 2px 0;white-space:nowrap;font-variant-numeric:tabular-nums;">
            ₹${safeFixed(finalTotal)}
          </td>
        </tr>
      </table>

      <div class="separator-dashed"></div>

      <!-- FOOTER -->
      <div style="text-align:center;font-weight:bold;text-transform:uppercase;margin-top:4px;font-size:11.5px;width:100%;">
        ${safe(
          !settings?.footer_msg ||
          settings.footer_msg === "Thank you! Please visit again." ||
          settings.footer_msg === "Thank you for dining with us!"
            ? `${t("thank_you")}! ${t("visit_again")}`
            : settings.footer_msg
        )}
      </div>

      <div class="separator-dashed" style="margin-top:5px;"></div>

      <div style="text-align:center;font-size:9px;color:#333;width:100%;">
        <div style="font-weight:600;">
          Powered by Career Craftly
        </div>
        <div style="margin-top:1px;font-size:8px;">
          Crafting Digital Success, Intelligently
        </div>
      </div>

      <div class="separator-solid" style="margin-top:5px;"></div>

    </div>
  `;
}

function buildKitchenReceiptBlock({
  order,
  settings,
  t,
  tokenNo,
  receiptNoFormatted,
  dateStr,
  timeStr,
  safe,
  menu
}) {
  const nameUpper = safe(
    (settings?.name || "ANNDEVTA THALI HOUSE").toUpperCase()
  );

  const itemsHTML = (order.items || [])
    .map((i) => {
      const subItems = getItemSubItems(i, t, menu);
      const subline = subItems.map(
        (sel) => `• ${safe(sel)}`
      );

      return `
        <table class="receipt-row-table" style="margin-bottom:5px;">
          <tr>
            <td style="width:70%;text-align:left;vertical-align:top;font-weight:bold;font-size:13px;padding-right:4px;word-break:break-word;">
              ${safe(t(i.name))}
            </td>
            <td style="width:30%;text-align:right;vertical-align:top;font-weight:bold;font-size:12.5px;padding-right:1px;white-space:nowrap;">
              Qty: ${i.qty}
            </td>
          </tr>
          ${subline.length > 0
          ? `
                <tr>
                  <td colspan="2" style="text-align:left;font-size:11px;color:#222;padding-left:6px;line-height:1.25;">
                    ${subline.join("<br/>")}
                  </td>
                </tr>
              `
          : ""
        }
        </table>
      `;
    })
    .join("");

  return `
    <div class="kitchen-receipt-container">

      <div style="text-align:center;width:100%;">
        <div style="font-weight:bold;font-size:13px;letter-spacing:0.02em;text-transform:uppercase;margin-bottom:2px;">
          ${nameUpper}
        </div>
      </div>

      <div class="separator-solid" style="margin:3px 0;"></div>

      <!-- KITCHEN INFO TABLE -->
      <table class="receipt-row-table" style="font-size:11.5px;margin:2px 0;">
        ${tokenNo !== undefined && tokenNo !== null
      ? `
              <tr>
                <td style="width:46%;text-align:left;font-weight:bold;font-size:12.5px;padding:2px 0;">TOKEN NO:</td>
                <td style="width:54%;text-align:right;font-weight:900;font-size:16px;padding:2px 1px 2px 0;white-space:nowrap;">
                  #${tokenNo}
                </td>
              </tr>
            `
      : ""
    }

        <tr>
          <td style="width:46%;text-align:left;padding:1px 0;">BILL NUMBER:</td>
          <td style="width:54%;text-align:right;font-weight:bold;padding:1px 1px 1px 0;white-space:nowrap;">
            ${receiptNoFormatted}
          </td>
        </tr>

        <tr>
          <td style="width:50%;text-align:left;padding:1px 0;">${dateStr}</td>
          <td style="width:50%;text-align:right;padding:1px 1px 1px 0;white-space:nowrap;">${timeStr}</td>
        </tr>

        ${order.notes
      ? `
              <tr>
                <td style="width:30%;text-align:left;font-weight:bold;color:#000;padding:2px 0;">NOTES:</td>
                <td style="width:70%;text-align:right;font-weight:bold;padding:2px 1px 2px 0;word-break:break-word;">
                  ${safe(order.notes)}
                </td>
              </tr>
            `
      : ""
    }
      </table>

      <div class="separator-dashed" style="margin:4px 0;"></div>

      <div style="text-align:center;font-weight:800;letter-spacing:1px;font-size:12px;width:100%;">
        KITCHEN / COUPON RECEIPT
      </div>

      <div class="separator-dashed" style="margin:4px 0;"></div>

      <!-- ITEMS -->
      <div style="margin:4px 0;width:100%;">
        ${itemsHTML}
      </div>

      <div class="separator-solid" style="margin-top:6px;margin-bottom:4px;"></div>

    </div>
  `;
}

export async function printReceipt({ order, settings, menu, menuMode }) {
  if (!order) return;

  // Defensive fallback / merge settings with offlineStorage to ensure fssai is present
  let effectiveSettings = settings;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('pos_offline_settings') : null;
    if (raw) {
      const cached = JSON.parse(raw)?.data;
      if (cached) {
        effectiveSettings = {
          ...cached,
          ...(settings || {}),
          fssai: (settings && settings.fssai !== undefined && settings.fssai !== null && String(settings.fssai).trim() !== '')
            ? settings.fssai
            : (cached.fssai || ''),
        };
      }
    }
  } catch (_) {}

  const lang = localStorage.getItem("pos_language") || effectiveSettings?.language || "en";
  const t = (key) => {
    const dict = translations[lang] || translations["en"];
    return dict[key] || translations["en"][key] || key;
  };
  const dt = new Date(order.paid_at || order.created_at || Date.now());
  const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;

  let hours = dt.getHours();
  const minutes = pad(dt.getMinutes());
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const timeStr = `${pad(hours)}:${minutes} ${ampm}`;

  // Customer-facing Bill Number: simple sequential number (#1, #2, #3...)
  const rawBillNum = order.billNumber ?? order.orderNumber ?? order.receipt_no;
  let cleanBillNum = null;
  if (rawBillNum !== undefined && rawBillNum !== null && rawBillNum !== "") {
    const num = parseInt(String(rawBillNum).replace(/[^0-9]/g, ""), 10);
    if (!isNaN(num) && num > 0) {
      cleanBillNum = num;
    }
  }
  const receiptNoFormatted = cleanBillNum !== null ? `#${cleanBillNum}` : "#—";

  const is58 = Number(effectiveSettings?.paper_width) === 58;
  const paperWidth = is58 ? "58mm" : "80mm";
  // Active printable head width (72mm for RetSol RTP-80 80mm roll, 48mm for 58mm roll)
  const printableWidth = is58 ? "48mm" : "72mm";

  const customerReceiptHTML = buildReceiptBlock({
    order,
    settings: effectiveSettings,
    t,
    tokenNo: order.token_no,
    receiptNoFormatted,
    dateStr,
    timeStr,
    safe,
    menu,
    menuMode,
  });

  const kitchenReceiptHTML = buildKitchenReceiptBlock({
    order,
    settings: effectiveSettings,
    t,
    tokenNo: order.token_no,
    receiptNoFormatted,
    dateStr,
    timeStr,
    safe,
    menu,
    menuMode,
  });

  const isParcel = (order?.order_type === "parcel") || (menuMode === "parcel");

  // ---------------------------------------------------------
  // Build a complete printable HTML document formatted for 72mm active printhead
  // ---------------------------------------------------------
  const buildPrintHTML = (receiptContent, title = "Receipt") => {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${title} #${receiptNoFormatted}</title>

<style>
  @page {
    size: ${paperWidth} auto;
    margin: 0mm;
  }

  * {
    box-sizing: border-box !important;
    margin: 0;
    padding: 0;
  }

  html, body {
    width: 100%;
    max-width: ${printableWidth};
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #000000;
    font-family: 'Segoe UI', Arial, -apple-system, BlinkMacSystemFont, 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.35;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .receipt-container,
  .kitchen-receipt-container {
    width: ${printableWidth};
    max-width: ${printableWidth};
    margin: 0;
    padding: 2mm 1.5mm 4mm 1.5mm;
    box-sizing: border-box !important;
    background: #ffffff;
    color: #000000;
    word-break: break-word;
    overflow: hidden;
  }

  @media print {
    @page {
      size: ${paperWidth} auto;
      margin: 0mm;
    }

    html, body {
      width: 100% !important;
      max-width: ${printableWidth} !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #ffffff !important;
    }

    .receipt-container,
    .kitchen-receipt-container {
      width: 100% !important;
      max-width: ${printableWidth} !important;
      margin: 0 !important;
      padding: 1.5mm 1.5mm 3mm 1.5mm !important;
      border: none !important;
      background: #ffffff !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }
  }

  .receipt-row-table {
    width: 100% !important;
    table-layout: fixed !important;
    border-collapse: collapse !important;
    border-spacing: 0 !important;
    box-sizing: border-box !important;
  }

  .separator-solid {
    width: 100%;
    border: none;
    border-top: 1.5px solid #000000;
    margin: 4px 0;
  }

  .separator-dashed {
    width: 100%;
    border: none;
    border-top: 1.5px dashed #000000;
    margin: 4px 0;
  }

  .paper-feed-end {
    height: 35px;
  }
</style>
</head>

<body>

${receiptContent}

<div class="paper-feed-end"></div>

</body>
</html>`;
  };

  // ---------------------------------------------------------
  // Electron printer helper
  // ---------------------------------------------------------
  const printOneReceipt = async (html) => {
    const isElectron =
      window.electronAPI &&
      window.electronAPI.printer;

    if (isElectron) {
      const localPrinter = typeof localStorage !== "undefined" ? localStorage.getItem("pos_default_printer") : null;
      const printerName =
        (effectiveSettings?.default_printer && effectiveSettings.default_printer !== "system_default")
          ? effectiveSettings.default_printer
          : (localPrinter || effectiveSettings?.default_printer || "system_default");

      const paperWidthSetting =
        Number(effectiveSettings?.paper_width) || 80;

      try {
        const res =
          await window.electronAPI.printer.print(
            html,
            printerName,
            paperWidthSetting
          );

        if (res && res.success === false) {
          console.error("Direct print failed:", res.error);
          toast.error(res.error || "Failed to print receipt");
          return false;
        }

        const isSuccess = typeof res === 'boolean' ? res : !!res?.success;
        if (!isSuccess) {
          toast.error("Failed to print receipt");
          return false;
        }

        return true;
      } catch (error) {
        console.error("Print error:", error);
        toast.error("Print error: " + (error?.message || "Unknown error"));
        return false;
      }
    }

    return fallbackBrowserPrint(html);
  };

  // ---------------------------------------------------------
  // DINING: Only customer receipt. One print job.
  // ---------------------------------------------------------
  if (!isParcel) {
    const customerHTML = buildPrintHTML(
      customerReceiptHTML,
      "Customer Receipt"
    );

    return await printOneReceipt(customerHTML);
  }

  // ---------------------------------------------------------
  // PARCEL: Print TWO SEPARATE jobs (Kitchen Coupon + Customer Bill)
  // ---------------------------------------------------------
  const kitchenHTML = buildPrintHTML(
    kitchenReceiptHTML,
    "Kitchen Coupon"
  );

  const customerHTML = buildPrintHTML(
    customerReceiptHTML,
    "Customer Bill"
  );

  const isElectron =
    window.electronAPI &&
    window.electronAPI.printer;

  if (isElectron) {
    try {
      const localPrinter = typeof localStorage !== "undefined" ? localStorage.getItem("pos_default_printer") : null;
      const printerName =
        (effectiveSettings?.default_printer && effectiveSettings.default_printer !== "system_default")
          ? effectiveSettings.default_printer
          : (localPrinter || effectiveSettings?.default_printer || "system_default");

      const paperWidthSetting =
        Number(effectiveSettings?.paper_width) || 80;

      console.log(
        "PARCEL: Sending kitchen + customer to Electron printer"
      );

      const res =
        await window.electronAPI.printer.printParcel(
          kitchenHTML,
          customerHTML,
          printerName,
          paperWidthSetting
        );

      if (res && res.success === false) {
        console.error(
          "Parcel direct print failed:",
          res.error
        );
        toast.error(
          res.error || "Failed to print parcel receipts"
        );
        return false;
      }

      const isSuccess =
        typeof res === "boolean" ? res : !!res?.success;
      if (!isSuccess) {
        toast.error("Failed to print parcel receipts");
        return false;
      }

      return true;
    } catch (error) {
      console.error(
        "Parcel print error:",
        error
      );
      toast.error("Parcel print error: " + (error?.message || "Unknown error"));
      return false;
    }
  }

  // Browser / non-Electron path
  openPrintPopup(kitchenHTML);
  await new Promise(resolve => setTimeout(resolve, 2500));
  openPrintPopup(customerHTML);

  return true;
}

function fallbackBrowserPrint(html) {
  const printFrame = document.createElement('iframe');
  printFrame.style.position = 'fixed';
  printFrame.style.right = '0';
  printFrame.style.bottom = '0';
  printFrame.style.width = '0';
  printFrame.style.height = '0';
  printFrame.style.border = '0';

  document.body.appendChild(printFrame);

  try {
    const frameDoc = printFrame.contentWindow ? printFrame.contentWindow.document : printFrame.contentDocument;
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();
  } catch (e) {
    console.error('Iframe print error', e);
  }

  setTimeout(() => {
    if (document.body.contains(printFrame)) {
      document.body.removeChild(printFrame);
    }
  }, 60000);

  return true;
}

/**
 * Opens a new popup window, writes HTML into it, then triggers print.
 */
function openPrintPopup(html) {
  const popup = window.open('', '_blank', 'width=400,height=600,scrollbars=no,menubar=no,toolbar=no');
  if (!popup) {
    fallbackBrowserPrint(html);
    return;
  }
  try {
    const htmlWithScript = html.includes('window.print()')
      ? html
      : html.replace('</body>', '<script>window.onload=()=>{window.print();setTimeout(()=>{window.close();},500);};</script></body>');
    popup.document.open();
    popup.document.write(htmlWithScript);
    popup.document.close();
  } catch (e) {
    console.error('Popup print error', e);
    try { popup.close(); } catch (_) {}
    fallbackBrowserPrint(html);
  }
}
