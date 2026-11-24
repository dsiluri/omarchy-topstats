// Pure parsing and formatting helpers for TopStats.
//
// The sampler does the I/O; everything in here is a pure function so it can
// be exercised from a plain QML/JS shell and stays free of Quickshell types.

var HISTORY_LIMIT = 120

function clamp(value, low, high) {
  var n = Number(value)
  if (!isFinite(n)) return low
  return Math.max(low, Math.min(high, n))
}

function percent(value) {
  return clamp(value, 0, 100)
}

// /proc/stat exposes one aggregate line and one line per logical CPU. The
// guest time is already included in user/nice, so it is deliberately left out
// of the total to avoid counting it twice.
function parseProcStat(text) {
  var lines = String(text || "").split("\n")
  var aggregate = null
  var cores = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line.indexOf("cpu") !== 0) continue
    var parts = line.split(/\s+/)
    if (parts.length < 5) continue
    var values = []
    for (var j = 1; j < parts.length && j <= 8; j++) values.push(Number(parts[j]) || 0)
    while (values.length < 8) values.push(0)
    var total = values[0] + values[1] + values[2] + values[3]
      + values[4] + values[5] + values[6] + values[7]
    var idle = values[3] + values[4]
    var row = { total: total, idle: idle }
    if (parts[0] === "cpu") aggregate = row
    else cores.push(row)
  }
  return { aggregate: aggregate, cores: cores }
}

// Usage needs two samples. A missing/zero-width window means "no reading
// yet", which the bar renders as the last known value rather than a jump to 0.
function cpuUsage(current, previous) {
  if (!current || !previous) return null
  var totalDelta = current.total - previous.total
  var idleDelta = current.idle - previous.idle
  if (totalDelta <= 0) return null
  return percent(100 * (1 - idleDelta / totalDelta))
}

function cpuCoreUsages(current, previous) {
  var out = []
  if (!current || !previous) return out
  var count = Math.min(current.length, previous.length)
  for (var i = 0; i < count; i++) {
    var usage = cpuUsage(current[i], previous[i])
    out.push(usage === null ? 0 : usage)
  }
  return out
}

// Memory "used" follows the same convention as GNOME System Monitor:
// total minus available, so reclaimable cache is not counted as pressure.
function parseMeminfo(text) {
  var values = ({})
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^([A-Za-z_()0-9]+):\s+(\d+)/)
    if (match) values[match[1]] = Number(match[2]) * 1024
  }
  var total = Number(values.MemTotal) || 0
  var available = Number(values.MemAvailable) || 0
  if (available <= 0 && values.MemFree !== undefined) {
    available = Number(values.MemFree) + (Number(values.Buffers) || 0) + (Number(values.Cached) || 0)
  }
  var used = Math.max(0, total - available)
  var swapTotal = Number(values.SwapTotal) || 0
  var swapFree = Number(values.SwapFree) || 0
  var swapUsed = Math.max(0, swapTotal - swapFree)
  return {
    total: total,
    available: available,
    used: used,
    percent: total > 0 ? percent(100 * used / total) : 0,
    swapTotal: swapTotal,
    swapFree: swapFree,
    swapUsed: swapUsed,
    swapPercent: swapTotal > 0 ? percent(100 * swapUsed / swapTotal) : 0
  }
}

// /proc/cpuinfo lists the current MHz of every logical CPU. The maximum is
// more useful than the average on hybrid parts: a single busy P-core at
// 5.1 GHz would otherwise average down to ~1 GHz across 24 threads.
function parseCpuFrequency(text) {
  var matches = String(text || "").match(/cpu MHz\s*:\s*([0-9.]+)/g) || []
  if (matches.length === 0) return 0
  var max = 0
  for (var i = 0; i < matches.length; i++) {
    var value = Number(matches[i].replace(/^[^:]*:\s*/, ""))
    if (isFinite(value) && value > max) max = value
  }
  return max
}

function parseCpuModel(text) {
  var match = String(text || "").match(/model name\s*:\s*(.+)/)
  return match ? match[1].trim() : ""
}

function parseUptime(text) {
  var parts = String(text || "").trim().split(/\s+/)
  var seconds = Number(parts[0])
  return isFinite(seconds) ? seconds : 0
}

function parseTemperature(text) {
  var milli = Number(String(text || "").trim())
  return isFinite(milli) && milli > 0 ? milli / 1000 : -1
}

