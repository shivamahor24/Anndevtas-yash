# pyrefly: ignore[missing-import]
"""
Thali POS Backend Regression Suite.
Covers: auth, settings, categories, menu+toggle, templates, orders+receipt_no atomic counter,
dashboard summary, reports (sales/products/thalis), CSV+Excel export, removed-endpoints 404.
# Trigger linter
"""
import os
import io
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    # fallback from frontend .env if test runs locally
    for path in ['frontend/.env', '../frontend/.env', '../../frontend/.env', '/app/frontend/.env']:
        try:
            with open(path) as f:
                for line in f:
                    if line.startswith('REACT_APP_BACKEND_URL'):
                        BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
                        break
            if BASE_URL:
                break
        except Exception:
            pass
API = f"{BASE_URL}/api"


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def admin_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": "admin@pos.com", "password": "admin123"})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    s.headers.update({"Authorization": f"Bearer {data['token']}"})
    return s


@pytest.fixture(scope="session")
def cashier_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": "cashier@pos.com", "password": "cashier123"})
    assert r.status_code == 200, f"cashier login failed: {r.status_code} {r.text}"
    data = r.json()
    s.headers.update({"Authorization": f"Bearer {data['token']}"})
    return s


@pytest.fixture(scope="session")
def menu_items(admin_session):
    r = admin_session.get(f"{API}/menu")
    assert r.status_code == 200
    return r.json()


