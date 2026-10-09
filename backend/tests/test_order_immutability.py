import pytest
import asyncio
import os
import aiosqlite
import json
from datetime import datetime, timezone

# Ensure testing uses an in-memory or dedicated test db
os.environ["DB_PATH"] = ":memory:"
os.environ["DB_NAME"] = "test_pos"

from httpx import AsyncClient, ASGITransport
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from server import app, lifespan, get_db, _execute, _fetchone, _fetchall, create_access_token

def _auth_header(role="admin", email="admin@example.com", tenant="tenant_test", user_id=None):
    uid = user_id or f"user_{role}_123"
    token = create_access_token(
        user_id=uid,
        email=email,
        role=role,
        tenant_id=tenant
    )
    return {
        "Authorization": f"Bearer {token}",
        "X-Tenant-ID": tenant
    }

async def _seed_user(db, role="admin", email="admin@example.com", tenant="tenant_test", user_id=None, name=None):
    uid = user_id or f"user_{role}_{tenant}_123"
    nm = name or f"Test {role.capitalize()}"
    await _execute(db,
        "INSERT OR REPLACE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (uid, email, nm, role, "hash", tenant, "2026-01-01T00:00:00Z")
    )
    return _auth_header(role=role, email=email, tenant=tenant, user_id=uid)

