import React, { useEffect, useState, useRef } from "react";
import * as XLSX from "xlsx";
import api from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "../components/ui/dialog";
import { Plus, Trash2, Sparkles, Pencil, FileSpreadsheet, Download, Upload, AlertCircle, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../context/LanguageContext";
import ConfirmDialog from "../components/ConfirmDialog";
import { safeArray } from "../lib/safeArray";
import { offlineStorage } from "../lib/offlineStorage";
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

export default function MenuPage() {
  const [categories, setCategories] = useState([]);
  const [menu, setMenu] = useState([]);
  const [editing, setEditing] = useState(null); // editing item or null
  const [catName, setCatName] = useState("");
  const [confirmDialog, setConfirmDialog] = useState({ open: false, action: null, title: "", message: "" });
  const { t } = useLanguage();

  // Excel Import States
  const fileInputRef = useRef(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importRows, setImportRows] = useState([]);
  const [skipDuplicates, setSkipDuplicates] = useState(false);
  const [menuDestination, setMenuDestination] = useState("dining");
  const [isImporting, setIsImporting] = useState(false);

  const refresh = async () => {
    try {
      const [c, m] = await Promise.all([api.get("/categories"), api.get("/menu")]);
      const catList = safeArray(c.data);
      const menuList = safeArray(m.data);
      setCategories(catList);
      setMenu(menuList);
      try {
        offlineStorage.saveCategories(catList);
        offlineStorage.saveMenu(menuList);
      } catch (_) {}
    } catch (e) {
      console.error("MenuPage load failed:", e);
    }
  };
  useEffect(() => { refresh(); }, []);

  const addCategory = async () => {
    if (!catName.trim()) return;
    await api.post("/categories", { name: catName });
    setCatName(""); refresh();
  };

  // --- Excel Import Handlers ---
  const handleFileSelected = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input value so same file can be re-selected if user wants
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const buffer = evt.target?.result;
        const wb = XLSX.read(buffer, { type: "array" });
        const firstSheetName = wb.SheetNames[0];
        if (!firstSheetName) {
          toast.error("The selected Excel workbook has no sheets.");
          return;
        }
        const ws = wb.Sheets[firstSheetName];
        const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });

        if (!rawRows || rawRows.length === 0) {
          toast.error("The selected Excel file contains no data rows.");
          return;
        }

        const seenNamesInFile = new Set();
        const parsed = rawRows.map((row, idx) => {
          const rowNum = idx + 2; // Excel row index considering row 1 is header
          const errors = [];

          // Helper to find column key case-insensitively
          const getVal = (regex) => {
            const key = Object.keys(row).find((k) => regex.test(k.trim()));
            return key ? String(row[key]).trim() : "";
          };

          const name = getVal(/^(item\s*name|name|item|dish|product)$/i);
          const category = getVal(/^(category|cat|category\s*name|group)$/i);
          const priceRaw = getVal(/^(price|rate|amount|cost|mrp)$/i);
          const description = getVal(/^(description|desc|details|extras)$/i);
          const taxRaw = getVal(/^(tax\/gst|tax|gst|tax\s*rate|gst\s*rate|tax\s*%|gst\s*%)$/i);
          const availRaw = getVal(/^(available\/status|available|status|is\s*available|active)$/i);

          // Required validations
          if (!name) {
            errors.push("Missing Item Name");
          }
          if (!category) {
            errors.push("Missing Category");
          }

          const priceNum = Number(priceRaw);
          if (priceRaw === "" || isNaN(priceNum) || priceNum < 0) {
            errors.push("Valid Price required");
          }

          let taxNum = 0;
          if (taxRaw !== "") {
            const parsedTax = Number(String(taxRaw).replace("%", "").trim());
            if (!isNaN(parsedTax) && parsedTax >= 0) {
              taxNum = parsedTax;
            }
          }

          let available = true;
          if (availRaw !== "") {
            const lowerAvail = availRaw.toLowerCase();
            if (["no", "false", "0", "n", "inactive", "unavailable"].includes(lowerAvail)) {
              available = false;
            }
          }

          // Duplicate detection against current menu and previous rows in this file
          const lowerName = name.toLowerCase();
          const isDuplicateInDb = Boolean(name && menu.some(
            (m) => m.name && m.name.trim().toLowerCase() === lowerName
          ));
          const isDuplicateInFile = Boolean(name && seenNamesInFile.has(lowerName));
          if (name) {
            seenNamesInFile.add(lowerName);
          }

          const isDuplicate = isDuplicateInDb || isDuplicateInFile;
          const status = errors.length > 0 ? "error" : (isDuplicate ? "duplicate" : "valid");

          return {
            rowNumber: rowNum,
            name,
            category,
            price: isNaN(priceNum) ? priceRaw : priceNum,
            description,
            taxRate: taxNum,
            available,
            isDuplicate,
            isDuplicateInDb,
            isDuplicateInFile,
            errors,
            status,
          };
        });

        setImportRows(parsed);
        setImportFile(file);
        setImportModalOpen(true);
      } catch (err) {
        console.error("Error reading Excel file:", err);
        toast.error("Failed to parse Excel file: " + (err.message || "Invalid format"));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const downloadTemplate = () => {
    try {
      const templateData = [
        {
          "Item Name": "Paneer Tikka",
          "Category": "Starter",
          "Price": 220,
          "Description": "Grilled paneer with spices",
          "Tax/GST": 5,
          "Available": "Yes",
        },
        {
          "Item Name": "Butter Naan",
          "Category": "Bread",
          "Price": 60,
          "Description": "Tandoori butter naan",
          "Tax/GST": 5,
          "Available": "Yes",
        },
        {
          "Item Name": "Dal Makhani",
          "Category": "Main Course",
          "Price": 180,
          "Description": "Creamy black lentils",
          "Tax/GST": 5,
          "Available": "Yes",
        },
        {
          "Item Name": "Gujarati Thali",
          "Category": "Thali",
          "Price": 250,
          "Description": "Special authentic Gujarati meal",
          "Tax/GST": 5,
          "Available": "Yes",
        },
      ];

      const ws = XLSX.utils.json_to_sheet(templateData);
      ws["!cols"] = [
        { wch: 22 },
        { wch: 16 },
        { wch: 10 },
        { wch: 32 },
        { wch: 10 },
        { wch: 12 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Menu Template");
      XLSX.writeFile(wb, "Menu_Import_Template.xlsx");
      toast.success("Excel template downloaded successfully");
    } catch (err) {
      console.error("Template download error:", err);
      toast.error("Failed to generate Excel template");
    }
  };

  const handleExecuteImport = async () => {
    // Filter out rows with errors
    const validRows = importRows.filter((r) => r.status !== "error");
    const rowsToImport = skipDuplicates
      ? validRows.filter((r) => !r.isDuplicate)
      : validRows;

    if (rowsToImport.length === 0) {
      toast.error("No valid items to import.");
      return;
    }

    setIsImporting(true);
    try {
      const itemsPayload = rowsToImport.map((r) => ({
        name: r.name,
        category: r.category,
        price: Number(r.price),
        description: r.description || "",
        tax_rate: Number(r.taxRate || 0),
        available: Boolean(r.available),
      }));

      let resData = null;
      try {
        const { data } = await api.post("/menu/bulk-import", {
          items: itemsPayload,
          skip_duplicates: skipDuplicates,
          menu_destination: menuDestination,
        });
        resData = data;
      } catch (backendErr) {
        console.warn("Backend bulk-import endpoint error, using fallback creation:", backendErr);
        // Fallback: create categories and items one by one
        const currentCats = [...categories];
        for (const r of itemsPayload) {
          let cat = currentCats.find((c) => c.name.toLowerCase() === r.category.toLowerCase());
          if (!cat) {
            const { data: newCat } = await api.post("/categories", { name: r.category });
            currentCats.push(newCat);
            cat = newCat;
          }
          const isThali = r.category.toLowerCase().includes("thali") || r.name.toLowerCase().includes("thali");
          await api.post("/menu", {
            name: r.name,
            category_id: cat.id,
            price: r.price,
            available: r.available,
            is_thali: isThali,
            thali_extras: r.description,
            menuType: menuDestination,
            menu_type: menuDestination,
            gst_enabled: r.tax_rate > 0,
            item_gst_rate: r.tax_rate,
          });
        }
      }

      // Refresh categories and menu so imported items appear immediately in UI
      await refresh();

      const importedCount = resData?.total_processed || rowsToImport.length;
      toast.success(`${importedCount} items imported successfully.`);
      setImportModalOpen(false);
      setImportRows([]);
      setImportFile(null);
      setMenuDestination("dining");
    } catch (err) {
      console.error("Import execution failed:", err);
      toast.error("Failed to import menu items: " + (err.response?.data?.detail || err.message));
    } finally {
      setIsImporting(false);
    }
  };

  const startNew = () => {
    setEditing({
      id: null,
      name: "",
      category_id: categories[0]?.id || "",
      price: 0,
      available: true,
      is_thali: false,
      thali_groups: [],
      thali_extras: "",
      portion_weight_kg: 0,
      menuType: "both",
      gst_enabled: false,
      item_gst_rate: 5,
    });
  };

  const startEdit = (item) => {
    const groups = (item.thali_groups || []).map((g, i) => ({
      ...g,
      _key: g._key || `${g.category_id || 'k'}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    }));
    const catObj = categories.find(c => c.id === item.category_id);
    const isThali = item.is_thali || (catObj?.name?.toLowerCase() === "thali");
    const mType = item.menuType || item.menu_type || (isThali ? "both" : "parcel");
    setEditing({
      ...item,
      thali_groups: groups,
      menuType: mType,
      gst_enabled: item.gst_enabled ?? false,
      item_gst_rate: item.item_gst_rate ?? 5,
    });
  };

  const save = async () => {
    if (!editing.name || !editing.category_id) return toast.error(t("save_item_error"));
    const mType = editing.menuType || (editing.is_thali ? "both" : "parcel");
    const cleanName = editing.name.trim();
    const payload = {
      name: cleanName,
      category_id: editing.category_id,
      price: Number(editing.price),
      available: editing.available,
      is_thali: editing.is_thali,
      thali_groups: editing.is_thali
        ? editing.thali_groups
            .filter((g) => g.category_id)
            .map((g) => {
              const catObj = categories.find((c) => c.id === g.category_id);
              const catName = catObj ? catObj.name : "";
              return {
                category_id: g.category_id,
                count: Number(g.count) || 1,
                label: (g.label && g.label.trim()) || catName || g.category_id,
              };
            })
        : [],
      thali_extras: editing.thali_extras || "",
      portion_weight_kg: Number(editing.portion_weight_kg) || 0,
      menuType: mType,
      menu_type: mType,
      gst_enabled: editing.gst_enabled ?? false,
      item_gst_rate: editing.gst_enabled ? (Number(editing.item_gst_rate) || 0) : 0,
    };

    // Duplicate Prevention: check if item with same name already exists
    const existing = menu.find(
      (m) => m.name && m.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    const targetId = editing.id || (existing ? existing.id : null);

    try {
      if (targetId) {
        await api.put(`/menu/${targetId}`, payload);
      } else {
        await api.post("/menu", payload);
      }
      toast.success(t("settings_saved_success"));
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("checkout_failed"));
    }
  };

  const remove = async (m) => {
    setConfirmDialog({
      open: true,
      title: "Delete Menu Item",
      message: `Are you sure you want to delete "${m.name}"? This action cannot be undone.`,
      action: async () => {
        await api.delete(`/menu/${m.id}`);
        refresh();
        toast.success("Menu item deleted successfully");
      }
    });
  };
  const toggle = async (m) => { await api.patch(`/menu/${m.id}/toggle`); refresh(); };

  const removeCat = async (c) => {
    setConfirmDialog({
      open: true,
      title: "Delete Category",
      message: `Are you sure you want to delete "${c.name}"? This action cannot be undone.`,
      action: async () => {
        await api.delete(`/categories/${c.id}`);
        refresh();
        toast.success("Category deleted successfully");
      }
    });
  };

  return (
    <div className="h-full bg-[#FFFDF9] rounded-[20px] md:rounded-[28px] lg:rounded-[32px] border border-[#F4E6D7] shadow-lg p-4 sm:p-5 md:p-6 lg:p-8 flex flex-col overflow-hidden">
      <div className="relative z-20 flex-shrink-0 mb-2 flex items-end justify-between">
        <div>
          <div className="text-[15px] uppercase tracking-[0.1em] font-bold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">{t("menu_database")}</div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900">{t("nav_menu")}</h1>
        </div>
        <div className="flex items-center gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx, .xls"
            className="hidden"
            onChange={handleFileSelected}
            data-testid="excel-file-input"
          />
          <Button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            variant="outline"
            className="border-[#F4E6D7] bg-white hover:bg-[#FFF8F2] text-slate-700 hover:text-[#FF6B00] font-bold rounded-xl shadow-xs transition-all flex items-center gap-2 cursor-pointer h-10 px-3.5 text-xs sm:text-sm"
            data-testid="import-excel-btn"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            <span>Import Excel</span>
          </Button>

          <Button
            onClick={startNew}
            className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:brightness-105 text-white font-bold rounded-xl shadow-xs transition-all flex items-center cursor-pointer h-10 px-4 text-xs sm:text-sm"
            data-testid="add-item-btn"
          >
            <Plus className="w-3 h-4 mr-2" /> {t("add_item")}
          </Button>
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {/* Professional Categories Section */}
        <Card className="mb-6 rounded-[26px] border-[#F4E6D7] bg-white shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-[17px] font-extrabold uppercase tracking-wider text-terracota">{t("categories")}</h2>
              {/* <p className="text-[15px] text-muted-foreground mt-1">Organize your menu items into categories</p> */}
            </div>
            <div className="text-s text-muted-foreground">
              {categories.length} {categories.length === 1 ? 'category' : 'categories'}
            </div>
          </div>

          {/* Categories Grid */}
          {categories.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-1 mb-1">
              {safeArray(categories).map(c => (
                <div
                  key={c.id}
                  className="group relative flex items-center justify-between px-3 py-3 rounded-2xl bg-gradient-to-br from-[#FFF8F2] to-white border border-[#F4E6D7] hover:border-[#FF8A3D] hover:shadow-sm transition-all"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-2 h-2 rounded-full bg-terracota flex-shrink-0"></div>
                    <span className="text-sm font-semibold text-foreground truncate">{t(c.name)}</span>
                  </div>
                  <button
                    onClick={() => removeCat(c)}
                    data-testid={`del-cat-${c.id}`}
                    className="opacity-0 group-hover:opacity-100 ml-2 p-1.5 rounded-md text-muted-foreground hover:text-white hover:bg-destructive transition-all flex-shrink-0"
                    title="Delete category"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 mb-1 border-2 border-dashed border-border rounded-lg">
              <div className="text-muted-foreground text-sm">No categories yet. Add your first category below.</div>
            </div>
          )}

          {/* Add Category Input */}
          <div className="flex
          gap-2
          pt-2">
            <Input
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && addCategory()}
              placeholder={t("category_name_placeholder") || "e.g., Sabji, Dal, Rice"}
              className="flex-1 rounded-xl border-[#F4E6D7] bg-[#FFFDF9]"
              data-testid="cat-name"
            />
            <Button
              onClick={addCategory}
              disabled={!catName.trim()}
              className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-terracota-hover text-white px-6"
              data-testid="add-cat-btn"
            >
              <Plus className="w-4 h-4 mr-2" /> Add
            </Button>
          </div>
        </Card>

        <Card className="rounded-[26px] border-[#F4E6D7] bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 rounded-t-[26px] overflow-hidden bg-gradient-to-r
            from-[#FF8A3D]
            to-[#FF6B00]
            text-[11px]
            text-white
            uppercase
            tracking-[0.18em]
            text-slate-500">
              <tr>
                <th className="text-left px-4 py-3 rounded-tl-[26px]">{t("item")}</th>
                <th className="text-left px-4 py-3">{t("category_name")}</th>
                <th className="text-right px-4 py-3">{t("price")}</th>
                <th className="text-center px-4 py-3">{t("available")}</th>
                <th className="text-right px-4 py-3 rounded-tr-[26px]"></th>
              </tr>
            </thead>
            <tbody data-testid="menu-table">
              {safeArray(menu).map(m => (
                <tr key={m.id} className="border-t border-border hover:bg-[#FFF8F2]">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      {m.is_thali && <span className="text-[11px] uppercase tracking-[0.18em] font-bold bg-[#FFF1E5] text-[#FF6B00] border border-[#FFD8B5] px-1.5 py-0.5 rounded">{t("thali")}</span>}
                      {t(m.name)}
                    </div>
                    {m.is_thali && m.thali_groups?.length > 0 && (
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {m.thali_groups.map(g => `${g.count} ${t(g.label)}`).join(' + ')}
                        {m.thali_extras ? ` + ${translateExtras(m.thali_extras, t)}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t(categories.find(c => c.id === m.category_id)?.name) || "—"}</td>
                  <td className="px-4 py-3 text-right font-mono">₹{m.price}</td>
                  <td className="px-4 py-3 text-center">
                    <Switch checked={m.available} onCheckedChange={() => toggle(m)} data-testid={`toggle-${m.id}`} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => startEdit(m)} data-testid={`edit-${m.id}`} className="text-foreground hover:bg-sand-subtle p-1.5 rounded-md mr-1"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => remove(m)} data-testid={`del-${m.id}`} className="text-destructive hover:bg-destructive/10 p-1.5 rounded-md"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
              {menu.length === 0 && <tr><td colSpan="5" className="text-center text-muted-foreground py-8">{t("no_items_yet")}</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>

      {editing && (
        <Dialog open={true} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="font-display text-2xl">{editing.id ? t("edit_item") : t("new_item")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto py-2">
              <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground">{t("name")}</label>
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="edit-name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">{t("category_name")}</label>
                  <select value={editing.category_id} onChange={(e) => setEditing({ ...editing, category_id: e.target.value })}
                    className="w-full bg-white border border-border rounded-md px-3 py-2 text-sm mt-1" data-testid="edit-cat">
                    {safeArray(categories).map(c => {
                      const name = t(c.name);
                      const displayName = (name === "Snakes" || name === "snakes" || c.name === "Snakes" || c.name === "snakes") ? "Snacks" : name;
                      return <option key={c.id} value={c.id}>{displayName}</option>;
                    })}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">{t("price")} (₹)</label>
                  <Input type="number" value={editing.price} onChange={(e) => {
                    const val = Number(e.target.value);
                    if (val < 0) {
                      toast.error(t("discount_cannot_be_negative")); // reuse negative alert or custom
                      setEditing({ ...editing, price: 0 });
                    } else {
                      setEditing({ ...editing, price: e.target.value });
                    }
                  }} data-testid="edit-price" />
                </div>
                {/* GST Configuration Section */}
                <div className="col-span-2 border border-[#F4E6D7] bg-[#FFFDF9] rounded-xl p-3 space-y-3">
                  <label className="text-xs uppercase tracking-wider font-bold text-slate-700 block">GST</label>

                  {/* Without GST / With GST segmented control */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing({ ...editing, gst_enabled: false })}
                      className={`flex-1 py-1.5 px-3 rounded-lg text-sm font-semibold border transition-all ${
                        !editing.gst_enabled
                          ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white border-[#FF6B00] shadow-sm"
                          : "bg-white text-slate-600 border-[#E2D5C3] hover:border-[#FF8A3D]"
                      }`}
                    >
                      Without GST
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing({ ...editing, gst_enabled: true, item_gst_rate: editing.item_gst_rate || 5 })}
                      className={`flex-1 py-1.5 px-3 rounded-lg text-sm font-semibold border transition-all ${
                        editing.gst_enabled
                          ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white border-[#FF6B00] shadow-sm"
                          : "bg-white text-slate-600 border-[#E2D5C3] hover:border-[#FF8A3D]"
                      }`}
                    >
                      With GST
                    </button>
                  </div>

                  {/* GST % picker — shown only if With GST selected */}
                  {editing.gst_enabled && (
                    <div className="space-y-2">
                      <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">How much GST do you want?</label>
                      <div className="flex flex-wrap gap-2 items-center">
                        {[0, 5, 12, 18, 28].map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => setEditing({ ...editing, item_gst_rate: pct })}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                              Number(editing.item_gst_rate) === pct
                                ? "bg-[#FF6B00] text-white border-[#FF6B00] shadow-sm"
                                : "bg-white text-slate-600 border-[#E2D5C3] hover:border-[#FF8A3D]"
                            }`}
                          >
                            {pct}%
                          </button>
                        ))}
                        {/* Custom input */}
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.5"
                            placeholder="Custom"
                            value={[0, 5, 12, 18, 28].includes(Number(editing.item_gst_rate)) ? "" : editing.item_gst_rate}
                            onChange={(e) => setEditing({ ...editing, item_gst_rate: parseFloat(e.target.value) || 0 })}
                            className="w-20 border border-[#E2D5C3] rounded-full px-2 py-1 text-xs text-center focus:outline-none focus:border-[#FF6B00] bg-white"
                          />
                          <span className="text-xs text-slate-500">%</span>
                        </div>
                      </div>

                      {/* Live price breakdown */}
                      {(() => {
                        const base = safeNumber(editing.price);
                        const rate = safeNumber(editing.item_gst_rate);
                        const gstAmt = Math.round(base * rate) / 100;
                        const final = base + gstAmt;
                        return (
                          <div className="flex items-center gap-2 text-[11px] text-slate-600 bg-[#FFF4EB] border border-[#FFD8B5] rounded-lg px-3 py-2 font-mono flex-wrap">
                            <span>Price ₹{safeFixed(base)}</span>
                            <span className="text-[#FF6B00] font-bold">+</span>
                            <span>GST {rate}% (₹{safeFixed(gstAmt)})</span>
                            <span className="text-[#FF6B00] font-bold">=</span>
                            <span className="font-bold text-slate-800">Final ₹{safeFixed(final)}</span>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

                <div className="col-span-2">
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">Inventory Deduction / Portion Weight (kg)</label>
                  <Input type="number" step="0.001" placeholder="0.250" value={editing.portion_weight_kg || ""} onChange={(e) => {
                    const val = Number(e.target.value);
                    setEditing({ ...editing, portion_weight_kg: val < 0 ? 0 : val });
                  }} />
                  <p className="text-[10px] text-muted-foreground mt-1">If set to 0, selling this item won't automatically deduct bulk inventory stock.</p>
                </div>
              </div>
              <div className="border-t border-border pt-3 space-y-1 bg-[#FFF8F2] border border-[#F4E6D7] p-3 rounded-xl">
                <label className="text-xs uppercase tracking-wider font-bold text-slate-700 block">
                  Where do you want to add this item?
                </label>
                <div className="flex items-center gap-5 pt-1" data-testid="menu-type-selection">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800 cursor-pointer">
                    <input
                      type="radio"
                      name="menuType"
                      value="dining"
                      checked={editing.menuType === "dining"}
                      onChange={(e) => setEditing({ ...editing, menuType: e.target.value })}
                      className="w-4 h-4 accent-[#FF6B00]"
                      data-testid="menu-type-dining"
                    />
                    Dining Menu
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800 cursor-pointer">
                    <input
                      type="radio"
                      name="menuType"
                      value="parcel"
                      checked={editing.menuType === "parcel"}
                      onChange={(e) => setEditing({ ...editing, menuType: e.target.value })}
                      className="w-4 h-4 accent-[#FF6B00]"
                      data-testid="menu-type-parcel"
                    />
                    Parcel Menu
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800 cursor-pointer">
                    <input
                      type="radio"
                      name="menuType"
                      value="both"
                      checked={editing.menuType === "both"}
                      onChange={(e) => setEditing({ ...editing, menuType: e.target.value })}
                      className="w-4 h-4 accent-[#FF6B00]"
                      data-testid="menu-type-both"
                    />
                    Both
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={editing.is_thali} onCheckedChange={(v) => setEditing({ ...editing, is_thali: v })} data-testid="edit-thali" />
                  <Sparkles className="w-4 h-4 text-terracota" /> {t("this_is_thali")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={editing.available} onCheckedChange={(v) => setEditing({ ...editing, available: v })} data-testid="edit-avail" />
                  {t("available")}
                </label>
              </div>

              {editing.is_thali && (
                <div className="bg-sand-subtle border border-border rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{t("thali_rules")}</div>
                    <Button size="sm" variant="outline" className="border-border h-7 text-xs"
                      onClick={() => setEditing({
                        ...editing,
                        thali_groups: [
                          ...(editing.thali_groups || []),
                          { category_id: "", label: "", count: 1, _key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
                        ],
                      })}
                      data-testid="add-thali-group">
                      <Plus className="w-3 h-3 mr-1" /> {t("add_rule")}
                    </Button>
                  </div>
                  {(editing.thali_groups || []).map((g, idx) => (
                    <div key={g._key || idx} className="grid grid-cols-12 gap-2 items-center" data-testid={`thali-group-row-${idx}`}>
                      <select value={g.category_id} onChange={(e) => {
                        const cat = categories.find(c => c.id === e.target.value);
                        const next = [...editing.thali_groups];
                        next[idx] = { ...next[idx], category_id: e.target.value, label: g.label || (cat?.name || "") };
                        setEditing({ ...editing, thali_groups: next });
                      }} className="col-span-5 bg-white border border-border rounded-md px-2 py-1.5 text-sm">
                        <option value="">{t("pick_category_placeholder")}</option>
                        {safeArray(categories).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <Input className="col-span-4 h-8" placeholder={t("rule_label_placeholder")} value={g.label}
                        onChange={(e) => {
                          const next = [...editing.thali_groups];
                          next[idx] = { ...next[idx], label: e.target.value };
                          setEditing({ ...editing, thali_groups: next });
                        }} />
                      <Input type="number" min="1" className="col-span-2 h-8 text-center" value={g.count}
                        onChange={(e) => {
                          const next = [...editing.thali_groups];
                          next[idx] = { ...next[idx], count: Math.max(1, Number(e.target.value) || 1) };
                          setEditing({ ...editing, thali_groups: next });
                        }} />
                      <button onClick={() => {
                        const next = editing.thali_groups.filter((_, i) => i !== idx);
                        setEditing({ ...editing, thali_groups: next });
                      }} className="col-span-1 text-destructive hover:bg-[#FFF4EB] p-1.5 rounded-md justify-self-center"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                  {(editing.thali_groups || []).length === 0 && (
                    <div className="text-xs text-muted-foreground">No rules yet. E.g. <i>Pick 2 from Sabji, 1 from Dal</i>.</div>
                  )}
                  <div>
                    <label className="text-xs uppercase tracking-wider text-muted-foreground">{t("fixed_inclusions_label")}</label>
                    <Input value={editing.thali_extras} onChange={(e) => setEditing({ ...editing, thali_extras: e.target.value })}
                      placeholder={t("fixed_inclusions_placeholder")} data-testid="thali-extras" />
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)} className="border-border">{t("cancel")}</Button>
              <Button onClick={save} className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:bg-[#FFF4EB] text-white" data-testid="save-item-btn">{t("save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Excel Import Preview Modal */}
      <Dialog open={importModalOpen} onOpenChange={(open) => {
        if (!isImporting) {
          setImportModalOpen(open);
          if (!open) {
            setImportRows([]);
            setImportFile(null);
            setMenuDestination("dining");
          }
        }
      }}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-6 rounded-2xl bg-white border border-[#F4E6D7] shadow-xl overflow-hidden">
          <DialogHeader className="flex flex-row items-center justify-between pb-3 border-b border-[#F4E6D7]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#FFF1E5] text-[#FF6B00] border border-[#FFD8B5] flex items-center justify-center">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <DialogTitle className="font-display text-xl font-bold text-slate-800">
                  Import Menu from Excel
                </DialogTitle>
                <p className="text-xs text-slate-500 mt-0.5">
                  File: <span className="font-semibold text-slate-700">{importFile?.name || "Spreadsheet"}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={downloadTemplate}
                className="text-xs font-semibold text-slate-600 border-[#F4E6D7] hover:bg-[#FFF8F2] hover:text-[#FF6B00] flex items-center gap-1.5 h-8 rounded-lg cursor-pointer"
                data-testid="download-template-btn"
              >
                <Download className="w-3.5 h-3.5 text-[#FF6B00]" />
                <span>Download Excel Template</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 flex items-center gap-1 h-8 rounded-lg cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Change File</span>
              </Button>
            </div>
          </DialogHeader>

          {/* Stats Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-3">
            <div className="bg-[#FFFDF9] border border-[#F4E6D7] rounded-xl p-2.5">
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total Rows</div>
              <div className="text-xl font-extrabold text-slate-800 mt-0.5">{importRows.length}</div>
            </div>
            <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-2.5">
              <div className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Valid Items</span>
              </div>
              <div className="text-xl font-extrabold text-emerald-700 mt-0.5">
                {importRows.filter(r => r.status === "valid").length}
              </div>
            </div>
            <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-2.5">
              <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wider flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span>Existing / Duplicates</span>
              </div>
              <div className="text-xl font-extrabold text-amber-700 mt-0.5">
                {importRows.filter(r => r.status === "duplicate").length}
              </div>
            </div>
            <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-2.5">
              <div className="text-[11px] font-bold text-rose-700 uppercase tracking-wider flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                <span>Invalid Rows</span>
              </div>
              <div className="text-xl font-extrabold text-rose-700 mt-0.5">
                {importRows.filter(r => r.status === "error").length}
              </div>
            </div>
          </div>

          {/* Options / Notice */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
                className="w-4 h-4 rounded text-[#FF6B00] border-slate-300 focus:ring-[#FF6B00] accent-[#FF6B00]"
              />
              <span className="text-slate-700 font-medium">
                Skip existing / duplicate items (don't overwrite)
              </span>
            </label>
            <div className="text-slate-500 italic">
              * Categories not in your database will be auto-created. Invalid rows are skipped automatically.
            </div>
          </div>

          {/* Menu Destination Selector */}
          <div className="bg-[#FFFDF9] border border-[#F4E6D7] rounded-xl p-3 space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Where should these items be added?
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* Dining Menu Option */}
              <label
                onClick={() => setMenuDestination("dining")}
                className={`relative flex items-start gap-2.5 p-2.5 rounded-xl border transition-all cursor-pointer select-none ${
                  menuDestination === "dining"
                    ? "bg-[#FFF8F2] border-[#FF6B00] ring-1 ring-[#FF6B00]/40 shadow-xs"
                    : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/70"
                }`}
                data-testid="dest-dining"
              >
                <input
                  type="radio"
                  name="menuDestination"
                  value="dining"
                  checked={menuDestination === "dining"}
                  onChange={() => setMenuDestination("dining")}
                  className="w-4 h-4 mt-0.5 text-[#FF6B00] accent-[#FF6B00] focus:ring-[#FF6B00] cursor-pointer"
                />
                <div className="flex-1">
                  <div className={`text-xs font-bold ${menuDestination === "dining" ? "text-[#FF6B00]" : "text-slate-800"}`}>
                    Dining Menu
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                    Add all imported items only to the Dining Menu.
                  </div>
                </div>
              </label>

              {/* Parcel Menu Option */}
              <label
                onClick={() => setMenuDestination("parcel")}
                className={`relative flex items-start gap-2.5 p-2.5 rounded-xl border transition-all cursor-pointer select-none ${
                  menuDestination === "parcel"
                    ? "bg-[#FFF8F2] border-[#FF6B00] ring-1 ring-[#FF6B00]/40 shadow-xs"
                    : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/70"
                }`}
                data-testid="dest-parcel"
              >
                <input
                  type="radio"
                  name="menuDestination"
                  value="parcel"
                  checked={menuDestination === "parcel"}
                  onChange={() => setMenuDestination("parcel")}
                  className="w-4 h-4 mt-0.5 text-[#FF6B00] accent-[#FF6B00] focus:ring-[#FF6B00] cursor-pointer"
                />
                <div className="flex-1">
                  <div className={`text-xs font-bold ${menuDestination === "parcel" ? "text-[#FF6B00]" : "text-slate-800"}`}>
                    Parcel Menu
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                    Add all imported items only to the Parcel Menu.
                  </div>
                </div>
              </label>

              {/* Both Menus Option */}
              <label
                onClick={() => setMenuDestination("both")}
                className={`relative flex items-start gap-2.5 p-2.5 rounded-xl border transition-all cursor-pointer select-none ${
                  menuDestination === "both"
                    ? "bg-[#FFF8F2] border-[#FF6B00] ring-1 ring-[#FF6B00]/40 shadow-xs"
                    : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/70"
                }`}
                data-testid="dest-both"
              >
                <input
                  type="radio"
                  name="menuDestination"
                  value="both"
                  checked={menuDestination === "both"}
                  onChange={() => setMenuDestination("both")}
                  className="w-4 h-4 mt-0.5 text-[#FF6B00] accent-[#FF6B00] focus:ring-[#FF6B00] cursor-pointer"
                />
                <div className="flex-1">
                  <div className={`text-xs font-bold ${menuDestination === "both" ? "text-[#FF6B00]" : "text-slate-800"}`}>
                    Both Menus
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                    Add all imported items to both the Dining Menu and Parcel Menu.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Preview Table */}
          <div className="flex-1 min-h-0 overflow-y-auto border border-[#F4E6D7] rounded-xl my-2">
            <table className="w-full text-xs text-left">
              <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600 font-bold uppercase tracking-wider text-[10px] border-b border-[#F4E6D7]">
                <tr>
                  <th className="px-3 py-2 w-12 text-center">Row</th>
                  <th className="px-3 py-2 w-28">Status</th>
                  <th className="px-3 py-2">Item Name</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-center">Tax %</th>
                  <th className="px-3 py-2 text-center">Available</th>
                  <th className="px-3 py-2">Issues / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {importRows.map((row) => {
                  const isExistingCat = categories.some(
                    c => c.name.toLowerCase() === (row.category || "").toLowerCase()
                  );
                  return (
                    <tr
                      key={row.rowNumber}
                      className={
                        row.status === "error"
                          ? "bg-rose-50/50 hover:bg-rose-50"
                          : row.status === "duplicate"
                          ? "bg-amber-50/40 hover:bg-amber-50/70"
                          : "hover:bg-slate-50"
                      }
                    >
                      <td className="px-3 py-2 text-center font-mono font-bold text-slate-500">
                        #{row.rowNumber}
                      </td>
                      <td className="px-3 py-2">
                        {row.status === "error" ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
                            <AlertCircle className="w-3 h-3" /> Error
                          </span>
                        ) : row.status === "duplicate" ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                            <AlertTriangle className="w-3 h-3" /> Duplicate
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" /> Ready
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-800">
                        {row.name || <span className="italic text-rose-500 font-normal">Missing name</span>}
                        {row.description && (
                          <div className="text-[11px] text-slate-400 truncate max-w-xs">{row.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {row.category ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span>{row.category}</span>
                            {!isExistingCat && (
                              <span className="text-[9px] font-bold uppercase tracking-wider bg-orange-100 text-[#FF6B00] border border-orange-200 px-1 py-0.2 rounded">
                                New Cat
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="italic text-rose-500 font-normal">Missing category</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-slate-800">
                        {typeof row.price === "number" ? `₹${row.price}` : <span className="text-rose-500">{row.price || "—"}</span>}
                      </td>
                      <td className="px-3 py-2 text-center text-slate-600 font-mono">
                        {row.taxRate ? `${row.taxRate}%` : "0%"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${row.available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                          {row.available ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.errors?.length > 0 ? (
                          <span className="text-rose-600 font-medium">{row.errors.join(", ")}</span>
                        ) : row.status === "duplicate" ? (
                          <span className="text-amber-700">
                            {row.isDuplicateInDb ? "Item exists in menu" : "Duplicate name in Excel file"}
                          </span>
                        ) : (
                          <span className="text-emerald-600">Valid</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <DialogFooter className="flex items-center justify-between pt-3 border-t border-[#F4E6D7] mt-2">
            <div className="text-xs text-slate-500 space-y-0.5">
              {(() => {
                const validRows = importRows.filter(r => r.status !== "error");
                const count = skipDuplicates ? validRows.filter(r => !r.isDuplicate).length : validRows.length;
                const destText =
                  menuDestination === "both"
                    ? "Dining Menu + Parcel Menu"
                    : menuDestination === "parcel"
                    ? "Parcel Menu"
                    : "Dining Menu";
                return (
                  <>
                    <div>
                      Ready to import: <strong className="text-slate-800">{count}</strong> valid items
                    </div>
                    <div>
                      Destination: <strong className="text-[#FF6B00] font-semibold">{destText}</strong>
                    </div>
                  </>
                );
              })()}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setImportModalOpen(false)}
                disabled={isImporting}
                className="border-border text-slate-600 cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleExecuteImport}
                disabled={
                  isImporting ||
                  importRows.filter(r => r.status !== "error" && (!skipDuplicates || !r.isDuplicate)).length === 0
                }
                className="bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:brightness-105 text-white font-bold cursor-pointer min-w-[200px]"
                data-testid="confirm-import-btn"
              >
                {isImporting ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    {menuDestination === "both"
                      ? "Import to Both Menus"
                      : menuDestination === "parcel"
                      ? "Import to Parcel Menu"
                      : "Import to Dining Menu"}
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Confirmation Dialog */}
      <ConfirmDialog
        open={confirmDialog.open}
        onClose={() => setConfirmDialog({ ...confirmDialog, open: false })}
        onConfirm={confirmDialog.action}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
