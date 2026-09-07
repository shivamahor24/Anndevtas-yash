import React, { useMemo, useState, useEffect } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { Receipt, CalendarDays, BookOpen, ListOrdered, LayoutDashboard, FileBarChart, Settings as SettingsIcon, LogOut, Package, Briefcase, Users, Menu, X, WifiOff, RefreshCw, CheckCircle2, CloudOff, ChevronLeft, ChevronRight } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import PasswordChangeDialog from "./PasswordChangeDialog";
import api from "../lib/api";
import { useSyncManager } from "../lib/offlineManager";
import AIChatWidget from "./AIChatWidget";
const NAV_ITEMS = [
  { to: "/", key: "nav_billing", label: "Billing", icon: Receipt, hero: true, end: true, testid: "nav-billing" },
  { to: "/orders", key: "nav_orders", label: "Orders", icon: ListOrdered, testid: "nav-orders" },
  { to: "/daily-menu", key: "nav_daily_menu", label: "Daily Menu", icon: CalendarDays, roles: ["admin"], testid: "nav-daily-menu" },
  { to: "/menu", key: "nav_menu", label: "Menu", icon: BookOpen, roles: ["admin"], testid: "nav-menu" },
  { to: "/dashboard", key: "nav_dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin"], testid: "nav-dashboard" },
  { to: "/reports", key: "nav_reports", label: "Reports", icon: FileBarChart, roles: ["admin"], testid: "nav-reports" },
  { to: "/staff", key: "nav_staff", label: "System Users", icon: Users, roles: ["admin"], testid: "nav-staff" },
  { to: "/settings", key: "nav_settings", label: "Settings", icon: SettingsIcon, roles: ["admin"], testid: "nav-settings" },
  { to: "/inventory", key: "nav_inventory", label: "Inventory", icon: Package, roles: ["admin"], testid: "nav-inventory" },
  { to: "/payroll", key: "nav_payroll", label: "Payroll & HR", icon: Briefcase, roles: ["admin"], testid: "nav-payroll" },
];

function navClasses({ isActive, hero }) {
  const base = "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150";
  if (isActive && hero) return `${base} bg-terracota text-white shadow-sm`;
  if (isActive) return `${base} bg-foreground text-white`;
  if (hero) return `${base} bg-terracota/5 text-terracota hover:bg-terracota/10`;
  return `${base} text-foreground hover:bg-sand-subtle`;
}

