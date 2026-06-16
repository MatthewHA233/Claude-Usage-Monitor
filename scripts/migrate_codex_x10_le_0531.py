#!/usr/bin/env python3
"""一次性数据迁移：把某 Codex 账号在某日期（含）之前的历史快照按指定倍率重算。

背景：app 采集时用「套餐倍率」对 used_percent 做归一化
  session_pct = used% * mult,  session_total_pct = 100 * mult（weekly 同理）。
某段历史的倍率记错时，可用本脚本按正确倍率重写：从已存 pct/total 反推原始 used_percent，再乘新倍率。
  used% = pct_old * 100 / total_old
  pct_new = used% * mult,  total_new = 100 * mult

本次用途：Codex `matthewha233@gmail.com` 在 2026-05-31（本地）及之前的历史快照，从 ×5 改为 ×10。

⚠️ 注意：app 的 `src-tauri/src/db.rs::normalize_codex_pro_scale` 会在每次启动时把 codex
`total=1000` 的行减半成 `total=500`（pct *= 0.5）。要让 ×10 不被撤销，需先在代码层放行 1000
（去掉/调整该迁移 + `storage_pct_and_total` 里 codex 1000→500 的处理），否则下次启动会被打回 ×5。

用法：
  python scripts/migrate_codex_x10_le_0531.py                 # dry-run（默认 db 路径）
  python scripts/migrate_codex_x10_le_0531.py <usage.db>       # dry-run（指定 db）
  python scripts/migrate_codex_x10_le_0531.py <usage.db> --apply   # 实际写入（请先自行备份 usage.db）
"""
import sqlite3
import sys
import os
import datetime

PROVIDER = "codex"
ALIAS = "matthewha233@gmail.com"
CUTOFF = datetime.date(2026, 5, 31)  # 含当天及之前（本地日期）
NEW_MULT = 10.0


def default_db() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local")
    return os.path.join(base, "claude-usage-monitor", "usage.db")


def local_date(collected_at: str):
    """RFC3339（通常 UTC）→ 本地日期；解析失败返回 None。"""
    try:
        return datetime.datetime.fromisoformat(collected_at).astimezone().date()
    except Exception:
        return None


def reconv(pct, total_old):
    """从已存 pct/total 反推原始 used_percent，再乘新倍率。total 缺失/<=0 时原样返回。"""
    if pct is None or not total_old or total_old <= 0:
        return pct
    return pct * 100.0 / total_old * NEW_MULT


def main() -> None:
    apply = "--apply" in sys.argv
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    db = pos[0] if pos else default_db()
    new_total = 100.0 * NEW_MULT

    con = sqlite3.connect(db, timeout=20)
    cur = con.cursor()
    rows = cur.execute(
        "SELECT id, collected_at, session_pct, session_total_pct, weekly_pct, weekly_total_pct "
        "FROM usage_snapshots WHERE provider=? AND account_alias=?",
        (PROVIDER, ALIAS),
    ).fetchall()
    targets = [r for r in rows if (d := local_date(r[1])) and d <= CUTOFF]

    print(f"db={db}")
    print(
        f"匹配 {len(targets)}/{len(rows)} 条 (provider={PROVIDER}, alias={ALIAS}, "
        f"本地日期 <= {CUTOFF}) → ×{int(NEW_MULT)} (total={int(new_total)})"
    )
    if not targets:
        con.close()
        return
    if not apply:
        print("dry-run（加 --apply 才实际写入）。样例 session_pct/total:", [(r[2], r[3]) for r in targets[:3]])
        con.close()
        return

    n = 0
    for snap_id, _ca, sp, st, wp, wt in targets:
        cur.execute(
            "UPDATE usage_snapshots SET session_pct=?, session_total_pct=?, weekly_pct=?, weekly_total_pct=? "
            "WHERE id=?",
            (reconv(sp, st), new_total, reconv(wp, wt), new_total, snap_id),
        )
        n += 1
    con.commit()
    con.close()
    print(f"已更新 {n} 条 → ×{int(NEW_MULT)} (total={int(new_total)})")


if __name__ == "__main__":
    main()
