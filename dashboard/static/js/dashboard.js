// ===============================
// Helper: wrap job labels in 2 lines
// ===============================
function wrapJobLabel(label) {
  if (!label) return "";
  if (label.length <= 12) return label;   // short labels stay as is

  // Try splitting at underscore or dash if present
  const splitChars = ["_", "-", " "];
  for (let ch of splitChars) {
    const idx = label.indexOf(ch, Math.floor(label.length / 3));
    if (idx !== -1) {
      return label.slice(0, idx) + "<br>" + label.slice(idx + 1);
    }
  }
  // fallback: split in the middle
  const mid = Math.floor(label.length / 2);
  return label.slice(0, mid) + "<br>" + label.slice(mid);
}



// ==========================
// Fetch data from Flask API
// ==========================
async function loadData() {
  const machineId = document.getElementById("machine").value || "";
  const startDate = document.getElementById("startDate").value || "";
  const endDate = document.getElementById("endDate").value || "";
  const status = document.getElementById("status").value || "";

  const url = new URL("/dashboard/api/data", window.location.origin);
  if (machineId) url.searchParams.append("machine_id", machineId);
  if (startDate) url.searchParams.append("start_date", startDate);
  if (endDate) url.searchParams.append("end_date", endDate);
  if (status) url.searchParams.append("status", status);   // ✅ new filter

  const response = await fetch(url);
  const data = await response.json();
  return data;
}


// ==========================
// Update KPI cards
// ==========================
// ==========================
// Update KPI cards
// ==========================
function updateKPIs(data) {
  // Percent KPIs
  document.getElementById("activePct").innerText =
    (data.active_pct != null ? data.active_pct.toFixed(1) : "0.0") + "%";

  document.getElementById("inactivePct").innerText =
    (data.inactive_pct != null ? data.inactive_pct.toFixed(1) : "0.0") + "%";

  document.getElementById("learnPct").innerText =
    (data.learn_pct != null ? data.learn_pct.toFixed(1) : "0.0") + "%";

  // Length KPIs
  document.getElementById("totalLength").innerText =
    (data.total_length != null ? data.total_length.toFixed(2) : 0) + " m";

  document.getElementById("activeLength").innerText =
    (data.active_length != null ? data.active_length.toFixed(2) : 0) + " m";

  document.getElementById("inactiveLength").innerText =
    (data.inactive_length != null ? data.inactive_length.toFixed(2) : 0) + " m";

  document.getElementById("learnLength").innerText =
    (data.learn_length != null ? data.learn_length.toFixed(2) : 0) + " m";

  // Other KPIs
  document.getElementById("totalDefects").innerText = data.total_defects ?? 0;
  document.getElementById("totalJobs").innerText = data.total_jobs ?? 0;
  document.getElementById("defectClasses").innerText = data.defect_classes ?? 0;
}


