#!/bin/bash
# TopStats process scanner. One tab-separated line per user-space process:
#   pid  cpu-seconds  rss-bytes  pss-bytes(-1 when not read)  cgroup  comm
# Usage: scan-processes.sh rss|pss   ("pss" also reads smaps_rollup, ~5x slower)
cd /proc || exit 1
extra=""
[ "$1" = "pss" ] && extra="[0-9]*/smaps_rollup"
exec gawk -v hz="$(getconf CLK_TCK)" -v page="$(getconf PAGESIZE)" '
BEGINFILE {
  if (ERRNO != "") nextfile
  split(FILENAME, p, "/"); pid = p[1]; kind = p[2]
}
kind == "stat" {
  s = $0; i = index(s, "("); j = 0
  for (k = length(s); k > 0; k--) if (substr(s, k, 1) == ")") { j = k; break }
  if (i == 0 || j == 0) nextfile
  comm[pid] = substr(s, i + 1, j - i - 1)
  split(substr(s, j + 2), f, " ")
  cpu[pid] = (f[12] + f[13]) / hz
  nextfile
}
kind == "statm" { rss[pid] = $2 * page; nextfile }
kind == "smaps_rollup" { if ($1 == "Pss:") { pss[pid] = $2 * 1024; nextfile } next }
kind == "cgroup" { if (substr($0, 1, 3) == "0::") cg[pid] = substr($0, 4); nextfile }
END {
  for (pid in comm) {
    if (!(pid in rss) || rss[pid] <= 0) continue
    name = comm[pid]; gsub(/[[:cntrl:]]/, " ", name)
    printf "%s\t%.2f\t%d\t%d\t%s\t%s\n", pid, cpu[pid], rss[pid], ((pid in pss) ? pss[pid] : -1), cg[pid], name
  }
}' [0-9]*/stat [0-9]*/statm [0-9]*/cgroup $extra 2>/dev/null
