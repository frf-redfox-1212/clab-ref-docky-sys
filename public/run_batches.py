# run_batches.py
# Auto-runs all SQL batch files directly against Supabase Postgres
# Place this file in the same folder as your batch_*.sql files
# Run: python run_batches.py

import psycopg2
import glob
import os
import time
import re

# ── CONFIG — fill these in ──────────────────────────────────────────────────
SUPABASE_HOST = "aws-1-ap-southeast-1.pooler.supabase.com"
SUPABASE_DB   = "postgres"
SUPABASE_USER = "postgres.shhkjxmjiqyswyfluabf"
SUPABASE_PASS = "4UwJRlnFRyAMay9C"  # paste your reset password here
SUPABASE_PORT = 5432
START_FROM_BATCH = 1  # change to resume from a specific batch
# ────────────────────────────────────────────────────────────────────────────

print("=" * 50)
print("Connecting to Supabase...")
print(f"Host: {SUPABASE_HOST}")
print("=" * 50)

try:
    conn = psycopg2.connect(
        host=SUPABASE_HOST,
        dbname=SUPABASE_DB,
        user=SUPABASE_USER,
        password=SUPABASE_PASS,
        port=SUPABASE_PORT,
        sslmode="require"
    )
    conn.autocommit = True
    cursor = conn.cursor()
    print("✓ Connected successfully!\n")
except Exception as e:
    print(f"✗ Connection failed: {e}")
    exit(1)

batch_files = sorted(glob.glob("batch_*.sql"))
total = len(batch_files)
print(f"Found {total} batch files")
print(f"Starting from batch {START_FROM_BATCH}\n")
print("-" * 50)

success = 0
failed = 0
total_inserted = 0
missing_doctors = {}  # internal_code -> name lookup
start_time = time.time()

for batch_file in batch_files:
    batch_num = int(batch_file.replace("batch_", "").replace(".sql", ""))
    
    if batch_num < START_FROM_BATCH:
        print(f"⏭  Batch {batch_num:03d} — skipped")
        continue

    with open(batch_file, "r") as f:
        sql = f.read()

    statements = [s.strip() for s in sql.split(";") if s.strip()]
    batch_start = time.time()

    try:
        inserted = 0
        skipped_duplicate = 0
        skipped_no_doctor = 0
        
        for stmt in statements:
            # Extract doctor internal_code from statement
            doc_match = re.search(r"internal_code = '(\d+)'", stmt)
            if doc_match:
                doc_internal = doc_match.group(1)
                cursor.execute(f"SELECT id, name FROM doctors WHERE internal_code = '{doc_internal}' LIMIT 1")
                result = cursor.fetchone()
                if not result:
                    skipped_no_doctor += 1
                    missing_doctors[doc_internal] = missing_doctors.get(doc_internal, 0) + 1
                    continue
            
            cursor.execute(stmt)
            if cursor.rowcount > 0:
                inserted += cursor.rowcount
            else:
                skipped_duplicate += 1
        
        total_inserted += inserted
        elapsed = time.time() - batch_start
        success += 1
        print(f"✓ Batch {batch_num:03d}/{total} — {inserted} inserted, {skipped_duplicate} duplicates, {skipped_no_doctor} no doctor ({elapsed:.1f}s) | Total: {total_inserted}")

    except Exception as e:
        failed += 1
        print(f"✗ Batch {batch_num:03d}/{total} FAILED: {e}")
        try:
            conn.rollback()
        except:
            pass

total_time = time.time() - start_time
print("\n" + "=" * 50)
print(f"Done in {total_time:.1f}s")
print(f"✓ Success: {success} batches")
print(f"✗ Failed:  {failed} batches")
print(f"Total rows inserted: {total_inserted}")
print("=" * 50)

if missing_doctors:
    print(f"\n📋 DOCTORS NOT FOUND IN DATABASE ({len(missing_doctors)} unique):")
    print(f"{'Internal Code':<20} {'Codes Skipped'}")
    print("-" * 40)
    for code, count in sorted(missing_doctors.items()):
        print(f"{code:<20} {count} codes skipped")
    print(f"\nTotal codes skipped due to missing doctors: {sum(missing_doctors.values())}")

cursor.close()
conn.close()