// ==========================
// Plot charts
// ==========================
function renderCharts(data) {
  const reels = data.reels || [];
  const defects = data.defects_all || [];

  // -------------------------------
  // Chart: Defects by Type (Pie)
  // -------------------------------
  const defectTypeCounts = {};
  defects.forEach(d => {
    defectTypeCounts[d.class_name] = (defectTypeCounts[d.class_name] || 0) + 1;
  });

  Plotly.newPlot("defectTypes", [{
    labels: Object.keys(defectTypeCounts),
    values: Object.values(defectTypeCounts),
    type: "pie",
    textinfo: "percent",
    hoverinfo: "label+value+percent",
    insidetextorientation: "radial"
  }], {
    title: "Defects by Type",
    legend: { orientation: "v" }
  });

    // -------------------------------
    // Chart: Inspection State Trend (color-coded)
    // -------------------------------
// -------------------------------
// Chart: Inspection State Timeline (scatter lines = Gantt-style)
// -------------------------------
const stateColors = {
  active: "green",
  inactive: "red",
  learn: "orange"
};

const ganttTraces = ["active", "inactive", "learn"].map(state => {
  const stateReels = reels.filter(r => r.inspection_state === state);

  return {
    x: stateReels.flatMap(r => [r.time_start, r.time_end, null]), // start -> end, then break
    y: stateReels.flatMap(() => [state, state, null]),            // keep same state label
    mode: "lines",
    line: { color: stateColors[state], width: 6 },
    name: state
  };
});

Plotly.newPlot("activeTrend", ganttTraces, {
  title: "Inspection State Over Time",
  xaxis: { type: "date", title: "Time" },
  yaxis: {
    title: "State",
    categoryorder: "array",
    categoryarray: ["inactive", "learn", "active"]
  },
  legend: { orientation: "v", x: 1.05, y: 1 }
});




  // -------------------------------
  // Chart: Defects Over Time
  // -------------------------------
    function floorToHour(d) {
    const date = new Date(d);
    date.setMinutes(0, 0, 0);
    return date;
    }

    function ceilToHour(d) {
    const date = new Date(d);
    if (date.getMinutes() !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0) {
        date.setHours(date.getHours() + 1);
        date.setMinutes(0, 0, 0);
    }
    return date;
    }

    const startTime = floorToHour(Math.min(...reels.map(r => new Date(r.time_start))));
    const endTime = ceilToHour(Math.max(...reels.map(r => new Date(r.time_end))));

    const defectTrace = {
    x: defects.map(d => d.defect_time),
    type: "histogram",
    histfunc: "count",
    autobinx: false,
    xbins: {
        start: startTime,
        end: endTime,
        size: 1000 * 60 * 60 // 1 hour bins aligned to clock hours
    },
    marker: { color: "steelblue" },
    name: "Defects"
    };

    Plotly.newPlot("defectTrend", [defectTrace], {
    title: "Defects Over Time",
    xaxis: { type: "date", range: [startTime, endTime] },
    yaxis: { title: "Defect Count" }
    });



  // -------------------------------
  // Chart 1: Meters Run by Job
  // -------------------------------
  const jobLengths = {};
  reels.forEach(r => {
    jobLengths[r.job_name] = (jobLengths[r.job_name] || 0) + (r.reel_end - r.reel_start);
  });

  const jobs1 = Object.keys(jobLengths);
  const jobs1Wrapped = jobs1.map(wrapJobLabel);

  Plotly.newPlot("jobsMeters", [{
    x: jobs1Wrapped,
    y: Object.values(jobLengths),
    type: "bar",
    marker: { color: "steelblue" }
  }], {
    title: "Meters Run by Job",
    xaxis: { title: "Job", automargin: true, tickangle: -45 },
    yaxis: { title: "Meters" },
    margin: { b: 100, t: 40 },
    height: 350
  });

  // -------------------------------
  // Chart 2: Active vs Inactive vs Learn by Job
  // -------------------------------
  const jobStates = {};
  reels.forEach(r => {
    if (!jobStates[r.job_name]) {
      jobStates[r.job_name] = { active: 0, inactive: 0, learn: 0 };
    }
    const length = (r.reel_end - r.reel_start);
    if (r.inspection_state === "active") {
      jobStates[r.job_name].active += length;
    } else if (r.inspection_state === "inactive") {
      jobStates[r.job_name].inactive += length;
    } else if (r.inspection_state === "learn") {
      jobStates[r.job_name].learn += length;
    }
  });

  const jobs2 = Object.keys(jobStates);
  const jobs2Wrapped = jobs2.map(wrapJobLabel);

  Plotly.newPlot("jobsTime", [
    { x: jobs2Wrapped, y: jobs2.map(j => jobStates[j].active), name: "Active", type: "bar", marker: { color: "seagreen" }},
    { x: jobs2Wrapped, y: jobs2.map(j => jobStates[j].inactive), name: "Inactive", type: "bar", marker: { color: "tomato" }},
    { x: jobs2Wrapped, y: jobs2.map(j => jobStates[j].learn), name: "Learn", type: "bar", marker: { color: "orange" }}
  ], { 
    title: "Meters by Job (Active vs Inactive vs Learn)",
    barmode: "stack",
    xaxis: { title: "Job", automargin: true, tickangle: -45 },
    yaxis: { title: "Meters" },
    margin: { b: 100, t: 40 },
    height: 350
  });

  // -------------------------------
  // Chart 3: Defects by Job (Stacked by Defect Type)
  // -------------------------------
  const jobDefectTypes = {};
  defects.forEach(d => {
    if (!jobDefectTypes[d.job_name]) jobDefectTypes[d.job_name] = {};
    jobDefectTypes[d.job_name][d.class_name] =
        (jobDefectTypes[d.job_name][d.class_name] || 0) + 1;
  });

  const jobs3 = Object.keys(jobDefectTypes);
  const jobs3Wrapped = jobs3.map(wrapJobLabel);
  const defectTypes = [...new Set(defects.map(d => d.class_name))];

  const traces = defectTypes.map(type => ({
    x: jobs3Wrapped,
    y: jobs3.map(job => jobDefectTypes[job][type] || 0),
    name: type,
    type: "bar"
  }));

  Plotly.newPlot("jobsDefects", traces, {
    title: "Defects by Job (Stacked)",
    barmode: "stack",
    xaxis: { title: "Job", automargin: true, tickangle: -45 },
    yaxis: { title: "Defect Count" },
    margin: { b: 120, t: 40 },
    height: 350
  });
}