@pytest.mark.anyio
async def test_order_number_immutability_and_soft_delete():
    async with lifespan(app):
        db = await get_db()
        await _execute(db, "INSERT OR REPLACE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("user_admin_123", "admin@test.com", "Test Admin", "admin", "hash", "t_seq_test", "2026-01-01"))
        await _execute(db, "INSERT OR REPLACE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("user_cashier_123", "cashier@test.com", "Test Cashier", "cashier", "hash", "t_seq_test", "2026-01-01"))

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin_headers = _auth_header("admin", "admin@test.com", "t_seq_test")
            cashier_headers = _auth_header("cashier", "cashier@test.com", "t_seq_test")

            # 1. Reset orders for clean test slate
            res = await client.delete("/api/orders/reset", headers=admin_headers)
            assert res.status_code == 200

            # 2. Create Order 1, 2, 3, 4
            created_orders = []
            for i in range(1, 5):
                order_data = {
                    "items": [{"menu_item_id": f"item_{i}", "name": f"Item {i}", "price": 100.0, "qty": 1}],
                    "payment_mode": "cash",
                    "customer_name": f"Customer {i}",
                    "customer_phone": f"987654321{i}",
                }
                res = await client.post("/api/orders", json=order_data, headers=admin_headers)
                assert res.status_code == 200, res.text
                created_orders.append(res.json())

            # Verify initial receipt numbers are strictly sequential: 1, 2, 3, 4
            receipt_nos = [o["receipt_no"] for o in created_orders]
            assert receipt_nos == [1, 2, 3, 4], f"Expected [1, 2, 3, 4], got {receipt_nos}"

            # 3. Test Authorization: Cashier cannot delete order (403 Forbidden)
            res = await client.delete(f"/api/orders/{created_orders[1]['id']}", headers=cashier_headers)
            assert res.status_code == 403, "Cashier should not have permission to delete order"

            # 4. Normal deletion: Admin deletes Order 2
            order_2_id = created_orders[1]["id"]
            res = await client.request(
                "DELETE",
                f"/api/orders/{order_2_id}",
                json={"reason": "Customer changed mind"},
                headers=admin_headers
            )
            assert res.status_code == 200
            del_resp = res.json()
            assert del_resp["ok"] is True
            assert del_resp["deletion_reason"] == "Customer changed mind"
            assert del_resp["deleted_by"] == "Test Admin"

            # 5. Verify Active Orders: Order 2 must NOT appear.
            # Orders 1, 3, 4 MUST PRESERVE THEIR ORIGINAL NUMBERS: [1, 3, 4]!
            # NO RENUMBERING! 3 does NOT become 2! 4 does NOT become 3!
            res = await client.get("/api/orders", headers=admin_headers)
            assert res.status_code == 200
            active_orders = res.json()
            active_receipts = [o["receipt_no"] for o in active_orders]
            assert 2 not in active_receipts, "Deleted order 2 must not appear in active orders"
            assert sorted(active_receipts) == [1, 3, 4], f"Expected active orders [1, 3, 4], got {sorted(active_receipts)}"

            # 6. Verify Deleted Orders endpoint: Order 2 appears with original receipt_no = 2
            res = await client.get("/api/orders/deleted", headers=admin_headers)
            assert res.status_code == 200
            deleted_list = res.json()
            assert len(deleted_list) == 1
            deleted_order = deleted_list[0]
            assert deleted_order["id"] == order_2_id
            assert deleted_order["receipt_no"] == 2
            assert deleted_order["is_deleted"] is True
            assert deleted_order["deletion_reason"] == "Customer changed mind"
            assert deleted_order["deleted_by"] == "Test Admin"
            assert deleted_order["deleted_at"] is not None

            # Cashier cannot access /api/orders/deleted
            res = await client.get("/api/orders/deleted", headers=cashier_headers)
            assert res.status_code == 403

            # 7. Create NEW Order after deletion:
            # Business rule: Must NOT reuse deleted number 2! Must continue forward to 5!
            new_order_data = {
                "items": [{"menu_item_id": "item_5", "name": "Item 5", "price": 150.0, "qty": 1}],
                "payment_mode": "upi",
                "customer_name": "Customer 5",
            }
            res = await client.post("/api/orders", json=new_order_data, headers=admin_headers)
            assert res.status_code == 200
            order_5 = res.json()
            assert order_5["receipt_no"] == 5, f"Expected order receipt_no 5, got {order_5['receipt_no']}"

            # Active orders now: [1, 3, 4, 5]
            res = await client.get("/api/orders", headers=admin_headers)
            active_receipts = sorted([o["receipt_no"] for o in res.json()])
            assert active_receipts == [1, 3, 4, 5], f"Expected [1, 3, 4, 5], got {active_receipts}"

            # 8. Multiple deletions: Delete Order 4
            order_4_id = created_orders[3]["id"]
            res = await client.request(
                "DELETE",
                f"/api/orders/{order_4_id}",
                json={"reason": "Kitchen shortage"},
                headers=admin_headers
            )
            assert res.status_code == 200

            # Active orders now: [1, 3, 5]
            res = await client.get("/api/orders", headers=admin_headers)
            active_receipts = sorted([o["receipt_no"] for o in res.json()])
            assert active_receipts == [1, 3, 5], f"Expected [1, 3, 5], got {active_receipts}"

            # Deleted orders now: [2, 4]
            res = await client.get("/api/orders/deleted", headers=admin_headers)
            deleted_receipts = sorted([o["receipt_no"] for o in res.json()])
            assert deleted_receipts == [2, 4], f"Expected deleted [2, 4], got {deleted_receipts}"

            # 9. Next order after multiple deletions: Must be 6!
            res = await client.post("/api/orders", json=new_order_data, headers=admin_headers)
            assert res.status_code == 200
            order_6 = res.json()
            assert order_6["receipt_no"] == 6

            # 10. Repeated deletion of already deleted order is idempotent
            res = await client.delete(f"/api/orders/{order_2_id}", headers=admin_headers)
            assert res.status_code == 200
            assert res.json().get("message") == "Order already deleted"

            # 11. Dashboard / Reports check:
            # Active orders count must be 4 (1, 3, 5, 6) and revenue must only include active orders
            res = await client.get("/api/dashboard/summary", headers=admin_headers)
            assert res.status_code == 200
            summary = res.json()
            assert summary["today"]["orders"] == 4, f"Dashboard today orders should be 4, got: {summary}"
            assert summary["today"]["revenue"] == 525.0, f"Dashboard today revenue should be 525.0, got: {summary}"


@pytest.mark.anyio
async def test_offline_sync_and_cross_tenant_isolation():
    async with lifespan(app):
        db = await get_db()
        await _execute(db, "INSERT OR REPLACE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("u_t1_admin", "admin@t1.com", "Admin T1", "admin", "hash", "tenant_alpha", "2026-01-01"))
        await _execute(db, "INSERT OR REPLACE INTO users (id, email, name, role, password_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("u_t2_admin", "admin@t2.com", "Admin T2", "admin", "hash", "tenant_beta", "2026-01-01"))

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            t1_headers = _auth_header("admin", "admin@t1.com", "tenant_alpha", user_id="u_t1_admin")
            t2_headers = _auth_header("admin", "admin@t2.com", "tenant_beta", user_id="u_t2_admin")

            # 1. Simulate Offline Created Orders synced to server
            # Orders created offline with numbers 101, 102, 103, 104
            # Order 102 was soft-deleted offline before sync
            offline_orders = [
                {
                    "id": "off_101",
                    "receipt_no": 101,
                    "items": [{"menu_item_id": "m1", "name": "Thali A", "price": 120.0, "qty": 1}],
                    "payment_mode": "cash",
                    "customer_name": "Cust 101",
                    "is_deleted": False,
                },
                {
                    "id": "off_102",
                    "receipt_no": 102,
                    "items": [{"menu_item_id": "m1", "name": "Thali A", "price": 120.0, "qty": 1}],
                    "payment_mode": "cash",
                    "customer_name": "Cust 102 (Deleted Offline)",
                    "is_deleted": True,
                    "deleted_at": "2026-10-07T12:00:00Z",
                    "deleted_by": "Admin T1",
                    "deletion_reason": "Offline cancellation",
                },
                {
                    "id": "off_103",
                    "receipt_no": 103,
                    "items": [{"menu_item_id": "m2", "name": "Thali B", "price": 150.0, "qty": 1}],
                    "payment_mode": "cash",
                    "customer_name": "Cust 103",
                    "is_deleted": False,
                },
            ]

            # Sync offline orders to server
            for order in offline_orders:
                res = await client.post("/api/orders", json=order, headers=t1_headers)
                assert res.status_code == 200, res.text

            # Verify active list: only 101 and 103 exist, and their numbers are UNCHANGED!
            res = await client.get("/api/orders", headers=t1_headers)
            active = res.json()
            active_rns = sorted([o["receipt_no"] for o in active])
            assert active_rns == [101, 103], f"Expected active [101, 103], got {active_rns}"

            # Verify deleted list: 102 exists with exact receipt_no = 102
            res = await client.get("/api/orders/deleted", headers=t1_headers)
            deleted = res.json()
            assert len(deleted) == 1
            assert deleted[0]["receipt_no"] == 102
            assert deleted[0]["deletion_reason"] == "Offline cancellation"

            # 2. Next online order after offline sync continues strictly forward (104, never 102)
            res = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "m3", "name": "Thali C", "price": 200.0, "qty": 1}],
                "payment_mode": "upi"
            }, headers=t1_headers)
            assert res.status_code == 200
            assert res.json()["receipt_no"] == 104

            # 3. Repeated sync is idempotent (posting off_101 again does not duplicate or renumber)
            res = await client.post("/api/orders", json=offline_orders[0], headers=t1_headers)
            assert res.status_code == 200
            res = await client.get("/api/orders", headers=t1_headers)
            active = res.json()
            assert len([o for o in active if o["id"] == "off_101"]) == 1

            # 4. Cross-Tenant Isolation:
            # Tenant Beta cannot view or delete Tenant Alpha's order
            res = await client.get(f"/api/orders/{offline_orders[0]['id']}", headers=t2_headers)
            assert res.status_code == 404, "Tenant Beta should not see Tenant Alpha's order"

            res = await client.delete(f"/api/orders/{offline_orders[0]['id']}", headers=t2_headers)
            assert res.status_code == 404, "Tenant Beta cannot delete Tenant Alpha's order"


