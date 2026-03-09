import sqlite3
import os

for db_path in ['chagent.db', 'backend/chagent.db', 'backend/chadb.sqlite']:
    if not os.path.exists(db_path):
        continue
    try:
        print(f"--- Database: {db_path} ---")
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = cur.fetchall()
        for t in tables:
            table_name = t[0]
            if 'teacher' in table_name or 'user' in table_name:
                print(f"Table: {table_name}")
                cur.execute(f"SELECT * FROM {table_name}")
                for row in cur.fetchall():
                    print(row)
    except Exception as e:
        print(f"Error querying {db_path}: {e}")