export default function Layout() {
  const { user, logout, isOffline } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [settings, setSettings] = useState(null);
  const [alertCount, setAlertCount] = useState(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { isOnline, syncStatus, pendingCount, triggerSync } = useSyncManager();

  const toggleSidebar = () => {
    setIsCollapsed((prev) => !prev);
  };

  const handleLogout = async () => { await logout(); navigate("/login"); };

  // Close mobile drawer on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  const visibleNav = useMemo(
    () => NAV_ITEMS.filter((n) => !n.roles || n.roles.includes(user?.role)),
    [user?.role]
  );

  // Fetch settings for app name and tagline
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const { offlineStorage } = await import("../lib/offlineStorage");
        const cached = offlineStorage.loadSettings() || {};
        const { data } = await api.get("/settings");
        console.log("Settings loaded:", data);
        const merged = {
          ...cached,
          ...(data || {}),
          fssai: (data && data.fssai !== undefined && data.fssai !== null)
            ? data.fssai
            : (cached.fssai || ""),
        };
        setSettings(merged);
        offlineStorage.saveSettings(merged);
      } catch (e) {
        console.error("Failed to load settings:", e);
        try {
          const { offlineStorage } = await import("../lib/offlineStorage");
          const cached = offlineStorage.loadSettings();
          if (cached) setSettings(cached);
        } catch (_) {}
      }
    };

    const fetchAlerts = async () => {
      if (user?.role === "admin") {
        try {
          const { data } = await api.get("/inventory/alerts/count");
          setAlertCount(data.count);
        } catch (e) { console.error("Failed to fetch alerts:", e); }
      }
    };

    fetchSettings();
    fetchAlerts();

    // Listen for settings updates
    const handleSettingsUpdate = () => {
      console.log("Settings update event received, refetching...");
      fetchSettings();
    };

    window.addEventListener('settingsUpdated', handleSettingsUpdate);

    return () => {
      window.removeEventListener('settingsUpdated', handleSettingsUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  const handlePasswordChangeClose = (success) => {
    if (success) {
      setShowPasswordChange(false);
    }
    // If not success and it's first login, keep dialog open
  };

  return (
    <div className="min-h-screen w-full bg-[#f5f7fb] main-wrapper overflow-hidden">
      {/* Mobile Top Header */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-border sticky top-0 z-30 shadow-sm h-14 top-navbar">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="p-1.5 rounded-md hover:bg-sand-subtle text-foreground transition-all"
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="font-display font-extrabold text-xl tracking-tight">
            {(settings?.app_name !== undefined && settings?.app_name !== null) ? settings.app_name : "Anndevta"}
          </div>
        </div>
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-terracota to-amber-600 flex items-center justify-center text-white font-bold text-sm shadow">
          {user?.name?.charAt(0).toUpperCase()}
        </div>
      </header>

      {/* Mobile Menu Drawer Backdrop */}
      {isMobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-40 backdrop-blur-sm transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar - Fixed/Drawer on mobile, Standard on desktop */}
      <aside
      className={`
      fixed left-0 top-0 h-screen
      w-[210px]
      p-2 sm:p-2.5 md:pr-1
      sidebar
      ${isCollapsed ? "collapsed" : ""}
      `}
>
        {/* Header with Customizable terracotaing */}
        <div className="relative h-full bg-[#FFFDF9] rounded-[24px] border border-[#F4E6D7] shadow-lg overflow-hidden flex flex-col">
          <button
            className="toggle-btn group"
            onClick={() => setIsCollapsed(!isCollapsed)}
            aria-label="Toggle navigation"
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-[#FF6B00] transition-transform duration-200 group-hover:translate-x-0.5" />
            ) : (
              <ChevronLeft className="w-4 h-4 text-slate-600 group-hover:text-[#FF6B00] transition-transform duration-200 group-hover:-translate-x-0.5" />
            )}
          </button>
          <div className="absolute inset-0 overflow-hidden pointer-events-none">      </div>

          {/* Logo */}
          <div className="relative px-4 pt-5 pb-3">
            <div className="flex justify-center">
              <img
                src={`${process.env.PUBLIC_URL}/sidebar_logo.png`}
                alt="AnnDevta Logo"
                className="w-full max-w-[140px] object-contain"
              />
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto px-3 py-1.5 space-y-1">
            <div className="space-y-1.5">
              {Array.isArray(visibleNav) &&
                visibleNav.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    data-testid={n.testid}
                    className={({ isActive }) =>
                      `flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-bold transition-all ${isActive
                        ? "bg-gradient-to-r from-[#FF8A3D] to-[#FF6B00] text-white shadow-sm"
                        : "text-slate-700 hover:bg-[#FFF3E7]"
                      }`
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <n.icon className="w-4.5 h-4.5 shrink-0" />
                      <span>{t(n.key)}</span>
                    </div>

                    {n.key === "nav_inventory" && alertCount > 0 && (
                      <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        {alertCount}
                      </span>
                    )}
                  </NavLink>
                ))}
            </div>
          </nav>

          {/* Bottom */}
          <div className="pt-2">

            <div className="p-2.5 bg-transparent space-y-1.5">
              <div className="user-profile-card mb-1 rounded-xl bg-white border border-[#F4E6D7] shadow-2xs px-2 py-1.5 flex items-center gap-2">
                <div className="user-profile-card-avatar w-7 h-7 rounded-full bg-gradient-to-br from-[#FF8A3D] to-[#FF6B00] flex items-center justify-center text-white font-extrabold text-xs shadow-xs shrink-0">
                  {user?.name?.charAt(0).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="user-profile-card-name text-xs font-bold text-slate-800 truncate leading-tight">
                    {user?.name}
                  </div>

                  <div className="user-profile-card-role text-[10px] text-slate-500 font-medium truncate leading-tight mt-0.5">
                    {user?.role === "admin" ? "Administrator" : "Cashier"}
                  </div>
                </div>
              </div>

              <button
                onClick={handleLogout}
                className="sign-out-btn w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border border-[#F4E6D7] text-xs font-semibold text-slate-700 shadow-2xs hover:bg-[#FFF8F2] transition-all"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{t("sign_out")}</span>
              </button>
            </div>

            <div className="career-craftly-footer p-2 m-2.5 mt-0 rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 border-t border-blue-200">
              <div className="flex flex-col items-center text-center">
                <img
                  src={`${process.env.PUBLIC_URL}/tranferentlogo.png`}
                  alt="Career Craftly"
                  className="h-4 shrink-0 object-contain"
                />
                <div className="text-center mt-1 career-craftly-text max-w-full overflow-hidden">
                  <div className="font-bold text-blue-900 text-[11px] leading-tight career-craftly-title">Career Craftly</div>
                  <div className="text-blue-700 text-[9.5px] leading-tight mt-0.5 career-craftly-subtitle">Digital Solutions</div>
                </div>
              </div>
            </div>

          </div>

        </div>
      </aside>


      {/* Main Content - Offset by sidebar width on desktop */}
      <main className="md:ml-[210px] h-screen min-w-0 p-2 sm:p-3 md:pl-1 overflow-hidden transition-all duration-300">
        {/* Sync / Offline Status Bar */}
        {(!isOnline || pendingCount > 0 || syncStatus === "syncing" || syncStatus === "synced" || syncStatus === "error") && (
          <div className={`w-full px-4 py-2 flex items-center justify-between text-xs font-semibold z-20 ${!isOnline
            ? "bg-red-500 text-white"
            : syncStatus === "syncing"
              ? "bg-yellow-400 text-amber-900"
              : syncStatus === "synced"
                ? "bg-green-500 text-white"
                : syncStatus === "error"
                  ? "bg-red-500 text-white"
                  : "bg-amber-100 text-amber-800"
            }`}>
            <div className="flex items-center gap-2">
              {!isOnline ? (
                <><WifiOff className="w-3.5 h-3.5" /> OFFLINE MODE{pendingCount > 0 ? ` · ${pendingCount} order${pendingCount > 1 ? "s" : ""} queued` : ""}</>
              ) : syncStatus === "syncing" ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Syncing {pendingCount} order{pendingCount > 1 ? "s" : ""}…</>
              ) : syncStatus === "synced" ? (
                <><CheckCircle2 className="w-3.5 h-3.5" /> All orders synced!</>
              ) : syncStatus === "error" ? (
                <><CloudOff className="w-3.5 h-3.5" /> Sync failed — will retry</>
              ) : (
                <><CloudOff className="w-3.5 h-3.5" /> {pendingCount} order{pendingCount > 1 ? "s" : ""} pending sync</>
              )}
            </div>
            {isOnline && pendingCount > 0 && syncStatus === "idle" && (
              <button onClick={triggerSync} className="underline underline-offset-2 hover:no-underline">
                Sync now
              </button>
            )}
          </div>
        )}
        <div className="h-[calc(100vh-20px)] sm:h-[calc(100vh-24px)] min-w-0 overflow-x-hidden overflow-y-auto bg-transparent">
          <Outlet />
        </div>

      </main>

      <PasswordChangeDialog
        open={showPasswordChange}
        onClose={handlePasswordChangeClose}
        isFirstLogin={true}
      />
      <AIChatWidget />
    </div>
  );
}
