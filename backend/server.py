# pyrefly: ignore [missing-import]
import sys
import calendar
import os
import json as json_module
from dotenv import load_dotenv
from pathlib import Path
from contextlib import asynccontextmanager

# Support running as PyInstaller bundle OR from source
if getattr(sys, 'frozen', False):
    # Running as backend.exe — .env is bundled next to the executable
    ROOT_DIR = Path(sys.executable).parent
else:
    ROOT_DIR = Path(__file__).parent

load_dotenv(ROOT_DIR / '.env')
os.environ.setdefault('MONGO_URL', 'mongodb://localhost:27017')
os.environ.setdefault('MONGO_URI', 'mongodb://localhost:27017')
# google-generativeai (Gemini AI) — bundled via PyInstaller hidden imports
try:
    import google.generativeai as genai
    genai.configure(api_key=os.environ.get('GEMINI_API_KEY', ''))
except ImportError:
    import logging as _log
    _log.warning(
        "[Anndevta POS] google-generativeai not found. "
        "AI features will be disabled. "
        "If running from source: pip install google-generativeai"
    )
    genai = None  # type: ignore

import io
import csv
import uuid
import logging
import bcrypt
import jwt
import aiosqlite
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal, Dict, Any

from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, EmailStr, ConfigDict
from openpyxl import Workbook  # type: ignore


from contextvars import ContextVar

# ------- SQLite -------
DB_PATH = os.environ.get('DB_PATH', str(ROOT_DIR / 'pos_data.db'))
default_db_name = os.environ.get('DB_NAME', 'pos')

# Tenant context — stores the tenant_id string for multi-tenant isolation
tenant_id_ctx: ContextVar[str] = ContextVar("tenant_id_ctx", default="default")


def _tenant() -> str:
    """Get the current tenant_id from context."""
    return tenant_id_ctx.get()


async def get_db() -> aiosqlite.Connection:
    """Get an aiosqlite connection. The connection is reused within the lifespan."""
    return _db_conn


_db_conn: aiosqlite.Connection = None  # type: ignore


JWT_ALGORITHM = "HS256"
JWT_SECRET = os.environ.get('JWT_SECRET', 'thali-pos-super-secret-key-987654321')

# ------- Logging -------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos")