// nvidia-smi --format=csv,noheader,nounits
// name, utilization.gpu, memory.used, memory.total, temperature.gpu,
// power.draw, driver_version
function parseNvidia(text) {
  var line = String(text || "").trim().split("\n")[0]
  if (!line) return null
  var parts = line.split(",")
  for (var i = 0; i < parts.length; i++) parts[i] = parts[i].trim()
  if (parts.length < 5) return null
  var usedMiB = toNumber(parts[2])
  var totalMiB = toNumber(parts[3])
  return {
    name: parts[0] || "NVIDIA GPU",
    percent: percent(toNumber(parts[1])),
    memUsed: usedMiB * 1024 * 1024,
    memTotal: totalMiB * 1024 * 1024,
    temp: toNumber(parts[4], -1),
    power: parts.length > 5 ? toNumber(parts[5], -1) : -1,
    driver: parts.length > 6 ? parts[6] : ""
  }
}

function toNumber(value, fallback) {
  var cleaned = String(value || "").replace(/[^0-9.+-]/g, "")
  if (cleaned === "" || cleaned === "+" || cleaned === "-") return fallback === undefined ? 0 : fallback
  var n = Number(cleaned)
  if (!isFinite(n)) return fallback === undefined ? 0 : fallback
  return n
}

// nvidia-smi pmon -c 1 lists every process with a graphics or compute
// context, unlike --query-compute-apps which omits graphics clients such as
// the compositor and browser. Columns: gpu pid type sm mem enc dec jpg ofa
// command. A dash means the column does not apply to that context. Zero-usage
// contexts are kept so the GPU tab can always name the applications using it.
function parseNvidiaProcesses(text) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line || line.charAt(0) === "#") continue
    var parts = line.split(/\s+/)
    if (parts.length < 10) continue
    var gpu = toNumber(parts[3], 0)
    var name = parts.slice(9).join(" ")
    out.push({
      pid: Number(parts[1]),
      gpu: gpu,
      name: processName(name)
    })
  }
  out.sort(function(a, b) { return b.gpu - a.gpu })
  return out
}

// Default grouping when the widget entry has no "groups" array. Docker
// container processes carry arbitrary names (postgres, node), so they can only
// be grouped by cgroup; the daemons live in docker.service / containerd.service.
var DEFAULT_GROUP_RULES = [
  { name: "docker", cgroup: "^/system\\.slice/(docker|containerd)" }
]

function compilePattern(text) {
  if (typeof text !== "string" || text === "") return null
  try { return new RegExp(text) } catch (e) { return null }
}

// Ordered rules; the first match wins. A rule matches when its cgroup regex
// matches the process cgroup path OR its comm regex matches the process name.
// Entries without a name (or longer than 32 chars) or without a valid pattern
// are skipped.
function compileGroupRules(value) {
  var source = Array.isArray(value) ? value : DEFAULT_GROUP_RULES
  var out = []
  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    if (!entry || typeof entry !== "object") continue
    var name = String(entry.name || "").trim()
    if (!name || name.length > 32) continue
    var comm = compilePattern(entry.comm)
    var cgroup = compilePattern(entry.cgroup)
    if (!comm && !cgroup) continue
    out.push({ name: name, comm: comm, cgroup: cgroup })
  }
  return out
}

// scan-processes.sh output: pid, cpu seconds, rss bytes, pss bytes (-1 when
// not read), cgroup path, comm (last, may contain spaces).
function parseProcessScan(text) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("\t")
    if (parts.length < 6) continue
    var pid = Number(parts[0])
    if (!isFinite(pid) || pid <= 0) continue
    var comm = parts.slice(5).join(" ")
    out.push({
      pid: pid,
      cpuSeconds: Number(parts[1]) || 0,
      rss: Number(parts[2]) || 0,
      pss: Number(parts[3]),
      cgroup: parts[4],
      comm: comm,
      name: processName(comm)
    })
  }
  return out
}

function groupNameFor(row, rules) {
  var comm = String(row.comm !== undefined ? row.comm : (row.name || ""))
  var cgroup = String(row.cgroup || "")
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i]
    if ((rule.cgroup && cgroup && rule.cgroup.test(cgroup)) || (rule.comm && rule.comm.test(comm))) return rule.name
  }
  return row.name
}

// Keeps the first limit-1 rows and folds the rest into one "other" row, so the
// section never exceeds `limit` rows. `sorted` must already be in display order.
function limitGroups(sorted, limit) {
  var n = Math.max(1, Math.floor(Number(limit) || 6))
  if (sorted.length <= n) return sorted.slice()
  var out = sorted.slice(0, n - 1)
  var other = { name: "other", other: true, cpu: 0, memory: 0, gpu: 0, count: 0, approx: false, pids: [] }
  for (var i = n - 1; i < sorted.length; i++) {
    var item = sorted[i]
    other.cpu += Number(item.cpu) || 0
    other.memory += Number(item.memory) || 0
    other.gpu += Number(item.gpu) || 0
    other.count += Number(item.count) || 0
    other.approx = other.approx || item.approx === true
  }
  out.push(other)
  return out
}