// ==========================
// Render Defect Details
// ==========================

function renderDefectDetails(allDefects) {
  const jobFilterVal = (document.getElementById("jobFilter").value || "").toLowerCase();
  const typeFilterVal = (document.getElementById("typeFilter").value || "").toLowerCase();
  const reelFilterVal = (document.getElementById("reelFilter").value || "").toLowerCase();
  const orderFilterVal = (document.getElementById("orderFilter").value || "").toLowerCase();
  const stateFilterVal = (document.getElementById("stateFilter").value || "").toLowerCase();

  // Parse numeric filters
  const magMin = parseFloat(document.getElementById("magMin").value) || 0;
  const magMax = parseFloat(document.getElementById("magMax").value);
  const sevMin = parseFloat(document.getElementById("sevMin").value) || 0;
  const sevMax = parseFloat(document.getElementById("sevMax").value);
  const posMin = parseFloat(document.getElementById("posMin").value) || 0;
  const posMaxEl = document.getElementById("posMax").value;
  const posMaxParsed = parseFloat(posMaxEl);

  // Safe defaults
  const magMaxSafe = isNaN(magMax) ? 9999 : magMax;
  const sevMaxSafe = isNaN(sevMax) ? 9999 : sevMax;
  const posMaxSafe = (isNaN(posMaxParsed) || posMaxEl === "" || posMaxParsed === 1000)
    ? 999999
    : posMaxParsed;

  let filtered = allDefects.filter((d, idx) => {
    const job = (d.job_name || "").toLowerCase();
    const type = (d.class_name || "").toLowerCase();
    const order = (d.order_number || "").toLowerCase();
    const reel = (d.reel_number || "").toString().toLowerCase();
    const state = (d.inspection_state || "").toLowerCase();
    const mag = parseFloat(d.magnitude_value) || 0;
    const sev = parseFloat(d.severity_value) || 0;
    const pos = parseFloat(d.format_position) || 0;


    const jobOk = !jobFilterVal || job === jobFilterVal;
    const typeOk = !typeFilterVal || type === typeFilterVal;
    const orderOk = !orderFilterVal || order === orderFilterVal;
    const reelOk = !reelFilterVal || reel === reelFilterVal;
    const stateOk = !stateFilterVal || state === stateFilterVal;
    const magOk = mag >= magMin && mag <= magMaxSafe;
    const sevOk = sev >= sevMin && sev <= sevMaxSafe;
    const posOk = pos >= posMin && pos <= posMaxSafe;

    return jobOk && typeOk && orderOk && reelOk && stateOk && magOk && sevOk && posOk;
  });

  // console.log("Defects before filter:", allDefects.length, "after filter:", filtered.length);

  renderTable(filtered);
  renderDefectCharts(filtered);
}




