#!/usr/bin/env python3
import argparse
import csv
import io
import os
import re
import sqlite3
import sys
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

PLATE_RE = re.compile(r"^[0-9]{8}$")
CODE_RE = re.compile(r"^[0-9]{4}$")
YEAR_RE = re.compile(r"^(19|20)[0-9]{2}$")
SUG_DEGEM_RE = re.compile(r"^[MP]$")

REPLACEMENT_CHAR = "\ufffd"


def iterate_lines_with_warnings(f, encoding):
    wrapper = io.TextIOWrapper(f, encoding=encoding, errors="replace", newline="")
    line_num = 0

    try:
        for line in wrapper:
            line_num += 1

            if REPLACEMENT_CHAR in line:
                print(
                    f"[WARN] Decoding issue at line {line_num}: contains replacement characters",
                    file=sys.stderr,
                )
                print(
                    f"        Line content: {line.rstrip()[:200]}",
                    file=sys.stderr,
                )

            yield line

    finally:
        wrapper.detach()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Build a compact SQLite database from data/models.csv and "
            "data/licenses.csv for license_plate_no -> make, model, color, year, seats."
        )
    )
    p.add_argument("--models", default="data/models.csv")
    p.add_argument("--licenses", default="data/licenses.csv")
    p.add_argument("--output", default="data/licenses.db")
    p.add_argument("--models-encoding", default="utf-8")
    p.add_argument("--licenses-encoding", default="cp1255")
    p.add_argument("--batch-size", type=int, default=10000)
    return p.parse_args()


def csv_reader(path: str, encoding: str):
    f = open(path, "rb")
    lines = iterate_lines_with_warnings(f, encoding)
    return csv.DictReader(lines, delimiter="|", quotechar='"')


def require_columns(reader: csv.DictReader, required: Iterable[str], path: str) -> None:
    missing = sorted(set(required) - set(reader.fieldnames or []))
    if missing:
        raise RuntimeError(f"{path} is missing required columns: {missing}")


def check_re(value: str, pattern: re.Pattern, field_name: str, row_num: int) -> str:
    if not pattern.fullmatch(value):
        raise ValueError(
            f"invalid {field_name} at row {row_num}: expected exact pattern {pattern.pattern!r}, got {value!r}"
        )
    return value


def parse_optional_int(value: str, field_name: str, row_num: int) -> Optional[int]:
    if value == "":
        return None
    try:
        return int(value)
    except ValueError as e:
        raise ValueError(f"invalid {field_name} at row {row_num}: {value!r}") from e