@pytest.mark.anyio
async def test_order_numbering_multi_gap_and_server_restart():
    """
    TASK 1, 9 & 12:
    - Normal sequential creation: 101, 102, 103, 104, 105
    - Multiple deletions: 102 and 104 deleted
    - Active: [101, 103, 105]
    - Deleted: [102, 104]
    - Next order must be 106 (never reuse 102 or 104)
    - Sequence counter never decrements
    """
    async with lifespan(app):
        db = await get_db()
        admin_headers = await _seed_user(db, "admin", "admin@restart.com", "t_restart")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.delete("/api/orders/reset", headers=admin_headers)

            # Create 5 orders with receipt numbers 101..105 via offline sync injection
            for i in range(101, 106):
                await client.post("/api/orders", json={
                    "id": f"ord_{i}",
                    "receipt_no": i,
                    "items": [{"menu_item_id": "item1", "name": "Item", "price": 50.0, "qty": 1}],
                    "payment_mode": "cash"
                }, headers=admin_headers)

            # Soft delete 102 and 104
            await client.request("DELETE", "/api/orders/ord_102", json={"reason": "Wrong table"}, headers=admin_headers)
            await client.request("DELETE", "/api/orders/ord_104", json={"reason": "Customer left"}, headers=admin_headers)

            # Verify active list: [101, 103, 105]
            res = await client.get("/api/orders", headers=admin_headers)
            active_rns = sorted([o["receipt_no"] for o in res.json()])
            assert active_rns == [101, 103, 105]

            # Verify deleted list: [102, 104]
            del_res = await client.get("/api/orders/deleted", headers=admin_headers)
            deleted_rns = sorted([o["receipt_no"] for o in del_res.json()])
            assert deleted_rns == [102, 104]

            # Next order MUST be 106!
            next_res = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "item1", "name": "Item", "price": 50.0, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            assert next_res.status_code == 200
            assert next_res.json()["receipt_no"] == 106

            # Even if counters table was deleted or behind, _next_receipt_number checks MAX(receipt_no)
            await _execute(db, "DELETE FROM counters WHERE id = 'receipt' AND tenant_db = 't_restart'")
            next_res_2 = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "item1", "name": "Item", "price": 50.0, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            assert next_res_2.status_code == 200
            assert next_res_2.json()["receipt_no"] == 107