// ==========================
// Render Table
// ==========================
function renderTable(defects) {
  const tbody = document.getElementById("defectTable").querySelector("tbody");
  tbody.innerHTML = "";

  defects.forEach(d => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${d.reel_number || ""}</td>
      <td>${d.defect_time || ""}</td>
      <td>${d.order_number || ""}</td>
      <td>${d.job_name || ""}</td>
      <td>${d.class_name || ""}</td>
      <td>${d.magnitude_value ?? ""}</td>
      <td>${d.severity_value ?? ""}</td>
      <td>${d.format_position ?? ""}</td>
      <td>${d.inspection_state || ""}</td>
      <td>
        ${
          d.image_src
            ? `<img src="/static/${d.image_src.replace(/\\/g, "/")}"
                   style="height:40px;cursor:pointer;"
                   onclick="showImageModal('/static/${d.image_src.replace(/\\/g, "/")}')">`
            : ""
        }
      </td>
    `;
    tbody.appendChild(row);
  });
}



// ==========================
// Render Defect Charts
// ==========================
function renderDefectCharts(defects) {
  if (!defects.length) {
    Plotly.purge("jobDefectTrend");
    Plotly.purge("jobDefectCounts");
    Plotly.purge("jobDefectMagnitude");
    Plotly.purge("jobDefectSeverity");
    Plotly.purge("jobDefectPosition");
    return;
  }

  // ----------------------------
  // 1. Defects Over Time (keep)
  // ----------------------------
  Plotly.newPlot("jobDefectTrend", [{
    x: defects.map(d => d.defect_time),
    type: "histogram",
    xbins: { size: 1000 * 60 * 60 }, // 1h bins
    marker: { color: "tomato" }
  }], { title: "Defects Over Time", xaxis: { type: "date" }, yaxis: { title: "Count" } });

  // ----------------------------
  // 2. Defects by Type (keep pie)
  // ----------------------------
  const counts = {};
  defects.forEach(d => counts[d.class_name] = (counts[d.class_name] || 0) + 1);
  Plotly.newPlot("jobDefectCounts", [{
    labels: Object.keys(counts),
    values: Object.values(counts),
    type: "pie",
    textinfo: "label+percent+value"
  }], { title: "Defects by Type" });

  // ----------------------------
  // 3. Magnitude Ranges
  // ----------------------------
  const magRanges = [
    { label: "0-0.2", min: 0, max: 0.2 },
    { label: "0.2-0.4", min: 0.2, max: 0.4 },
    { label: "0.4-0.6", min: 0.4, max: 0.6 },
    { label: "0.6-0.8", min: 0.6, max: 0.8 },
    { label: "0.8-1.0", min: 0.8, max: 1.0 }
  ];
  const magCounts = magRanges.map(r =>
    defects.filter(d => d.magnitude_value >= r.min && d.magnitude_value < r.max).length
  );
  Plotly.newPlot("jobDefectMagnitude", [{
    x: magRanges.map(r => r.label),
    y: magCounts,
    type: "bar",
    marker: { color: "steelblue" }
  }], { title: "Magnitude Ranges", xaxis: { title: "Magnitude Bin" }, yaxis: { title: "Count" } });

  // ----------------------------
  // 4. Severity Ranges
  // ----------------------------
  const sevRanges = [
    { label: "0-5", min: 0, max: 5 },
    { label: "5-20", min: 5, max: 20 },
    { label: "20-50", min: 20, max: 50 },
    { label: "50-100", min: 50, max: 100 },
    { label: "100-250", min: 100, max: 250 },
    { label: "250-500", min: 250, max: 500 },
    { label: ">500", min: 500, max: Infinity }
  ];
  const sevCounts = sevRanges.map(r =>
    defects.filter(d => d.severity_value >= r.min && d.severity_value < r.max).length
  );
  Plotly.newPlot("jobDefectSeverity", [{
    x: sevRanges.map(r => r.label),
    y: sevCounts,
    type: "bar",
    marker: { color: "orange" }
  }], { title: "Severity Ranges", xaxis: { title: "Severity Bin" }, yaxis: { title: "Count" } });

  // ----------------------------
  // 5. Position Histogram
  // ----------------------------
  Plotly.newPlot("jobDefectPosition", [{
    type: "histogram",
    x: defects.map(d => d.format_position),
    nbinsx: 40,
    marker: { color: "green" }
  }], { title: "Defects by Format Position", xaxis: { title: "Position" }, yaxis: { title: "Count" } });

  
}



// ==========================
// Main Dashboard Renderer
// ==========================

async function renderDashboard() {
  const data = await loadData();

  // console.log("defects_all:", (data.defects_all || []).length, "defects_table:", (data.defects_table || []).length);

  updateKPIs(data);
  renderCharts(data);

  // ----------------------------
  // Populate dropdowns
  // ----------------------------
  const jobFilter = document.getElementById("jobFilter");
  const typeFilter = document.getElementById("typeFilter");
  const orderFilter = document.getElementById("orderFilter");
  const reelFilter = document.getElementById("reelFilter");
  const stateFilter = document.getElementById("stateFilter");

  // Reset dropdowns
  jobFilter.innerHTML = "<option value=''>All Jobs</option>";
  typeFilter.innerHTML = "<option value=''>All Types</option>";
  orderFilter.innerHTML = "<option value=''>All Orders</option>";
  reelFilter.innerHTML = "<option value=''>All Reels</option>";

  // Extract unique values
  const jobs = [...new Set((data.defects_all || []).map(d => d.job_name))];
  const types = [...new Set((data.defects_all || []).map(d => d.class_name))];
  const orders = [...new Set((data.defects_all || []).map(d => d.order_number))];
  const reels = [...new Set((data.defects_all || []).map(d => d.reel_number))];

  // Populate dropdowns dynamically
  jobs.forEach(j => {
    if (j) {
      const opt = document.createElement("option");
      opt.value = j;
      opt.textContent = j;
      jobFilter.appendChild(opt);
    }
  });

  types.forEach(t => {
    if (t) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      typeFilter.appendChild(opt);
    }
  });

  orders.forEach(o => {
    if (o) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      orderFilter.appendChild(opt);
    }
  });

  reels.forEach(o => {
    if (o) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      reelFilter.appendChild(opt);
    }
  });

  // ----------------------------
  // Hook up filter event listeners
  // ----------------------------
  ["orderFilter", "stateFilter", "jobFilter", "typeFilter", "reelFilter"].forEach(id => {
    document.getElementById(id).onchange = () =>
      renderDefectDetails(data.defects_table || []);
  });

  ["magMin", "magMax", "sevMin", "sevMax", "posMin", "posMax"].forEach(id => {
    document.getElementById(id).oninput = () =>
      renderDefectDetails(data.defects_table || []);
  });

  // ----------------------------
  // Initial render
  // ----------------------------
  renderDefectDetails(data.defects_table || []);
}




// ==========================
// Image Modal Controls
// ==========================
function showImageModal(src) {
  document.getElementById("modalImage").src = src;
  document.getElementById("imageModal").style.display = "block";
}

function closeModal() {
  document.getElementById("imageModal").style.display = "none";
  document.getElementById("modalImage").src = "";  // clear it
}




// ==========================
// Event Bindings
// ==========================

document.getElementById("applyFilters").addEventListener("click", renderDashboard);
document.addEventListener("DOMContentLoaded", () => { renderDashboard(); });