function processName(value) {
  var name = String(value || "").trim()
  if (!name) return "unknown"
  // Full command lines (NVIDIA reports one) collapse to the executable name.
  if (name.indexOf("/") !== -1) {
    var pieces = name.split(/\s+/)
    name = pieces[0]
    var slash = name.lastIndexOf("/")
    if (slash !== -1) name = name.slice(slash + 1)
  }
  return name.length > 26 ? name.slice(0, 25) + "…" : name
}

// Collapse processes into app groups: the first matching rule names the group,
// unmatched processes group by their own command name. Kernel threads are
// dropped (they have no resident memory) so an idle list is filled with real
// applications rather than "7:1-events" and friends.
function aggregateApps(rows, rules) {
  var byName = {}
  var activeRules = rules || []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    var memory = Number(row.memory) || 0
    if (!row.name) continue
    // Scan rows carry memory; pmon rows do not. Only treat memory==0 as a
    // kernel thread when the row actually came from the scan.
    if (row.memory !== undefined && memory <= 0) continue
    var group = groupNameFor(row, activeRules)
    var key = String(group).toLowerCase()
    if (!byName[key]) {
      byName[key] = { name: group, cpu: 0, cpuSeconds: 0, memory: 0, gpu: 0, count: 0, approx: false, pids: [] }
    }
    var entry = byName[key]
    entry.cpuSeconds += Number(row.cpuDelta) || 0
    entry.memory += memory
    entry.gpu += Number(row.gpu) || 0
    entry.count += 1
    entry.approx = entry.approx || row.approx === true
    entry.pids.push(row.pid)
  }
  var out = []
  for (var name in byName) out.push(byName[name])
  return out
}

// CPU seconds a process used since the previous scan. A pid missing from the
// previous scan started after it (the scan lists every process with resident
// memory), so everything it has used happened inside the interval and counts
// in full instead of reading as 0 until the next scan.
function cpuSecondsSince(current, previous) {
  if (previous === undefined) return Math.max(0, current)
  return Math.max(0, current - previous)
}

// Appends one scan's per-group CPU seconds to the rolling window and drops
// samples that are no longer needed to cover `windowSeconds`. `apps` are the
// aggregateApps() groups of that scan whose cpuSeconds were summed from
// cpuSecondsSince(). Totals are kept per group, not per pid, so a process
// that exits mid-window keeps contributing what it used.
function pushCpuSample(samples, apps, elapsed, windowSeconds) {
  if (!(elapsed > 0)) return samples
  var groups = {}
  for (var i = 0; i < apps.length; i++) {
    groups[String(apps[i].name).toLowerCase()] = { name: apps[i].name, seconds: apps[i].cpuSeconds || 0 }
  }
  var out = samples.concat([{ elapsed: elapsed, groups: groups }])
  var span = 0
  for (var j = out.length - 1; j >= 0; j--) {
    span += out[j].elapsed
    if (span >= windowSeconds) return out.slice(j)
  }
  return out
}

// Groups with their CPU share averaged over the window, as a percentage of
// the whole machine. `latest` supplies memory and process counts from the
// newest scan; groups that only exist in older samples (all their processes
// exited) stay listed with count 0 until they age out of the window.
function windowedApps(samples, latest, cpuCount) {
  var span = 0
  var seconds = {}
  var names = {}
  for (var i = 0; i < samples.length; i++) {
    span += samples[i].elapsed
    for (var key in samples[i].groups) {
      seconds[key] = (seconds[key] || 0) + samples[i].groups[key].seconds
      names[key] = samples[i].groups[key].name
    }
  }
  var scale = span > 0 ? 100 / span / Math.max(1, cpuCount) : 0
  var out = []
  var seen = {}
  for (var a = 0; a < latest.length; a++) {
    var lkey = String(latest[a].name).toLowerCase()
    seen[lkey] = true
    var copy = {}
    for (var field in latest[a]) copy[field] = latest[a][field]
    copy.cpu = (seconds[lkey] || 0) * scale
    out.push(copy)
  }
  for (var gone in seconds) {
    if (seen[gone]) continue
    out.push({ name: names[gone], cpu: seconds[gone] * scale, cpuSeconds: 0, memory: 0, gpu: 0, count: 0, approx: false, pids: [] })
  }
  return out
}