@pytest.mark.anyio
async def test_repeated_sync_four_times_idempotency():
    """
    TASK 7:
    Verify repeated sync (Sync -> Sync -> Sync -> Sync) produces:
    - No duplicate orders
    - No duplicate deleted orders
    - No order number changes
    - No resurrected orders
    """
    async with lifespan(app):
        db = await get_db()
        admin_headers = await _seed_user(db, "admin", "admin@sync4.com", "t_sync4")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.delete("/api/orders/reset", headers=admin_headers)

            payloads = [
                {"id": "s_201", "receipt_no": 201, "items": [{"menu_item_id": "m1", "name": "P1", "price": 100, "qty": 1}], "payment_mode": "cash", "is_deleted": False},
                {"id": "s_202", "receipt_no": 202, "items": [{"menu_item_id": "m2", "name": "P2", "price": 150, "qty": 1}], "payment_mode": "cash", "is_deleted": True, "deleted_at": "2026-10-08T00:00:00Z", "deleted_by": "Owner", "deletion_reason": "Offline void"},
                {"id": "s_203", "receipt_no": 203, "items": [{"menu_item_id": "m3", "name": "P3", "price": 200, "qty": 1}], "payment_mode": "cash", "is_deleted": False},
            ]

            # Replay the sync 4 times
            for _ in range(4):
                for p in payloads:
                    res = await client.post("/api/orders", json=p, headers=admin_headers)
                    assert res.status_code == 200

            # Verify active list has exactly 2 orders (201, 203), no duplicates
            res = await client.get("/api/orders", headers=admin_headers)
            active = res.json()
            assert len(active) == 2
            assert sorted([o["receipt_no"] for o in active]) == [201, 203]

            # Verify deleted list has exactly 1 order (202), no duplicates
            del_res = await client.get("/api/orders/deleted", headers=admin_headers)
            deleted = del_res.json()
            assert len(deleted) == 1
            assert deleted[0]["receipt_no"] == 202
            assert deleted[0]["deletion_reason"] == "Offline void"

            # Check next order is strictly 204
            res_next = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "m4", "name": "P4", "price": 250, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            assert res_next.status_code == 200
            assert res_next.json()["receipt_no"] == 204


