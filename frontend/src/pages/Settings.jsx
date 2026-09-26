import React, { useEffect, useState } from "react";
import api from "../lib/api";
import { offlineStorage } from "../lib/offlineStorage";
import { safeNumber, safeFixed } from "../lib/utils";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Save, Store, Receipt, Sliders, Eye, Database, Download, Upload, AlertTriangle, Info, Printer, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import ReceiptPreview from "../components/ReceiptPreview";
import { useLanguage } from "../context/LanguageContext";

export default function Settings() {
  const { t, changeLanguage } = useLanguage();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [printers, setPrinters] = useState([]);
  const [defaultPrinterName, setDefaultPrinterName] = useState(null);
  const [refreshingPrinters, setRefreshingPrinters] = useState(false);
  const [testPrinting, setTestPrinting] = useState(false);

  const loadPrinters = async (showToast = false) => {
    if (!window.electronAPI || !window.electronAPI.printer) return;
    setRefreshingPrinters(true);
    try {
      const list = await window.electronAPI.printer.getPrinters();
      const printerArray = Array.isArray(list) ? list : (list?.printers || []);
      setPrinters(printerArray);
      const defaultP = printerArray.find(p => p.isDefault);
      setDefaultPrinterName(defaultP ? defaultP.name : null);
      if (showToast) {
        toast.success(`Printers refreshed. Found ${printerArray.length} printer(s).`);
      }
    } catch (err) {
      console.error('Failed to load printers:', err);
      if (showToast) {
        toast.error('Failed to detect printers.');
      }
    } finally {
      setRefreshingPrinters(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    const initSettings = async () => {
      // 1. First retrieve local machine printer preference
      let localPrinter = localStorage.getItem("pos_default_printer");
      if (window.electronAPI && window.electronAPI.getAuthData) {
        try {
          const sessionPrinter = await window.electronAPI.getAuthData("pos_default_printer");
          if (sessionPrinter) {
            localPrinter = sessionPrinter;
          }
        } catch (_) {}
      }

      // 2. Fetch server settings
      try {
        const offlineSettings = offlineStorage.loadSettings() || {};
        const r = await api.get("/settings");
        if (mounted && r.data) {
          const serverPrinter = r.data.default_printer;
          // Prefer explicitly configured printer
          const chosenPrinter = (serverPrinter && serverPrinter !== "system_default")
            ? serverPrinter
            : (localPrinter || serverPrinter || "system_default");

          const loadedData = {
            ...offlineSettings,
            ...r.data,
            fssai: (r.data.fssai !== undefined && r.data.fssai !== null)
              ? r.data.fssai
              : (offlineSettings.fssai || ""),
            default_printer: chosenPrinter,
          };
          setS(loadedData);
          offlineStorage.saveSettings(loadedData);

          if (chosenPrinter) {
            localStorage.setItem("pos_default_printer", chosenPrinter);
            if (window.electronAPI && window.electronAPI.setAuthData) {
              window.electronAPI.setAuthData("pos_default_printer", chosenPrinter);
            }
          }

          if (r.data.language && !localStorage.getItem("pos_language")) {
            changeLanguage(r.data.language);
          }
        }
      } catch (err) {
        console.error("Failed to load settings from server:", err);
        // Fallback to offline storage
        const offlineSettings = offlineStorage.loadSettings();
        if (mounted && offlineSettings) {
          setS({
            ...offlineSettings,
            default_printer: localPrinter || offlineSettings.default_printer || "system_default",
          });
        }
      }
    };

    initSettings();

    // Load last backup timestamp from localStorage
    const lastBackupTime = localStorage.getItem("lastBackupTime");
    if (lastBackupTime && mounted) {
      setLastBackup(new Date(lastBackupTime));
    }
    // Load printers if in Electron
    if (window.electronAPI && window.electronAPI.printer && mounted) {
      loadPrinters();
    }
    return () => { mounted = false; };
  }, [changeLanguage]);

  const save = async () => {
    if (!s) return;
    setBusy(true);
    try {
      let selectedPrinter = s.default_printer || localStorage.getItem("pos_default_printer") || "system_default";
      if (!selectedPrinter || selectedPrinter.trim() === "") {
        selectedPrinter = "system_default";
      }

      const cgstVal = Number(s.cgst_rate) ?? 2.5;
      const sgstVal = Number(s.sgst_rate) ?? 2.5;
      const payload = {
        name: s.name || "Thali House",
        address: s.address || "",
        gstin: s.gstin || "",
        fssai: s.fssai || "",
        phone: s.phone || "",
        cgst_rate: cgstVal,
        sgst_rate: sgstVal,
        gst_rate: cgstVal + sgstVal,
        footer_msg: s.footer_msg || "",
        show_gst: s.show_gst !== undefined ? !!s.show_gst : true,
        show_payment: s.show_payment !== undefined ? !!s.show_payment : true,
        show_thali_selections: !!s.show_thali_selections,
        paper_width: Number(s.paper_width) || 80,
        font_size: s.font_size || "medium",
        header_alignment: s.header_alignment || "center",
        header_template: s.header_template || "classic",
        auto_print: s.auto_print !== undefined ? !!s.auto_print : true,
        receipt_prefix: s.receipt_prefix ?? "",
        receipt_padding: Number(s.receipt_padding) || 6,
        tax_label: s.tax_label ?? "CGST & SGST",
        language: s.language ?? "en",
        app_name: s.app_name ?? "Anndevta",
        app_tagline: s.app_tagline ?? "THALI BILLING COUNTER",
        default_printer: selectedPrinter,
      };

      // Always save locally on this machine immediately
      offlineStorage.saveSettings(payload);
      localStorage.setItem("pos_default_printer", selectedPrinter);
      if (window.electronAPI && window.electronAPI.setAuthData) {
        try {
          await window.electronAPI.setAuthData("pos_default_printer", selectedPrinter);
        } catch (_) {}
      }

      let responseData = null;
      try {
        const { data } = await api.put("/settings", payload);
        responseData = data;
        console.log("Settings saved to server:", data);
      } catch (apiErr) {
        console.warn("Backend /settings PUT error or offline:", apiErr);
        responseData = payload;
      }

      const mergedData = {
        ...payload,
        ...(responseData || {}),
        fssai: (responseData && responseData.fssai !== undefined && responseData.fssai !== null && responseData.fssai !== "")
          ? responseData.fssai
          : (payload.fssai || ""),
        default_printer: selectedPrinter,
      };
      setS(mergedData);
      offlineStorage.saveSettings(mergedData);

      if (mergedData?.language) {
        changeLanguage(mergedData.language);
      }

      // Notify other components (like Layout, Billing) that settings were updated
      window.dispatchEvent(new Event('settingsUpdated'));

      toast.success(t("settings_saved_success"));
    } catch (e) {
      console.error("Save settings error:", e);
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };



  const createBackup = async () => {
    setBackupBusy(true);
    try {
      const { data } = await api.post("/backup/create");

      // Create timestamped filename
      const now = new Date();
      const timestamp = now.toISOString().replace(/:/g, '-').split('.')[0];
      const filename = `AnndevtaPOS_Backup_${timestamp}.json`;

      // Create download link
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      // Save backup timestamp
      localStorage.setItem("lastBackupTime", now.toISOString());
      setLastBackup(now);

      toast.success(`${t("backup_created")}: ${filename}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Backup failed");
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async () => {
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Confirm before restore
      if (!window.confirm(t("confirm_restore"))) {
        return;
      }

      setRestoreBusy(true);
      try {
        const text = await file.text();
        const backupData = JSON.parse(text);

        // Validate backup structure
        if (!backupData.collections || !backupData.timestamp) {
          throw new Error(t("invalid_backup_format"));
        }

        await api.post("/backup/restore", backupData);

        toast.success(t("backup_restored"));

        // Reload page after 2 seconds
        setTimeout(() => {
          window.location.reload();
        }, 2000);

      } catch (e) {
        toast.error(e?.response?.data?.detail || e.message || "Restore failed");
        setRestoreBusy(false);
      }
    };

    input.click();
  };

  const handleTestPrint = async () => {
    if (!window.electronAPI || !window.electronAPI.printer) {
      toast.error("Printer API not available. Please run in Electron app.");
      return;
    }

    setTestPrinting(true);
    try {
      const printerName = s.default_printer || localStorage.getItem("pos_default_printer") || "system_default";
      const paperWidth = Number(s.paper_width) || 80;
      const res = await window.electronAPI.printer.testPrint(printerName, paperWidth);

      if (res && res.success === false) {
        toast.error(res.error || "Test print failed. Check printer connection.");
      } else if (res && (res.success === true || typeof res === 'boolean')) {
        const targetDesc = res.printerName || printerName;
        toast.success(`Test print sent to '${targetDesc}'!`);
      } else {
        toast.error("Test print failed. Check printer connection.");
      }
    } catch (error) {
      toast.error("Test print error: " + (error?.message || error));
    } finally {
      setTestPrinting(false);
    }
  };


  const getBackupStatus = () => {
    if (!lastBackup) return { text: "No Backup Found", color: "text-destructive", showWarning: true };

    const daysSince = Math.floor((Date.now() - lastBackup.getTime()) / (1000 * 60 * 60 * 24));

    if (daysSince >= 30) {
      return { text: "Backup Overdue", color: "text-destructive", showWarning: true };
    } else if (daysSince >= 7) {
      return { text: "Backup Recommended", color: "text-amber-600", showWarning: true };
    } else {
      return { text: lastBackup.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), color: "text-forest", showWarning: false };
    }
  };

  if (!s) return <div className="p-10 text-muted-foreground">Loading…</div>;

  // Mock order for Settings Preview
  const mockOrder = {
    receipt_no: 17,
    created_at: new Date("2026-06-22T01:20:00").toISOString(),
    cashier_name: "Owner",
    items: [
      {
        menu_item_id: "mock-1",
        name: "Regular Thali",
        price: 150,
        qty: 1,
        is_thali: true,
        thali_selections: {
          "Sabji": ["Paneer Masala", "Mix Veg"],
          "Dal": ["Dal Tadka"]
        }
      },
      {
        menu_item_id: "mock-2",
        name: "Buttermilk",
        price: 30,
        qty: 2,
        is_thali: false
      }
    ],
    subtotal: 210,
    cgst: (210 * Number(s.cgst_rate ?? (s.gst_rate ? s.gst_rate / 2 : 2.5))) / 100,
    sgst: (210 * Number(s.sgst_rate ?? (s.gst_rate ? s.gst_rate / 2 : 2.5))) / 100,
    tax: (210 * (Number(s.cgst_rate ?? 2.5) + Number(s.sgst_rate ?? 2.5))) / 100,
    discount: 0,
    total: 210 + (s.show_gst !== false ? (210 * (Number(s.cgst_rate ?? 2.5) + Number(s.sgst_rate ?? 2.5))) / 100 : 0),
    payment_mode: "card"
  };

  return (
    <div className="h-full
    bg-[#FFFDF9]
    rounded-[20px] md:rounded-[28px] lg:rounded-[32px]
    border
    border-[#F4E6D7]
    shadow-lg
    px-4 sm:px-6 lg:px-8
    pt-4 sm:pt-6 lg:pt-8
    pb-4 lg:pb-6
    flex
    flex-col
    overflow-hidden
  ">
      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-3 sm:px-5 py-4">
          {/* Page Header */}
          <div className="mb-4 flex items-center justify-between flex-wrap gap-4 border-b border-[#F4E6D7] pb-4">
            <div>
              <div className="text-[13px] uppercase tracking-[0.12em] font-extrabold bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] bg-clip-text text-transparent">
                Configuration
              </div>
              <div className="flex items-center gap-2.5 mt-0.5">
                <Store className="w-6 h-6 text-[#FF7A2F] shrink-0" />
                <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">
                  Restaurant & Receipt Settings
                </h1>
              </div>
            </div>
            <Button onClick={save} disabled={busy} className="rounded-xl h-10 px-5 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] hover:opacity-95 text-white shadow-md text-xs font-bold active:scale-95 touch-manipulation" data-testid="save-settings-btn">
              <Save className="w-4 h-4 mr-1.5" /> {busy ? "Saving..." : "Save Settings"}
            </Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Left Side: Form Controls */}
            <div className="lg:col-span-7 xl:col-span-7 space-y-4">

              {/* Section 1: Restaurant Profile */}
              <Card className="p-4 sm:p-5 border-[#F4E6D7] shadow-none space-y-3.5 bg-white rounded-2xl">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-[#FF6B00] flex items-center gap-2">
                  <Store className="w-4 h-4" /> {t("restaurant_profile")}
                </h2>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("restaurant_name")}</label>
                  <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} className="mt-1 h-9 text-xs sm:text-sm" data-testid="set-name" />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("address")}</label>
                  <Input value={s.address} onChange={(e) => setS({ ...s, address: e.target.value })} className="mt-1 h-9 text-xs sm:text-sm" data-testid="set-address" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("gstin")}</label>
                    <Input value={s.gstin} onChange={(e) => setS({ ...s, gstin: e.target.value })} className="mt-1 h-9 text-xs sm:text-sm font-mono" placeholder="29ABCDE1234F1Z5" data-testid="set-gstin" />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("phone")}</label>
                    <Input value={s.phone} onChange={(e) => setS({ ...s, phone: e.target.value })} className="mt-1 h-9 text-xs sm:text-sm" data-testid="set-phone" />
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("language_select")}</label>
                  <select
                    value={s.language || "en"}
                    onChange={(e) => {
                      const val = e.target.value;
                      setS({ ...s, language: val });
                      changeLanguage(val);
                    }}
                    className="w-full bg-white border border-[#F4E6D7] rounded-xl px-3 h-9.5 text-xs sm:text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-[#FF6B00]"
                    data-testid="set-language"
                  >
                    <option value="en">English</option>
                    <option value="gu">ગુજરાતી</option>
                    <option value="bilingual">ગુજરાતી + English</option>
                  </select>
                </div>

                {/* Sidebar Branding */}
                <div className="pt-3 border-t border-slate-100">
                  <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-600 mb-2">Sidebar Branding</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">App Name</label>
                      <Input
                        value={s.app_name ?? "Anndevta"}
                        onChange={(e) => setS({ ...s, app_name: e.target.value })}
                        className="mt-1 h-9 text-xs"
                        placeholder="Anndevta"
                        data-testid="set-app-name"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tagline</label>
                      <Input
                        value={s.app_tagline ?? "THALI BILLING COUNTER"}
                        onChange={(e) => setS({ ...s, app_tagline: e.target.value })}
                        className="mt-1 h-9 text-xs"
                        placeholder="THALI BILLING COUNTER"
                        data-testid="set-app-tagline"
                      />
                    </div>
                  </div>
                </div>
              </Card>

              {/* Section 2: Receipt Formatting */}
              <Card className="p-4 sm:p-5 border-[#F4E6D7] shadow-none space-y-3.5 bg-white rounded-2xl">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-[#FF6B00] flex items-center gap-2">
                  <Sliders className="w-4 h-4" /> {t("receipt_format_styles")}
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("header_alignment")}</label>
                    <select
                      value={s.header_alignment}
                      onChange={(e) => setS({ ...s, header_alignment: e.target.value })}
                      className="w-full bg-white border border-[#F4E6D7] rounded-xl px-3 h-9.5 text-xs sm:text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-[#FF6B00]"
                    >
                      <option value="center">Center Header</option>
                      <option value="left">Left Header</option>
                      <option value="right">Right Header</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("header_template")}</label>
                    <select
                      value={s.header_template}
                      onChange={(e) => setS({ ...s, header_template: e.target.value })}
                      className="w-full bg-white border border-[#F4E6D7] rounded-xl px-3 h-9.5 text-xs sm:text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-[#FF6B00]"
                    >
                      <option value="classic">Classic (Name, Address, Phone, GSTIN, FSSAI)</option>
                      <option value="compact">Compact (Name, Phone)</option>
                      <option value="modern">Modern (Styled Logo, Name, Address)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="min-w-0">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("paper_width")}</label>
                    <select
                      value={s.paper_width}
                      onChange={(e) => setS({ ...s, paper_width: Number(e.target.value) })}
                      className="w-full bg-white border border-[#F4E6D7] rounded-xl px-3 h-9.5 text-xs sm:text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-[#FF6B00]"
                    >
                      <option value="80">80mm (3-inch)</option>
                      <option value="58">58mm (2-inch)</option>
                    </select>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1 truncate">
                        <Printer className="w-3 h-3 shrink-0" />
                        Default Printer
                      </label>
                      {window.electronAPI && (
                        <button
                          type="button"
                          onClick={() => loadPrinters(true)}
                          disabled={refreshingPrinters}
                          className="text-[10px] text-[#FF6B00] hover:text-[#e05e00] flex items-center gap-0.5 font-semibold focus:outline-none shrink-0"
                          title="Refresh available printers"
                        >
                          <RefreshCw className={`w-2.5 h-2.5 ${refreshingPrinters ? "animate-spin" : ""}`} />
                          Refresh
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1.5 mt-1 items-center">
                      <select
                        value={s.default_printer || "system_default"}
                        onChange={(e) => {
                          const val = e.target.value;
                          setS({ ...s, default_printer: val });
                          localStorage.setItem("pos_default_printer", val);
                          if (window.electronAPI && window.electronAPI.setAuthData) {
                            window.electronAPI.setAuthData("pos_default_printer", val);
                          }
                        }}
                        className="flex-1 min-w-0 w-0 bg-white border border-[#F4E6D7] rounded-xl px-3 h-9.5 text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-[#FF6B00] truncate"
                      >
                        <option value="system_default">
                          System Default {defaultPrinterName ? `— ${defaultPrinterName}` : ""}
                        </option>
                        {printers.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.name} {p.isDefault ? "(Windows Default)" : ""}
                          </option>
                        ))}
                        {s.default_printer && s.default_printer !== "system_default" && !printers.some(p => p.name === s.default_printer) && (
                          <option key={s.default_printer} value={s.default_printer}>
                            {s.default_printer} (Saved)
                          </option>
                        )}
                      </select>
                    </div>
                    {!window.electronAPI && (
                      <div className="text-[10px] text-amber-600 mt-0.5">Desktop app required for direct thermal printing.</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("font_size")}</label>
                    <select
                      value={s.font_size}
                      onChange={(e) => setS({ ...s, font_size: e.target.value })}
                      className="w-full bg-white border border-[#F4E6D7] rounded-xl px-3 h-9.5 text-xs sm:text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-[#FF6B00]"
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </div>
                </div>

                {/* Tax & GST Settings Section */}
                <div className="pt-3 border-t border-slate-100 space-y-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("tax_label")}</label>
                    <Input value={s.tax_label ?? "CGST & SGST"} onChange={(e) => setS({ ...s, tax_label: e.target.value })} className="mt-1 h-9 text-xs sm:text-sm" placeholder="CGST & SGST" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("default_cgst") ?? "Default CGST %"}</label>
                      <Input type="number" step="any" value={s.cgst_rate ?? (s.gst_rate !== undefined ? s.gst_rate / 2 : 2.5)} onChange={(e) => {
                        const val = Number(e.target.value);
                        if (val < 0) {
                          toast.error(t("cgst_rate_negative_error") ?? "CGST rate cannot be negative");
                          setS({ ...s, cgst_rate: 0 });
                        } else if (val > 100) {
                          toast.error(t("cgst_rate_max_error") ?? "CGST rate cannot exceed 100%");
                          setS({ ...s, cgst_rate: 100 });
                        } else {
                          setS({ ...s, cgst_rate: e.target.value });
                        }
                      }} className="mt-1 h-9 text-xs sm:text-sm font-mono" data-testid="set-cgst-rate" />
                    </div>
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("default_sgst") ?? "Default SGST %"}</label>
                      <Input type="number" step="any" value={s.sgst_rate ?? (s.gst_rate !== undefined ? s.gst_rate / 2 : 2.5)} onChange={(e) => {
                        const val = Number(e.target.value);
                        if (val < 0) {
                          toast.error(t("sgst_rate_negative_error") ?? "SGST rate cannot be negative");
                          setS({ ...s, sgst_rate: 0 });
                        } else if (val > 100) {
                          toast.error(t("sgst_rate_max_error") ?? "SGST rate cannot exceed 100%");
                          setS({ ...s, sgst_rate: 100 });
                        } else {
                          setS({ ...s, sgst_rate: e.target.value });
                        }
                      }} className="mt-1 h-9 text-xs sm:text-sm font-mono" data-testid="set-sgst-rate" />
                    </div>
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("total_gst") ?? "Total GST"}</label>
                      <div className="mt-1 h-9 px-3 bg-slate-50 border border-[#F4E6D7] rounded-xl text-xs font-extrabold flex items-center justify-between text-slate-900 select-none">
                        <span className="text-sm font-mono text-[#FF6B00]">{safeFixed(safeNumber(s?.cgst_rate, 2.5) + safeNumber(s?.sgst_rate, 2.5), 1)}%</span>
                        <span className="text-[10px] text-slate-500 font-normal">({s?.cgst_rate ?? 2.5}% + {s?.sgst_rate ?? 2.5}%)</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500 leading-normal break-words pt-0.5">
                    {t("gst_helper_text") ?? "CGST and SGST are applied separately and combined to calculate the total GST."}
                  </div>
                </div>

                <div className="pt-2">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("fssai_number") ?? "FSSAI NUMBER"}</label>
                  <Input
                    value={s.fssai || ""}
                    onChange={(e) => setS({ ...s, fssai: e.target.value })}
                    className="mt-1 h-9 text-xs sm:text-sm font-mono"
                    placeholder="12345678901234"
                    data-testid="set-fssai"
                  />
                </div>

                <div className="pt-2">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("footer_message")}</label>
                  <Input value={s.footer_msg} onChange={(e) => setS({ ...s, footer_msg: e.target.value })} className="mt-1 h-9 text-xs sm:text-sm" data-testid="set-footer" />
                </div>
              </Card>

              {/* Section 3: Receipt Number Format */}
              <Card className="p-4 sm:p-5 border-[#F4E6D7] shadow-none space-y-3.5 bg-white rounded-2xl">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-[#FF6B00] flex items-center gap-2">
                  <Receipt className="w-4 h-4" /> {t("receipt_numbering")}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("receipt_prefix")}</label>
                    <Input value={s.receipt_prefix} onChange={(e) => setS({ ...s, receipt_prefix: e.target.value })} className="mt-1 h-9 text-xs font-mono" placeholder="ANP-" />
                    <div className="text-[10px] text-slate-500 mt-1">Example: Prefix 'ANP-' results in 'ANP-000001'.</div>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t("receipt_padding")}</label>
                    <Input type="number" value={s.receipt_padding} onChange={(e) => setS({ ...s, receipt_padding: e.target.value })} className="mt-1 h-9 text-xs font-mono" placeholder="6" />
                    <div className="text-[10px] text-slate-500 mt-1">Number of digits for numeric component.</div>
                  </div>
                </div>
              </Card>

              {/* Section 4: Toggles & Features */}
              <Card className="p-4 sm:p-5 border-[#F4E6D7] shadow-none space-y-3.5 bg-white rounded-2xl">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-[#FF6B00] flex items-center gap-2">
                  <Receipt className="w-4 h-4" /> {t("template_features_rules")}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none border border-[#F4E6D7] rounded-xl p-2.5 hover:bg-[#FFF3E7]/40 transition-all">
                    <input
                      type="checkbox"
                      checked={s.show_gst}
                      onChange={(e) => setS({ ...s, show_gst: e.target.checked })}
                      className="w-4 h-4 rounded text-[#FF6B00] border-[#F4E6D7] focus:ring-[#FF6B00]"
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">{t("show_tax_breakdown")}</div>
                      <div className="text-[9.5px] text-slate-500">Print subtotal & tax row details.</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer select-none border border-[#F4E6D7] rounded-xl p-2.5 hover:bg-[#FFF3E7]/40 transition-all">
                    <input
                      type="checkbox"
                      checked={s.show_payment}
                      onChange={(e) => setS({ ...s, show_payment: e.target.checked })}
                      className="w-4 h-4 rounded text-[#FF6B00] border-[#F4E6D7] focus:ring-[#FF6B00]"
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">{t("show_payment_method")}</div>
                      <div className="text-[9.5px] text-slate-500">Display if billed via cash/upi/card.</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer select-none border border-[#F4E6D7] rounded-xl p-2.5 hover:bg-[#FFF3E7]/40 transition-all">
                    <input
                      type="checkbox"
                      checked={s.show_thali_selections}
                      onChange={(e) => setS({ ...s, show_thali_selections: e.target.checked })}
                      className="w-4 h-4 rounded text-[#FF6B00] border-[#F4E6D7] focus:ring-[#FF6B00]"
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">{t("show_thali_selections")}</div>
                      <div className="text-[9.5px] text-slate-500">Print detailed thali selections.</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer select-none border border-[#F4E6D7] rounded-xl p-2.5 hover:bg-[#FFF3E7]/40 transition-all sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={s.auto_print}
                      onChange={(e) => setS({ ...s, auto_print: e.target.checked })}
                      className="w-4 h-4 rounded text-[#FF6B00] border-[#F4E6D7] focus:ring-[#FF6B00]"
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">{t("auto_print_receipt")}</div>
                      <div className="text-[9.5px] text-slate-500">Print receipts automatically after checkout.</div>
                    </div>
                  </label>

                  <div className="flex items-center justify-center border border-[#F4E6D7] rounded-xl p-2.5">
                    <Button
                      onClick={handleTestPrint}
                      disabled={testPrinting || !window.electronAPI}
                      variant="outline"
                      className="w-full border-[#FF6B00] text-[#FF6B00] hover:bg-[#FF6B00] hover:text-white text-xs font-bold h-9 rounded-lg"
                    >
                      <Printer className="w-3.5 h-3.5 mr-1.5" />
                      {testPrinting ? "Printing..." : "Test Print"}
                    </Button>
                  </div>
                </div>
              </Card>

              {/* Section 5: Data Management */}
              <Card className="p-4 sm:p-5 border-[#F4E6D7] shadow-none space-y-3.5 bg-white rounded-2xl">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-[#FF6B00] flex items-center gap-2">
                  <Database className="w-4 h-4" /> {t("data_management")}
                </h2>

                <div className="bg-orange-50/50 border border-orange-100 rounded-xl p-3">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${getBackupStatus().showWarning ? 'text-amber-600' : 'text-slate-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-extrabold text-slate-800">{t("last_backup")}</div>
                      <div className={`text-xs font-mono font-bold ${getBackupStatus().color} mt-0.5`}>
                        {getBackupStatus().text}
                      </div>
                      {getBackupStatus().showWarning && (
                        <div className="text-[10px] text-slate-500 mt-1">
                          Regular backups protect your business data. Create a backup now.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Button
                    onClick={createBackup}
                    disabled={backupBusy}
                    className="rounded-xl h-10 bg-gradient-to-r from-[#78A61A] to-[#5F9210] hover:brightness-105 text-xs font-bold active:scale-95 touch-manipulation"
                    data-testid="backup-now-btn"
                  >
                    <Download className="w-4 h-4 mr-1.5" />
                    {backupBusy ? "..." : t("backup_now")}
                  </Button>

                  <Button
                    onClick={restoreBackup}
                    disabled={restoreBusy}
                    variant="outline"
                    className="rounded-xl h-10 bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white hover:opacity-95 text-xs font-bold active:scale-95 touch-manipulation"
                    data-testid="restore-backup-btn"
                  >
                    <Upload className="w-4 h-4 mr-1.5" />
                    {restoreBusy ? "..." : t("restore_backup")}
                  </Button>
                </div>

                <div className="text-[10.5px] text-slate-500 space-y-0.5 pt-2 border-t border-slate-100">
                  <p><strong>Backup includes:</strong> Orders, revenue, menu items, daily templates, Thali rules, users, settings.</p>
                  <p><strong>File format:</strong> JSON file with timestamp (e.g., AnndevtaPOS_Backup_2026-06-22.json)</p>
                </div>
              </Card>

              {/* Section 6: About & Branding */}
              <Card className="p-4 sm:p-5 border-[#F4E6D7] shadow-none space-y-3 bg-white rounded-2xl">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-[#FF6B00] flex items-center gap-2">
                  <Info className="w-4 h-4" /> System Information
                </h2>

                <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <img src={`${process.env.PUBLIC_URL}/tranferentlogo.png`} alt="Career Craftly" className="h-12 object-contain" />
                    <div>
                      <div className="text-base font-extrabold text-blue-900 leading-tight">Career Craftly</div>
                      <div className="text-xs text-blue-700 font-medium">Crafting Digital Success, Intelligently</div>
                    </div>
                  </div>

                  <div className="border-t border-blue-200 pt-3 space-y-1.5 text-xs text-blue-900">
                    <div className="flex justify-between">
                      <span className="font-bold">Product:</span>
                      <span>Anndevta POS System</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-bold">Version:</span>
                      <span>1.0.0</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-bold">Developed by:</span>
                      <span>Career Craftly</span>
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            {/* Right Side: Interactive Thermal Preview */}
            <div className="lg:col-span-5 xl:col-span-5 lg:sticky lg:top-4 flex flex-col items-center">
              <div className="w-full flex items-center justify-center gap-2 mb-2 text-xs font-extrabold text-slate-700 uppercase tracking-wider">
                <Eye className="w-4 h-4 text-[#FF6B00]" /> {t("thermal_print_preview")} ({s.paper_width}mm)
              </div>

              <div className="w-full max-w-[320px] flex justify-center bg-slate-100/70 p-3 sm:p-4 rounded-2xl border border-[#F4E6D7] shadow-inner overflow-hidden">
                <ReceiptPreview order={mockOrder} settings={s} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