function formatBytes(bytes, decimals) {
  var n = Number(bytes)
  if (!isFinite(n) || n < 0) return "—"
  if (n >= 1024 * 1024 * 1024) {
    return trimFixed(n / (1024 * 1024 * 1024), decimals === undefined ? 1 : decimals) + " GB"
  }
  if (n >= 1024 * 1024) {
    return trimFixed(n / (1024 * 1024), 0) + " MB"
  }
  if (n >= 1024) return trimFixed(n / 1024, 0) + " KB"
  return Math.round(n) + " B"
}

// Network rates use the same binary units as the rest of the plugin. The
// compact form is for the bar; the full form is for tooltips and the panel.
// Both deliberately round to whole units: a system monitor does not need
// 1.83K/s in the top bar.
function formatRate(bytesPerSec) {
  var n = Number(bytesPerSec)
  if (!isFinite(n) || n < 0) n = 0
  if (n >= 1024 * 1024 * 1024) return trimFixed(n / (1024 * 1024 * 1024), 1) + " GB/s"
  if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + " MB/s"
  if (n >= 1024) return Math.round(n / 1024) + " KB/s"
  return Math.round(n) + " B/s"
}

function formatRateCompact(bytesPerSec) {
  var n = Number(bytesPerSec)
  if (!isFinite(n) || n < 0) n = 0
  if (n >= 1024 * 1024 * 1024) return trimFixed(n / (1024 * 1024 * 1024), 1) + "G/s"
  if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + "M/s"
  if (n >= 1024) return Math.round(n / 1024) + "K/s"
  return Math.round(n) + "B/s"
}

// /proc/net/dev: loopback is excluded, and interfaces whose counters are
// still zero are ignored. Summing the rest gives the same view as a desktop
// network monitor without depending on NetworkManager.
function parseNetDev(text) {
  var lines = String(text || "").split("\n")
  var rx = 0
  var tx = 0
  var interfaces = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var colon = line.indexOf(":")
    if (colon === -1) continue
    var iface = line.slice(0, colon).trim()
    if (!iface || iface === "lo") continue
    var fields = line.slice(colon + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    var ifaceRx = Number(fields[0]) || 0
    var ifaceTx = Number(fields[8]) || 0
    if (ifaceRx === 0 && ifaceTx === 0) continue
    rx += ifaceRx
    tx += ifaceTx
    interfaces.push(iface)
  }
  return { rxBytes: rx, txBytes: tx, interfaces: interfaces }
}

function trimFixed(value, decimals) {
  var text = Number(value).toFixed(decimals)
  if (text.indexOf(".") !== -1) text = text.replace(/\.?0+$/, "")
  return text
}

function formatPercent(value) {
  var n = Number(value)
  if (!isFinite(n)) return "—"
  return Math.round(n) + "%"
}

function formatFrequency(mhz) {
  var n = Number(mhz)
  if (!isFinite(n) || n <= 0) return "—"
  if (n >= 1000) return trimFixed(n / 1000, 2) + " GHz"
  return Math.round(n) + " MHz"
}

function formatTemperature(celsius) {
  var n = Number(celsius)
  if (!isFinite(n) || n < 0) return "—"
  return Math.round(n) + " °C"
}

function formatPower(watts) {
  var n = Number(watts)
  if (!isFinite(n) || n < 0) return "—"
  return trimFixed(n, 1) + " W"
}

function formatUptime(seconds) {
  var total = Math.max(0, Math.floor(Number(seconds) || 0))
  var days = Math.floor(total / 86400)
  var hours = Math.floor((total % 86400) / 3600)
  var minutes = Math.floor((total % 3600) / 60)
  var parts = []
  if (days > 0) parts.push(days + (days === 1 ? " day" : " days"))
  if (hours > 0) parts.push(hours + (hours === 1 ? " hour" : " hours"))
  if (minutes > 0 && days === 0) parts.push(minutes + (minutes === 1 ? " minute" : " minutes"))
  if (parts.length === 0) return "less than a minute"
  return parts.join(" ")
}

function pushHistory(values, value, limit) {
  var out = Array.isArray(values) ? values.slice() : []
  var n = Number(value)
  out.push(isFinite(n) ? clamp(n, 0, 100) : 0)
  var max = limit || HISTORY_LIMIT
  while (out.length > max) out.shift()
  return out
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  var sum = 0
  for (var i = 0; i < values.length; i++) sum += Number(values[i]) || 0
  return sum / values.length
}