@pytest.mark.anyio
async def test_reporting_and_dashboard_financial_semantics():
    """
    TASK 8:
    Verify reports & dashboard:
    - Deleted orders are strictly excluded from revenue, order counts, and top items
    - Historical deleted orders remain retrievable via /orders/deleted
    """
    async with lifespan(app):
        db = await get_db()
        admin_headers = await _seed_user(db, "admin", "admin@reports.com", "t_reports")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.delete("/api/orders/reset", headers=admin_headers)

            # Order 1: 100
            res1 = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "it1", "name": "Dish A", "price": 100.0, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            o1 = res1.json()

            # Order 2: 200
            res2 = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "it2", "name": "Dish B", "price": 200.0, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            o2 = res2.json()

            # Order 3: 300
            res3 = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "it3", "name": "Dish C", "price": 300.0, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            o3 = res3.json()

            # Total before deletion = 100 + 200 + 300 = 600 subtotal, 630.0 with 5% GST
            dash1 = (await client.get("/api/dashboard/summary", headers=admin_headers)).json()
            assert dash1["today"]["orders"] == 3
            assert dash1["today"]["revenue"] == 630.0

            sales1 = (await client.get("/api/reports/sales", headers=admin_headers)).json()
            assert len(sales1) == 3

            # Delete Order 2 (200.0 + 10 GST = 210.0)
            del_resp = await client.request("DELETE", f"/api/orders/{o2['id']}", json={"reason": "Customer cancellation"}, headers=admin_headers)
            assert del_resp.status_code == 200

            # Dashboard must now have only 2 orders, revenue = 420.0
            dash2 = (await client.get("/api/dashboard/summary", headers=admin_headers)).json()
            assert dash2["today"]["orders"] == 2
            assert dash2["today"]["revenue"] == 420.0

            # Reports must exclude deleted order: 2 orders, 400 total
            sales2 = (await client.get("/api/reports/sales", headers=admin_headers)).json()
            assert len(sales2) == 2
            assert [s["id"] for s in sales2] == [o1["id"], o3["id"]]

            # Product report must only contain Dish A and Dish C
            prod_report = (await client.get("/api/reports/products", headers=admin_headers)).json()
            dish_names = [p["name"] for p in prod_report]
            assert "Dish B" not in dish_names
            assert "Dish A" in dish_names
            assert "Dish C" in dish_names

            # Historical audit query retains deleted order 2
            deleted_list = (await client.get("/api/orders/deleted", headers=admin_headers)).json()
            assert len(deleted_list) == 1
            assert deleted_list[0]["id"] == o2["id"]
            assert deleted_list[0]["deletion_reason"] == "Customer cancellation"