# ---------- Auth ----------
class TestAuth:
    def test_login_bad_creds(self):
        r = requests.post(f"{API}/auth/login", json={"email": "admin@pos.com", "password": "wrong"})
        assert r.status_code == 401

    def test_login_admin_sets_cookie(self):
        r = requests.post(f"{API}/auth/login", json={"email": "admin@pos.com", "password": "admin123"})
        assert r.status_code == 200
        assert "access_token" in r.cookies
        body = r.json()
        assert body["user"]["role"] == "admin"
        assert "token" in body

    def test_me_requires_auth(self):
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_me_returns_user(self, admin_session):
        r = admin_session.get(f"{API}/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == "admin@pos.com"
        # password_hash must NOT leak
        assert "password_hash" not in r.json()

    def test_cashier_login(self, cashier_session):
        r = cashier_session.get(f"{API}/auth/me")
        assert r.status_code == 200
        assert r.json()["role"] == "cashier"


# ---------- Settings ----------
class TestSettings:
    def test_get_settings(self, admin_session):
        r = admin_session.get(f"{API}/settings")
        assert r.status_code == 200
        s = r.json()
        for k in ("name", "address", "gstin", "fssai", "phone", "gst_rate", "cgst_rate", "sgst_rate", "footer_msg"):
            assert k in s

    def test_update_settings_admin(self, admin_session):
        # capture current
        cur = admin_session.get(f"{API}/settings").json()
        new = {
            "name": "TEST_Thali House",
            "address": "Test Addr",
            "gstin": "TEST29ABCDE",
            "fssai": "12345678901234",
            "phone": "+91 99999",
            "cgst_rate": 6.0,
            "sgst_rate": 6.0,
            "gst_rate": 12.0,
            "footer_msg": "Test footer",
        }
        r = admin_session.put(f"{API}/settings", json=new)
        assert r.status_code == 200
        got = admin_session.get(f"{API}/settings").json()
        assert got["name"] == "TEST_Thali House"
        assert got["fssai"] == "12345678901234"
        assert got["cgst_rate"] == 6.0
        assert got["sgst_rate"] == 6.0
        assert got["gst_rate"] == 12.0
        # restore
        admin_session.put(f"{API}/settings", json={
            "name": cur["name"], "address": cur["address"], "gstin": cur["gstin"], "fssai": cur.get("fssai", ""),
            "phone": cur["phone"], "cgst_rate": cur.get("cgst_rate", 2.5), "sgst_rate": cur.get("sgst_rate", 2.5),
            "gst_rate": cur["gst_rate"], "footer_msg": cur["footer_msg"],
        })

    def test_update_settings_cashier_forbidden(self, cashier_session):
        r = cashier_session.put(f"{API}/settings", json={
            "name": "X", "address": "", "gstin": "", "phone": "",
            "cgst_rate": 2.5, "sgst_rate": 2.5, "gst_rate": 5.0, "footer_msg": "x",
        })
        assert r.status_code == 403

    def test_fssai_and_header_alignment(self, admin_session):
        cur = admin_session.get(f"{API}/settings").json()
        payload = {
            **cur,
            "fssai": "5555555465555",
            "header_alignment": "right",
        }
        r = admin_session.put(f"{API}/settings", json=payload)
        assert r.status_code == 200
        got = admin_session.get(f"{API}/settings").json()
        assert got["fssai"] == "5555555465555"
        assert got["header_alignment"] == "right"

        # Test empty FSSAI
        payload["fssai"] = ""
        r2 = admin_session.put(f"{API}/settings", json=payload)
        assert r2.status_code == 200
        got2 = admin_session.get(f"{API}/settings").json()
        assert got2["fssai"] == ""

        # Restore
        admin_session.put(f"{API}/settings", json=cur)


# ---------- Categories & Menu ----------
class TestCategoriesAndMenu:
    def test_list_categories(self, admin_session):
        r = admin_session.get(f"{API}/categories")
        assert r.status_code == 200
        cats = r.json()
        names = {c["name"] for c in cats}
        # seed defines Gujarati categories
        for n in ("Dining Menu", "Parcel Menu", "Daily Thalis"):
            assert n in names, f"Missing seeded category: {n}"

    def test_list_menu_has_thalis(self, menu_items):
        thalis = [m for m in menu_items if m.get("is_thali")]
        assert len(thalis) >= 3
        for t in thalis:
            assert isinstance(t.get("thali_groups"), list)

    def test_toggle_menu_item(self, admin_session, menu_items):
        # pick a non-thali item
        item = next(m for m in menu_items if not m.get("is_thali"))
        before = item["available"]
        r = admin_session.patch(f"{API}/menu/{item['id']}/toggle")
        assert r.status_code == 200
        after = r.json()["available"]
        assert after == (not before)
        # toggle back
        admin_session.patch(f"{API}/menu/{item['id']}/toggle")

    def test_create_update_delete_thali(self, admin_session):
        cats = admin_session.get(f"{API}/categories").json()
        thali_cat = next(c for c in cats if c["name"] == "Thali")
        sabji_cat = next(c for c in cats if c["name"] == "Sabji")
        body = {
            "name": "TEST_Mega Thali",
            "category_id": thali_cat["id"],
            "price": 333.0,
            "available": True,
            "is_thali": True,
            "thali_groups": [{"category_id": sabji_cat["id"], "label": "Sabji", "count": 3}],
            "thali_extras": "Roti, Salad",
        }
        r = admin_session.post(f"{API}/menu", json=body)
        assert r.status_code == 200
        new_item = r.json()
        assert new_item["is_thali"] is True
        assert len(new_item["thali_groups"]) == 1
        assert new_item["price"] == 333.0

        # update
        body["price"] = 350.0
        r = admin_session.put(f"{API}/menu/{new_item['id']}", json=body)
        assert r.status_code == 200
        assert r.json()["price"] == 350.0

        # delete
        r = admin_session.delete(f"{API}/menu/{new_item['id']}")
        assert r.status_code == 200


# ---------- Templates ----------
class TestTemplates:
    def test_template_create_activate_delete(self, admin_session, menu_items):
        ids = [m["id"] for m in menu_items[:5]]
        r = admin_session.post(f"{API}/templates", json={"name": "TEST_lunch", "item_ids": ids})
        assert r.status_code == 200
        tid = r.json()["id"]

        r = admin_session.post(f"{API}/templates/{tid}/activate")
        assert r.status_code == 200
        assert r.json()["activated"] == len(ids)
        # verify only those 5 are available
        new_menu = admin_session.get(f"{API}/menu").json()
        avail = {m["id"] for m in new_menu if m.get("available")}
        assert set(ids).issubset(avail)
        # re-enable everything afterwards
        for m in new_menu:
            if not m.get("available"):
                admin_session.patch(f"{API}/menu/{m['id']}/toggle")

        r = admin_session.delete(f"{API}/templates/{tid}")
        assert r.status_code == 200


# ---------- Orders & Receipt Counter ----------
class TestOrders:
    def test_empty_cart_400(self, admin_session):
        r = admin_session.post(f"{API}/orders", json={"items": [], "payment_mode": "cash"})
        assert r.status_code == 400

    def test_create_order_returns_receipt_no_and_persists(self, admin_session, menu_items):
        regular = next(m for m in menu_items if m.get("is_thali") and m["name"] == "Regular Thali")
        paneer = next(m for m in menu_items if m["name"] == "Paneer Masala")
        body = {
            "items": [
                {"menu_item_id": regular["id"], "name": regular["name"], "price": regular["price"],
                 "qty": 1, "tax_rate": 5.0, "is_thali": True,
                 "thali_selections": {"Sabji": ["Paneer Masala", "Mix Veg"], "Dal": ["Dal Tadka"]},
                 "thali_extras": regular.get("thali_extras", "")},
                {"menu_item_id": paneer["id"], "name": paneer["name"], "price": paneer["price"],
                 "qty": 2, "tax_rate": 5.0, "is_thali": False},
            ],
            "discount": 10.0,
            "payment_mode": "upi",
            "notes": "TEST_order",
        }
        r = admin_session.post(f"{API}/orders", json=body)
        assert r.status_code == 200, r.text
        o = r.json()
        assert isinstance(o["receipt_no"], int) and o["receipt_no"] >= 1
        # totals
        expected_subtotal = 150 + 120 * 2
        assert o["subtotal"] == expected_subtotal
        assert o["total"] == round(expected_subtotal + expected_subtotal * 0.05 - 10, 2)
        assert o["payment_mode"] == "upi"

        # GET back
        r2 = admin_session.get(f"{API}/orders/{o['id']}")
        assert r2.status_code == 200
        assert r2.json()["receipt_no"] == o["receipt_no"]
        # thali selections preserved
        thali_item = next(i for i in r2.json()["items"] if i["is_thali"])
        assert thali_item["thali_selections"]["Sabji"] == ["Paneer Masala", "Mix Veg"]

        # DELETE order test
        del_res = admin_session.delete(f"{API}/orders/{o['id']}")
        assert del_res.status_code == 200
        assert del_res.json()["ok"] is True
        # Verify 404 after deletion
        r3 = admin_session.get(f"{API}/orders/{o['id']}")
        assert r3.status_code == 404

    def test_reset_all_orders(self, admin_session, menu_items):
        item = next(m for m in menu_items if not m.get("is_thali"))
        payload = {
            "items": [{"menu_item_id": item["id"], "name": item["name"], "price": item["price"],
                       "qty": 1, "tax_rate": 5.0, "is_thali": False}],
            "discount": 0, "payment_mode": "cash",
        }
        admin_session.post(f"{API}/orders", json=payload)
        admin_session.post(f"{API}/orders", json=payload)
        
        # Reset orders
        reset_res = admin_session.delete(f"{API}/orders/reset")
        assert reset_res.status_code == 200
        assert reset_res.json()["ok"] is True

        # Verify empty list
        orders_res = admin_session.get(f"{API}/orders")
        assert orders_res.status_code == 200
        assert len(orders_res.json()) == 0

    def test_receipt_no_atomic_increment(self, admin_session, menu_items):
        item = next(m for m in menu_items if not m.get("is_thali"))
        payload = {
            "items": [{"menu_item_id": item["id"], "name": item["name"], "price": item["price"],
                       "qty": 1, "tax_rate": 5.0, "is_thali": False}],
            "discount": 0, "payment_mode": "cash",
        }
        r1 = admin_session.post(f"{API}/orders", json=payload).json()
        r2 = admin_session.post(f"{API}/orders", json=payload).json()
        assert r2["receipt_no"] == r1["receipt_no"] + 1

    def test_list_orders_search_by_receipt_no(self, admin_session, menu_items):
        item = next(m for m in menu_items if not m.get("is_thali"))
        new_order = admin_session.post(f"{API}/orders", json={
            "items": [{"menu_item_id": item["id"], "name": item["name"], "price": item["price"],
                       "qty": 1, "tax_rate": 5.0, "is_thali": False}],
            "discount": 0, "payment_mode": "card",
        }).json()
        r = admin_session.get(f"{API}/orders", params={"q": str(new_order["receipt_no"])})
        assert r.status_code == 200
        results = r.json()
        assert any(o["receipt_no"] == new_order["receipt_no"] for o in results)


# ---------- Dashboard ----------
class TestDashboard:
    def test_dashboard_summary_shape(self, admin_session):
        r = admin_session.get(f"{API}/dashboard/summary")
        assert r.status_code == 200
        d = r.json()
        for key in ("today", "week", "month", "series",
                    "top_items_today", "top_items_week", "top_items_month",
                    "top_thalis_today", "top_thalis_week", "top_thalis_month",
                    "payment_today", "payment_week", "payment_month"):
            assert key in d
        # KPI shape
        for k in ("revenue", "orders", "avg"):
            assert k in d["today"]
        # payment breakdown shape
        for k in ("cash", "card", "upi"):
            assert k in d["payment_today"]
        # series should be 7 days
        assert len(d["series"]) == 7

    def test_top_thalis_aggregation(self, admin_session):
        d = admin_session.get(f"{API}/dashboard/summary").json()
        # After previous TestOrders.test_create_order_returns_receipt_no_and_persists, at least one thali should appear
        # Use week window since today might cross UTC
        thali_names = {x["name"] for x in d["top_thalis_week"]}
        if thali_names:
            assert "Regular Thali" in thali_names or any("Thali" in n for n in thali_names)


# ---------- Reports & Export ----------
class TestReports:
    def test_reports_sales(self, admin_session):
        r = admin_session.get(f"{API}/reports/sales")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_reports_products(self, admin_session):
        r = admin_session.get(f"{API}/reports/products")
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body, list)
        if body:
            for k in ("name", "qty", "revenue"):
                assert k in body[0]

    def test_reports_thalis(self, admin_session):
        r = admin_session.get(f"{API}/reports/thalis")
        assert r.status_code == 200
        body = r.json()
        assert "thalis" in body and "selection_picks" in body

    def test_export_csv(self, admin_session):
        r = admin_session.get(f"{API}/reports/export/sales.csv")
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        assert r.content.startswith(b"Receipt #")

    def test_export_xlsx(self, admin_session):
        r = admin_session.get(f"{API}/reports/export/sales.xlsx")
        assert r.status_code == 200
        ct = r.headers.get("content-type", "")
        assert "openxmlformats-officedocument.spreadsheetml.sheet" in ct
        # Excel files start with PK (zip)
        assert r.content[:2] == b"PK"

    def test_export_products_thalis(self, admin_session):
        for rtype in ("products", "thalis"):
            r = admin_session.get(f"{API}/reports/export/{rtype}.csv")
            assert r.status_code == 200
            r2 = admin_session.get(f"{API}/reports/export/{rtype}.xlsx")
            assert r2.status_code == 200


# ---------- Removed endpoints ----------
class TestRemovedEndpoints:
    @pytest.mark.parametrize("path", [
        "/online-orders", "/tables", "/inventory", "/customers", "/discounts", "/kot",
        "/staff/register",
    ])
    def test_endpoints_404(self, admin_session, path):
        r = admin_session.get(f"{API}{path}")
        # 404 (not found) or 405 (method not allowed) — endpoint must not be functional
        assert r.status_code in (404, 405), f"{path} returned {r.status_code} unexpectedly"
