import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Save, Trash2, Play, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../context/LanguageContext";
import { safeArray } from "../lib/safeArray";

export default function DailyMenu() {
  const [menu, setMenu] = useState([]);
  const [categories, setCategories] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState("");

  const [openCategories, setOpenCategories] = useState([]);
  const { t } = useLanguage();

  const refresh = async () => {
    try {
      const [m, c, tp] = await Promise.all([
        api.get("/menu"),
        api.get("/categories"),
        api.get("/templates"),
      ]);
      setMenu(safeArray(m.data));
      setCategories(safeArray(c.data));
      setTemplates(safeArray(tp.data));
    } catch (e) {
      console.error("DailyMenu load failed:", e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const safeMenu = safeArray(menu);
  const safeCategories = safeArray(categories);
  const safeTemplates = safeArray(templates);

  // Group items by category and add top-level Dining Menu & Parcel Menu categories
  const categoryGrouped = useMemo(() => {
    const byCat = {};
    for (const c of safeCategories) {
      byCat[c.id] = { ...c, items: [] };
    }
    for (const m of safeMenu) {
      const catId = m.category_id;
      if (byCat[catId]) {
        byCat[catId].items.push(m);
      } else {
        const fallbackCatId = catId || "uncategorized";
        if (!byCat[fallbackCatId]) {
          const catObj = safeCategories.find((c) => c.id === fallbackCatId);
          byCat[fallbackCatId] = {
            id: fallbackCatId,
            name: catObj ? catObj.name : (m.category || "General"),
            items: [],
          };
        }
        byCat[fallbackCatId].items.push(m);
      }
    }

    const regularCategories = Object.values(byCat)
      .filter((cat) => cat.items.length > 0)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    const checkIsThali = (item) => {
      if (item.is_thali) return true;
      const catObj = safeCategories.find((c) => c.id === item.category_id);
      const c = (catObj ? catObj.name : (item.category_name || item.category || "")).toUpperCase();
      return c === "THALI";
    };

    const getEffectiveMenuType = (item) => {
      const type = (item.menuType || item.menu_type || "").toLowerCase();
      if (["dining", "parcel", "both"].includes(type)) {
        return type;
      }
      return checkIsThali(item) ? "dining" : "parcel";
    };

    // Dining Menu items (dining or both)
    const diningItems = safeMenu.filter((m) => {
      const type = getEffectiveMenuType(m);
      return type === "dining" || type === "both";
    });

    // Parcel Menu items (parcel or both)
    const parcelItems = safeMenu.filter((m) => {
      const type = getEffectiveMenuType(m);
      return type === "parcel" || type === "both";
    });

    const menuTypeCategories = [
      {
        id: "dining_menu_cat",
        name: "Dining Menu",
        items: diningItems,
      },
      {
        id: "parcel_menu_cat",
        name: "Parcel Menu",
        items: parcelItems,
      },
    ];

    return [...menuTypeCategories, ...regularCategories];
  }, [safeMenu, safeCategories]);

  const toggle = async (m) => {
    try {
      await api.patch(`/menu/${m.id}/toggle`);
      setMenu((prev) => safeArray(prev).map((x) => x.id === m.id ? { ...x, available: !x.available } : x));
    } catch (e) { toast.error("Toggle failed"); }
  };

  const setAllInCategory = async (catItems, value) => {
    try {
      await Promise.all(safeArray(catItems).filter(i => i.available !== value).map(i => api.patch(`/menu/${i.id}/toggle`)));
      refresh();
    } catch (e) { toast.error("Bulk toggle failed"); }
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) return toast.error(t("save_template_error"));
    try {
      const active = safeMenu.filter(m => m.available).map(m => m.id);
      await api.post("/templates", { name: templateName, item_ids: active });
      toast.success(`${t("template_saved")}: "${templateName}"`);
      setTemplateName("");
      refresh();
    } catch (e) { toast.error("Save template failed"); }
  };

  const activate = async (tpl) => {
    if (!window.confirm(t("confirm_activate_template").replace("{name}", tpl.name))) return;
    try {
      await api.post(`/templates/${tpl.id}/activate`);
      toast.success(`${t("template_activated")}: "${tpl.name}"`);
      refresh();
    } catch (e) { toast.error("Activate template failed"); }
  };

  const removeTemplate = async (tpl) => {
    if (!window.confirm(t("confirm_delete_template").replace("{name}", tpl.name))) return;
    try {
      await api.delete(`/templates/${tpl.id}`);
      refresh();
    } catch (e) { toast.error("Delete template failed"); }
  };

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long" });
  const activeCount = safeMenu.filter(m => m.available).length;

  return (
    <div className="h-full bg-[#FFFDF9] rounded-[20px] md:rounded-[28px] lg:rounded-[32px] border border-[#F4E6D7] shadow-lg p-4 sm:p-5 md:p-6 lg:p-8 flex flex-col overflow-hidden">
      <div className="mb-8">
        <div>
          <div className="text-[15px] uppercase tracking-[0.1em] font-bold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">{today}</div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <CalendarDays className="w-7 h-7 text-[#FF6B00]" /> {t("nav_daily_menu")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("daily_menu_subtext")} <span className="text-foreground font-semibold">{activeCount}</span> {t("active_items")}.
          </p>
        </div>
      </div>

      <Card className="mb-4 rounded-[26px] bg-white border-[#F4E6D7] shadow-sm p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-sm font-semibold">{t("save_as_template_title")}</div>
            <div className="text-xs text-muted-foreground mt-1">{t("save_as_template_sub")}</div>
          </div>
          <div className="flex gap-2">
            <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)}
              placeholder={t("template_name_placeholder")} className="w-64 bg-[#FFFDF9] border-[#F4E6D7] rounded-xl" data-testid="template-name" />
            <Button onClick={saveTemplate} className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:brightness-105 text-white" data-testid="save-template-btn">
              <Save className="w-4 h-4 mr-2" /> {t("save_template_btn")}
            </Button>
          </div>
        </div>

        {safeTemplates.length > 0 && (
          <div className="mt-4 pt-4 border-t border-terracota/20">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-semibold mb-2">{t("templates")}</div>
            <div className="flex flex-wrap gap-2" data-testid="templates-list">
              {safeTemplates.map((tpl) => (
                <div key={tpl.id} className="flex items-center gap-1 bg-white border border-border rounded-md pl-3 pr-1 py-1" data-testid={`template-${tpl.id}`}>
                  <span className="text-sm font-medium">{tpl.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">({safeArray(tpl.item_ids).length})</span>
                  <button onClick={() => activate(tpl)} className="p-1 ml-1 text-forest hover:bg-forest/10 rounded-md" title="Activate" data-testid={`activate-${tpl.id}`}><Play className="w-3.5 h-3.5" /></button>
                  <button onClick={() => removeTemplate(tpl)} className="p-1 text-muted-foreground hover:text-destructive rounded-md" title="Delete" data-testid={`del-template-${tpl.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* List of Categories */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 min-h-0">
        {categoryGrouped.length === 0 ? (
          <Card className="rounded-[24px] border-[#F4E6D7] bg-white p-6 text-center text-sm text-muted-foreground">
            No menu items available.
          </Card>
        ) : (
          categoryGrouped.map((cat) => (
            <Card key={cat.id} className="rounded-[24px] border-[#F4E6D7] bg-white shadow-sm overflow-hidden" data-testid={`cat-section-${cat.id}`}>
              <div
                className="px-6 py-4 border-b border-[#F4E6D7] bg-white flex items-center justify-between cursor-pointer"
                onClick={() => {
                  setOpenCategories((prev) =>
                    prev.includes(cat.id)
                      ? prev.filter((id) => id !== cat.id)
                      : [...prev, cat.id]
                  );
                }}
              >
                <div className="flex items-center gap-2 font-display font-bold text-lg">
                  <span>{openCategories.includes(cat.id) ? "▼" : "▶"}</span>
                  <span>{t(cat.name)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted-foreground font-semibold">{safeArray(cat.items).filter(i => i.available).length}/{safeArray(cat.items).length} {t("active")}</span>
                  <button onClick={(e) => { e.stopPropagation(); setAllInCategory(cat.items, true); }} className="text-[#FF8A3D] font-semibold hover:underline" data-testid={`all-on-${cat.id}`}>{t("all_on")}</button>
                  <button onClick={(e) => { e.stopPropagation(); setAllInCategory(cat.items, false); }} className="text-muted-foreground font-semibold hover:underline" data-testid={`all-off-${cat.id}`}>{t("all_off")}</button>
                </div>
              </div>
              {openCategories.includes(cat.id) && (
                <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {safeArray(cat.items).map(m => (
                    <label key={m.id}
                      className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition-all cursor-pointer ${m.available ? "border-[#FFD8B5] bg-[#FFF7EF]" : "border-[#F4E6D7] bg-white"}`}
                      data-testid={`daily-item-${m.id}`}>
                      <div className="min-w-0">
                        <div className="text-s font-semibold flex items-center gap-1.5 truncate">
                          {t(m.name)}
                        </div>
                        <div className="text-s text-muted-foreground font-semibold">₹{m.price}</div>
                      </div>
                      <Switch checked={m.available} onCheckedChange={() => toggle(m)} data-testid={`daily-toggle-${m.id}`} />
                    </label>
                  ))}
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