@pytest.mark.anyio
async def test_legacy_database_migration_and_persistence(tmp_path):
    """
    TASK 11:
    Verify schema migration from an older database that lacked is_deleted, deleted_at, etc.
    - Legacy orders remain active (is_deleted = 0)
    - Order numbers remain untouched
    - Migration does not lose data
    - Deletion and queries work on migrated database
    """
    db_file = tmp_path / "legacy_test.db"
    
    # 1. Create legacy schema manually without soft-delete columns
    async with aiosqlite.connect(str(db_file)) as legacy_conn:
        await legacy_conn.execute("""
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL DEFAULT 'default',
                email TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'cashier',
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        """)
        await legacy_conn.execute("""
            CREATE TABLE orders (
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
                PRIMARY KEY (id, tenant_db)
            );
        """)
        await legacy_conn.execute("""
            CREATE TABLE counters (
                id TEXT NOT NULL,
                tenant_db TEXT NOT NULL DEFAULT 'default',
                value INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (id, tenant_db)
            );
        """)
        await legacy_conn.execute("""
            CREATE TABLE settings (
                id TEXT NOT NULL,
                tenant_db TEXT NOT NULL DEFAULT 'default',
                data TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (id, tenant_db)
            );
        """)
        # Insert admin user
        await legacy_conn.execute(
            "INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("u_mig_admin", "t_mig", "admin@mig.com", "Mig Admin", "admin", "hash", "2025-01-01T00:00:00Z")
        )
        # Insert legacy orders
        await legacy_conn.execute(
            "INSERT INTO orders (id, tenant_db, receipt_no, items, subtotal, total, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("leg_1", "t_mig", 50, json.dumps([{"name": "Old Meal", "price": 100, "qty": 1}]), 100.0, 100.0, "2025-01-01T10:00:00Z", "2025-01-01T10:00:00Z")
        )
        await legacy_conn.execute(
            "INSERT INTO orders (id, tenant_db, receipt_no, items, subtotal, total, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("leg_2", "t_mig", 51, json.dumps([{"name": "Old Meal 2", "price": 120, "qty": 1}]), 120.0, 120.0, "2025-01-01T11:00:00Z", "2025-01-01T11:00:00Z")
        )
        await legacy_conn.execute(
            "INSERT INTO counters (id, tenant_db, value) VALUES ('receipt', 't_mig', 51)"
        )
        await legacy_conn.commit()

    # 2. Run application lifespan with this database to trigger automatic migration
    saved_db_path = os.environ.get("DB_PATH")
    os.environ["DB_PATH"] = str(db_file)
    try:
        async with lifespan(app):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                admin_headers = _auth_header("admin", "admin@mig.com", "t_mig", user_id="u_mig_admin")

                # Verify migrated orders are readable and active
                res = await client.get("/api/orders", headers=admin_headers)
                assert res.status_code == 200
                orders = res.json()
                assert len(orders) == 2
                assert [o["receipt_no"] for o in orders] == [51, 50]
                assert all(o["is_deleted"] is False for o in orders)

                # Next order must continue forward: receipt_no = 52
                res_new = await client.post("/api/orders", json={
                    "items": [{"menu_item_id": "m_new", "name": "New Meal", "price": 80, "qty": 1}],
                    "payment_mode": "cash"
                }, headers=admin_headers)
                assert res_new.status_code == 200
                assert res_new.json()["receipt_no"] == 52

                # Soft delete migrated order leg_1
                del_res = await client.request(
                    "DELETE",
                    "/api/orders/leg_1",
                    json={"reason": "Audit cleanup"},
                    headers=admin_headers
                )
                assert del_res.status_code == 200

                # Active list now has [52, 51]
                active_res = await client.get("/api/orders", headers=admin_headers)
                active_rns = [o["receipt_no"] for o in active_res.json()]
                assert 50 not in active_rns
                assert 51 in active_rns
                assert 52 in active_rns
    finally:
        if saved_db_path:
            os.environ["DB_PATH"] = saved_db_path
        else:
            os.environ["DB_PATH"] = ":memory:"


@pytest.mark.anyio
async def test_comprehensive_authorization_matrix():
    """
    TASK 5:
    Full security matrix:
    - Owner can delete: YES
    - Admin can delete: YES
    - Cashier can delete: NO (403)
    - Unauthenticated cannot delete: NO (401/403)
    - Cross-tenant delete: NO (404)
    """
    async with lifespan(app):
        db = await get_db()
        owner_headers = await _seed_user(db, "owner", "owner@sec.com", "t_sec")
        admin_headers = await _seed_user(db, "admin", "admin@sec.com", "t_sec")
        cashier_headers = await _seed_user(db, "cashier", "cashier@sec.com", "t_sec")
        other_tenant_headers = await _seed_user(db, "owner", "owner@other.com", "t_other")

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.delete("/api/orders/reset", headers=owner_headers)

            # Create test orders
            o1_resp = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "m1", "name": "Item 1", "price": 50, "qty": 1}],
                "payment_mode": "cash"
            }, headers=owner_headers)
            assert o1_resp.status_code == 200
            o1 = o1_resp.json()

            o2_resp = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "m2", "name": "Item 2", "price": 60, "qty": 1}],
                "payment_mode": "cash"
            }, headers=owner_headers)
            assert o2_resp.status_code == 200
            o2 = o2_resp.json()

            # 1. Cashier cannot delete (403 Forbidden)
            res = await client.delete(f"/api/orders/{o1['id']}", headers=cashier_headers)
            assert res.status_code == 403

            # 2. Unauthenticated cannot delete (401/403)
            res = await client.delete(f"/api/orders/{o1['id']}")
            assert res.status_code in [401, 403]

            # 3. Other tenant cannot delete (404 Not Found)
            res = await client.delete(f"/api/orders/{o1['id']}", headers=other_tenant_headers)
            assert res.status_code == 404

            # 4. Admin can delete
            res = await client.delete(f"/api/orders/{o1['id']}", headers=admin_headers)
            assert res.status_code == 200

            # 5. Owner can delete
            res = await client.delete(f"/api/orders/{o2['id']}", headers=owner_headers)
            assert res.status_code == 200

            # 6. Cashier cannot reset orders
            res = await client.delete("/api/orders/reset", headers=cashier_headers)
            assert res.status_code == 403