def configure_db(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()

    # Bulk-build tuned for small RAM and small final size.
    cur.execute("PRAGMA journal_mode=OFF;")
    cur.execute("PRAGMA synchronous=OFF;")
    cur.execute("PRAGMA locking_mode=EXCLUSIVE;")
    cur.execute("PRAGMA temp_store=FILE;")
    cur.execute("PRAGMA cache_size=-16384;")  # ~16 MiB
    cur.execute("PRAGMA page_size=4096;")
    cur.execute("PRAGMA foreign_keys=ON;")
    cur.execute("PRAGMA automatic_index=ON;")

    cur.executescript(
        """
        CREATE TABLE make_names (
            make_id   INTEGER PRIMARY KEY,
            make_name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE model_names (
            model_id   INTEGER PRIMARY KEY,
            model_name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE color_names (
            color_id   INTEGER PRIMARY KEY,
            color_name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE model_keys (
            tozeret_cd   INTEGER NOT NULL,
            degem_cd     INTEGER NOT NULL,
            shnat_yitzur INTEGER NOT NULL CHECK (shnat_yitzur BETWEEN 1900 AND 2099),
            seats        INTEGER NOT NULL,
            PRIMARY KEY (tozeret_cd, degem_cd, shnat_yitzur)
        ) WITHOUT ROWID;

        CREATE TABLE licenses (
            license_plate_no INTEGER PRIMARY KEY,
            make_id          INTEGER NOT NULL,
            model_id         INTEGER NOT NULL,
            color_id         INTEGER NOT NULL,
            year             INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2099),
            seats            INTEGER NOT NULL,
            FOREIGN KEY (make_id) REFERENCES make_names(make_id),
            FOREIGN KEY (model_id) REFERENCES model_names(model_id),
            FOREIGN KEY (color_id) REFERENCES color_names(color_id)
        ) WITHOUT ROWID;
        """
    )
    conn.commit()


class NameTableCache:
    def __init__(self, conn: sqlite3.Connection, table: str, id_col: str, name_col: str):
        self.conn = conn
        self.table = table
        self.id_col = id_col
        self.name_col = name_col
        self.cache: Dict[str, int] = {}

        self.select_sql = f"SELECT {id_col} FROM {table} WHERE {name_col} = ?"
        self.insert_sql = f"INSERT INTO {table} ({name_col}) VALUES (?)"

    def get_id(self, value: str) -> int:
        cached = self.cache.get(value)
        if cached is not None:
            return cached

        cur = self.conn.cursor()
        row = cur.execute(self.select_sql, (value,)).fetchone()
        if row is None:
            cur.execute(self.insert_sql, (value,))
            value_id = int(cur.lastrowid)
        else:
            value_id = int(row[0])

        self.cache[value] = value_id
        return value_id


def batched(rows: Iterator[Tuple], batch_size: int) -> Iterator[List[Tuple]]:
    batch: List[Tuple] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def load_models_to_dict(path: str, encoding: str) -> dict:
    reader = csv_reader(path, encoding)
    require_columns(
        reader,
        {"tozeret_cd", "degem_cd", "shnat_yitzur", "mispar_moshavim", "sug_degem"},
        path,
    )

    models = {}

    for i, row in enumerate(reader, start=2):
        # common columns: 'degem_nm', 'kinuy_mishari', 'tozeret_nm', 'tozeret_cd', 'shnat_yitzur', 'sug_degem', 'ramat_gimur', 'degem_cd', 'kvutzat_zihum', 'ramat_eivzur_betihuty'
        tozeret_cd = int(check_re(row["tozeret_cd"], CODE_RE, "tozeret_cd", i))
        degem_cd = int(check_re(row["degem_cd"], CODE_RE, "degem_cd", i))
        shnat_yitzur = int(check_re(row["shnat_yitzur"], YEAR_RE, "shnat_yitzur", i))
        seats = parse_optional_int(row["mispar_moshavim"], "mispar_moshavim", i)
        sug_degem = check_re(row["sug_degem"], SUG_DEGEM_RE, "sug_degem", i)

        if seats is None:
            raise ValueError(f"missing mispar_moshavim at row {i}")

        key = (tozeret_cd, degem_cd, shnat_yitzur, sug_degem)

        prev_seats = models.get(key)
        if prev_seats is None:
            models[key] = seats
        elif prev_seats != seats:
            raise RuntimeError(
                "conflicting duplicate model key: "
                f"(tozeret_cd={tozeret_cd:04d}, "
                f"degem_cd={degem_cd:04d}, "
                f"{sug_degem=}, "
                f"shnat_yitzur={shnat_yitzur}); "
                f"{prev_seats=}, {seats=}, csv_row={i}"
            )

    return models

def import_licenses(conn, path, encoding, models_dict, batch_size):
    reader = csv_reader(path, encoding)
    require_columns(
        reader,
        {
            "mispar_rechev",
            "tozeret_cd",
            "degem_cd",
            "shnat_yitzur",
            "sug_degem",
            "tozeret_nm",
            "degem_nm",
            "tzeva_rechev",
        },
        path,
    )

    make_cache = NameTableCache(conn, "make_names", "make_id", "make_name")
    model_cache = NameTableCache(conn, "model_names", "model_id", "model_name")
    color_cache = NameTableCache(conn, "color_names", "color_id", "color_name")

    cur = conn.cursor()

    def rows():
        for i, row in enumerate(reader, start=2):
            license_plate_no = int(check_re(row["mispar_rechev"], PLATE_RE, "mispar_rechev", i))
            tozeret_cd = int(check_re(row["tozeret_cd"], CODE_RE, "tozeret_cd", i))
            degem_cd = int(check_re(row["degem_cd"], CODE_RE, "degem_cd", i))
            shnat_yitzur = int(check_re(row["shnat_yitzur"], YEAR_RE, "shnat_yitzur", i))
            sug_degem = check_re(row["sug_degem"], SUG_DEGEM_RE, "sug_degem", i)

            key = (tozeret_cd, degem_cd, shnat_yitzur, sug_degem)

            seats = models_dict.get(key)
            if seats is None:
                raise KeyError(
                    "no matching model: "
                    f"(tozeret_cd={tozeret_cd:04d}, "
                    f"degem_cd={degem_cd:04d}, "
                    f"{sug_degem=}, "
                    f"shnat_yitzur={shnat_yitzur}) at row {i}"
                )

            make_id = make_cache.get_id(row["tozeret_nm"])
            model_id = model_cache.get_id(row["degem_nm"])
            color_id = color_cache.get_id(row["tzeva_rechev"])

            yield (license_plate_no, make_id, model_id, color_id, shnat_yitzur, seats)

    n = 0
    for batch in batched(rows(), batch_size):
        cur.executemany("""
            INSERT INTO licenses
            (license_plate_no, make_id, model_id, color_id, year, seats)
            VALUES (?, ?, ?, ?, ?, ?)
        """, batch)
        n += len(batch)
        conn.commit()

    return n

def create_indexes(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE INDEX idx_licenses_make_id ON licenses(make_id);
        CREATE INDEX idx_licenses_model_id ON licenses(model_id);
        CREATE INDEX idx_licenses_color_id ON licenses(color_id);
        """
    )
    conn.commit()


def compact(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("ANALYZE;")
    conn.commit()
    cur.execute("VACUUM;")
    conn.commit()


def main() -> int:
    args = parse_args()

    if os.path.exists(args.output):
        os.remove(args.output)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    conn = sqlite3.connect(args.output)
    try:
        configure_db(conn)

        print(f"Importing models from {args.models} ...", file=sys.stderr)
        models_dict = load_models_to_dict(path=args.models, encoding=args.models_encoding)
        print(f"Imported {len(models_dict)} model rows.", file=sys.stderr)

        print(f"Importing licenses from {args.licenses} ...", file=sys.stderr)
        license_count = import_licenses(conn=conn, path=args.licenses, encoding=args.licenses_encoding, models_dict=models_dict, batch_size=args.batch_size)
        print(f"Imported {license_count} license rows.", file=sys.stderr)

        print("Creating indexes ...", file=sys.stderr)
        create_indexes(conn)

        print("Compacting database ...", file=sys.stderr)
        compact(conn)

    finally:
        conn.close()

    print(f"Wrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