# ------- Helpers -------
def now_utc() -> datetime: return datetime.now(timezone.utc)
def iso(dt: datetime) -> str: return dt.isoformat()
def new_id() -> str: return str(uuid.uuid4())
def hash_password(p: str) -> str: return bcrypt.hashpw(p.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
def verify_password(p: str, h: str) -> bool: return bcrypt.checkpw(p.encode("utf-8"), h.encode("utf-8"))


def create_access_token(user_id: str, email: str, role: str, tenant_id: str) -> str:
    # Set expiration to 100 years (effectively never expires)
    payload = {"sub": user_id, "email": email, "role": role, "tenant_id": tenant_id,
               "exp": now_utc() + timedelta(days=36500), "type": "access"}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(user_id: str, tenant_id: str) -> str:
    # Set expiration to 100 years (effectively never expires)
    payload = {"sub": user_id, "tenant_id": tenant_id,
               "exp": now_utc() + timedelta(days=36500), "type": "refresh",
               "jti": new_id()}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _row_to_dict(cursor_description, row) -> dict:
    """Convert a sqlite3.Row tuple to a dict using cursor description."""
    if row is None:
        return None
    return {cursor_description[i][0]: row[i] for i in range(len(cursor_description))}


async def _fetchone(db: aiosqlite.Connection, sql: str, params=()) -> Optional[dict]:
    """Execute SQL and fetch one row as a dict."""
    cursor = await db.execute(sql, params)
    row = await cursor.fetchone()
    if row is None:
        return None
    return _row_to_dict(cursor.description, row)


async def _fetchall(db: aiosqlite.Connection, sql: str, params=()) -> list:
    """Execute SQL and fetch all rows as list of dicts."""
    cursor = await db.execute(sql, params)
    rows = await cursor.fetchall()
    if not rows:
        return []
    desc = cursor.description
    return [_row_to_dict(desc, r) for r in rows]


async def _execute(db: aiosqlite.Connection, sql: str, params=()):
    """Execute SQL (INSERT/UPDATE/DELETE) and commit."""
    await db.execute(sql, params)
    await db.commit()


def _parse_json(val, default=None):
    """Parse a JSON string from SQLite, returning default if None/empty."""
    if val is None:
        return default if default is not None else None
    try:
        return json_module.loads(val)
    except (json_module.JSONDecodeError, TypeError):
        return default if default is not None else val


def _to_json(val) -> str:
    """Convert a Python object to a JSON string for SQLite storage."""
    if val is None:
        return "null"
    return json_module.dumps(val, default=str)


async def get_current_user(request: Request) -> dict:
    db = await get_db()
    token = request.cookies.get("access_token")
    token_source = "cookie"
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            token_source = "bearer_header"
    if not token:
        logger.warning("[AUTH] No token found in cookies or Authorization header | path=%s", request.url.path)
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        logger.info("[AUTH] Token expired | source=%s path=%s", token_source, request.url.path)
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        logger.warning("[AUTH] Invalid token | source=%s error=%s path=%s", token_source, e, request.url.path)
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") == "refresh":
        logger.warning("[AUTH] Refresh token used as access token | path=%s", request.url.path)
        raise HTTPException(status_code=401, detail="Invalid token type")
    user = await _fetchone(db,
        "SELECT id, email, name, role, tenant_id, created_at FROM users WHERE id = ?",
        (payload["sub"],))
    if not user:
        logger.warning("[AUTH] User not found in DB | sub=%s path=%s", payload.get("sub"), request.url.path)
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_roles(*roles: str):
    async def dep(user: dict = Depends(get_current_user)) -> dict:
        if roles and user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Forbidden")
        return user
    return dep


# ------- Models -------
class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RestaurantSettings(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str = "Thali House"
    address: str = ""
    gstin: str = ""
    fssai: str = ""
    phone: str = ""
    gst_rate: float = 5.0
    cgst_rate: float = 2.5
    sgst_rate: float = 2.5
    footer_msg: str = "Thank you for dining with us!"
    show_gst: bool = True
    show_payment: bool = True
    show_thali_selections: bool = False
    paper_width: int = 80
    font_size: str = "medium"
    header_alignment: str = "center"
    header_template: str = "classic"
    auto_print: bool = True
    receipt_prefix: str = ""
    receipt_padding: int = 6
    tax_label: str = "CGST & SGST"
    language: str = "en"
    app_name: Optional[str] = "Anndevta"
    app_tagline: Optional[str] = "THALI BILLING COUNTER"
    default_printer: Optional[str] = "system_default"
    last_reset_date: Optional[str] = None


class CategoryIn(BaseModel):
    name: str
    sort_order: int = 0


class ThaliGroup(BaseModel):
    category_id: str
    label: str = ""
    count: int = 1


class MenuItemIn(BaseModel):
    name: str
    category_id: str
    price: float
    available: bool = False
    is_thali: bool = False
    thali_groups: List[ThaliGroup] = Field(default_factory=list)
    thali_extras: str = ""
    portion_weight_kg: float = 0.0
    menuType: Optional[str] = None
    menu_type: Optional[str] = None
    gst_enabled: bool = False
    item_gst_rate: float = 0.0


class TemplateIn(BaseModel):
    name: str
    item_ids: List[str]


class ThaliSelections(BaseModel):
    # category_id -> list of selected item names
    by_category: Dict[str, List[str]] = Field(default_factory=dict)


class OrderItem(BaseModel):
    menu_item_id: str
    name: str
    price: float
    qty: int
    tax_rate: float = 5.0
    is_thali: bool = False
    thali_selections: Optional[Any] = None
    thali_extras: Optional[str] = ""
    sub_items: Optional[Any] = None
    addons: Optional[Any] = None
    included_items: Optional[Any] = None
    extra_bread: Optional[int] = 0
    extra_bread_charge: Optional[float] = 0.0

    class Config:
        extra = "allow"


class OrderIn(BaseModel):
    items: List[OrderItem]
    discount: float = 0.0
    payment_mode: str = "cash"
    notes: str = ""
    token_no: Optional[int] = None
    order_type: Optional[str] = "dining"
    customer_name: Optional[str] = ""
    customer_phone: Optional[str] = ""

    class Config:
        extra = "allow"


# ------- Inventory Models -------
class SupplierIn(BaseModel):
    name: str
    contact_person: str = ""
    phone: str = ""
    email: str = ""
    address: str = ""
    gstin: str = ""


class StockAdjustmentIn(BaseModel):
    product_id: str
    qty_change: int
    reason: Literal["damage", "loss", "correction", "count", "other"] = "correction"
    remarks: str = ""


class PurchaseOrderItemIn(BaseModel):
    product_id: str
    product_name: str = ""
    qty: int
    unit_cost: float


class PurchaseOrderIn(BaseModel):
    supplier_id: str
    items: List[PurchaseOrderItemIn]
    notes: str = ""


class GoodsReceivedItemIn(BaseModel):
    product_id: str
    qty_received: int


class GoodsReceivedIn(BaseModel):
    items: List[GoodsReceivedItemIn]
    notes: str = ""


class MenuItemInventoryUpdate(BaseModel):
    current_stock: Optional[int] = None
    reorder_level: int = 10
    min_stock: int = 5
    max_stock: int = 1000
    sku: Optional[str] = None
    barcode: Optional[str] = None
    unit_cost: float = 0.0
    location_id: str = "main"


# ------- Inventory Helpers -------
async def _record_inventory_transaction(
    product_id: str, qty_change: float, tx_type: str,
    reference_id: str = "", user_id: str = "", remarks: str = "",
    location_id: str = "main",
):
    """Record every stock change in the audit ledger."""
    db = await get_db()
    tenant = _tenant()
    tx = {
        "id": new_id(),
        "tenant_db": tenant,
        "product_id": product_id,
        "qty_change": qty_change,
        "type": tx_type,
        "reference_id": reference_id,
        "user_id": user_id,
        "remarks": remarks,
        "location_id": location_id,
        "created_at": iso(now_utc()),
    }
    await _execute(db,
        """INSERT INTO inventory_transactions (id, tenant_db, product_id, qty_change, type, reference_id, user_id, remarks, location_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (tx["id"], tx["tenant_db"], tx["product_id"], tx["qty_change"], tx["type"],
         tx["reference_id"], tx["user_id"], tx["remarks"], tx["location_id"], tx["created_at"]))
    return tx


async def _create_stock_alert(product_id: str, product_name: str, current_stock: float, threshold: float):
    """Create a low-stock or out-of-stock alert if one doesn't already exist (unresolved)."""
    db = await get_db()
    tenant = _tenant()
    alert_type = "out_of_stock" if current_stock <= 0 else "low_stock"
    existing = await _fetchone(db,
        "SELECT id FROM stock_alerts WHERE tenant_db = ? AND product_id = ? AND alert_type = ? AND is_resolved = 0",
        (tenant, product_id, alert_type))
    if existing:
        await _execute(db,
            "UPDATE stock_alerts SET current_stock = ?, updated_at = ? WHERE id = ?",
            (current_stock, iso(now_utc()), existing["id"]))
        return existing
    alert = {
        "id": new_id(),
        "tenant_db": tenant,
        "product_id": product_id,
        "product_name": product_name,
        "alert_type": alert_type,
        "current_stock": current_stock,
        "threshold": threshold,
        "is_read": 0,
        "is_resolved": 0,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }
    await _execute(db,
        """INSERT INTO stock_alerts (id, tenant_db, product_id, product_name, alert_type, current_stock, threshold, is_read, is_resolved, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (alert["id"], alert["tenant_db"], alert["product_id"], alert["product_name"],
         alert["alert_type"], alert["current_stock"], alert["threshold"],
         alert["is_read"], alert["is_resolved"], alert["created_at"], alert["updated_at"]))
    return alert


async def _update_stock_and_record(product_id: str, qty_change: float, tx_type: str,
                                    reference_id: str = "", user_id: str = "", remarks: str = ""):
    """Atomically update stock on a menu item and record the transaction."""
    db = await get_db()
    tenant = _tenant()
    item = await _fetchone(db, "SELECT * FROM menu WHERE tenant_db = ? AND id = ?", (tenant, product_id))
    if not item or item.get("current_stock") is None:
        return None  # inventory not tracked for this item
    
    qty_change = round(qty_change, 3)
    new_stock = max(0.0, round(item["current_stock"] + qty_change, 3))
    
    await _execute(db, "UPDATE menu SET current_stock = ? WHERE tenant_db = ? AND id = ?",
                   (new_stock, tenant, product_id))
    tx = await _record_inventory_transaction(
        product_id=product_id, qty_change=qty_change, tx_type=tx_type,
        reference_id=reference_id, user_id=user_id, remarks=remarks,
    )
    reorder = item.get("reorder_level") or 10
    if new_stock <= reorder:
        await _create_stock_alert(product_id, item["name"], new_stock, reorder)
    elif new_stock > reorder:
        # auto-resolve any existing alerts for this product
        await _execute(db,
            "UPDATE stock_alerts SET is_resolved = 1, updated_at = ? WHERE tenant_db = ? AND product_id = ? AND is_resolved = 0",
            (iso(now_utc()), tenant, product_id))
    return {"new_stock": new_stock, "transaction": tx}


# ------- Database Schema -------
async def _create_tables(db: aiosqlite.Connection):
    """Create all required tables if they don't exist."""
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'cashier',
            password_hash TEXT NOT NULL,
            tenant_id TEXT NOT NULL DEFAULT 'default',
            created_at TEXT NOT NULL,
            status TEXT DEFAULT 'Active'
        );

        CREATE TABLE IF NOT EXISTS tenants (
            tenant_id TEXT PRIMARY KEY,
            restaurant_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS refresh_tokens (
            jti TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL DEFAULT 'default',
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS settings (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            data TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS categories (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS menu (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            name TEXT NOT NULL,
            category_id TEXT NOT NULL DEFAULT '',
            price REAL NOT NULL DEFAULT 0,
            available INTEGER NOT NULL DEFAULT 0,
            is_thali INTEGER NOT NULL DEFAULT 0,
            thali_groups TEXT DEFAULT '[]',
            thali_extras TEXT DEFAULT '',
            portion_weight_kg REAL DEFAULT 0,
            menuType TEXT DEFAULT 'parcel',
            menu_type TEXT DEFAULT 'parcel',
            current_stock REAL DEFAULT NULL,
            reorder_level INTEGER DEFAULT 10,
            min_stock INTEGER DEFAULT 5,
            max_stock INTEGER DEFAULT 1000,
            sku TEXT DEFAULT NULL,
            barcode TEXT DEFAULT NULL,
            unit_cost REAL DEFAULT 0,
            location_id TEXT DEFAULT 'main',
            gst_enabled INTEGER NOT NULL DEFAULT 0,
            item_gst_rate REAL NOT NULL DEFAULT 0.0,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS orders (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            receipt_no INTEGER,
            items TEXT NOT NULL DEFAULT '[]',
            subtotal REAL NOT NULL DEFAULT 0,
            tax REAL NOT NULL DEFAULT 0,
            discount REAL NOT NULL DEFAULT 0,
            total REAL NOT NULL DEFAULT 0,
            payment_mode TEXT NOT NULL DEFAULT 'cash',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            paid_at TEXT NOT NULL,
            cashier_email TEXT DEFAULT '',
            cashier_name TEXT DEFAULT '',
            token_no INTEGER DEFAULT NULL,
            order_type TEXT DEFAULT 'dining',
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS counters (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            value INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS templates (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            name TEXT NOT NULL,
            item_ids TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id TEXT PRIMARY KEY,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            product_id TEXT NOT NULL,
            qty_change REAL NOT NULL DEFAULT 0,
            type TEXT NOT NULL DEFAULT '',
            reference_id TEXT DEFAULT '',
            user_id TEXT DEFAULT '',
            remarks TEXT DEFAULT '',
            location_id TEXT DEFAULT 'main',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS suppliers (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            name TEXT NOT NULL,
            contact_person TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            address TEXT DEFAULT '',
            gstin TEXT DEFAULT '',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS purchase_orders (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            po_number INTEGER DEFAULT NULL,
            supplier_id TEXT NOT NULL,
            items TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'draft',
            total_amount REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            created_by TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            ordered_at TEXT DEFAULT NULL,
            received_at TEXT DEFAULT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS stock_adjustments (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            product_id TEXT NOT NULL,
            qty_before REAL DEFAULT 0,
            qty_after REAL DEFAULT 0,
            qty_change REAL DEFAULT 0,
            reason TEXT DEFAULT 'correction',
            user_id TEXT DEFAULT '',
            remarks TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS stock_alerts (
            id TEXT PRIMARY KEY,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            product_id TEXT NOT NULL,
            product_name TEXT DEFAULT '',
            alert_type TEXT DEFAULT 'low_stock',
            current_stock REAL DEFAULT 0,
            threshold REAL DEFAULT 0,
            is_read INTEGER NOT NULL DEFAULT 0,
            is_resolved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS staff_profiles (
            user_id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            designation TEXT DEFAULT '',
            department TEXT DEFAULT '',
            joining_date TEXT DEFAULT '',
            employment_type TEXT DEFAULT 'Full-Time',
            bank_name TEXT DEFAULT '',
            bank_account TEXT DEFAULT '',
            ifsc_code TEXT DEFAULT '',
            pan_number TEXT DEFAULT '',
            uan_number TEXT DEFAULT '',
            status TEXT DEFAULT 'Active',
            mobile_number TEXT DEFAULT '',
            emergency_contact TEXT DEFAULT '',
            address TEXT DEFAULT '',
            PRIMARY KEY (user_id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS employees_salary_structure (
            id TEXT NOT NULL,
            employee_id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            wage_type TEXT DEFAULT 'Fixed',
            basic_salary REAL DEFAULT 0,
            hra REAL DEFAULT 0,
            conveyance REAL DEFAULT 0,
            medical REAL DEFAULT 0,
            special_allowance REAL DEFAULT 0,
            pf_deduction REAL DEFAULT 0,
            esi_deduction REAL DEFAULT 0,
            professional_tax REAL DEFAULT 0,
            hourly_rate REAL DEFAULT 0,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS attendance_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Present',
            check_in TEXT DEFAULT NULL,
            check_out TEXT DEFAULT NULL,
            overtime_hours REAL DEFAULT 0,
            late_mark INTEGER DEFAULT 0,
            UNIQUE(tenant_db, employee_id, date)
        );

        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Present',
            check_in TEXT DEFAULT NULL,
            check_out TEXT DEFAULT NULL,
            overtime_hours REAL DEFAULT 0,
            late_mark INTEGER DEFAULT 0,
            UNIQUE(tenant_db, employee_id, date)
        );

        CREATE TABLE IF NOT EXISTS salary_advances (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            emi_amount REAL DEFAULT 0,
            reason TEXT DEFAULT '',
            status TEXT DEFAULT 'Pending',
            balance REAL DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS payrolls (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            month INTEGER NOT NULL,
            year INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'Draft',
            total_net_pay REAL DEFAULT 0,
            employee_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            created_by TEXT DEFAULT '',
            updated_at TEXT DEFAULT NULL,
            payment_mode TEXT DEFAULT NULL,
            transaction_id TEXT DEFAULT NULL,
            paid_at TEXT DEFAULT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS payroll_items (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            payroll_id TEXT NOT NULL,
            employee_id TEXT NOT NULL,
            employee_name TEXT DEFAULT '',
            days_credited REAL DEFAULT 0,
            gross_pay REAL DEFAULT 0,
            deductions REAL DEFAULT 0,
            advance_deduction REAL DEFAULT 0,
            direct_payments_deduction REAL DEFAULT 0,
            bonuses REAL DEFAULT 0,
            penalties REAL DEFAULT 0,
            net_pay REAL DEFAULT 0,
            paid_amount REAL DEFAULT 0,
            payment_mode TEXT DEFAULT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS leave_requests (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            type TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            reason TEXT DEFAULT '',
            status TEXT DEFAULT 'Pending',
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS direct_payments (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            payment_mode TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            date TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS bonuses (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            reason TEXT DEFAULT '',
            date TEXT NOT NULL,
            status TEXT DEFAULT 'Pending',
            payroll_id TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS penalties (
            id TEXT NOT NULL,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            employee_id TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            reason TEXT DEFAULT '',
            date TEXT NOT NULL,
            status TEXT DEFAULT 'Pending',
            payroll_id TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, tenant_db)
        );

        CREATE TABLE IF NOT EXISTS payroll_audit_logs (
            id TEXT PRIMARY KEY,
            tenant_db TEXT NOT NULL DEFAULT 'default',
            payroll_id TEXT NOT NULL,
            status TEXT NOT NULL,
            changed_by TEXT DEFAULT '',
            timestamp TEXT NOT NULL
        );

        -- Indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(tenant_db, paid_at);
        CREATE INDEX IF NOT EXISTS idx_orders_receipt ON orders(tenant_db, receipt_no);
        CREATE INDEX IF NOT EXISTS idx_inv_tx_product ON inventory_transactions(tenant_db, product_id);
        CREATE INDEX IF NOT EXISTS idx_inv_tx_created ON inventory_transactions(tenant_db, created_at);
        CREATE INDEX IF NOT EXISTS idx_stock_alerts_product ON stock_alerts(tenant_db, product_id);
        CREATE INDEX IF NOT EXISTS idx_menu_tenant ON menu(tenant_db);
    """)
    await db.commit()

    # Backward-compatible column migrations for existing databases
    migration_statements = [
        "ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'dining'",
        "ALTER TABLE orders ADD COLUMN customer_name TEXT DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN customer_phone TEXT DEFAULT ''",
        "ALTER TABLE menu ADD COLUMN gst_enabled INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE menu ADD COLUMN item_gst_rate REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE menu ADD COLUMN current_stock REAL DEFAULT NULL",
        "ALTER TABLE menu ADD COLUMN reorder_level INTEGER DEFAULT 10",
        "ALTER TABLE menu ADD COLUMN min_stock INTEGER DEFAULT 5",
        "ALTER TABLE menu ADD COLUMN max_stock INTEGER DEFAULT 1000",
        "ALTER TABLE menu ADD COLUMN sku TEXT DEFAULT NULL",
        "ALTER TABLE menu ADD COLUMN barcode TEXT DEFAULT NULL",
        "ALTER TABLE menu ADD COLUMN unit_cost REAL DEFAULT 0",
        "ALTER TABLE menu ADD COLUMN location_id TEXT DEFAULT 'main'",
    ]
    for stmt in migration_statements:
        try:
            await db.execute(stmt)
            await db.commit()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_conn
    db_file = Path(DB_PATH)
    db_file.parent.mkdir(parents=True, exist_ok=True)
    _db_conn = await aiosqlite.connect(str(db_file), timeout=60.0)
    _db_conn.row_factory = None  # We use our own row-to-dict conversion
    try:
        # Use DELETE journal mode (not WAL) so there are no .wal/.shm side files
        # that can be left behind when the process is forcibly killed.
        await _db_conn.execute("PRAGMA journal_mode=DELETE")
        await _db_conn.execute("PRAGMA busy_timeout=60000")
        await _db_conn.execute("PRAGMA foreign_keys=ON")
        await _create_tables(_db_conn)
        await seed_defaults()
    except Exception as e:
        logger.warning(f"Lifespan database setup warning: {e}")

    creds_dir = ROOT_DIR / "memory"
    try:
        creds_dir.mkdir(exist_ok=True, parents=True)
        (creds_dir / "test_credentials.md").write_text(
            "# Thali POS Test Credentials\n\n"
            f"- Owner (admin): {os.environ.get('ADMIN_EMAIL', 'admin@pos.com')} / {os.environ.get('ADMIN_PASSWORD', 'admin123')}\n"
            "- Cashier: cashier@pos.com / cashier123\n\n"
            "Auth endpoints: POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout\n"
        )
    except Exception as e:
        logger.warning(f"Could not write test credentials file: {e}")
    yield
    await _db_conn.close()


# ------- App -------
app = FastAPI(title="Thali POS", lifespan=lifespan)

@app.middleware("http")
async def tenant_middleware(request: Request, call_next):
    tenant_id = request.query_params.get("tenant_id")
    if not tenant_id:
        token = request.cookies.get("access_token")
        if not token:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]
        if token:
            try:
                payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
                tenant_id = payload.get("tenant_id")
            except Exception:
                pass
    
    if not tenant_id:
        tenant_id = "default"
    
    token_ctx = tenant_id_ctx.set(tenant_id)
    
    try:
        response = await call_next(request)
    finally:
        tenant_id_ctx.reset(token_ctx)
    return response

api = APIRouter(prefix="/api")


# ------- Auth -------
class SignupIn(BaseModel):
    email: EmailStr
    password: str
    restaurant_name: str


@api.post("/auth/signup")
async def signup(body: SignupIn):
    db = await get_db()
    email = body.email.lower()
    existing = await _fetchone(db, "SELECT id FROM users WHERE email = ?", (email,))
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    tenant_id = str(uuid.uuid4()).replace('-', '')[:16]
    user_id = new_id()
    
    # Create user
    await _execute(db,
        "INSERT INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, email, "Owner", "admin", hash_password(body.password), tenant_id, iso(now_utc())))
    
    # Create tenant record
    await _execute(db,
        "INSERT INTO tenants (tenant_id, restaurant_name, created_at) VALUES (?, ?, ?)",
        (tenant_id, body.restaurant_name, iso(now_utc())))
    
    # Initialize Tenant settings
    settings_data = {
        "id": "restaurant",
        "name": body.restaurant_name,
        "address": "", "gstin": "", "fssai": "", "phone": "", "gst_rate": 5.0, "cgst_rate": 2.5, "sgst_rate": 2.5,
        "footer_msg": "Thank you for dining with us!",
        "auto_print": False, "tax_label": "CGST & SGST", "language": "en"
    }
    await _execute(db,
        "INSERT INTO settings (id, tenant_db, data) VALUES (?, ?, ?)",
        ("restaurant", tenant_id, _to_json(settings_data)))
    
    return {"ok": True, "tenant_id": tenant_id}


@api.post("/auth/login")
async def login(body: LoginIn, response: Response):
    db = await get_db()
    email = body.email.lower()
    user = await _fetchone(db, "SELECT * FROM users WHERE email = ?", (email,))
    if not user or not verify_password(body.password, user["password_hash"]):
        logger.info("[AUTH] Login failed for email=%s", email)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    tenant_id = user.get("tenant_id", "default")
    access_token = create_access_token(user["id"], user["email"], user["role"], tenant_id)
    refresh_token = create_refresh_token(user["id"], tenant_id)
    
    # Decode refresh token to get jti for DB storage
    rt_payload = jwt.decode(refresh_token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    await _execute(db,
        "INSERT INTO refresh_tokens (jti, user_id, tenant_id, expires_at, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?)",
        (rt_payload["jti"], user["id"], tenant_id,
         datetime.fromtimestamp(rt_payload["exp"], tz=timezone.utc).isoformat(),
         iso(now_utc()), 0))
    
    # Set cookie for backward compatibility
    response.set_cookie(
        key="access_token", value=access_token, httponly=True,
        secure=False, samesite="lax", max_age=30 * 24 * 3600, path="/",
    )
    logger.info("[AUTH] Login successful | email=%s tenant=%s", email, tenant_id)
    return {
        "token": access_token,
        "refresh_token": refresh_token,
        "user": {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"], "tenant_id": tenant_id},
    }


@api.post("/auth/logout")
async def logout(request: Request, response: Response):
    db = await get_db()
    # Revoke refresh token if provided
    try:
        body = await request.json()
        rt = body.get("refresh_token")
    except Exception:
        rt = None
    if rt:
        try:
            rt_payload = jwt.decode(rt, JWT_SECRET, algorithms=[JWT_ALGORITHM])
            await _execute(db,
                "UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?",
                (rt_payload.get("jti"),))
        except Exception:
            pass  # token already invalid, that's fine
    response.delete_cookie("access_token", path="/")
    logger.info("[AUTH] Logout")
    return {"ok": True}


class RefreshIn(BaseModel):
    refresh_token: str


@api.post("/auth/refresh")
async def refresh_token_endpoint(body: RefreshIn, response: Response):
    """Exchange a valid refresh token for a new access + refresh token pair (rotation)."""
    db = await get_db()
    try:
        payload = jwt.decode(body.refresh_token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        logger.info("[AUTH] Refresh token expired")
        raise HTTPException(status_code=401, detail="Refresh token expired")
    except jwt.InvalidTokenError as e:
        logger.warning("[AUTH] Invalid refresh token: %s", e)
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Not a refresh token")
    
    # Check if token is revoked
    stored = await _fetchone(db, "SELECT * FROM refresh_tokens WHERE jti = ?", (payload.get("jti"),))
    if not stored or stored.get("revoked"):
        logger.warning("[AUTH] Revoked refresh token used | jti=%s", payload.get("jti"))
        raise HTTPException(status_code=401, detail="Token revoked")
    
    # Look up user
    user = await _fetchone(db,
        "SELECT id, email, name, role, tenant_id FROM users WHERE id = ?",
        (payload["sub"],))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    
    tenant_id = user.get("tenant_id", payload.get("tenant_id", "default"))
    
    # Revoke old refresh token (rotation)
    await _execute(db, "UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?", (payload["jti"],))
    
    # Issue new pair
    new_access = create_access_token(user["id"], user["email"], user["role"], tenant_id)
    new_refresh = create_refresh_token(user["id"], tenant_id)
    
    new_rt_payload = jwt.decode(new_refresh, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    await _execute(db,
        "INSERT INTO refresh_tokens (jti, user_id, tenant_id, expires_at, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?)",
        (new_rt_payload["jti"], user["id"], tenant_id,
         datetime.fromtimestamp(new_rt_payload["exp"], tz=timezone.utc).isoformat(),
         iso(now_utc()), 0))
    
    response.set_cookie(
        key="access_token", value=new_access, httponly=True,
        secure=False, samesite="lax", max_age=30 * 24 * 3600, path="/",
    )
    logger.info("[AUTH] Token refreshed | user=%s", user["id"])
    return {
        "token": new_access,
        "refresh_token": new_refresh,
        "user": {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"], "tenant_id": tenant_id},
    }


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


@api.post("/auth/change-password")
async def change_password(body: PasswordChangeIn, user=Depends(get_current_user)):
    """Change user password. Requires current password for verification."""
    db = await get_db()
    db_user = await _fetchone(db, "SELECT * FROM users WHERE id = ?", (user["id"],))
    if not db_user or not verify_password(body.current_password, db_user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    
    # Validate new password
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    
    # Don't allow reusing default password
    if body.new_password == "admin123":
        raise HTTPException(status_code=400, detail="Cannot use default password")
    
    # Update password
    new_hash = hash_password(body.new_password)
    await _execute(db, "UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user["id"]))
    
    return {"ok": True, "message": "Password changed successfully"}


# ------- Staff Accounts -------
class StaffIn(BaseModel):
    name: str
    email: EmailStr
    password: str
    role: str = "cashier"


@api.get("/staff", dependencies=[Depends(require_roles("admin"))])
async def list_staff(user=Depends(get_current_user)):
    db = await get_db()
    tenant_id = user.get("tenant_id", "default")
    tenant = _tenant()
    users = await _fetchall(db,
        "SELECT id, email, name, role, tenant_id, created_at FROM users WHERE tenant_id = ?",
        (tenant_id,))
    
    profiles = await _fetchall(db,
        "SELECT * FROM staff_profiles WHERE tenant_db = ?", (tenant,))
    profile_map = {p["user_id"]: p for p in profiles}
    
    structures = await _fetchall(db,
        "SELECT * FROM employees_salary_structure WHERE tenant_db = ?", (tenant,))
    structure_map = {s["employee_id"]: s for s in structures}
    
    for u in users:
        p = profile_map.get(u["id"], {})
        s = structure_map.get(u["id"], {})
        # ensure employee_id alias for frontend
        u["employee_id"] = u["id"]
        for k, v in p.items():
            if k not in u and k not in ("tenant_db",):
                u[k] = v
        # Defaults if no profile
        if "status" not in u: u["status"] = "Active"
        if "designation" not in u: u["designation"] = ""
        if "department" not in u: u["department"] = ""
        
        # Merge salary details for frontend display
        u["salary_wage_type"] = s.get("wage_type", "Fixed")
        u["salary_basic"] = s.get("basic_salary", 0)
        u["salary_hourly_rate"] = s.get("hourly_rate", 0)
        
    return users


@api.post("/staff", dependencies=[Depends(require_roles("admin"))])
async def create_staff(body: StaffIn, user=Depends(get_current_user)):
    db = await get_db()
    tenant_id = user.get("tenant_id", "default")
    tenant = _tenant()
    email = body.email.lower()
    
    existing = await _fetchone(db, "SELECT id FROM users WHERE email = ?", (email,))
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
        
    user_id = new_id()
    await _execute(db,
        "INSERT INTO users (id, email, name, password_hash, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, email, body.name, hash_password(body.password), body.role, tenant_id, iso(now_utc())))
    
    await _execute(db,
        """INSERT INTO staff_profiles (user_id, tenant_db, designation, department, joining_date, employment_type,
           bank_name, bank_account, ifsc_code, pan_number, uan_number, status, mobile_number, emergency_contact, address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, tenant, "", "", iso(now_utc())[:10], "Full-Time",
         "", "", "", "", "", "Active", "", "", ""))
    
    await _execute(db,
        """INSERT INTO employees_salary_structure (id, employee_id, tenant_db, wage_type, basic_salary, hra, conveyance, medical,
           special_allowance, pf_deduction, esi_deduction, professional_tax, hourly_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (new_id(), user_id, tenant, "Fixed", 0, 0, 0, 0, 0, 0, 0, 0, 0))
    
    return {"ok": True, "id": user_id}

@api.put("/staff/{user_id}", dependencies=[Depends(require_roles("admin"))])
async def update_staff(user_id: str, body: dict, user=Depends(get_current_user)):
    db = await get_db()
    tenant_id = user.get("tenant_id", "default")
    tenant = _tenant()
    
    # Update user table fields
    user_fields = {}
    if "name" in body: user_fields["name"] = body["name"]
    if "role" in body: user_fields["role"] = body["role"]
    if "email" in body: user_fields["email"] = body["email"]
    
    if user_fields:
        set_clause = ", ".join(f"{k} = ?" for k in user_fields)
        params = list(user_fields.values()) + [user_id, tenant_id]
        await _execute(db, f"UPDATE users SET {set_clause} WHERE id = ? AND tenant_id = ?", params)
        
    # Update staff profile fields
    profile_keys = [k for k in body if k not in ("id", "password", "email", "name", "role", "created_at", "tenant_id", "password_hash", "employee_id", "user_id")]
    if profile_keys:
        # Check if profile exists
        existing = await _fetchone(db, "SELECT user_id FROM staff_profiles WHERE user_id = ? AND tenant_db = ?", (user_id, tenant))
        if existing:
            set_clause = ", ".join(f"{k} = ?" for k in profile_keys)
            params = [body[k] for k in profile_keys] + [user_id, tenant]
            await _execute(db, f"UPDATE staff_profiles SET {set_clause} WHERE user_id = ? AND tenant_db = ?", params)
        else:
            cols = ["user_id", "tenant_db"] + profile_keys
            placeholders = ", ".join(["?"] * len(cols))
            col_str = ", ".join(cols)
            vals = [user_id, tenant] + [body[k] for k in profile_keys]
            await _execute(db, f"INSERT INTO staff_profiles ({col_str}) VALUES ({placeholders})", vals)
        
    return {"ok": True}

@api.delete("/staff/{user_id}", dependencies=[Depends(require_roles("admin"))])
async def delete_staff(user_id: str, user=Depends(get_current_user)):
    db = await get_db()
    tenant_id = user.get("tenant_id", "default")
    tenant = _tenant()
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
        
    # Check if user exists and belongs to this tenant
    target = await _fetchone(db, "SELECT id FROM users WHERE id = ? AND tenant_id = ?", (user_id, tenant_id))
    if not target:
        raise HTTPException(status_code=404, detail="Staff not found")
    
    await _execute(db, "DELETE FROM users WHERE id = ? AND tenant_id = ?", (user_id, tenant_id))
    await _execute(db, "DELETE FROM staff_profiles WHERE user_id = ? AND tenant_db = ?", (user_id, tenant))
    await _execute(db, "DELETE FROM employees_salary_structure WHERE employee_id = ? AND tenant_db = ?", (user_id, tenant))
    return {"ok": True}


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


# ------- Settings -------
@api.get("/settings")
async def get_settings(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    row = await _fetchone(db, "SELECT data FROM settings WHERE id = ? AND tenant_db = ?", ("restaurant", tenant))
    if not row:
        s = {"id": "restaurant", **RestaurantSettings().model_dump()}
        await _execute(db, "INSERT INTO settings (id, tenant_db, data) VALUES (?, ?, ?)",
                       ("restaurant", tenant, _to_json(s)))
        return s
    s = _parse_json(row["data"], {})
    # Backward-compatible migration for CGST/SGST rates
    defaults = RestaurantSettings().model_dump()
    if "cgst_rate" not in s or "sgst_rate" not in s:
        existing_gst = float(s.get("gst_rate", 5.0))
        s["cgst_rate"] = round(existing_gst / 2.0, 2)
        s["sgst_rate"] = round(existing_gst / 2.0, 2)
    if not s.get("tax_label") or s.get("tax_label") == "GST":
        s["tax_label"] = "CGST & SGST"
    s["gst_rate"] = float(s.get("cgst_rate", 2.5)) + float(s.get("sgst_rate", 2.5))

    merged = {**defaults, **s}
    merged["id"] = "restaurant"
    return merged


@api.put("/settings")
async def update_settings(body: RestaurantSettings, _: dict = Depends(require_roles("admin"))):
    if body.cgst_rate < 0 or body.cgst_rate > 100:
        raise HTTPException(status_code=400, detail="CGST rate must be between 0 and 100")
    if body.sgst_rate < 0 or body.sgst_rate > 100:
        raise HTTPException(status_code=400, detail="SGST rate must be between 0 and 100")
    body.gst_rate = body.cgst_rate + body.sgst_rate

    db = await get_db()
    tenant = _tenant()
    data = {"id": "restaurant", **body.model_dump()}
    existing = await _fetchone(db, "SELECT id FROM settings WHERE id = ? AND tenant_db = ?", ("restaurant", tenant))
    if existing:
        await _execute(db, "UPDATE settings SET data = ? WHERE id = ? AND tenant_db = ?",
                       (_to_json(data), "restaurant", tenant))
    else:
        await _execute(db, "INSERT INTO settings (id, tenant_db, data) VALUES (?, ?, ?)",
                       ("restaurant", tenant, _to_json(data)))
    return data


# ------- Categories -------
@api.get("/categories")
async def list_categories(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    return await _fetchall(db, "SELECT id, name, sort_order FROM categories WHERE tenant_db = ? ORDER BY sort_order ASC", (tenant,))


@api.post("/categories")
async def create_category(body: CategoryIn, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    obj = {"id": new_id(), **body.model_dump()}
    await _execute(db, "INSERT INTO categories (id, tenant_db, name, sort_order) VALUES (?, ?, ?, ?)",
                   (obj["id"], tenant, obj["name"], obj["sort_order"]))
    return obj


@api.delete("/categories/{cid}")
async def delete_category(cid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "DELETE FROM categories WHERE id = ? AND tenant_db = ?", (cid, tenant))
    return {"ok": True}


# ------- Menu -------
def _menu_row_to_dict(row: dict) -> dict:
    """Convert a menu row with JSON fields to a proper dict."""
    if row is None:
        return None
    row["thali_groups"] = _parse_json(row.get("thali_groups"), [])
    row["available"] = bool(row.get("available"))
    row["is_thali"] = bool(row.get("is_thali"))
    row["gst_enabled"] = bool(row.get("gst_enabled"))
    row["item_gst_rate"] = float(row.get("item_gst_rate") or 0.0)
    return row


@api.get("/menu")
async def list_menu(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    current_date = datetime.now().strftime("%Y-%m-%d")
    
    # Get settings
    row = await _fetchone(db, "SELECT data FROM settings WHERE id = ? AND tenant_db = ?", ("restaurant", tenant))
    if not row:
        s = {"id": "restaurant", **RestaurantSettings().model_dump()}
        await _execute(db, "INSERT INTO settings (id, tenant_db, data) VALUES (?, ?, ?)",
                       ("restaurant", tenant, _to_json(s)))
    else:
        s = _parse_json(row["data"], {})
    
    last_reset = s.get("last_reset_date")
    if last_reset != current_date:
        s["last_reset_date"] = current_date
        await _execute(db, "UPDATE settings SET data = ? WHERE id = ? AND tenant_db = ?",
                       (_to_json(s), "restaurant", tenant))
    
    items = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ?", (tenant,))
    result = []
    for item in items:
        item = _menu_row_to_dict(item)
        if not item.get("menuType") and not item.get("menu_type"):
            default_type = "both" if item.get("is_thali") else "parcel"
            item["menuType"] = default_type
            item["menu_type"] = default_type
        elif not item.get("menuType"):
            item["menuType"] = item.get("menu_type")
        elif not item.get("menu_type"):
            item["menu_type"] = item.get("menuType")
        # Remove tenant_db from response
        item.pop("tenant_db", None)
        result.append(item)
    return result


@api.post("/menu")
async def create_menu(body: MenuItemIn, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    obj = {"id": new_id(), **body.model_dump()}
    m_type = body.menuType or body.menu_type or ("both" if body.is_thali else "parcel")
    obj["menuType"] = m_type
    obj["menu_type"] = m_type
    await _execute(db,
        """INSERT INTO menu (id, tenant_db, name, category_id, price, available, is_thali, thali_groups, thali_extras,
           portion_weight_kg, menuType, menu_type, gst_enabled, item_gst_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (obj["id"], tenant, obj["name"], obj["category_id"], obj["price"],
         1 if obj["available"] else 0, 1 if obj["is_thali"] else 0,
         _to_json([g.model_dump() for g in body.thali_groups]),
         obj["thali_extras"], obj["portion_weight_kg"], obj["menuType"], obj["menu_type"],
         1 if obj.get("gst_enabled") else 0, float(obj.get("item_gst_rate") or 0)))
    obj["thali_groups"] = [g.model_dump() for g in body.thali_groups]
    return obj


@api.put("/menu/{mid}")
async def update_menu(mid: str, body: MenuItemIn, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    m_type = body.menuType or body.menu_type or ("both" if body.is_thali else "parcel")
    data["menuType"] = m_type
    data["menu_type"] = m_type
    await _execute(db,
        """UPDATE menu SET name=?, category_id=?, price=?, available=?, is_thali=?, thali_groups=?, thali_extras=?,
           portion_weight_kg=?, menuType=?, menu_type=?, gst_enabled=?, item_gst_rate=? WHERE id=? AND tenant_db=?""",
        (data["name"], data["category_id"], data["price"],
         1 if data["available"] else 0, 1 if data["is_thali"] else 0,
         _to_json(data["thali_groups"]), data["thali_extras"],
         data["portion_weight_kg"], data["menuType"], data["menu_type"],
         1 if data.get("gst_enabled") else 0, float(data.get("item_gst_rate") or 0),
         mid, tenant))
    updated = await _fetchone(db, "SELECT * FROM menu WHERE id = ? AND tenant_db = ?", (mid, tenant))
    if updated:
        updated = _menu_row_to_dict(updated)
        updated.pop("tenant_db", None)
    return updated


@api.patch("/menu/{mid}/toggle")
async def toggle_menu(mid: str, _: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    item = await _fetchone(db, "SELECT available FROM menu WHERE id = ? AND tenant_db = ?", (mid, tenant))
    if not item:
        raise HTTPException(404, "Not found")
    new_val = not bool(item.get("available", False))
    await _execute(db, "UPDATE menu SET available = ? WHERE id = ? AND tenant_db = ?",
                   (1 if new_val else 0, mid, tenant))
    return {"ok": True, "available": new_val}


@api.delete("/menu/{mid}")
async def delete_menu(mid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "DELETE FROM menu WHERE id = ? AND tenant_db = ?", (mid, tenant))
    return {"ok": True}


@api.post("/menu/reset")
async def reset_menu_availability(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "UPDATE menu SET available = 0 WHERE tenant_db = ?", (tenant,))
    return {"ok": True}



# ------- Templates (Daily Menu snapshots) -------
@api.get("/templates")
async def list_templates(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    rows = await _fetchall(db, "SELECT * FROM templates WHERE tenant_db = ?", (tenant,))
    for r in rows:
        r["item_ids"] = _parse_json(r.get("item_ids"), [])
        r.pop("tenant_db", None)
    return rows


@api.post("/templates")
async def create_template(body: TemplateIn, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    obj = {"id": new_id(), "name": body.name, "item_ids": body.item_ids, "created_at": iso(now_utc())}
    await _execute(db,
        "INSERT INTO templates (id, tenant_db, name, item_ids, created_at) VALUES (?, ?, ?, ?, ?)",
        (obj["id"], tenant, obj["name"], _to_json(obj["item_ids"]), obj["created_at"]))
    return obj


@api.post("/templates/{tid}/activate")
async def activate_template(tid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    tpl = await _fetchone(db, "SELECT * FROM templates WHERE id = ? AND tenant_db = ?", (tid, tenant))
    if not tpl:
        raise HTTPException(404, "Template not found")
    active_ids = set(_parse_json(tpl.get("item_ids"), []))
    items = await _fetchall(db, "SELECT id FROM menu WHERE tenant_db = ?", (tenant,))
    for it in items:
        await _execute(db, "UPDATE menu SET available = ? WHERE id = ? AND tenant_db = ?",
                       (1 if it["id"] in active_ids else 0, it["id"], tenant))
    return {"ok": True, "activated": len(active_ids)}


@api.delete("/templates/{tid}")
async def delete_template(tid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "DELETE FROM templates WHERE id = ? AND tenant_db = ?", (tid, tenant))
    return {"ok": True}


# ------- Orders -------
def _compute_totals(items: list, discount: float, default_cgst_rate: float = 2.5, default_sgst_rate: float = 2.5, order_type: str = "dining") -> dict:
    is_parcel = (order_type or "").lower() == "parcel"
    gross_total = sum((i["price"] * i["qty"]) + ((i.get("extra_bread_charge") or 0) * i["qty"]) for i in items)

    if is_parcel:
        # Parcel: Item prices are GST INCLUSIVE.
        # Extract GST from the gross price: Base = Gross / (1 + total_rate/100), GST = Gross - Base
        cgst = 0.0
        sgst = 0.0
        taxable_subtotal = 0.0

        for i in items:
            line_gross = (i["price"] * i["qty"]) + ((i.get("extra_bread_charge") or 0) * i["qty"])
            c_rate = i.get("cgst_rate", default_cgst_rate)
            s_rate = i.get("sgst_rate", default_sgst_rate)
            total_rate = c_rate + s_rate
            if total_rate > 0:
                base = line_gross / (1 + total_rate / 100)
                item_tax = line_gross - base
                item_cgst = item_tax * (c_rate / total_rate)
                item_sgst = item_tax * (s_rate / total_rate)
            else:
                base = line_gross
                item_cgst = 0.0
                item_sgst = 0.0
            taxable_subtotal += base
            cgst += item_cgst
            sgst += item_sgst

        cgst = round(cgst, 2)
        sgst = round(sgst, 2)
        tax = round(cgst + sgst, 2)
        total = max(0.0, round(gross_total - discount, 2))

        return {
            "subtotal": round(gross_total, 2),
            "taxable_subtotal": round(taxable_subtotal, 2),
            "cgst": cgst,
            "sgst": sgst,
            "tax": tax,
            "total": total,
        }
    else:
        # Dine-In: Item prices are GST EXCLUSIVE.
        # Add GST on top of base subtotal: CGST = Base * 2.5%, SGST = Base * 2.5%
        cgst = sum(((i["price"] * i["qty"]) + ((i.get("extra_bread_charge") or 0) * i["qty"])) * (i.get("cgst_rate", default_cgst_rate) / 100) for i in items)
        sgst = sum(((i["price"] * i["qty"]) + ((i.get("extra_bread_charge") or 0) * i["qty"])) * (i.get("sgst_rate", default_sgst_rate) / 100) for i in items)
        cgst = round(cgst, 2)
        sgst = round(sgst, 2)
        tax = round(cgst + sgst, 2)
        total = max(0.0, round(gross_total + tax - discount, 2))

        return {
            "subtotal": round(gross_total, 2),
            "taxable_subtotal": round(gross_total, 2),
            "cgst": cgst,
            "sgst": sgst,
            "tax": tax,
            "total": total,
        }



async def _next_receipt_number() -> int:
    db = await get_db()
    tenant = _tenant()
    row = await _fetchone(db, "SELECT value FROM counters WHERE id = ? AND tenant_db = ?", ("receipt", tenant))
    if row:
        new_val = int(row["value"]) + 1
        await _execute(db, "UPDATE counters SET value = ? WHERE id = ? AND tenant_db = ?", (new_val, "receipt", tenant))
        return new_val
    else:
        max_order = await _fetchone(db, "SELECT MAX(receipt_no) as max_rn FROM orders WHERE tenant_db = ?", (tenant,))
        max_rn = int(max_order["max_rn"]) if max_order and max_order["max_rn"] is not None else 0
        new_val = max_rn + 1
        await _execute(db, "INSERT INTO counters (id, tenant_db, value) VALUES (?, ?, ?)", ("receipt", tenant, new_val))
        return new_val


@api.post("/orders")
async def create_order(body: OrderIn, user: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    items = [i.model_dump() for i in body.items]
    if not items:
        raise HTTPException(400, "Cart is empty")
    
    # Apply configured GST rate from settings to items
    row = await _fetchone(db, "SELECT data FROM settings WHERE id = ? AND tenant_db = ?", ("restaurant", tenant))
    s = _parse_json(row["data"], {}) if row else {}
    default_cgst = float(s.get("cgst_rate", float(s.get("gst_rate", 5.0)) / 2.0))
    default_sgst = float(s.get("sgst_rate", float(s.get("gst_rate", 5.0)) / 2.0))
    gst_rate = default_cgst + default_sgst

    for item in items:
        if item.get("cgst_rate") is None:
            item["cgst_rate"] = default_cgst
        if item.get("sgst_rate") is None:
            item["sgst_rate"] = default_sgst
        if item.get("tax_rate") is None or item.get("tax_rate") == 5.0:
            item["tax_rate"] = item["cgst_rate"] + item["sgst_rate"]

    order_type = (body.order_type or "dining").lower()
    totals = _compute_totals(items, body.discount, default_cgst, default_sgst, order_type)
    rn = await _next_receipt_number()
    ts = iso(now_utc())
    order = {
        "id": new_id(),
        "receipt_no": rn,
        "items": items,
        "subtotal": totals["subtotal"],
        "cgst": totals["cgst"],
        "sgst": totals["sgst"],
        "tax": totals["tax"],
        "cgst_rate": default_cgst,
        "sgst_rate": default_sgst,
        "discount": body.discount,
        "total": totals["total"],
        "payment_mode": body.payment_mode,
        "notes": body.notes,
        "customer_name": getattr(body, "customer_name", "") or "",
        "customer_phone": getattr(body, "customer_phone", "") or "",
        "created_at": ts,
        "paid_at": ts,
        "cashier_email": user.get("email"),
        "cashier_name": user.get("name"),
        "token_no": body.token_no,
        "order_type": order_type,
    }
    await _execute(db,
        """INSERT INTO orders (id, tenant_db, receipt_no, items, subtotal, tax, discount, total, payment_mode, notes,
           created_at, paid_at, cashier_email, cashier_name, token_no, order_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (order["id"], tenant, order["receipt_no"], _to_json(order["items"]),
         order["subtotal"], order["tax"], order["discount"], order["total"],
         order["payment_mode"], order["notes"], order["created_at"], order["paid_at"],
         order["cashier_email"], order["cashier_name"], order["token_no"], order["order_type"]))


    # --- Inventory hook: decrement stock for each sold item ---
    for item in items:
        mid = item.get("menu_item_id")
        if not mid: continue
        
        qty = item.get("qty", 1)
        menu_item = await _fetchone(db, "SELECT * FROM menu WHERE id = ? AND tenant_db = ?", (mid, tenant))
        if not menu_item: continue
        menu_item = _menu_row_to_dict(menu_item)
        
        pw_kg = menu_item.get("portion_weight_kg", 0.0) or 0.0

        if item.get("is_thali") and item.get("thali_selections"):
            # Deduct for the base thali item itself
            deduction = (qty * pw_kg) if pw_kg > 0 else qty
            await _update_stock_and_record(
                product_id=mid, qty_change=-deduction, tx_type="sale",
                reference_id=order["id"], user_id=user.get("id", ""),
                remarks=f"Sale #{order['receipt_no']} (Thali Base)"
            )
            # Deduct for each selected sub-item
            thali_sel = item.get("thali_selections", {})
            if isinstance(thali_sel, dict):
                selections_dict = thali_sel.get("by_category", thali_sel)
                for group, sub_items in selections_dict.items():
                    if isinstance(sub_items, list):
                        for sub_item_name in sub_items:
                            sub_db_item = await _fetchone(db, "SELECT * FROM menu WHERE name = ? AND tenant_db = ?", (sub_item_name, tenant))
                            if sub_db_item:
                                sub_db_item = _menu_row_to_dict(sub_db_item)
                                sub_pw = sub_db_item.get("portion_weight_kg", 0.0) or 0.0
                                sub_deduction = (qty * sub_pw) if sub_pw > 0 else qty
                                await _update_stock_and_record(
                                    product_id=sub_db_item["id"], 
                                    qty_change=-sub_deduction, 
                                    tx_type="sale",
                                    reference_id=order["id"], user_id=user.get("id", ""),
                                    remarks=f"Sale #{order['receipt_no']} (Thali Selection)"
                                )
        else:
            # Standard item
            deduction = (qty * pw_kg) if pw_kg > 0 else qty
            await _update_stock_and_record(
                product_id=mid, qty_change=-deduction, tx_type="sale",
                reference_id=order["id"], user_id=user.get("id", ""),
                remarks=f"Sale #{order['receipt_no']}"
            )

    return order


@api.get("/orders")
async def list_orders(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 500,
    user: dict = Depends(get_current_user),
):
    db = await get_db()
    tenant = _tenant()
    conditions = ["tenant_db = ?"]
    params: list = [tenant]
    
    if user.get("role") == "cashier":
        conditions.append("cashier_email = ?")
        params.append(user.get("email"))
    
    if from_date:
        conditions.append("paid_at >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("paid_at <= ?")
        params.append(to_date)
    
    if q:
        try:
            rn = int(q)
            conditions.append("(receipt_no = ? OR id LIKE ?)")
            params.extend([rn, f"%{q}%"])
        except ValueError:
            conditions.append("id LIKE ?")
            params.append(f"%{q}%")
    
    where = " AND ".join(conditions)
    params.append(limit)
    rows = await _fetchall(db,
        f"SELECT * FROM orders WHERE {where} ORDER BY paid_at DESC LIMIT ?", params)
    
    for r in rows:
        r["items"] = _parse_json(r.get("items"), [])
        r.pop("tenant_db", None)
    return rows


@api.get("/orders/{oid}")
async def get_order(oid: str, _: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    o = await _fetchone(db, "SELECT * FROM orders WHERE id = ? AND tenant_db = ?", (oid, tenant))
    if not o:
        raise HTTPException(404, "Not found")
    o["items"] = _parse_json(o.get("items"), [])
    return o


@api.delete("/orders/reset")
async def reset_orders_reset_path(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "DELETE FROM orders WHERE tenant_db = ?", (tenant,))
    await _execute(db, "DELETE FROM counters WHERE id = 'receipt' AND tenant_db = ?", (tenant,))
    return {"ok": True, "message": "All order records deleted"}


@api.delete("/orders")
async def reset_orders_root_path(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "DELETE FROM orders WHERE tenant_db = ?", (tenant,))
    await _execute(db, "DELETE FROM counters WHERE id = 'receipt' AND tenant_db = ?", (tenant,))
    return {"ok": True, "message": "All order records deleted"}


@api.delete("/orders/{oid}")
async def delete_order(oid: str, user: dict = Depends(get_current_user)):
    if oid == "reset":
        return await reset_orders_reset_path(user)
    db = await get_db()
    tenant = _tenant()
    order = await _fetchone(db, "SELECT id FROM orders WHERE id = ? AND tenant_db = ?", (oid, tenant))
    if not order:
        raise HTTPException(404, "Order not found")
    await _execute(db, "DELETE FROM orders WHERE id = ? AND tenant_db = ?", (oid, tenant))
    remaining = await _fetchone(db, "SELECT COUNT(*) as count FROM orders WHERE tenant_db = ?", (tenant,))
    if remaining and remaining["count"] == 0:
        await _execute(db, "DELETE FROM counters WHERE id = 'receipt' AND tenant_db = ?", (tenant,))
    return {"ok": True, "id": oid}


# ------- Dashboard -------
def _day_range(days_back: int):
    end = now_utc()
    start = end - timedelta(days=days_back)
    return iso(start), iso(end)


def _today_range():
    today = now_utc().date()
    start = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    end = datetime.combine(today, datetime.max.time(), tzinfo=timezone.utc)
    return iso(start), iso(end)


async def _orders_in_range(start_iso: str, end_iso: str) -> list:
    db = await get_db()
    tenant = _tenant()
    rows = await _fetchall(db,
        "SELECT * FROM orders WHERE tenant_db = ? AND paid_at >= ? AND paid_at <= ?",
        (tenant, start_iso, end_iso))
    for r in rows:
        r["items"] = _parse_json(r.get("items"), [])
        r.pop("tenant_db", None)
    return rows


def _agg_top_items(orders: list, only_thali: bool = False, top: int = 5) -> list:
    counter: Dict[str, int] = {}
    rev: Dict[str, float] = {}
    for o in orders:
        for it in o.get("items", []):
            if only_thali and not it.get("is_thali"): continue
            if (not only_thali) and it.get("is_thali"): continue
            name = it["name"]
            counter[name] = counter.get(name, 0) + it["qty"]
            rev[name] = rev.get(name, 0.0) + (it["price"] * it["qty"])
    out = sorted(counter.items(), key=lambda x: -x[1])[:top]
    return [{"name": n, "qty": q, "revenue": round(rev[n], 2)} for n, q in out]


def _agg_payment_breakdown(orders: list) -> dict:
    out = {"cash": 0.0, "card": 0.0, "upi": 0.0}
    for o in orders:
        m = o.get("payment_mode", "cash")
        if m in out:
            out[m] += o.get("total", 0)
    return {k: round(v, 2) for k, v in out.items()}


@api.get("/dashboard/summary")
async def dashboard_summary(_: dict = Depends(get_current_user)):
    today_s, today_e = _today_range()
    week_s, _w = _day_range(7)
    month_s, _m = _day_range(30)

    today_orders = await _orders_in_range(today_s, today_e)
    week_orders = await _orders_in_range(week_s, iso(now_utc()))
    month_orders = await _orders_in_range(month_s, iso(now_utc()))

    def kpi(orders):
        total = sum(o.get("total", 0) for o in orders)
        count = len(orders)
        return {
            "revenue": round(total, 2),
            "orders": count,
            "avg": round(total / count, 2) if count else 0.0,
        }

    # Last 7-day daily series
    series = []
    for i in range(6, -1, -1):
        day = (now_utc() - timedelta(days=i)).date()
        ds = iso(datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc))
        de = iso(datetime.combine(day, datetime.max.time(), tzinfo=timezone.utc))
        day_orders = [o for o in week_orders if ds <= o.get("paid_at", "") <= de]
        series.append({
            "date": day.isoformat(),
            "revenue": round(sum(o.get("total", 0) for o in day_orders), 2),
            "orders": len(day_orders),
        })

    return {
        "today": kpi(today_orders),
        "week": kpi(week_orders),
        "month": kpi(month_orders),
        "series": series,
        "top_items_today": _agg_top_items(today_orders, only_thali=False),
        "top_items_week": _agg_top_items(week_orders, only_thali=False),
        "top_items_month": _agg_top_items(month_orders, only_thali=False),
        "top_thalis_today": _agg_top_items(today_orders, only_thali=True),
        "top_thalis_week": _agg_top_items(week_orders, only_thali=True),
        "top_thalis_month": _agg_top_items(month_orders, only_thali=True),
        "payment_today": _agg_payment_breakdown(today_orders),
        "payment_week": _agg_payment_breakdown(week_orders),
        "payment_month": _agg_payment_breakdown(month_orders),
    }


# ------- Reports -------
async def _reports_orders(from_date: Optional[str], to_date: Optional[str]) -> list:
    db = await get_db()
    tenant = _tenant()
    s = await _fetchone(db, "SELECT data FROM settings WHERE id = 'main' AND tenant_db = ?", (tenant,))
    data = _parse_json(s.get("data") if s else None, {})
    cleared_at = data.get("reports_cleared_at")

    fd = from_date or iso(now_utc() - timedelta(days=30))
    td = to_date or iso(now_utc())

    if cleared_at and cleared_at > fd:
        fd = cleared_at

    if fd > td:
        return []

    return await _orders_in_range(fd, td)


@api.delete("/reports/reset")
async def reset_reports(_: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    now_str = iso(now_utc())
    s = await _fetchone(db, "SELECT data FROM settings WHERE id = 'main' AND tenant_db = ?", (tenant,))
    data = _parse_json(s.get("data") if s else None, {})
    data["reports_cleared_at"] = now_str
    await _execute(db,
        "INSERT INTO settings (id, tenant_db, data) VALUES ('main', ?, ?) ON CONFLICT(id, tenant_db) DO UPDATE SET data = excluded.data",
        (tenant, json_module.dumps(data)))
    return {"ok": True, "message": "Report records cleared successfully", "reports_cleared_at": now_str}


@api.get("/reports/sales")
async def report_sales(from_date: Optional[str] = None, to_date: Optional[str] = None, _: dict = Depends(get_current_user)):
    return await _reports_orders(from_date, to_date)


@api.get("/reports/products")
async def report_products(from_date: Optional[str] = None, to_date: Optional[str] = None, _: dict = Depends(get_current_user)):
    orders = await _reports_orders(from_date, to_date)
    return _agg_top_items(orders, only_thali=False, top=1000)


@api.get("/reports/thalis")
async def report_thalis(from_date: Optional[str] = None, to_date: Optional[str] = None, _: dict = Depends(get_current_user)):
    orders = await _reports_orders(from_date, to_date)
    by_name = _agg_top_items(orders, only_thali=True, top=1000)
    # also aggregate which sabji/dal selections were popular
    pick_counter: Dict[str, int] = {}
    for o in orders:
        for it in o.get("items", []):
            if not it.get("is_thali"): continue
            for _cat, names in (it.get("thali_selections") or {}).items():
                for n in names:
                    pick_counter[n] = pick_counter.get(n, 0) + it["qty"]
    top_picks = [{"name": n, "qty": q} for n, q in sorted(pick_counter.items(), key=lambda x: -x[1])[:50]]
    return {"thalis": by_name, "selection_picks": top_picks}


def _build_xlsx(rows: list, headers: list) -> bytes:
    wb = Workbook()
    ws = wb.active
    if ws is None:
        ws = wb.create_sheet()
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _build_csv(rows: list, headers: list) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


@api.get("/reports/export/{rtype}.{fmt}")
async def export_report(
    rtype: Literal["sales", "products", "thalis"],
    fmt: Literal["csv", "xlsx"],
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(get_current_user),
):
    orders = await _reports_orders(from_date, to_date)

    if rtype == "sales":
        headers = ["Receipt #", "Date", "Items", "Subtotal", "CGST", "SGST", "Total Tax", "Discount", "Total", "Payment", "Cashier"]
        rows = []
        for o in orders:
            items_txt = "; ".join(f"{i['name']} x{i['qty']}" for i in o.get("items", []))
            tax_val = float(o.get("tax", 0))
            cgst_val = float(o.get("cgst", round(tax_val / 2.0, 2)))
            sgst_val = float(o.get("sgst", round(tax_val - cgst_val, 2)))
            rows.append([
                o.get("receipt_no", ""),
                o.get("paid_at", ""),
                items_txt,
                o.get("subtotal", 0),
                cgst_val,
                sgst_val,
                tax_val,
                o.get("discount", 0),
                o.get("total", 0),
                o.get("payment_mode", ""),
                o.get("cashier_name", ""),
            ])
    elif rtype == "products":
        agg = _agg_top_items(orders, only_thali=False, top=1000)
        headers = ["Product", "Qty Sold", "Revenue (Rs)"]
        rows = [[a["name"], a["qty"], a["revenue"]] for a in agg]
    else:  # thalis
        agg = _agg_top_items(orders, only_thali=True, top=1000)
        headers = ["Thali", "Qty Sold", "Revenue (Rs)"]
        rows = [[a["name"], a["qty"], a["revenue"]] for a in agg]

    fname = f"{rtype}_{(from_date or 'all')[:10]}_{(to_date or 'now')[:10]}.{fmt}"
    if fmt == "xlsx":
        data = _build_xlsx(rows, headers)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        data = _build_csv(rows, headers)
        media = "text/csv"

    return StreamingResponse(
        iter([data]),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ------- Health -------
@api.get("/")
async def root():
    return {"ok": True, "service": "Thali POS"}


# ------- Seed -------
async def _seed_users():
    db = await get_db()
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@pos.com").lower()
    admin_pw = os.environ.get("ADMIN_PASSWORD", "admin123")
    try:
        existing = await _fetchone(db, "SELECT * FROM users WHERE email = ?", (admin_email,))
        if not existing:
            await _execute(db,
                "INSERT OR IGNORE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), admin_email, "Owner", "admin", hash_password(admin_pw), "default", iso(now_utc())))
        elif not verify_password(admin_pw, existing["password_hash"]):
            await _execute(db, "UPDATE users SET password_hash = ? WHERE email = ?",
                           (hash_password(admin_pw), admin_email))
    except Exception as e:
        logger.warning(f"Seed admin user warning: {e}")

    try:
        cashier = await _fetchone(db, "SELECT id FROM users WHERE email = ?", ("cashier@pos.com",))
        if not cashier:
            await _execute(db,
                "INSERT OR IGNORE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), "cashier@pos.com", "Cashier", "cashier", hash_password("cashier123"), "default", iso(now_utc())))
    except Exception as e:
        logger.warning(f"Seed cashier user warning: {e}")


async def _seed_settings():
    db = await get_db()
    tenant = _tenant()
    existing = await _fetchone(db, "SELECT id FROM settings WHERE id = ? AND tenant_db = ?", ("restaurant", tenant))
    if existing:
        return
    s = {
        "id": "restaurant",
        "name": "Anndevta Thali House",
        "address": "12, MG Road, Bengaluru 560001",
        "gstin": "29ABCDE1234F1Z5",
        "fssai": "",
        "phone": "+91 98765 43210",
        "gst_rate": 5.0,
        "footer_msg": "Thank you! Please visit again.",
        "show_gst": True,
        "show_payment": True,
        "show_thali_selections": False,
        "paper_width": 80,
        "font_size": "medium",
        "header_alignment": "center",
        "header_template": "classic",
        "auto_print": True,
        "receipt_prefix": "",
        "receipt_padding": 6,
        "tax_label": "GST",
        "language": "en",
    }
    await _execute(db, "INSERT INTO settings (id, tenant_db, data) VALUES (?, ?, ?)",
                   ("restaurant", tenant, _to_json(s)))


async def _seed_categories() -> dict:
    db = await get_db()
    tenant = _tenant()
    count_row = await _fetchone(db, "SELECT COUNT(*) as cnt FROM categories WHERE tenant_db = ?", (tenant,))
    if count_row["cnt"] == 0:
        for c in [
            {"name": "Dining Menu", "sort_order": 1},
            {"name": "Parcel Menu", "sort_order": 2},
            {"name": "Daily Thalis", "sort_order": 3},
        ]:
            await _execute(db, "INSERT INTO categories (id, tenant_db, name, sort_order) VALUES (?, ?, ?, ?)",
                           (new_id(), tenant, c["name"], c["sort_order"]))
    rows = await _fetchall(db, "SELECT id, name FROM categories WHERE tenant_db = ?", (tenant,))
    return {c["name"]: c["id"] for c in rows}


def _gujarati_seed_items(cat_lookup: dict) -> list:
    return [
        # Dining Menu
        {"category_id": cat_lookup.get("Dining Menu"), "name": "Unlimited Gujarati Thali", "price": 180.0, "is_thali": 1, "thali_extras": "Roti – Puri, 4 Sabzi, Dal – Bhat, Papad, Salad, Chhachh", "menu_type": "dining"},
        {"category_id": cat_lookup.get("Dining Menu"), "name": "Unlimited Gujarati Thali (Sweet & Farsan Included)", "price": 280.0, "is_thali": 1, "thali_extras": "Roti – Puri, 4 Sabzi, Dal – Bhat, Papad, Salad, Chhachh, Sweet – 1, Farsan – 2", "menu_type": "dining"},
        {"category_id": cat_lookup.get("Dining Menu"), "name": "Roti Sabzi (8 Roti + 1 Sabzi)", "price": 120.0, "is_thali": 0, "thali_extras": "8 Roti + 1 Sabzi", "menu_type": "dining"},
        {"category_id": cat_lookup.get("Dining Menu"), "name": "Puri Sabzi (8 Puri + 1 Sabzi)", "price": 120.0, "is_thali": 0, "thali_extras": "8 Puri + 1 Sabzi", "menu_type": "dining"},

        # Parcel Menu
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Fixed Gujarati Thali (aapke tiffin mein)", "price": 150.0, "is_thali": 1, "thali_extras": "Fixed Gujarati Thali in your tiffin", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Fixed Gujarati Thali (hamare container mein)", "price": 160.0, "is_thali": 1, "thali_extras": "Fixed Gujarati Thali in container", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Roti Sabzi (1 Sabzi + 6 Roti)", "price": 120.0, "is_thali": 0, "thali_extras": "1 Sabzi + 6 Roti", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Puri Sabzi (1 Sabzi + 6 Puri)", "price": 120.0, "is_thali": 0, "thali_extras": "1 Sabzi + 6 Puri", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Punjabi Sabzi", "price": 80.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Extra Sweet", "price": 50.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Extra Farsan", "price": 30.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Sabzi", "price": 60.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Dal", "price": 40.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Bhat", "price": 40.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Khichdi", "price": 40.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Kadhi", "price": 40.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Extra Sabzi Bhaji", "price": 10.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Extra Roti", "price": 7.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Papad", "price": 10.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},
        {"category_id": cat_lookup.get("Parcel Menu"), "name": "Chhachh", "price": 15.0, "is_thali": 0, "thali_extras": "", "menu_type": "parcel"},

        # Daily Thalis
        {"category_id": cat_lookup.get("Daily Thalis"), "name": "Savar Ki Gujarati Thali", "price": 150.0, "is_thali": 1, "thali_extras": "2 Sabzi, Dal, Bhat, Salad, Papad, 6 Roti", "menu_type": "both"},
        {"category_id": cat_lookup.get("Daily Thalis"), "name": "Shaam Ki Gujarati Thali", "price": 150.0, "is_thali": 1, "thali_extras": "2 Sabzi, 1 Khichdi-Kadhi, Papad, Salad, 4 Bhakhri ya 6 Roti", "menu_type": "both"},
    ]


async def _seed_menu(cat_lookup: dict):
    db = await get_db()
    tenant = _tenant()
    count_row = await _fetchone(db, "SELECT COUNT(*) as cnt FROM menu WHERE tenant_db = ?", (tenant,))
    if count_row["cnt"] > 0:
        return
    for item in _gujarati_seed_items(cat_lookup):
        await _execute(db,
            """INSERT INTO menu (id, tenant_db, name, category_id, price, available, is_thali, thali_groups, thali_extras, menuType, menu_type)
               VALUES (?, ?, ?, ?, ?, 1, ?, '[]', ?, ?, ?)""",
            (new_id(), tenant, item["name"], item["category_id"], item["price"], item["is_thali"],
             item["thali_extras"], item["menu_type"], item["menu_type"]))


async def seed_defaults():
    try:
        await _seed_users()
        await _seed_settings()
        cat_lookup = await _seed_categories()
        await _seed_menu(cat_lookup)
    except Exception as e:
        logger.warning(f"Seed defaults warning: {e}")



# ======= INVENTORY MODULE =======

# ------- Inventory Dashboard -------
@api.get("/inventory/dashboard")
async def inventory_dashboard(_: dict = Depends(require_roles("admin"))):
    """Aggregated inventory KPIs."""
    db = await get_db()
    tenant = _tenant()
    all_items = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ?", (tenant,))
    for it in all_items:
        it = _menu_row_to_dict(it)
    tracked = [i for i in all_items if i.get("current_stock") is not None]
    total_value = sum((i.get("current_stock", 0) * (i.get("unit_cost") or i.get("price") or 0)) for i in tracked)
    low_stock = [i for i in tracked if 0 < (i.get("current_stock") or 0) <= (i.get("reorder_level") or 10)]
    out_of_stock = [i for i in tracked if (i.get("current_stock") or 0) <= 0]

    # Recent activity
    recent_txns = await _fetchall(db,
        "SELECT * FROM inventory_transactions WHERE tenant_db = ? ORDER BY created_at DESC LIMIT 20", (tenant,))

    # Unread alerts
    alerts = await _fetchall(db,
        "SELECT * FROM stock_alerts WHERE tenant_db = ? AND is_resolved = 0 ORDER BY created_at DESC LIMIT 20", (tenant,))

    # Top moving products (by total absolute qty_change in last 30 days)
    cutoff = iso(now_utc() - timedelta(days=30))
    recent_sales = await _fetchall(db,
        "SELECT * FROM inventory_transactions WHERE tenant_db = ? AND type = 'sale' AND created_at >= ?",
        (tenant, cutoff))
    move_counter: Dict[str, float] = {}
    for tx in recent_sales:
        pid = tx["product_id"]
        move_counter[pid] = move_counter.get(pid, 0) + abs(tx.get("qty_change", 0))
    top_movers_ids = sorted(move_counter.items(), key=lambda x: -x[1])[:10]
    top_movers = []
    for pid, qty in top_movers_ids:
        item = await _fetchone(db, "SELECT name, current_stock FROM menu WHERE id = ? AND tenant_db = ?", (pid, tenant))
        if item:
            top_movers.append({"name": item["name"], "qty_sold": round(qty, 3), "current_stock": item.get("current_stock")})

    # Today's Consumption
    today_start = iso(now_utc().replace(hour=0, minute=0, second=0, microsecond=0))
    today_sales = await _fetchall(db,
        "SELECT qty_change FROM inventory_transactions WHERE tenant_db = ? AND type = 'sale' AND created_at >= ?",
        (tenant, today_start))
    todays_consumption = round(sum(abs(tx.get("qty_change", 0)) for tx in today_sales), 3)

    # Unmapped items
    unmapped_items_count = sum(1 for i in all_items if (i.get("portion_weight_kg") or 0) <= 0)

    return {
        "total_value": round(total_value, 2),
        "total_products": len(tracked),
        "low_stock_count": len(low_stock),
        "out_of_stock_count": len(out_of_stock),
        "low_stock_items": [{"id": i["id"], "name": i["name"], "current_stock": i.get("current_stock", 0), "reorder_level": i.get("reorder_level", 10)} for i in low_stock[:10]],
        "out_of_stock_items": [{"id": i["id"], "name": i["name"]} for i in out_of_stock[:10]],
        "recent_activity": recent_txns,
        "alerts": alerts,
        "top_movers": top_movers,
        "todays_consumption_kg": todays_consumption,
        "unmapped_items_count": unmapped_items_count
    }


# ------- Stock Management -------
@api.get("/inventory/stock")
async def list_stock(
    q: Optional[str] = None,
    status: Optional[str] = None,
    _: dict = Depends(require_roles("admin")),
):
    """All products with stock levels."""
    db = await get_db()
    tenant = _tenant()
    items = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ?", (tenant,))
    result = []
    for it in items:
        it = _menu_row_to_dict(it)
        stock = it.get("current_stock")
        reorder = it.get("reorder_level") or 10
        if stock is None:
            stock_status = "untracked"
        elif stock <= 0:
            stock_status = "out_of_stock"
        elif stock <= reorder:
            stock_status = "low_stock"
        else:
            stock_status = "in_stock"
        it["stock_status"] = stock_status
        if status and status != "all" and stock_status != status:
            continue
        if q:
            ql = q.lower()
            if not (ql in it.get("name", "").lower() or ql in (it.get("sku") or "").lower() or ql in (it.get("barcode") or "").lower()):
                continue
        it.pop("tenant_db", None)
        result.append(it)
    return result


@api.patch("/inventory/stock/{mid}")
async def update_inventory_fields(mid: str, body: MenuItemInventoryUpdate, _: dict = Depends(require_roles("admin"))):
    """Update inventory fields for a menu item."""
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    set_parts = []
    params = []
    for k, v in data.items():
        set_parts.append(f"{k} = ?")
        params.append(v)
    params.extend([mid, tenant])
    await _execute(db, f"UPDATE menu SET {', '.join(set_parts)} WHERE id = ? AND tenant_db = ?", params)
    updated = await _fetchone(db, "SELECT * FROM menu WHERE id = ? AND tenant_db = ?", (mid, tenant))
    if not updated:
        raise HTTPException(404, "Product not found")
    updated = _menu_row_to_dict(updated)
    updated.pop("tenant_db", None)
    return updated


class StockChangeIn(BaseModel):
    qty: int
    remarks: str = ""


@api.post("/inventory/stock/{mid}/add")
async def add_stock(mid: str, body: StockChangeIn, user: dict = Depends(require_roles("admin"))):
    """Add stock to a product."""
    db = await get_db()
    tenant = _tenant()
    if body.qty <= 0:
        raise HTTPException(400, "Quantity must be positive")
    result = await _update_stock_and_record(
        product_id=mid, qty_change=body.qty, tx_type="adjustment",
        user_id=user.get("id", ""), remarks=body.remarks or "Manual stock addition",
    )
    if result is None:
        # Item not tracked yet, enable tracking
        item = await _fetchone(db, "SELECT id FROM menu WHERE id = ? AND tenant_db = ?", (mid, tenant))
        if not item:
            raise HTTPException(404, "Product not found")
        await _execute(db, "UPDATE menu SET current_stock = ? WHERE id = ? AND tenant_db = ?", (body.qty, mid, tenant))
        tx = await _record_inventory_transaction(
            product_id=mid, qty_change=body.qty, tx_type="adjustment",
            user_id=user.get("id", ""), remarks=body.remarks or "Initial stock entry",
        )
        return {"new_stock": body.qty, "transaction": tx}
    return result


@api.post("/inventory/stock/{mid}/remove")
async def remove_stock(mid: str, body: StockChangeIn, user: dict = Depends(require_roles("admin"))):
    """Remove stock from a product."""
    if body.qty <= 0:
        raise HTTPException(400, "Quantity must be positive")
    result = await _update_stock_and_record(
        product_id=mid, qty_change=-body.qty, tx_type="adjustment",
        user_id=user.get("id", ""), remarks=body.remarks or "Manual stock removal",
    )
    if result is None:
        raise HTTPException(400, "Inventory not tracked for this product")
    return result


@api.post("/inventory/adjust")
async def adjust_stock(body: StockAdjustmentIn, user: dict = Depends(require_roles("admin"))):
    """Manual stock adjustment with full audit."""
    db = await get_db()
    tenant = _tenant()
    item = await _fetchone(db, "SELECT * FROM menu WHERE id = ? AND tenant_db = ?", (body.product_id, tenant))
    if not item:
        raise HTTPException(404, "Product not found")
    item = _menu_row_to_dict(item)
    old_stock = item.get("current_stock", 0) or 0
    new_stock = max(0, old_stock + body.qty_change)
    await _execute(db, "UPDATE menu SET current_stock = ? WHERE id = ? AND tenant_db = ?",
                   (new_stock, body.product_id, tenant))
    adj = {
        "id": new_id(),
        "product_id": body.product_id,
        "qty_before": old_stock,
        "qty_after": new_stock,
        "qty_change": body.qty_change,
        "reason": body.reason,
        "user_id": user.get("id", ""),
        "remarks": body.remarks,
        "created_at": iso(now_utc()),
    }
    await _execute(db,
        """INSERT INTO stock_adjustments (id, tenant_db, product_id, qty_before, qty_after, qty_change, reason, user_id, remarks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (adj["id"], tenant, adj["product_id"], adj["qty_before"], adj["qty_after"],
         adj["qty_change"], adj["reason"], adj["user_id"], adj["remarks"], adj["created_at"]))
    tx_type = "damage" if body.reason in ("damage", "loss") else "adjustment"
    await _record_inventory_transaction(
        product_id=body.product_id, qty_change=body.qty_change, tx_type=tx_type,
        reference_id=adj["id"], user_id=user.get("id", ""),
        remarks=f"{body.reason}: {body.remarks}",
    )
    reorder = item.get("reorder_level") or 10
    if new_stock <= reorder:
        await _create_stock_alert(body.product_id, item["name"], new_stock, reorder)
    return {"adjustment": adj, "new_stock": new_stock}


# ------- Inventory Transactions Ledger -------
@api.get("/inventory/transactions")
async def list_inventory_transactions(
    product_id: Optional[str] = None,
    tx_type: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    limit: int = 200,
    _: dict = Depends(require_roles("admin")),
):
    db = await get_db()
    tenant = _tenant()
    conditions = ["tenant_db = ?"]
    params: list = [tenant]
    if product_id:
        conditions.append("product_id = ?")
        params.append(product_id)
    if tx_type:
        conditions.append("type = ?")
        params.append(tx_type)
    if from_date:
        conditions.append("created_at >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("created_at <= ?")
        params.append(to_date)
    where = " AND ".join(conditions)
    params.append(limit)
    txns = await _fetchall(db,
        f"SELECT * FROM inventory_transactions WHERE {where} ORDER BY created_at DESC LIMIT ?", params)
    # Enrich with product name
    product_cache = {}
    for tx in txns:
        pid = tx.get("product_id")
        if pid and pid not in product_cache:
            p = await _fetchone(db, "SELECT name FROM menu WHERE id = ? AND tenant_db = ?", (pid, tenant))
            product_cache[pid] = p.get("name", "Unknown") if p else "Deleted"
        tx["product_name"] = product_cache.get(pid, "Unknown")
        tx.pop("tenant_db", None)
    return txns


# ------- Stock Alerts -------
@api.get("/inventory/alerts")
async def list_alerts(resolved: Optional[bool] = None, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    conditions = ["tenant_db = ?"]
    params: list = [tenant]
    if resolved is not None:
        conditions.append("is_resolved = ?")
        params.append(1 if resolved else 0)
    where = " AND ".join(conditions)
    rows = await _fetchall(db,
        f"SELECT * FROM stock_alerts WHERE {where} ORDER BY created_at DESC LIMIT 100", params)
    for r in rows:
        r.pop("tenant_db", None)
    return rows


@api.get("/inventory/alerts/count")
async def alert_count(_: dict = Depends(get_current_user)):
    """Unread alert count for nav badge."""
    db = await get_db()
    tenant = _tenant()
    row = await _fetchone(db,
        "SELECT COUNT(*) as count FROM stock_alerts WHERE tenant_db = ? AND is_resolved = 0 AND is_read = 0",
        (tenant,))
    return {"count": row["count"] if row else 0}


@api.patch("/inventory/alerts/{aid}/read")
async def mark_alert_read(aid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    await _execute(db, "UPDATE stock_alerts SET is_read = 1 WHERE id = ?", (aid,))
    return {"ok": True}


@api.patch("/inventory/alerts/{aid}/resolve")
async def resolve_alert(aid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    await _execute(db, "UPDATE stock_alerts SET is_resolved = 1, updated_at = ? WHERE id = ?",
                   (iso(now_utc()), aid))
    return {"ok": True}


# ------- Suppliers -------
@api.get("/inventory/suppliers")
async def list_suppliers(_: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    rows = await _fetchall(db,
        "SELECT * FROM suppliers WHERE tenant_db = ? AND is_active = 1 ORDER BY name ASC", (tenant,))
    for r in rows:
        r.pop("tenant_db", None)
    return rows


@api.post("/inventory/suppliers")
async def create_supplier(body: SupplierIn, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    obj = {"id": new_id(), **body.model_dump(), "is_active": True, "created_at": iso(now_utc())}
    await _execute(db,
        """INSERT INTO suppliers (id, tenant_db, name, contact_person, phone, email, address, gstin, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (obj["id"], tenant, obj["name"], obj["contact_person"], obj["phone"],
         obj["email"], obj["address"], obj["gstin"], 1, obj["created_at"]))
    return obj


@api.put("/inventory/suppliers/{sid}")
async def update_supplier(sid: str, body: SupplierIn, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    set_parts = ", ".join(f"{k} = ?" for k in data)
    params = list(data.values()) + [sid, tenant]
    await _execute(db, f"UPDATE suppliers SET {set_parts} WHERE id = ? AND tenant_db = ?", params)
    row = await _fetchone(db, "SELECT * FROM suppliers WHERE id = ? AND tenant_db = ?", (sid, tenant))
    if row:
        row.pop("tenant_db", None)
    return row


@api.delete("/inventory/suppliers/{sid}")
async def delete_supplier(sid: str, _: dict = Depends(require_roles("admin"))):
    """Soft delete."""
    db = await get_db()
    tenant = _tenant()
    await _execute(db, "UPDATE suppliers SET is_active = 0 WHERE id = ? AND tenant_db = ?", (sid, tenant))
    return {"ok": True}


# ------- Purchase Orders -------
@api.get("/inventory/purchase-orders")
async def list_purchase_orders(
    status: Optional[str] = None,
    _: dict = Depends(require_roles("admin")),
):
    db = await get_db()
    tenant = _tenant()
    conditions = ["tenant_db = ?"]
    params: list = [tenant]
    if status and status != "all":
        conditions.append("status = ?")
        params.append(status)
    where = " AND ".join(conditions)
    pos = await _fetchall(db,
        f"SELECT * FROM purchase_orders WHERE {where} ORDER BY created_at DESC LIMIT 500", params)
    for po in pos:
        po["items"] = _parse_json(po.get("items"), [])
        sup = await _fetchone(db, "SELECT name FROM suppliers WHERE id = ? AND tenant_db = ?",
                              (po.get("supplier_id"), tenant))
        po["supplier_name"] = sup["name"] if sup else "Unknown"
        po.pop("tenant_db", None)
    return pos


async def _next_po_number() -> int:
    db = await get_db()
    tenant = _tenant()
    row = await _fetchone(db, "SELECT value FROM counters WHERE id = ? AND tenant_db = ?", ("purchase_order", tenant))
    if row:
        new_val = row["value"] + 1
        await _execute(db, "UPDATE counters SET value = ? WHERE id = ? AND tenant_db = ?", (new_val, "purchase_order", tenant))
        return new_val
    else:
        await _execute(db, "INSERT INTO counters (id, tenant_db, value) VALUES (?, ?, ?)", ("purchase_order", tenant, 1))
        return 1


@api.post("/inventory/purchase-orders")
async def create_purchase_order(body: PurchaseOrderIn, user: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    po_num = await _next_po_number()
    total = sum(i.qty * i.unit_cost for i in body.items)
    items_data = []
    for i in body.items:
        d = i.model_dump()
        if not d.get("product_name"):
            p = await _fetchone(db, "SELECT name FROM menu WHERE id = ? AND tenant_db = ?", (d["product_id"], tenant))
            d["product_name"] = p["name"] if p else "Unknown"
        items_data.append(d)
    po = {
        "id": new_id(),
        "po_number": po_num,
        "supplier_id": body.supplier_id,
        "items": items_data,
        "status": "draft",
        "total_amount": round(total, 2),
        "notes": body.notes,
        "created_by": user.get("id", ""),
        "created_at": iso(now_utc()),
        "ordered_at": None,
        "received_at": None,
    }
    await _execute(db,
        """INSERT INTO purchase_orders (id, tenant_db, po_number, supplier_id, items, status, total_amount, notes, created_by, created_at, ordered_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (po["id"], tenant, po["po_number"], po["supplier_id"], _to_json(po["items"]),
         po["status"], po["total_amount"], po["notes"], po["created_by"], po["created_at"],
         po["ordered_at"], po["received_at"]))
    return po


@api.get("/inventory/purchase-orders/{pid}")
async def get_purchase_order(pid: str, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    po = await _fetchone(db, "SELECT * FROM purchase_orders WHERE id = ? AND tenant_db = ?", (pid, tenant))
    if not po:
        raise HTTPException(404, "Purchase order not found")
    po["items"] = _parse_json(po.get("items"), [])
    sup = await _fetchone(db, "SELECT name FROM suppliers WHERE id = ? AND tenant_db = ?",
                          (po.get("supplier_id"), tenant))
    po["supplier_name"] = sup["name"] if sup else "Unknown"
    po.pop("tenant_db", None)
    return po


class POStatusUpdate(BaseModel):
    status: Literal["draft", "ordered", "partial", "received", "cancelled"]


@api.patch("/inventory/purchase-orders/{pid}/status")
async def update_po_status(pid: str, body: POStatusUpdate, _: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    updates = {"status": body.status}
    if body.status == "ordered":
        updates["ordered_at"] = iso(now_utc())
    elif body.status == "received":
        updates["received_at"] = iso(now_utc())
    set_parts = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [pid, tenant]
    await _execute(db, f"UPDATE purchase_orders SET {set_parts} WHERE id = ? AND tenant_db = ?", params)
    po = await _fetchone(db, "SELECT * FROM purchase_orders WHERE id = ? AND tenant_db = ?", (pid, tenant))
    if po:
        po["items"] = _parse_json(po.get("items"), [])
        po.pop("tenant_db", None)
    return po


@api.post("/inventory/purchase-orders/{pid}/receive")
async def receive_goods(pid: str, body: GoodsReceivedIn, user: dict = Depends(require_roles("admin"))):
    """GRN — Receive goods against a PO, auto-increase stock."""
    db = await get_db()
    tenant = _tenant()
    po = await _fetchone(db, "SELECT * FROM purchase_orders WHERE id = ? AND tenant_db = ?", (pid, tenant))
    if not po:
        raise HTTPException(404, "Purchase order not found")
    po["items"] = _parse_json(po.get("items"), [])
    if po["status"] == "cancelled":
        raise HTTPException(400, "Cannot receive goods for a cancelled PO")

    results = []
    for gi in body.items:
        result = await _update_stock_and_record(
            product_id=gi.product_id, qty_change=gi.qty_received, tx_type="purchase",
            reference_id=pid, user_id=user.get("id", ""),
            remarks=f"PO #{po['po_number']}: {body.notes}",
        )
        if result is None:
            item = await _fetchone(db, "SELECT id FROM menu WHERE id = ? AND tenant_db = ?", (gi.product_id, tenant))
            if item:
                await _execute(db, "UPDATE menu SET current_stock = ? WHERE id = ? AND tenant_db = ?",
                               (gi.qty_received, gi.product_id, tenant))
                await _record_inventory_transaction(
                    product_id=gi.product_id, qty_change=gi.qty_received, tx_type="purchase",
                    reference_id=pid, user_id=user.get("id", ""),
                    remarks=f"PO #{po['po_number']}: {body.notes}",
                )
                result = {"new_stock": gi.qty_received}
        results.append({"product_id": gi.product_id, "qty_received": gi.qty_received, **(result or {})})

    await _execute(db,
        "UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ? AND tenant_db = ?",
        (iso(now_utc()), pid, tenant))
    return {"po_id": pid, "results": results}


# ------- Inventory Reports -------
@api.get("/inventory/reports/current-stock")
async def report_current_stock(_: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    items = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ? AND current_stock IS NOT NULL", (tenant,))
    return [{"id": i["id"], "name": i["name"], "sku": i.get("sku", ""), "barcode": i.get("barcode", ""),
             "category_id": i.get("category_id", ""), "current_stock": i.get("current_stock", 0),
             "reorder_level": i.get("reorder_level", 10), "unit_cost": i.get("unit_cost", 0),
             "price": i.get("price", 0),
             "stock_value": round((i.get("current_stock") or 0) * (i.get("unit_cost") or i.get("price") or 0), 2),
             } for i in items]


@api.get("/inventory/reports/valuation")
async def report_valuation(_: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    items = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ? AND current_stock IS NOT NULL", (tenant,))
    rows = []
    total_cost = 0.0
    total_retail = 0.0
    for i in items:
        cost_val = (i.get("current_stock") or 0) * (i.get("unit_cost") or i.get("price") or 0)
        retail_val = (i.get("current_stock") or 0) * (i.get("price") or 0)
        total_cost += cost_val
        total_retail += retail_val
        rows.append({"id": i["id"], "name": i["name"], "current_stock": i.get("current_stock", 0),
                     "unit_cost": i.get("unit_cost", 0), "price": i.get("price", 0),
                     "cost_value": round(cost_val, 2), "retail_value": round(retail_val, 2)})
    return {"items": rows, "total_cost_value": round(total_cost, 2), "total_retail_value": round(total_retail, 2)}


@api.get("/inventory/reports/movement")
async def report_movement(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_roles("admin")),
):
    db = await get_db()
    tenant = _tenant()
    fd = from_date or iso(now_utc() - timedelta(days=30))
    td = to_date or iso(now_utc())
    txns = await _fetchall(db,
        "SELECT * FROM inventory_transactions WHERE tenant_db = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 10000",
        (tenant, fd, td))
    by_product: Dict[str, dict] = {}
    for tx in txns:
        pid = tx["product_id"]
        if pid not in by_product:
            p = await _fetchone(db, "SELECT name, current_stock FROM menu WHERE id = ? AND tenant_db = ?", (pid, tenant))
            by_product[pid] = {"product_id": pid, "name": p.get("name", "?") if p else "Deleted",
                               "current_stock": p.get("current_stock", 0) if p else 0,
                               "total_in": 0, "total_out": 0, "net": 0}
        chg = tx.get("qty_change", 0)
        if chg > 0:
            by_product[pid]["total_in"] += chg
        else:
            by_product[pid]["total_out"] += abs(chg)
        by_product[pid]["net"] += chg
    return list(by_product.values())


@api.get("/inventory/reports/low-stock")
async def report_low_stock(_: dict = Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    items = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ? AND current_stock IS NOT NULL", (tenant,))
    low = [i for i in items if (i.get("current_stock") or 0) <= (i.get("reorder_level") or 10)]
    return [{"id": i["id"], "name": i["name"], "current_stock": i.get("current_stock", 0),
             "reorder_level": i.get("reorder_level", 10), "min_stock": i.get("min_stock", 5),
             "deficit": max(0, (i.get("reorder_level") or 10) - (i.get("current_stock") or 0))} for i in low]


@api.get("/inventory/reports/dead-stock")
async def report_dead_stock(
    days: int = 30,
    _: dict = Depends(require_roles("admin")),
):
    """Items with zero sales in the given period."""
    db = await get_db()
    tenant = _tenant()
    cutoff = iso(now_utc() - timedelta(days=days))
    sold_txns = await _fetchall(db,
        "SELECT product_id FROM inventory_transactions WHERE tenant_db = ? AND type = 'sale' AND created_at >= ?",
        (tenant, cutoff))
    sold_ids = set(tx["product_id"] for tx in sold_txns)
    tracked = await _fetchall(db, "SELECT * FROM menu WHERE tenant_db = ? AND current_stock IS NOT NULL", (tenant,))
    dead = [i for i in tracked if i["id"] not in sold_ids and (i.get("current_stock") or 0) > 0]
    return [{"id": i["id"], "name": i["name"], "current_stock": i.get("current_stock", 0),
             "unit_cost": i.get("unit_cost", 0),
             "stock_value": round((i.get("current_stock") or 0) * (i.get("unit_cost") or i.get("price") or 0), 2),
             "days_no_sale": days} for i in dead]


@api.get("/inventory/reports/purchases")
async def report_purchases(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_roles("admin")),
):
    db = await get_db()
    tenant = _tenant()
    conditions = ["tenant_db = ?"]
    params: list = [tenant]
    if from_date:
        conditions.append("created_at >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("created_at <= ?")
        params.append(to_date)
    where = " AND ".join(conditions)
    pos = await _fetchall(db,
        f"SELECT * FROM purchase_orders WHERE {where} ORDER BY created_at DESC LIMIT 1000", params)
    for po in pos:
        po["items"] = _parse_json(po.get("items"), [])
        sup = await _fetchone(db, "SELECT name FROM suppliers WHERE id = ? AND tenant_db = ?",
                              (po.get("supplier_id"), tenant))
        po["supplier_name"] = sup["name"] if sup else "Unknown"
        po.pop("tenant_db", None)
    return pos


@api.get("/inventory/reports/export/{rtype}.{fmt}")
async def export_inventory_report(
    rtype: Literal["current-stock", "valuation", "low-stock", "dead-stock", "movement", "purchases"],
    fmt: Literal["csv", "xlsx"],
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _: dict = Depends(require_roles("admin")),
):
    if rtype == "current-stock":
        data = await report_current_stock(_)
        headers = ["Name", "SKU", "Barcode", "Stock", "Reorder Level", "Unit Cost", "Price", "Stock Value"]
        rows = [[d["name"], d["sku"], d["barcode"], d["current_stock"], d["reorder_level"],
                 d["unit_cost"], d["price"], d["stock_value"]] for d in data]
    elif rtype == "valuation":
        data = await report_valuation(_)
        headers = ["Name", "Stock", "Unit Cost", "Price", "Cost Value", "Retail Value"]
        rows = [[d["name"], d["current_stock"], d["unit_cost"], d["price"],
                 d["cost_value"], d["retail_value"]] for d in data["items"]]
    elif rtype == "low-stock":
        data = await report_low_stock(_)
        headers = ["Name", "Current Stock", "Reorder Level", "Min Stock", "Deficit"]
        rows = [[d["name"], d["current_stock"], d["reorder_level"], d["min_stock"], d["deficit"]] for d in data]
    elif rtype == "dead-stock":
        data = await report_dead_stock(days=30, _=_)
        headers = ["Name", "Current Stock", "Unit Cost", "Stock Value", "Days No Sale"]
        rows = [[d["name"], d["current_stock"], d["unit_cost"], d["stock_value"], d["days_no_sale"]] for d in data]
    elif rtype == "movement":
        data = await report_movement(from_date=from_date, to_date=to_date, _=_)
        headers = ["Name", "Current Stock", "Total In", "Total Out", "Net"]
        rows = [[d["name"], d["current_stock"], d["total_in"], d["total_out"], d["net"]] for d in data]
    else:  # purchases
        data = await report_purchases(from_date=from_date, to_date=to_date, _=_)
        headers = ["PO #", "Supplier", "Status", "Total", "Created", "Received"]
        rows = [[d.get("po_number"), d.get("supplier_name"), d.get("status"),
                 d.get("total_amount"), d.get("created_at", ""), d.get("received_at", "")] for d in data]

    fname = f"inventory_{rtype}_{(from_date or 'all')[:10]}_{(to_date or 'now')[:10]}.{fmt}"
    if fmt == "xlsx":
        file_data = _build_xlsx(rows, headers)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        file_data = _build_csv(rows, headers)
        media = "text/csv"

    return StreamingResponse(
        iter([file_data]),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origin_regex=".*",
    allow_methods=["*"],
    allow_headers=["*"],
)


@api.post("/backup/create")
async def create_backup(_user=Depends(require_roles("admin"))):
    """Create a complete backup of all collections."""
    db = await get_db()
    tenant = _tenant()
    
    backup_data = {
        "timestamp": iso(now_utc()),
        "version": "1.0.0",
        "collections": {}
    }
    
    collections = ["settings", "categories", "menu", "templates", "orders", "counters",
                   "inventory_transactions", "suppliers", "purchase_orders", "stock_adjustments", "stock_alerts"]
    for coll_name in collections:
        if coll_name == "settings":
            rows = await _fetchall(db, "SELECT * FROM settings WHERE tenant_db = ?", (tenant,))
            for r in rows:
                r["_data"] = _parse_json(r.pop("data", "{}"), {})
        else:
            rows = await _fetchall(db, f"SELECT * FROM {coll_name} WHERE tenant_db = ?", (tenant,))
        # Parse JSON fields in specific tables
        for r in rows:
            r.pop("tenant_db", None)
            if coll_name in ("orders",):
                r["items"] = _parse_json(r.get("items"), [])
            elif coll_name in ("templates",):
                r["item_ids"] = _parse_json(r.get("item_ids"), [])
            elif coll_name in ("menu",):
                r["thali_groups"] = _parse_json(r.get("thali_groups"), [])
                r["available"] = bool(r.get("available"))
                r["is_thali"] = bool(r.get("is_thali"))
            elif coll_name in ("purchase_orders",):
                r["items"] = _parse_json(r.get("items"), [])
        backup_data["collections"][coll_name] = rows
    
    # Also backup users for this tenant
    users = await _fetchall(db, "SELECT id, email, name, role, tenant_id, created_at, status FROM users WHERE tenant_id = ?",
                            (tenant if tenant != "default" else "default",))
    backup_data["collections"]["users"] = users
    
    json_str = json_module.dumps(backup_data, indent=2, default=str)
    return Response(content=json_str, media_type="application/json")


@api.post("/backup/restore")
async def restore_backup(request: Request, _user=Depends(require_roles("admin"))):
    """Restore database from backup file."""
    db = await get_db()
    tenant = _tenant()
    
    body = await request.body()
    backup_data = json_module.loads(body.decode("utf-8"))
    
    if "collections" not in backup_data or "timestamp" not in backup_data:
        raise HTTPException(status_code=400, detail="Invalid backup file format")
    
    allowed = ["settings", "categories", "menu", "templates", "orders", "counters",
               "inventory_transactions", "suppliers", "purchase_orders", "stock_adjustments", "stock_alerts"]
    
    for coll_name, docs in backup_data["collections"].items():
        if coll_name not in allowed:
            continue
        # Clear existing data for this tenant
        await _execute(db, f"DELETE FROM {coll_name} WHERE tenant_db = ?", (tenant,))
        
        for doc in docs:
            doc["tenant_db"] = tenant
            if coll_name == "settings":
                data = doc.pop("_data", doc)
                await _execute(db, "INSERT INTO settings (id, tenant_db, data) VALUES (?, ?, ?)",
                               (doc.get("id", "restaurant"), tenant, _to_json(data)))
            elif coll_name == "orders":
                doc["items"] = _to_json(doc.get("items", []))
                cols = list(doc.keys())
                placeholders = ", ".join(["?"] * len(cols))
                col_str = ", ".join(cols)
                await _execute(db, f"INSERT INTO {coll_name} ({col_str}) VALUES ({placeholders})", list(doc.values()))
            elif coll_name == "templates":
                doc["item_ids"] = _to_json(doc.get("item_ids", []))
                cols = list(doc.keys())
                placeholders = ", ".join(["?"] * len(cols))
                col_str = ", ".join(cols)
                await _execute(db, f"INSERT INTO {coll_name} ({col_str}) VALUES ({placeholders})", list(doc.values()))
            elif coll_name == "menu":
                doc["thali_groups"] = _to_json(doc.get("thali_groups", []))
                doc["available"] = 1 if doc.get("available") else 0
                doc["is_thali"] = 1 if doc.get("is_thali") else 0
                cols = list(doc.keys())
                placeholders = ", ".join(["?"] * len(cols))
                col_str = ", ".join(cols)
                await _execute(db, f"INSERT INTO {coll_name} ({col_str}) VALUES ({placeholders})", list(doc.values()))
            elif coll_name == "purchase_orders":
                doc["items"] = _to_json(doc.get("items", []))
                cols = list(doc.keys())
                placeholders = ", ".join(["?"] * len(cols))
                col_str = ", ".join(cols)
                await _execute(db, f"INSERT INTO {coll_name} ({col_str}) VALUES ({placeholders})", list(doc.values()))
            else:
                cols = list(doc.keys())
                placeholders = ", ".join(["?"] * len(cols))
                col_str = ", ".join(cols)
                await _execute(db, f"INSERT INTO {coll_name} ({col_str}) VALUES ({placeholders})", list(doc.values()))
    
    return {"status": "success", "restored_at": iso(now_utc()), "backup_timestamp": backup_data["timestamp"]}


@api.get("/backup/last")
async def get_last_backup(_user=Depends(require_roles("admin"))):
    """Get last backup timestamp from settings or local storage."""
    return {"last_backup": None}


@app.get("/api/health")
async def health_check():
    """Lightweight liveness probe used by the Electron main process."""
    try:
        db = await get_db()
        await db.execute("SELECT 1")
        return {"status": "ok", "version": "1.0.0", "database": "connected"}
    except Exception as e:
        logger.error("[HEALTH] Database connection check failed: %s", e)
        raise HTTPException(status_code=500, detail="Database connection failed")



# ==========================================
# PAYROLL & HR MODULE MODELS
# ==========================================

class EmployeeIn(BaseModel):
    user_id: Optional[str] = None
    full_name: str
    photo_url: Optional[str] = ""
    mobile: Optional[str] = ""
    email: Optional[str] = ""
    address: Optional[str] = ""
    emergency_contact: Optional[str] = ""
    designation: str
    department: str
    joining_date: str
    employment_type: Literal["Full-Time", "Part-Time", "Contract"]
    bank_name: Optional[str] = ""
    bank_account: Optional[str] = ""
    ifsc_code: Optional[str] = ""
    pan_number: Optional[str] = ""
    aadhaar_number: Optional[str] = ""
    uan_number: Optional[str] = ""
    notes: Optional[str] = ""
    status: Literal["Active", "Inactive"] = "Active"

class SalaryStructureIn(BaseModel):
    wage_type: Literal["Fixed", "Hourly"] = "Fixed"
    basic_salary: float = 0
    hra: float = 0
    conveyance: float = 0
    medical: float = 0
    special_allowance: float = 0
    pf_deduction: float = 0
    esi_deduction: float = 0
    professional_tax: float = 0
    hourly_rate: float = 0

class AttendanceRecordIn(BaseModel):
    employee_id: str
    date: str  # YYYY-MM-DD
    status: Literal["Present", "Absent", "Half-Day", "Leave", "Holiday"]
    check_in: Optional[str] = None
    check_out: Optional[str] = None
    overtime_hours: float = 0
    late_mark: bool = False

class AttendanceBulkIn(BaseModel):
    records: List[AttendanceRecordIn]

class LeaveRequestIn(BaseModel):
    employee_id: str
    type: Literal["Casual Leave", "Sick Leave", "Paid Leave", "Unpaid Leave"]
    start_date: str
    end_date: str
    reason: str
    status: Literal["Pending", "Approved", "Rejected"] = "Pending"

class BiometricSyncIn(BaseModel):
    device_id: str
    employee_id: str
    timestamp: str # ISO string
    scan_type: Literal["check-in", "check-out"]

class SalaryAdvanceIn(BaseModel):
    employee_id: str
    amount: float
    emi_amount: float
    reason: str
    status: Literal["Pending", "Approved", "Rejected"] = "Pending"

class PayrollProcessIn(BaseModel):
    month: int
    year: int

class PayrollStatusUpdate(BaseModel):
    status: Literal["Draft", "Approved", "Paid", "Partial"]
    payment_mode: Optional[str] = None
    transaction_id: Optional[str] = None

class ItemPaymentIn(BaseModel):
    amount: float
    payment_mode: str

class DirectPaymentIn(BaseModel):
    employee_id: str
    amount: float
    payment_mode: str
    notes: str

class BonusPenaltyIn(BaseModel):
    employee_id: str
    amount: float
    reason: str
    date: str

# ==========================================
# PAYROLL & HR MODULE API ROUTES
# ==========================================

@api.get("/payroll/dashboard")
async def get_payroll_dashboard(user=Depends(require_roles("admin"))):
    db = await get_db()
    tenant_id = user.get("tenant_id", "default")
    tenant = _tenant()
    
    count_row = await _fetchone(db, "SELECT COUNT(*) as cnt FROM users WHERE tenant_id = ?", (tenant_id,))
    all_users_count = count_row["cnt"] if count_row else 0
    active_emps = all_users_count
    
    now_dt = datetime.now()
    month, year = now_dt.month, now_dt.year
    prev_month = month - 1 if month > 1 else 12
    prev_year = year if month > 1 else year - 1

    last_payroll = await _fetchone(db,
        "SELECT total_net_pay FROM payrolls WHERE tenant_db = ? AND month = ? AND year = ?",
        (tenant, prev_month, prev_year))
    last_cost = last_payroll["total_net_pay"] if last_payroll else 0
    
    pending_row = await _fetchone(db,
        "SELECT COUNT(*) as cnt FROM payrolls WHERE tenant_db = ? AND status IN ('Draft', 'Approved')",
        (tenant,))
    pending_payouts = pending_row["cnt"] if pending_row else 0
    
    today_str = now_dt.strftime("%Y-%m-%d")
    att_today = await _fetchall(db, "SELECT status FROM attendance WHERE tenant_db = ? AND date = ?", (tenant, today_str))
    present_today = sum(1 for a in att_today if a["status"] == "Present")
    absent_today = sum(1 for a in att_today if a["status"] == "Absent")
    
    implicit_absent = active_emps - len(att_today)
    total_absent_today = absent_today + (implicit_absent if implicit_absent > 0 else 0)

    # Advances
    advances = await _fetchall(db,
        "SELECT balance FROM salary_advances WHERE tenant_db = ? AND balance > 0 AND status = 'Approved'",
        (tenant,))
    outstanding_advances = sum(a["balance"] for a in advances)

    # Get employee balances from latest payroll run
    latest_run = await _fetchone(db, "SELECT * FROM payrolls WHERE tenant_db = ? ORDER BY created_at DESC LIMIT 1", (tenant,))
    employee_balances = []
    if latest_run:
        items = await _fetchall(db, "SELECT * FROM payroll_items WHERE tenant_db = ? AND payroll_id = ?",
                                (tenant, latest_run["id"]))
        for item in items:
            status = "Paid" if latest_run["status"] == "Paid" else "Pending"
            employee_balances.append({
                "id": item.get("employee_id"),
                "name": item.get("employee_name"),
                "gross": item.get("gross_pay", 0),
                "advances": item.get("advance_deduction", 0),
                "deductions": (item.get("deductions") or 0) + (item.get("penalties") or 0),
                "outstanding": item.get("net_pay", 0),
                "status": status
            })

    return {
        "active_employees": active_emps,
        "last_month_cost": last_cost,
        "pending_payouts": pending_payouts,
        "present_today": present_today,
        "absent_today": total_absent_today,
        "outstanding_advances": outstanding_advances,
        "employee_balances": employee_balances
    }


@api.get("/payroll/employees/{emp_id}/structure")
async def get_salary_structure(emp_id: str, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    struct = await _fetchone(db,
        "SELECT * FROM employees_salary_structure WHERE employee_id = ? AND tenant_db = ?",
        (emp_id, tenant))
    if not struct:
        raise HTTPException(404, "Structure not found")
    struct.pop("tenant_db", None)
    return struct

@api.put("/payroll/employees/{emp_id}/structure")
async def update_salary_structure(emp_id: str, body: SalaryStructureIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    existing = await _fetchone(db,
        "SELECT id FROM employees_salary_structure WHERE employee_id = ? AND tenant_db = ?",
        (emp_id, tenant))
    if existing:
        set_parts = ", ".join(f"{k} = ?" for k in data)
        params = list(data.values()) + [emp_id, tenant]
        await _execute(db, f"UPDATE employees_salary_structure SET {set_parts} WHERE employee_id = ? AND tenant_db = ?", params)
    else:
        data["id"] = new_id()
        data["employee_id"] = emp_id
        data["tenant_db"] = tenant
        cols = list(data.keys())
        placeholders = ", ".join(["?"] * len(cols))
        col_str = ", ".join(cols)
        await _execute(db, f"INSERT INTO employees_salary_structure ({col_str}) VALUES ({placeholders})", list(data.values()))
    return {"status": "success"}

@api.get("/payroll/attendance")
async def get_attendance(date: str, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    records = await _fetchall(db,
        "SELECT * FROM attendance_records WHERE tenant_db = ? AND date = ?", (tenant, date))
    for r in records:
        r.pop("tenant_db", None)
    return records

@api.post("/payroll/attendance")
async def save_attendance(body: AttendanceBulkIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    for rec in body.records:
        data = rec.model_dump()
        existing = await _fetchone(db,
            "SELECT id FROM attendance_records WHERE tenant_db = ? AND employee_id = ? AND date = ?",
            (tenant, rec.employee_id, rec.date))
        if existing:
            set_parts = ", ".join(f"{k} = ?" for k in data)
            params = list(data.values()) + [existing["id"]]
            await _execute(db, f"UPDATE attendance_records SET {set_parts} WHERE id = ?", params)
        else:
            data["tenant_db"] = tenant
            data["late_mark"] = 1 if data.get("late_mark") else 0
            cols = list(data.keys())
            placeholders = ", ".join(["?"] * len(cols))
            col_str = ", ".join(cols)
            await _execute(db, f"INSERT INTO attendance_records ({col_str}) VALUES ({placeholders})", list(data.values()))
    return {"status": "success"}

@api.get("/payroll/advances")
async def get_advances(_=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    advances = await _fetchall(db, "SELECT * FROM salary_advances WHERE tenant_db = ?", (tenant,))
    for a in advances:
        emp = await _fetchone(db, "SELECT name FROM users WHERE id = ?", (a["employee_id"],))
        a["employee_name"] = emp["name"] if emp else "Unknown"
        a.pop("tenant_db", None)
    return advances

@api.post("/payroll/advances")
async def create_advance(body: SalaryAdvanceIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    advance_id = str(uuid.uuid4())
    data = body.model_dump()
    await _execute(db,
        """INSERT INTO salary_advances (id, tenant_db, employee_id, amount, emi_amount, reason, status, balance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (advance_id, tenant, data["employee_id"], data["amount"], data["emi_amount"],
         data["reason"], data["status"], data["amount"], iso(now_utc())))
    return {"status": "success"}

@api.get("/payroll/direct-payments")
async def get_direct_payments(_=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    payments = await _fetchall(db,
        "SELECT * FROM direct_payments WHERE tenant_db = ? ORDER BY date DESC", (tenant,))
    for p in payments:
        emp = await _fetchone(db, "SELECT name FROM users WHERE id = ?", (p["employee_id"],))
        p["employee_name"] = emp["name"] if emp else "Unknown"
        p.pop("tenant_db", None)
    return payments

@api.post("/payroll/direct-payments")
async def create_direct_payment(body: DirectPaymentIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    await _execute(db,
        "INSERT INTO direct_payments (id, tenant_db, employee_id, amount, payment_mode, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tenant, data["employee_id"], data["amount"], data["payment_mode"], data["notes"], iso(now_utc())))
    return {"status": "success"}

@api.get("/payroll/leaves")
async def get_leaves(_=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    leaves = await _fetchall(db,
        "SELECT * FROM leave_requests WHERE tenant_db = ? ORDER BY start_date DESC", (tenant,))
    for l in leaves:
        emp = await _fetchone(db, "SELECT name FROM users WHERE id = ?", (l["employee_id"],))
        l["employee_name"] = emp["name"] if emp else "Unknown"
        l.pop("tenant_db", None)
    return leaves

@api.post("/payroll/leaves")
async def create_leave(body: LeaveRequestIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    await _execute(db,
        "INSERT INTO leave_requests (id, tenant_db, employee_id, type, start_date, end_date, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tenant, data["employee_id"], data["type"], data["start_date"],
         data["end_date"], data["reason"], data["status"], iso(now_utc())))
    return {"status": "success"}

@api.post("/payroll/attendance/biometric-sync")
async def biometric_sync(body: BiometricSyncIn):
    db = await get_db()
    tenant = _tenant()
    date_str = body.timestamp[:10]
    
    att = await _fetchone(db,
        "SELECT * FROM attendance WHERE tenant_db = ? AND employee_id = ? AND date = ?",
        (tenant, body.employee_id, date_str))
    
    if not att:
        att = {
            "employee_id": body.employee_id,
            "date": date_str,
            "status": "Present",
            "check_in": None,
            "check_out": None,
            "overtime_hours": 0,
            "late_mark": 0
        }
    
    if body.scan_type == "check-in":
        if not att.get("check_in"):
            att["check_in"] = body.timestamp
    elif body.scan_type == "check-out":
        att["check_out"] = body.timestamp
    
    existing = await _fetchone(db,
        "SELECT id FROM attendance WHERE tenant_db = ? AND employee_id = ? AND date = ?",
        (tenant, body.employee_id, date_str))
    if existing:
        await _execute(db,
            "UPDATE attendance SET status=?, check_in=?, check_out=?, overtime_hours=?, late_mark=? WHERE tenant_db=? AND employee_id=? AND date=?",
            (att["status"], att["check_in"], att["check_out"], att["overtime_hours"], att["late_mark"],
             tenant, body.employee_id, date_str))
    else:
        await _execute(db,
            "INSERT INTO attendance (tenant_db, employee_id, date, status, check_in, check_out, overtime_hours, late_mark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (tenant, body.employee_id, date_str, att["status"], att["check_in"], att["check_out"],
             att["overtime_hours"], att["late_mark"]))
    
    return {"status": "success", "message": "Biometric log synced"}


@api.get("/payroll/bonuses")
async def get_bonuses(_=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    bonuses = await _fetchall(db, "SELECT * FROM bonuses WHERE tenant_db = ? ORDER BY date DESC", (tenant,))
    for b in bonuses:
        emp = await _fetchone(db, "SELECT name FROM users WHERE id = ?", (b["employee_id"],))
        b["employee_name"] = emp["name"] if emp else "Unknown"
        b.pop("tenant_db", None)
    return bonuses

@api.post("/payroll/bonuses")
async def create_bonus(body: BonusPenaltyIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    await _execute(db,
        "INSERT INTO bonuses (id, tenant_db, employee_id, amount, reason, date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tenant, data["employee_id"], data["amount"], data["reason"],
         data["date"], "Pending", iso(now_utc())))
    return {"status": "success"}

@api.get("/payroll/penalties")
async def get_penalties(_=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    penalties = await _fetchall(db, "SELECT * FROM penalties WHERE tenant_db = ? ORDER BY date DESC", (tenant,))
    for p in penalties:
        emp = await _fetchone(db, "SELECT name FROM users WHERE id = ?", (p["employee_id"],))
        p["employee_name"] = emp["name"] if emp else "Unknown"
        p.pop("tenant_db", None)
    return penalties

@api.post("/payroll/penalties")
async def create_penalty(body: BonusPenaltyIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    data = body.model_dump()
    await _execute(db,
        "INSERT INTO penalties (id, tenant_db, employee_id, amount, reason, date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tenant, data["employee_id"], data["amount"], data["reason"],
         data["date"], "Pending", iso(now_utc())))
    return {"status": "success"}


@api.get("/payroll/runs")
async def get_payrolls(_=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    runs = await _fetchall(db, "SELECT * FROM payrolls WHERE tenant_db = ? ORDER BY created_at DESC", (tenant,))
    for r in runs:
        r.pop("tenant_db", None)
    return runs

@api.get("/payroll/runs/{run_id}")
async def get_payroll_details(run_id: str, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    run = await _fetchone(db, "SELECT * FROM payrolls WHERE id = ? AND tenant_db = ?", (run_id, tenant))
    if not run: raise HTTPException(404, "Run not found")
    run.pop("tenant_db", None)
    items = await _fetchall(db, "SELECT * FROM payroll_items WHERE payroll_id = ? AND tenant_db = ?", (run_id, tenant))
    for it in items:
        it.pop("tenant_db", None)
    return {"run": run, "items": items}

@api.post("/payroll/process")
async def process_payroll(body: PayrollProcessIn, user=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    tenant_id = user.get("tenant_id", "default")
    
    existing = await _fetchone(db,
        "SELECT * FROM payrolls WHERE tenant_db = ? AND month = ? AND year = ?",
        (tenant, body.month, body.year))
    if existing and existing["status"] != "Draft":
        raise HTTPException(400, "Payroll for this month is already approved/paid.")
    
    _, total_days = calendar.monthrange(body.year, body.month)
    start_date = f"{body.year}-{body.month:02d}-01"
    end_date = f"{body.year}-{body.month:02d}-{total_days}"

    all_users = await _fetchall(db, "SELECT * FROM users WHERE tenant_id = ?", (tenant_id,))
    profiles = await _fetchall(db, "SELECT * FROM staff_profiles WHERE tenant_db = ?", (tenant,))
    profile_map = {p["user_id"]: p for p in profiles}
    emps = []
    for u in all_users:
        p = profile_map.get(u["id"], {})
        if p.get("status", "Active") == "Active":
            emps.append(u)
    items = []
    total_net = 0

    for emp in emps:
        struct = await _fetchone(db,
            "SELECT * FROM employees_salary_structure WHERE employee_id = ? AND tenant_db = ?",
            (emp["id"], tenant))
        if not struct: continue

        att_records = await _fetchall(db,
            "SELECT * FROM attendance_records WHERE tenant_db = ? AND employee_id = ? AND date >= ? AND date <= ?",
            (tenant, emp["id"], start_date, end_date))

        present = sum(1 for r in att_records if r["status"] == "Present")
        half_days = sum(1 for r in att_records if r["status"] == "Half-Day")
        holidays = sum(1 for r in att_records if r["status"] == "Holiday")
        leaves = sum(1 for r in att_records if r["status"] == "Leave")
        
        unpaid_leave_requests = await _fetchall(db,
            "SELECT * FROM leave_requests WHERE tenant_db = ? AND employee_id = ? AND status = 'Approved' AND type = 'Unpaid Leave' AND start_date <= ? AND end_date >= ?",
            (tenant, emp["id"], end_date, start_date))
        
        unpaid_leave_days = 0
        for ul in unpaid_leave_requests:
            sd = max(ul["start_date"], start_date)
            ed = min(ul["end_date"], end_date)
            if sd <= ed:
                dt_start = datetime.strptime(sd, "%Y-%m-%d")
                dt_end = datetime.strptime(ed, "%Y-%m-%d")
                unpaid_leave_days += (dt_end - dt_start).days + 1

        days_credited = max(0, present + (half_days * 0.5) + holidays + leaves - unpaid_leave_days)
        
        gross = 0
        basic = struct.get("basic_salary", 0)
        
        if struct.get("wage_type") == "Fixed":
            prorate_factor = days_credited / total_days if total_days > 0 else 0
            gross = (basic + struct.get("hra", 0) + struct.get("conveyance", 0) + struct.get("medical", 0) + struct.get("special_allowance", 0)) * prorate_factor
        else:
            overtime = sum(r.get("overtime_hours", 0) for r in att_records)
            gross = overtime * struct.get("hourly_rate", 0)

        deductions = struct.get("pf_deduction", 0) + struct.get("esi_deduction", 0) + struct.get("professional_tax", 0)
        
        advance_deduction = 0
        active_advances = await _fetchall(db,
            "SELECT * FROM salary_advances WHERE tenant_db = ? AND employee_id = ? AND balance > 0 AND status = 'Approved'",
            (tenant, emp["id"]))
        for advance in active_advances:
            emi = min(advance["emi_amount"], advance["balance"])
            advance_deduction += emi

        total_deductions = deductions + advance_deduction

        direct_payouts = await _fetchall(db,
            "SELECT amount FROM direct_payments WHERE tenant_db = ? AND employee_id = ? AND date >= ? AND date <= ?",
            (tenant, emp["id"], start_date, end_date + "T23:59:59"))
        direct_payments_total = sum(p["amount"] for p in direct_payouts)

        pending_bonuses = await _fetchall(db,
            "SELECT amount FROM bonuses WHERE tenant_db = ? AND employee_id = ? AND status = 'Pending' AND date <= ?",
            (tenant, emp["id"], end_date + "T23:59:59"))
        total_bonuses = sum(b["amount"] for b in pending_bonuses)
        
        pending_penalties = await _fetchall(db,
            "SELECT amount FROM penalties WHERE tenant_db = ? AND employee_id = ? AND status = 'Pending' AND date <= ?",
            (tenant, emp["id"], end_date + "T23:59:59"))
        total_penalties = sum(p["amount"] for p in pending_penalties)

        net_pay = max(0, gross + total_bonuses - total_deductions - direct_payments_total - total_penalties)

        item = {
            "id": str(uuid.uuid4()),
            "employee_id": emp["id"],
            "employee_name": emp.get("name", "Unknown"),
            "days_credited": days_credited,
            "gross_pay": gross,
            "deductions": deductions,
            "advance_deduction": advance_deduction,
            "direct_payments_deduction": direct_payments_total,
            "bonuses": total_bonuses,
            "penalties": total_penalties,
            "net_pay": net_pay
        }
        items.append(item)
        total_net += net_pay

    if existing:
        await _execute(db, "DELETE FROM payroll_items WHERE payroll_id = ? AND tenant_db = ?", (existing["id"], tenant))
        run_id = existing["id"]
        await _execute(db,
            "UPDATE payrolls SET total_net_pay = ?, employee_count = ?, updated_at = ? WHERE id = ? AND tenant_db = ?",
            (total_net, len(items), iso(now_utc()), run_id, tenant))
    else:
        run_id = str(uuid.uuid4())
        await _execute(db,
            """INSERT INTO payrolls (id, tenant_db, month, year, status, total_net_pay, employee_count, created_at, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, tenant, body.month, body.year, "Draft", total_net, len(items), iso(now_utc()), user.get("email")))

    for it in items:
        it["payroll_id"] = run_id
        await _execute(db,
            """INSERT INTO payroll_items (id, tenant_db, payroll_id, employee_id, employee_name, days_credited, gross_pay,
               deductions, advance_deduction, direct_payments_deduction, bonuses, penalties, net_pay)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (it["id"], tenant, it["payroll_id"], it["employee_id"], it["employee_name"],
             it["days_credited"], it["gross_pay"], it["deductions"], it["advance_deduction"],
             it["direct_payments_deduction"], it["bonuses"], it["penalties"], it["net_pay"]))

    return {"status": "success", "run_id": run_id}

@api.patch("/payroll/runs/{run_id}/status")
async def update_payroll_status(run_id: str, body: PayrollStatusUpdate, user=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    run = await _fetchone(db, "SELECT * FROM payrolls WHERE id = ? AND tenant_db = ?", (run_id, tenant))
    if not run: raise HTTPException(404, "Run not found")

    updates = {"status": body.status, "updated_at": iso(now_utc())}
    if body.status == "Paid":
        updates["payment_mode"] = body.payment_mode
        updates["transaction_id"] = body.transaction_id
        updates["paid_at"] = iso(now_utc())

        items = await _fetchall(db, "SELECT * FROM payroll_items WHERE payroll_id = ? AND tenant_db = ?", (run_id, tenant))
        for item in items:
            if (item.get("advance_deduction") or 0) > 0:
                active_advance = await _fetchone(db,
                    "SELECT * FROM salary_advances WHERE tenant_db = ? AND employee_id = ? AND balance > 0",
                    (tenant, item["employee_id"]))
                if active_advance:
                    new_balance = active_advance["balance"] - item["advance_deduction"]
                    await _execute(db, "UPDATE salary_advances SET balance = ? WHERE id = ? AND tenant_db = ?",
                                   (new_balance, active_advance["id"], tenant))
            
            if (item.get("bonuses") or 0) > 0:
                await _execute(db,
                    "UPDATE bonuses SET status = 'Paid', payroll_id = ? WHERE tenant_db = ? AND employee_id = ? AND status = 'Pending'",
                    (run_id, tenant, item["employee_id"]))
            if (item.get("penalties") or 0) > 0:
                await _execute(db,
                    "UPDATE penalties SET status = 'Deducted', payroll_id = ? WHERE tenant_db = ? AND employee_id = ? AND status = 'Pending'",
                    (run_id, tenant, item["employee_id"]))

    set_parts = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [run_id, tenant]
    await _execute(db, f"UPDATE payrolls SET {set_parts} WHERE id = ? AND tenant_db = ?", params)
    
    await _execute(db,
        "INSERT INTO payroll_audit_logs (id, tenant_db, payroll_id, status, changed_by, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tenant, run_id, body.status, user.get("email"), iso(now_utc())))
    return {"status": "success"}

@api.post("/payroll/runs/{run_id}/items/{item_id}/pay")
async def pay_payroll_item(run_id: str, item_id: str, body: ItemPaymentIn, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    item = await _fetchone(db, "SELECT * FROM payroll_items WHERE id = ? AND tenant_db = ?", (item_id, tenant))
    if not item: raise HTTPException(404, "Item not found")
    
    paid_so_far = (item.get("paid_amount") or 0) + body.amount
    await _execute(db,
        "UPDATE payroll_items SET paid_amount = ?, payment_mode = ? WHERE id = ? AND tenant_db = ?",
        (paid_so_far, body.payment_mode, item_id, tenant))
    
    run_items = await _fetchall(db, "SELECT * FROM payroll_items WHERE payroll_id = ? AND tenant_db = ?", (run_id, tenant))
    all_paid = all((i.get("paid_amount") or 0) >= i["net_pay"] for i in run_items)
    
    if all_paid:
        await _execute(db, "UPDATE payrolls SET status = 'Paid' WHERE id = ? AND tenant_db = ?", (run_id, tenant))
    elif paid_so_far > 0:
        await _execute(db, "UPDATE payrolls SET status = 'Partial' WHERE id = ? AND tenant_db = ?", (run_id, tenant))
        
    return {"status": "success"}

@api.get("/payroll/payslip/{item_id}")
async def get_payslip(item_id: str, _=Depends(require_roles("admin"))):
    db = await get_db()
    tenant = _tenant()
    item = await _fetchone(db, "SELECT * FROM payroll_items WHERE id = ? AND tenant_db = ?", (item_id, tenant))
    if not item: raise HTTPException(404, "Payslip not found")
    item.pop("tenant_db", None)
    emp = await _fetchone(db, "SELECT * FROM users WHERE id = ?", (item["employee_id"],))
    profile = await _fetchone(db, "SELECT * FROM staff_profiles WHERE user_id = ? AND tenant_db = ?",
                              (item["employee_id"], tenant)) or {}
    if emp:
        emp.pop("password_hash", None)
        emp.update(profile)
    run = await _fetchone(db, "SELECT * FROM payrolls WHERE id = ? AND tenant_db = ?", (item["payroll_id"], tenant))
    if run:
        run.pop("tenant_db", None)
    struct = await _fetchone(db,
        "SELECT * FROM employees_salary_structure WHERE employee_id = ? AND tenant_db = ?",
        (item["employee_id"], tenant))
    if struct:
        struct.pop("tenant_db", None)
    
    return {"item": item, "employee": emp, "payroll": run, "structure": struct}

class ChatMessage(BaseModel):
    message: str
    history: List[Dict[str, str]] = []

@api.post("/ai/chat")
async def ai_chat(body: ChatMessage, user: dict = Depends(get_current_user)):
    db = await get_db()
    tenant = _tenant()
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_str = today.isoformat()
    
    orders = await _fetchall(db,
        "SELECT total FROM orders WHERE tenant_db = ? AND created_at >= ?",
        (tenant, today_str))
    total_sales = sum(o.get("total", 0) for o in orders)
    
    staff_count_row = await _fetchone(db, "SELECT COUNT(*) as cnt FROM users WHERE status = 'Active'", ())
    staff_count = staff_count_row["cnt"] if staff_count_row else 0
    
    alert_row = await _fetchone(db,
        "SELECT COUNT(*) as cnt FROM stock_alerts WHERE tenant_db = ? AND is_resolved = 0", (tenant,))
    stock_alerts_count = alert_row["cnt"] if alert_row else 0

    system_prompt = f"""
You are Anndevta, the AI growth manager and operational assistant for Anndevta Thali House.
You have access to the current software data:
- Today's Sales: Rs.{total_sales:.2f} ({len(orders)} orders)
- Active Staff Members: {staff_count}
- Unresolved Stock Alerts: {stock_alerts_count}

Provide actionable advice for restaurant growth and answer questions accurately based on this data. Keep responses concise, helpful, and in a friendly, professional tone. Use markdown formatting.
"""

    if genai is None:
        raise HTTPException(
            status_code=503,
            detail="AI features are currently unavailable. The google-generativeai package is not installed."
        )

    model = genai.GenerativeModel('gemini-1.5-flash', system_instruction=system_prompt)
    
    messages = []
    for h in body.history:
        messages.append({"role": "user" if h["role"] == "user" else "model", "parts": [h["content"]]})
        
    messages.append({"role": "user", "parts": [body.message]})
    
    try:
        response = model.generate_content(messages)
        return {"response": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

app.include_router(api)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