@pytest.mark.anyio
async def test_delete_by_receipt_no_and_idempotency():
    """Verify that delete works by receipt_no fallback, and repeat delete is idempotent."""
    async with lifespan(app):
        db = await get_db()
        admin_headers = await _seed_user(db, "admin", "admin@deltest.com", "t_del_test")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Create order
            res = await client.post("/api/orders", json={
                "items": [{"menu_item_id": "m1", "name": "Item 1", "price": 100, "qty": 1}],
                "payment_mode": "cash"
            }, headers=admin_headers)
            assert res.status_code == 200
            order = res.json()
            rn = order["receipt_no"]
            oid = order["id"]

            # 2. Delete by receipt_no
            del_res = await client.delete(f"/api/orders/{rn}", headers=admin_headers)
            assert del_res.status_code == 200
            assert del_res.json()["ok"] is True
            assert del_res.json()["id"] == oid

            # 3. Repeated delete by receipt_no is idempotent (200 with "Order already deleted")
            repeat_res = await client.delete(f"/api/orders/{rn}", headers=admin_headers)
            assert repeat_res.status_code == 200
            assert repeat_res.json()["message"] == "Order already deleted"

            # 4. Repeated delete by id is also idempotent
            repeat_id_res = await client.delete(f"/api/orders/{oid}", headers=admin_headers)
            assert repeat_id_res.status_code == 200
            assert repeat_id_res.json()["message"] == "Order already deleted"


@pytest.mark.anyio
async def test_bulk_delete_and_restore_all():
    async with lifespan(app):
        db = await get_db()
        admin_headers = await _seed_user(db, "admin", "admin@bulktest.com", "t_bulk_test")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Reset orders
            await client.delete("/api/orders/reset", headers=admin_headers)

            # 2. Create 3 orders
            for i in range(1, 4):
                res = await client.post("/api/orders", json={
                    "items": [{"menu_item_id": f"m{i}", "name": f"Item {i}", "price": 100, "qty": 1}],
                    "payment_mode": "cash"
                }, headers=admin_headers)
                assert res.status_code == 200

            active = await client.get("/api/orders", headers=admin_headers)
            assert len(active.json()) == 3
            assert sorted([o["receipt_no"] for o in active.json()]) == [1, 2, 3]

            # 3. Bulk delete all active orders
            del_res = await client.post("/api/orders/delete-all", json={"reason": "Testing bulk delete"}, headers=admin_headers)
            assert del_res.status_code == 200
            assert del_res.json()["ok"] is True

            active_after = await client.get("/api/orders", headers=admin_headers)
            deleted_after = await client.get("/api/orders/deleted", headers=admin_headers)
            assert len(active_after.json()) == 0
            assert len(deleted_after.json()) == 3
            assert sorted([o["receipt_no"] for o in deleted_after.json()]) == [1, 2, 3]

            # 4. Bulk restore all deleted orders
            rest_res = await client.post("/api/orders/restore-all", headers=admin_headers)
            assert rest_res.status_code == 200
            assert rest_res.json()["ok"] is True

            active_restored = await client.get("/api/orders", headers=admin_headers)
            deleted_restored = await client.get("/api/orders/deleted", headers=admin_headers)
            assert len(active_restored.json()) == 3
            assert len(deleted_restored.json()) == 0
            assert sorted([o["receipt_no"] for o in active_restored.json()]) == [1, 2, 3]


