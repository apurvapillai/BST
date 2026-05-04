  const DefectDriversTab = (() => {
    let initialized = false;
    let latestRequestToken = 0;
    let inflightPromise = null;
    let inflightKey = "";
    let lastRenderedKey = "";
    let hasRendered = false;
    let timelineRows = [];
    let rawTimelineRows = [];
    let selectedTimelineEventKey = "";
    let selectedEventFilters = new Set();
    let bstTimeExpanded = false;
    let activeReferenceDetail = null;
    let activeMaskDetail = null;
    let activeSpeedDetail = null;
    let activeSpikeDetail = null;
    let referenceViewerState = null;
    const DEFAULT_MIN_REEL_LENGTH_FEET = 4000;
    const MIN_LENGTH_STORAGE_KEY = "defectDrivers.minReelLength";
    let minReelLengthFilter = loadMinReelLength();
    const DRIVER_FILTER_OPTIONS = [
      { key: "sensitivity_change", label: "Sensitivity" },
      { key: "mask_change", label: "Mask" },
      { key: "reference_change", label: "Reference" },
      { key: "speed_shift", label: "Speed" },
      { key: "bst_coverage", label: "BST" },
      { key: "defect_spike", label: "Defect Spike" },
    ];
    const els = {};

    function buildRequestKey(filtersState) {
      if (typeof Utils === "object" && typeof Utils.buildFilterRequestKey === "function") {
        return Utils.buildFilterRequestKey(filtersState || {});
      }
      try {
        return JSON.stringify(filtersState || {});
      } catch (err) {
        return "";
      }
    }

    function formatNumber(value, digits = 0) {
      return Utils.formatNumber(value, digits);
    }

    function formatFeet(value, digits = 0) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
      return `${Utils.formatNumber(value, digits)} ft`;
    }

    function formatRate(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
      return `${Utils.formatNumber(value, 2)}/1k ft`;
    }

    function formatPercent(value, digits = 1) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
      return `${Utils.formatNumber(value, digits)}%`;
    }

    function formatAvgSize(value, basis) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "n/a";
      }
      const formatted = Utils.formatNumber(value, 2);
      if (basis === "magnitude_value_fallback") {
        return `${formatted} fallback`;
      }
      return formatted;
    }

    function formatDelta(value, digits = 2, suffix = "") {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
      const num = Number(value);
      const prefix = num > 0 ? "+" : "";
      return `${prefix}${Utils.formatNumber(num, digits)}${suffix}`;
    }

    function formatTime(value) {
      if (!value) return "--";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function escapeAttr(value) {
      if (value === null || value === undefined) return "";
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/\n/g, "&#10;");
    }

    function renderEmpty(container, message) {
      if (!container) return;
      container.innerHTML = `<div class="drivers-empty placeholder">${Utils.escapeHtml(message)}</div>`;
    }

    function formatMaskCoords(raw) {
      if (raw === null || raw === undefined) return "";
      if (typeof raw === "string") return raw.trim();
      try {
        return JSON.stringify(raw);
      } catch (err) {
        return String(raw);
      }
    }

    function latestReferenceImageFromDetail(detail = {}) {
      if (detail.latest_reference_image && detail.latest_reference_image.image_src) {
        return detail.latest_reference_image;
      }
      const images = Array.isArray(detail.reference_images) ? detail.reference_images : [];
      for (let index = images.length - 1; index >= 0; index -= 1) {
        if (images[index] && images[index].image_src) {
          return images[index];
        }
      }
      return null;
    }

    function renderTimelineDetailEmpty() {
      if (!els.timelineDetail) return;
      activeReferenceDetail = null;
      activeMaskDetail = null;
      activeSpeedDetail = null;
      activeSpikeDetail = null;
      els.timelineDetail.innerHTML = `
        <div class="drivers-detail-empty">
          <p class="kpi-section__title">Event Detail</p>
          <small>Select a timeline flag to inspect the evidence behind that event.</small>
        </div>
      `;
    }

    function renderDriverFilterBar() {
      if (!els.eventFilters) return;
      els.eventFilters.innerHTML = DRIVER_FILTER_OPTIONS
        .map((option) => {
          const selected = selectedEventFilters.has(option.key);
          return `
            <button
              type="button"
              class="drivers-filter-chip${selected ? " is-selected" : ""}"
              data-driver-filter="${Utils.escapeHtml(option.key)}"
              aria-pressed="${selected ? "true" : "false"}"
            >
              ${Utils.escapeHtml(option.label)}
            </button>
          `;
        })
        .join("");
    }

    function getFilteredTimelineRows(rows = []) {
      if (!selectedEventFilters.size) {
        return Array.isArray(rows) ? rows : [];
      }
      return (Array.isArray(rows) ? rows : []).filter((row) =>
        (row.events || []).some((event) => selectedEventFilters.has(event.type))
      );
    }

    function loadMinReelLength() {
      if (typeof sessionStorage === "undefined") return DEFAULT_MIN_REEL_LENGTH_FEET;
      try {
        const raw = sessionStorage.getItem(MIN_LENGTH_STORAGE_KEY);
        if (raw === null || raw === undefined) return DEFAULT_MIN_REEL_LENGTH_FEET;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return DEFAULT_MIN_REEL_LENGTH_FEET;
        if (parsed <= 0) return 0;
        return parsed;
      } catch (err) {
        return DEFAULT_MIN_REEL_LENGTH_FEET;
      }
    }

    function persistMinReelLength(value) {
      if (typeof sessionStorage === "undefined") return;
      try {
        sessionStorage.setItem(MIN_LENGTH_STORAGE_KEY, String(value || 0));
      } catch (err) {
        // ignore
      }
    }

    function updateMinLengthChip() {
      const chip = document.getElementById("driversMinLengthChip");
      const text = chip ? chip.querySelector("span") : null;
      if (!chip) return;
      if (minReelLengthFilter > 0) {
        chip.classList.remove("hidden");
        if (text) {
          text.textContent = `Min reel feet ≥ ${Utils.formatNumber(minReelLengthFilter, 0)} ft`;
        }
      } else {
        chip.classList.add("hidden");
        if (text) text.textContent = "";
      }
    }

    function applyMinReelLength(rawValue) {
      const parsed = Number(rawValue);
      const nextValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      if (nextValue === minReelLengthFilter) {
        updateMinLengthChip();
        return;
      }
      minReelLengthFilter = nextValue;
      persistMinReelLength(minReelLengthFilter);
      if (els.minLengthInput) {
        els.minLengthInput.value = minReelLengthFilter ? Math.round(minReelLengthFilter) : "";
      }
      updateMinLengthChip();
      load.flush();
    }

    function setupMinReelLengthControls() {
      els.minLengthInput = document.getElementById("driversMinReelLengthInput");
      els.minLengthApply = document.getElementById("driversMinReelLengthApply");
      els.minLengthClear = document.getElementById("driversMinLengthClear");
      if (els.minLengthInput) {
        els.minLengthInput.value = minReelLengthFilter ? Math.round(minReelLengthFilter) : "";
        els.minLengthInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applyMinReelLength(els.minLengthInput.value);
          }
        });
      }
      if (els.minLengthApply) {
        els.minLengthApply.addEventListener("click", () => applyMinReelLength(els.minLengthInput ? els.minLengthInput.value : ""));
      }
      if (els.minLengthClear) {
        els.minLengthClear.addEventListener("click", () => applyMinReelLength(""));
      }
      updateMinLengthChip();
    }

    function renderKpis(kpis = {}) {
      if (!els.kpis) return;
      const cards = [
        {
          label: "Reels Analyzed",
          value: formatNumber(kpis.reels_analyzed || 0),
          meta: `${formatNumber(kpis.total_defects || 0)} total defects`,
        },
        {
          label: "Total Footage",
          value: formatFeet(kpis.total_footage, 0),
          meta: "Normalized basis for rate analysis",
        },
        {
          label: "Defects per 1000 ft",
          value: formatRate(kpis.defects_per_1000ft),
          meta: "Length-normalized defect load",
        },
        {
          label: "Average Defect Size",
          value: formatNumber(kpis.average_defect_size, 2),
          meta: kpis.avg_size_basis ? `Using ${kpis.avg_size_basis}` : "Severity-based when available",
        },
        {
          label: "Top Defect Type",
          value: kpis.top_defect_type_label || "--",
          meta: `${formatNumber(kpis.top_defect_type_count || 0)} defects`,
        },
      ];
      els.kpis.innerHTML = cards
        .map(
          (card) => `
            <article class="drivers-kpi-card">
              <span class="drivers-kpi-card__label">${Utils.escapeHtml(card.label)}</span>
              <strong class="drivers-kpi-card__value">${Utils.escapeHtml(card.value)}</strong>
              <small class="drivers-kpi-card__meta">${Utils.escapeHtml(card.meta)}</small>
            </article>
          `
        )
        .join("");
    }

    function renderLegend(eventCounts = {}) {
      if (!els.legend) return;
      const labels = [
        ["sensitivity_change", "Sensitivity"],
        ["mask_change", "Mask"],
        ["reference_change", "Reference"],
        ["speed_shift", "Speed"],
        ["bst_coverage", "BST Coverage"],
        ["defect_spike", "Spike"],
      ];
      els.legend.innerHTML = labels
        .map(([key, label]) => {
          const count = Number(eventCounts[key]) || 0;
          return `
            <span class="drivers-chip drivers-chip--${key}">
              ${Utils.escapeHtml(label)}
              <strong>${Utils.escapeHtml(formatNumber(count))}</strong>
            </span>
          `;
        })
        .join("");
    }

    function renderTimeline(rows = []) {
      if (!els.timeline) return;
      rawTimelineRows = Array.isArray(rows) ? rows : [];
      const filteredRows = getFilteredTimelineRows(rawTimelineRows);
      timelineRows = filteredRows;
      if (!rawTimelineRows.length) {
        renderEmpty(els.timeline, "No reels found for the current shared filters.");
        renderTimelineDetailEmpty();
        return;
      }
      if (!filteredRows.length) {
        renderEmpty(els.timeline, "No timeline events match the selected drivers.");
        renderTimelineDetailEmpty();
        return;
      }
      els.timeline.innerHTML = filteredRows
        .map((row, rowIndex) => {
          const events = (row.events || [])
            .map(
              (event, eventIndex) => `
                <button
                  type="button"
                  class="drivers-event drivers-event--interactive drivers-event--${Utils.escapeHtml(event.type || "generic")}${selectedTimelineEventKey === `${rowIndex}:${eventIndex}` ? " is-active" : ""}"
                  data-timeline-row="${rowIndex}"
                  data-timeline-event="${eventIndex}"
                >
                  <strong>${Utils.escapeHtml(event.label || "Event")}</strong>
                  <span>${Utils.escapeHtml(event.summary || "")}</span>
                </button>
              `
            )
            .join("");
          const metrics = [
            `Defects ${formatNumber(row.total_defects || 0)}`,
            `Rate ${formatRate(row.defects_per_1000ft)}`,
            `Avg size ${formatAvgSize(row.avg_defect_size, row.avg_defect_size_basis)}`,
            `Speed ${row.speed_avg !== null && row.speed_avg !== undefined ? formatNumber(row.speed_avg, 1) : "--"}`,
            `BST active ${formatPercent(row.bst_active_pct, 1)}`,
          ]
            .filter(Boolean)
            .map((item) => `<span>${Utils.escapeHtml(item)}</span>`)
            .join("");
          return `
            <article class="drivers-timeline-row">
              <div class="drivers-timeline-row__meta">
                <div class="drivers-timeline-row__stamp">${Utils.escapeHtml(formatTime(row.time))}</div>
                <div class="drivers-timeline-row__title">${Utils.escapeHtml(row.reel_code || "Reel")}</div>
                <div class="drivers-timeline-row__sub">
                  ${Utils.escapeHtml(row.job || "Unassigned")} · ${Utils.escapeHtml(row.order || "No order")} · ${Utils.escapeHtml(formatFeet(row.length_ft, 0))}
                </div>
              </div>
              <div class="drivers-timeline-row__rail">
                <span class="drivers-timeline-row__dot"></span>
              </div>
              <div class="drivers-timeline-row__body">
                <div class="drivers-timeline-row__metrics">${metrics}</div>
                <div class="drivers-timeline-row__events">${events || '<span class="drivers-empty-inline">No driver changes detected</span>'}</div>
              </div>
            </article>
          `;
        })
        .join("");
      if (!selectedTimelineEventKey) {
        renderTimelineDetailEmpty();
      }
    }

    function formatClassBreakdown(rows = []) {
      if (!rows.length) return "--";
      return rows
        .slice(0, 3)
        .map((row) => `${row.label || row.name}: ${formatNumber(row.count || 0)}`)
        .join(" · ");
    }

    function renderImpactTable(container, rows, emptyMessage, extraColumnRenderer) {
      if (!container) return;
      if (!rows || !rows.length) {
        renderEmpty(container, emptyMessage);
        return;
      }
      const headerExtra = extraColumnRenderer ? "<th>Driver Detail</th>" : "";
      const body = rows
        .slice(0, 10)
        .map((row) => {
          const extra = extraColumnRenderer ? `<td>${extraColumnRenderer(row)}</td>` : "";
          return `
            <tr>
              <td>
                <strong>${Utils.escapeHtml(row.reel_code || "Reel")}</strong>
                <div class="drivers-table__sub">${Utils.escapeHtml((row.job || "Unassigned") + " · " + (row.order || "No order"))}</div>
              </td>
              <td>${Utils.escapeHtml(formatTime(row.time))}</td>
              <td>${Utils.escapeHtml(formatRate(row.before_rate_per_1000ft))}</td>
              <td>${Utils.escapeHtml(formatRate(row.after_rate_per_1000ft))}</td>
              <td>${Utils.escapeHtml(formatDelta(row.rate_delta_per_1000ft, 2, "/1k ft"))}</td>
              <td>${Utils.escapeHtml(formatDelta(row.avg_size_delta, 2))}</td>
              <td>${Utils.escapeHtml(formatClassBreakdown(row.after_class_counts || []))}</td>
              ${extra}
            </tr>
          `;
        })
        .join("");
      container.innerHTML = `
        <div class="drivers-table">
          <table>
            <thead>
              <tr>
                <th>Reel</th>
                <th>Time</th>
                <th>Before Rate</th>
                <th>After Rate</th>
                <th>Rate Delta</th>
                <th>Size Delta</th>
                <th>After Types</th>
                ${headerExtra}
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      `;
    }

    function renderSensitivity(payload = {}) {
      if (!els.sensitivity) return;
      const summaryRows = payload.sensitivity_summary || [];
      if (!summaryRows.length) {
        renderEmpty(els.sensitivity, "No sensitivity threshold usage was generated for the current filters.");
        return;
      }

      const summaryMarkup = `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Threshold Value</th>
                  <th>Reels</th>
                  <th>Total Feet</th>
                  <th>Avg BST Active %</th>
                  <th>Total Defects</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg Size</th>
                </tr>
              </thead>
              <tbody>
                ${summaryRows
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.class_label || row.class_name || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.threshold_value, 2))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.reel_count || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_footage || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatPercent(row.avg_bst_active_pct, 1))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, "severity_value"))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `;

      els.sensitivity.innerHTML = `
        <div class="drivers-subsection">
          <div class="drivers-subsection__title">Threshold Value Summary</div>
          ${summaryMarkup}
        </div>
      `;
    }

    function renderBstSummary(payload = {}) {
      if (!els.bstSummary) return;
      const summary = payload.summary || {};
      const lengthBuckets = payload.length_buckets || [];
      const timeOfDay = payload.time_of_day || [];
      if (!lengthBuckets.length && !timeOfDay.length && !Number(summary.total_reels || 0)) {
        renderEmpty(els.bstSummary, "No BST active summary was generated for the current filters.");
        return;
      }
      const cards = `
        <div class="drivers-mini-grid">
          <article class="drivers-mini-card">
            <span>Total Reels</span>
            <strong>${formatNumber(summary.total_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Active Reels</span>
            <strong>${formatNumber(summary.active_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Partial Reels</span>
            <strong>${formatNumber(summary.partial_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Inactive Reels</span>
            <strong>${formatNumber(summary.inactive_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>BST Active %</span>
            <strong>${formatPercent(summary.active_pct, 1)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>BST Partial %</span>
            <strong>${formatPercent(summary.partial_pct, 1)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>BST Inactive %</span>
            <strong>${formatPercent(summary.inactive_pct, 1)}</strong>
          </article>
        </div>
      `;
      const lengthMarkup = lengthBuckets.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Reel Length Bucket</th>
                  <th>Reels</th>
                  <th>Active Reels</th>
                  <th>Partial Reels</th>
                  <th>Inactive Reels</th>
                  <th>Active %</th>
                  <th>Partial %</th>
                  <th>Inactive %</th>
                </tr>
              </thead>
              <tbody>
                ${lengthBuckets
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.active_reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.partial_reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.inactive_reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatPercent(row.active_pct, 1))}</td>
                        <td>${Utils.escapeHtml(formatPercent(row.partial_pct, 1))}</td>
                        <td>${Utils.escapeHtml(formatPercent(row.inactive_pct, 1))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No BST reel-length summary was generated.</div>`;
      const timeMarkup = timeOfDay.length
        ? `
          ${(() => {
            const groupedBuckets = [
              ["< 5,000 ft", "5,000 - 8,000 ft"],
              ["8,000 - 11,000 ft", "11,000 - 14,000 ft"],
              ["> 14,000 ft"],
            ];
            return groupedBuckets
              .map((group, groupIndex) => {
                const table = `
                  <div class="drivers-table drivers-table--summary drivers-table--fit">
                    <table>
                      <thead>
                        <tr>
                          <th rowspan="2">Time of Day</th>
                          ${group
                            .map((label) => `<th colspan="6">${Utils.escapeHtml(label)}</th>`)
                            .join("")}
                        </tr>
                        <tr>
                          ${group
                            .map(
                              () => `
                                <th>Active Reels</th>
                                <th>Partial Reels</th>
                                <th>Inactive Reels</th>
                                <th>Active %</th>
                                <th>Partial %</th>
                                <th>Inactive %</th>
                              `
                            )
                            .join("")}
                        </tr>
                      </thead>
                      <tbody>
                        ${timeOfDay
                          .map((row) => {
                            const bucketsByLabel = new Map(
                              (row.length_buckets || []).map((bucket) => [bucket.bucket_label, bucket])
                            );
                            return `
                              <tr>
                                <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                                ${group
                                  .map((label) => {
                                    const bucket = bucketsByLabel.get(label) || {};
                                    return `
                                      <td>${Utils.escapeHtml(formatNumber(bucket.active_reels || 0))}</td>
                                      <td>${Utils.escapeHtml(formatNumber(bucket.partial_reels || 0))}</td>
                                      <td>${Utils.escapeHtml(formatNumber(bucket.inactive_reels || 0))}</td>
                                      <td>${Utils.escapeHtml(formatPercent(bucket.active_pct, 1))}</td>
                                      <td>${Utils.escapeHtml(formatPercent(bucket.partial_pct, 1))}</td>
                                      <td>${Utils.escapeHtml(formatPercent(bucket.inactive_pct, 1))}</td>
                                    `;
                                  })
                                  .join("")}
                              </tr>
                            `;
                          })
                          .join("")}
                      </tbody>
                    </table>
                  </div>
                `;
                return `
                  <div class="drivers-subsection${groupIndex ? " drivers-subsection--compact" : ""}">
                    <div class="drivers-subsection__title">Length Groups ${group.join(" · ")}</div>
                    ${table}
                  </div>
                `;
              })
              .join("");
          })()}
        `
        : `<div class="drivers-empty placeholder">No BST time-of-day summary was generated.</div>`;
      els.bstSummary.innerHTML = cards;
      const lengthHost = document.createElement("div");
      lengthHost.className = "drivers-subsection";
      lengthHost.innerHTML = `
        <div class="drivers-subsection__title">BST Status by Reel Length</div>
        ${lengthMarkup}
      `;
      els.bstSummary.appendChild(lengthHost);
      const timeHost = document.createElement("div");
      timeHost.className = "drivers-subsection";
      timeHost.innerHTML = `
        <div class="drivers-section__header">
          <div>
            <div class="drivers-subsection__title">BST Status by Time of Day and Reel Length</div>
            <small>Expand to view the time-of-day breakdown across the reel-length groups.</small>
          </div>
          <button
            type="button"
            class="drivers-toggle-btn"
            id="driversBstTimeToggle"
            aria-expanded="${bstTimeExpanded ? "true" : "false"}"
          >
            ${bstTimeExpanded ? "Hide Time Breakdown" : "Expand Time Breakdown"}
          </button>
        </div>
        <div class="${bstTimeExpanded ? "" : "hidden"}" id="driversBstTimeDetails">
          ${timeMarkup}
        </div>
      `;
      els.bstSummary.appendChild(timeHost);
      const toggle = document.getElementById("driversBstTimeToggle");
      if (toggle) {
        toggle.addEventListener("click", () => {
          bstTimeExpanded = !bstTimeExpanded;
          renderBstSummary(payload);
        });
      }
    }

    function renderDriverSummary(payload = {}) {
      if (!els.summary) return;
      const summary = payload.summary || {};
      const allFlags = payload.all_flag_rows || [];
      const timeOfDay = payload.time_of_day || [];
      if (!allFlags.length && !Number(summary.total_spike_reels || 0)) {
        renderEmpty(els.summary, "No defect spike reels were found for the current filters.");
        return;
      }
      const cards = `
        <div class="drivers-mini-grid">
          <article class="drivers-mini-card">
            <span>Total Defect Spike Reels</span>
            <strong>${formatNumber(summary.total_spike_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Spike Reels With No Flags</span>
            <strong>${formatNumber(summary.no_flag_spike_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Spike Reels With 1 Flag</span>
            <strong>${formatNumber(summary.one_flag_spike_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Spike Reels With Multiple Flags</span>
            <strong>${formatNumber(summary.multi_flag_spike_reels || 0)}</strong>
          </article>
        </div>
      `;
      const renderSpikeCauseCards = (rows, emptyMessage, valueLabel) => {
        if (!rows.length) {
          return `<div class="drivers-empty placeholder">${Utils.escapeHtml(emptyMessage)}</div>`;
        }
        return `
          <div class="drivers-cause-list">
            ${rows
              .map((row) => {
                const pct = Math.max(0, Math.min(100, Number(row.pct_of_spike_reels || 0)));
                return `
                  <article class="drivers-cause-card">
                    <div class="drivers-cause-card__top">
                      <strong>${Utils.escapeHtml(row.flag_label || row.combination_label || "--")}</strong>
                      <span>${Utils.escapeHtml(formatPercent(row.pct_of_spike_reels, 1))}</span>
                    </div>
                    <div class="drivers-cause-card__meta">
                      <span>${Utils.escapeHtml(`${formatNumber(row.reels || 0)} ${valueLabel}`)}</span>
                      <span>${Utils.escapeHtml(`${formatPercent(row.pct_of_spike_reels, 1)} of spike reels`)}</span>
                    </div>
                    <div class="drivers-trend-bar"><span style="width:${pct}%"></span></div>
                  </article>
                `;
              })
              .join("")}
          </div>
        `;
      };
      const renderSpikePresenceGrid = (rows, emptyMessage) => {
        if (!rows.length) {
          return `<div class="drivers-empty placeholder">${Utils.escapeHtml(emptyMessage)}</div>`;
        }
        return `
          <div class="drivers-presence-grid">
            ${rows
              .map(
                (row) => `
                  <article class="drivers-presence-card">
                    <strong>${Utils.escapeHtml(row.flag_label || "--")}</strong>
                    <div class="drivers-presence-card__meta">
                      <span>${Utils.escapeHtml(`${formatNumber(row.reels || 0)} reels`)}</span>
                      <span>${Utils.escapeHtml(formatPercent(row.pct_of_spike_reels, 1))}</span>
                    </div>
                  </article>
                `
              )
              .join("")}
          </div>
        `;
      };
      const flagMarkup = allFlags.length
        ? `
          ${renderSpikePresenceGrid(allFlags, "No spike reel flags were found.")}
        `
        : `<div class="drivers-empty placeholder">No spike reel flags were found.</div>`;
      els.summary.innerHTML = cards;
      const allFlagHost = document.createElement("div");
      allFlagHost.className = "drivers-subsection";
      allFlagHost.innerHTML = `
        <div class="drivers-subsection__title">Flag Presence on Spike Reels</div>
        ${flagMarkup}
      `;
      els.summary.appendChild(allFlagHost);
      const timeOfDayMarkup = timeOfDay.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Time of Day</th>
                  <th>Reels</th>
                  <th>Feet</th>
                  <th>Total Defects</th>
                  <th>Avg BST Active %</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                </tr>
              </thead>
              <tbody>
                ${timeOfDay
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(formatPercent(row.avg_bst_active_pct, 1))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No spike time-of-day analysis was generated.</div>`;
      const timeHost = document.createElement("div");
      timeHost.className = "drivers-subsection";
      timeHost.innerHTML = `
        <div class="drivers-subsection__title">Defect Spikes by Time of Day</div>
        ${timeOfDayMarkup}
      `;
      els.summary.appendChild(timeHost);
    }

    function renderMaskSegments(payload = {}) {
      if (!els.mask) return;
      const overview = payload.mask_overview || {};
      const summary = overview.summary || {};
      const rows = overview.buckets || [];
      const timeOfDay = overview.time_of_day || [];
      if (!rows.length && !timeOfDay.length) {
        renderEmpty(els.mask, "No mask overview was generated for the current filters.");
        return;
      }
      const cards = `
        <div class="drivers-mini-grid">
          <article class="drivers-mini-card">
            <span>Total Reels</span>
            <strong>${formatNumber(summary.total_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Reels with Masks</span>
            <strong>${formatNumber(summary.reels_with_masks || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Reels without Masks</span>
            <strong>${formatNumber(summary.reels_without_masks || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Total Feet with Masks</span>
            <strong>${Utils.escapeHtml(formatFeet(summary.total_feet_with_masks || 0, 0))}</strong>
          </article>
        </div>
      `;
      const bucketMarkup = rows.length
        ? `
        <div class="drivers-table drivers-table--summary drivers-table--fit">
          <table>
            <thead>
              <tr>
                <th>Mask Bucket</th>
                <th>Reels</th>
                <th>Feet</th>
                <th>Total Defects</th>
                <th>Avg BST Active %</th>
                <th>Defects/1k ft</th>
                <th>Adjusted Defects/1k ft</th>
                <th>Avg Size</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                    <tr>
                      <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                      <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                      <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                      <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                      <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                      <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                      <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                      <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, "severity_value"))}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `
        : `<div class="drivers-empty placeholder">No mask bucket overview was generated.</div>`;
      const timeOfDayMarkup = timeOfDay.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Time of Day</th>
                  <th>Reels</th>
                  <th>Reels with Masks</th>
                  <th>Feet</th>
                  <th>% With Masks</th>
                </tr>
              </thead>
              <tbody>
                ${timeOfDay
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reel_count || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels_with_masks || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.pct_with_masks, 1)}%`)}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No mask time-of-day analysis was generated.</div>`;
      els.mask.innerHTML = cards;
      const bucketHost = document.createElement("div");
      bucketHost.innerHTML = bucketMarkup;
      els.mask.appendChild(bucketHost);
      const timeOfDayHost = document.createElement("div");
      timeOfDayHost.className = "drivers-subsection";
      timeOfDayHost.innerHTML = `
        <div class="drivers-subsection__title">Mask Presence by Time of Day</div>
        ${timeOfDayMarkup}
      `;
      els.mask.appendChild(timeOfDayHost);
    }

    function renderReference(payload = {}) {
      if (!els.reference) return;
      const summary = payload.summary || {};
      const buckets = payload.buckets || [];
      const hourBuckets = payload.hour_buckets || [];
      const timeOfDay = payload.time_of_day || [];
      const chartMax = hourBuckets.reduce(
        (max, row) => Math.max(max, Number(row.reels_with_reference_changes || 0)),
        0
      ) || 1;
      const cards = `
        <div class="drivers-mini-grid">
          <article class="drivers-mini-card">
            <span>Total Reels</span>
            <strong>${formatNumber(summary.total_reels || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Reels with Changes</span>
            <strong>${formatNumber(summary.reels_with_changes || 0)}</strong>
          </article>
        </div>
      `;
      const bucketMarkup = buckets.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Reference Bucket</th>
                  <th>Reels</th>
                  <th>Feet</th>
                  <th>Total Defects</th>
                  <th>Avg BST Active %</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg Size</th>
                </tr>
              </thead>
              <tbody>
                ${buckets
                  .map(
                    (row) => `
                      <tr>
                        <td>
                          <strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong>
                          <div class="drivers-table__sub">${Utils.escapeHtml(
                            row.bucket_key === "no_change"
                              ? "Exactly 1 reference image"
                              : row.bucket_key === "single_change"
                                ? "Exactly 2 reference images"
                                : "3 or more reference images"
                          )}</div>
                        </td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, "severity_value"))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No reference bucket analysis was generated.</div>`;
      const chartMarkup = hourBuckets.length
        ? `
          <div class="drivers-refchart">
            <div class="drivers-refchart__plot">
              ${hourBuckets
              .map(
                (row) => `
                  <div class="drivers-refchart__bucket">
                    <div
                      class="drivers-refchart__bar"
                      data-tooltip="${escapeAttr(
                        [
                          `${formatTime(row.bucket_start)} -> ${formatTime(row.bucket_end)}`,
                          `Reels: ${formatNumber(row.reel_count || 0)}`,
                          `Reels with changes: ${formatNumber(row.reels_with_reference_changes || 0)}`,
                          `Total reference changes: ${formatNumber(row.total_reference_changes || 0)}`,
                          `Feet: ${formatFeet(row.total_feet || 0, 0)}`,
                          `Defects: ${formatNumber(row.total_defects || 0)}`,
                          `Defects/1k ft: ${formatRate(row.defects_per_1000ft)}`,
                          `Avg BST active: ${formatNumber(row.avg_bst_active_pct, 1)}%`
                        ].join("\n")
                      )}"
                      style="height:${Math.max(10, Math.round((Number(row.reels_with_reference_changes || 0) / chartMax) * 180))}px"
                    >
                      <span>${Utils.escapeHtml(formatNumber(row.reels_with_reference_changes || 0))}</span>
                    </div>
                    <div class="drivers-refchart__label">${Utils.escapeHtml(formatTime(row.bucket_start))}</div>
                  </div>
                `
              )
              .join("")}
          </div>
          </div>
        `
        : `<div class="drivers-empty placeholder">No reference change chart data was generated.</div>`;
      els.reference.innerHTML = cards;
      const tableHost = document.createElement("div");
      tableHost.innerHTML = bucketMarkup;
      els.reference.appendChild(tableHost);
      const chartHost = document.createElement("div");
      chartHost.className = "drivers-subsection";
      chartHost.innerHTML = `
        <div class="drivers-subsection__title">Reference Change by Hour</div>
        ${chartMarkup}
      `;
      els.reference.appendChild(chartHost);
      const timeOfDayMarkup = timeOfDay.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Time of Day</th>
                  <th>Reels</th>
                  <th>Reels with Changes</th>
                  <th>Total Reference Changes</th>
                  <th>Feet</th>
                  <th>% With Changes</th>
                </tr>
              </thead>
              <tbody>
                ${timeOfDay
                  .map(
                    (row) => `
                      <tr class="${row.is_peak_change_bucket ? "drivers-table__row--highlight" : ""}">
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reel_count || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels_with_reference_changes || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_reference_changes || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(
                          row.reel_count ? ((Number(row.reels_with_reference_changes || 0) / Number(row.reel_count || 0)) * 100) : 0,
                          1
                        )}%`)}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No reference time-of-day analysis was generated.</div>`;
      const timeOfDayHost = document.createElement("div");
      timeOfDayHost.className = "drivers-subsection";
      timeOfDayHost.innerHTML = `
        <div class="drivers-subsection__title">Reference Changes by Time of Day</div>
        ${timeOfDayMarkup}
      `;
      els.reference.appendChild(timeOfDayHost);
    }

    function renderBucketCards(rows = []) {
      if (!rows.length) {
        return `<div class="drivers-empty placeholder">No bucketed data available.</div>`;
      }
      return `
        <div class="drivers-mini-grid">
          ${rows
            .map(
              (row) => `
                <article class="drivers-mini-card">
                  <span>${Utils.escapeHtml(row.bucket || "--")}</span>
                  <strong>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</strong>
                  <small>${Utils.escapeHtml(`${formatNumber(row.reels || 0)} reels · ${formatFeet(row.total_footage || 0, 0)}`)}</small>
                  <small>${Utils.escapeHtml(`Avg size ${formatNumber(row.avg_defect_size, 2)}`)}</small>
                </article>
              `
            )
            .join("")}
        </div>
      `;
    }

    function renderSpeed(payload = {}) {
      if (!els.speed) return;
      const summary = payload.summary || {};
      const buckets = payload.buckets || [];
      const stability = payload.stability || [];
      const timeOfDay = payload.time_of_day || [];
      const bestRange = payload.best_range || null;
      if (!buckets.length && !stability.length && !timeOfDay.length) {
        renderEmpty(els.speed, "No speed overview was generated for the current filters.");
        return;
      }
      const cards = `
        <div class="drivers-mini-grid">
          <article class="drivers-mini-card">
            <span>Reels with Speed</span>
            <strong>${formatNumber(summary.total_reels_with_speed || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Reels without Speed</span>
            <strong>${formatNumber(summary.reels_without_speed || 0)}</strong>
          </article>
          <article class="drivers-mini-card">
            <span>Best Observed Speed Range</span>
            <strong>${Utils.escapeHtml(bestRange?.bucket_label || "--")}</strong>
            <small>${Utils.escapeHtml(
              bestRange
                ? `${formatRate(bestRange.adjusted_defects_per_1000ft)} adj /1k ft · ${formatNumber(bestRange.reels || 0)} reels`
                : "No qualifying range"
            )}</small>
          </article>
        </div>
      `;
      const bucketMarkup = buckets.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Speed Range</th>
                  <th>Reels</th>
                  <th>Total Defects</th>
                  <th>Feet</th>
                  <th>Avg Speed</th>
                  <th>Avg BST Active %</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg Size</th>
                </tr>
              </thead>
              <tbody>
                ${buckets
                  .map(
                    (row) => `
                      <tr class="${bestRange && bestRange.bucket_label === row.bucket_label ? "drivers-table__row--highlight" : ""}">
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.avg_speed, 2))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, "severity_value"))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No speed range buckets were generated.</div>`;
      const stabilityMarkup = stability.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Speed Stability</th>
                  <th>Reels</th>
                  <th>Feet</th>
                  <th>Total Defects</th>
                  <th>Avg BST Active %</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg Size</th>
                  <th>Avg Speed Range</th>
                </tr>
              </thead>
              <tbody>
                ${stability
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, "severity_value"))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.avg_speed_variation, 3))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No speed stability analysis was generated.</div>`;
      const timeOfDayMarkup = timeOfDay.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Time of Day</th>
                  <th>Reels</th>
                  <th>Avg Speed</th>
                  <th>Min Speed</th>
                  <th>Max Speed</th>
                  <th>Feet</th>
                  <th>Total Defects</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg BST Active %</th>
                </tr>
              </thead>
              <tbody>
                ${timeOfDay
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.avg_speed, 2))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.min_speed, 2))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.max_speed, 2))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No speed time-of-day summary was generated.</div>`;
      els.speed.innerHTML = cards;
      const bucketHost = document.createElement("div");
      bucketHost.innerHTML = bucketMarkup;
      els.speed.appendChild(bucketHost);
      const stabilityHost = document.createElement("div");
      stabilityHost.className = "drivers-subsection";
      stabilityHost.innerHTML = `
        <div class="drivers-subsection__title">Speed Stability</div>
        ${stabilityMarkup}
      `;
      els.speed.appendChild(stabilityHost);
      const timeOfDayHost = document.createElement("div");
      timeOfDayHost.className = "drivers-subsection";
      timeOfDayHost.innerHTML = `
        <div class="drivers-subsection__title">Speed by Time of Day</div>
        ${timeOfDayMarkup}
      `;
      els.speed.appendChild(timeOfDayHost);
    }

    function renderLength(payload = {}) {
      if (!els.length) return;
      const buckets = payload.buckets || [];
      const timeOfDay = payload.time_of_day || [];
      if (!buckets.length && !timeOfDay.length) {
        renderEmpty(els.length, "No reel-length overview was generated for the current filters.");
        return;
      }
      const bucketMarkup = buckets.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Reel Length Bucket</th>
                  <th>Reels</th>
                  <th>Total Feet</th>
                  <th>Total Defects</th>
                  <th>Avg BST Active %</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg Size</th>
                </tr>
              </thead>
              <tbody>
                ${buckets
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, "severity_value"))}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No reel-length bucket analysis was generated.</div>`;
      const timeOfDayMarkup = timeOfDay.length
        ? `
          <div class="drivers-table drivers-table--summary drivers-table--fit">
            <table>
              <thead>
                <tr>
                  <th>Time of Day</th>
                  <th>Reels</th>
                  <th>Avg Reel Length</th>
                  <th>Min Reel Length</th>
                  <th>Max Reel Length</th>
                  <th>Total Feet</th>
                  <th>Total Defects</th>
                  <th>Defects/1k ft</th>
                  <th>Adjusted Defects/1k ft</th>
                  <th>Avg BST Active %</th>
                </tr>
              </thead>
              <tbody>
                ${timeOfDay
                  .map(
                    (row) => `
                      <tr>
                        <td><strong>${Utils.escapeHtml(row.bucket_label || "--")}</strong></td>
                        <td>${Utils.escapeHtml(formatNumber(row.reels || 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.avg_length_ft || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.min_length_ft || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.max_length_ft || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatFeet(row.total_feet || 0, 0))}</td>
                        <td>${Utils.escapeHtml(formatNumber(row.total_defects || 0))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(formatRate(row.adjusted_defects_per_1000ft))}</td>
                        <td>${Utils.escapeHtml(`${formatNumber(row.avg_bst_active_pct, 1)}%`)}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="drivers-empty placeholder">No reel-length time-of-day analysis was generated.</div>`;
      els.length.innerHTML = bucketMarkup;
      const timeHost = document.createElement("div");
      timeHost.className = "drivers-subsection";
      timeHost.innerHTML = `
        <div class="drivers-subsection__title">Reel Length by Time of Day</div>
        ${timeOfDayMarkup}
      `;
      els.length.appendChild(timeHost);
    }

    function renderReferenceDetail(detail = {}) {
      const images = detail.reference_images || [];
      const gallery = images.length
        ? `
          <div class="drivers-detail-gallery">
            ${images
              .map((image, index) => {
                const src = image.image_src ? urlForStatic(image.image_src) : "";
                return `
                  <button
                    type="button"
                    class="drivers-detail-image-card drivers-detail-image-card--interactive"
                    data-reference-viewer-open="true"
                    data-reference-viewer-index="${index}"
                  >
                    <div class="drivers-detail-image-frame">
                      ${src
                        ? `<img src="${Utils.escapeHtml(src)}" alt="${Utils.escapeHtml(image.filename || `Reference ${image.order_index || ""}`)}" loading="lazy" decoding="async">`
                        : `<div class="drivers-empty placeholder">No preview</div>`}
                    </div>
                    <div class="drivers-detail-image-meta">
                      <strong>${Utils.escapeHtml(image.filename || `Reference ${image.order_index || ""}`)}</strong>
                      <span>${Utils.escapeHtml(`Order ${formatNumber(image.order_index || 0)}`)}</span>
                      <span>${Utils.escapeHtml(formatTime(image.captured_at))}</span>
                    </div>
                  </button>
                `;
              })
              .join("")}
          </div>
        `
        : `<div class="drivers-empty placeholder">No reference images attached to this event.</div>`;
      return `
        <div class="drivers-detail-block">
          <div class="drivers-detail-header">
            <div>
              <p class="kpi-section__title">Reference Change</p>
              <small>${Utils.escapeHtml((detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"))}</small>
            </div>
            ${images.length
              ? `<button type="button" class="button-secondary drivers-detail-expand-btn" data-reference-viewer-open="true" data-reference-viewer-index="0" aria-label="Open reference comparison viewer">Expand</button>`
              : ""}
          </div>
          <div class="drivers-detail-metrics">
            <span>${Utils.escapeHtml(`Reel ID ${formatNumber(detail.reel_id || 0)}`)}</span>
            <span>${Utils.escapeHtml(`${formatNumber(detail.reference_count || 0)} reference images`)}</span>
            <span>${Utils.escapeHtml(`${formatNumber(detail.repeated_updates || 0)} repeated updates`)}</span>
          </div>
          ${gallery}
        </div>
      `;
    }

    function renderSpeedDetail(detail = {}) {
      return `
        <div class="drivers-detail-block">
          <div class="drivers-detail-header">
            <div>
              <p class="kpi-section__title">Speed Shift</p>
              <small>${Utils.escapeHtml((detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"))}</small>
            </div>
            <button type="button" class="button-secondary drivers-detail-expand-btn" data-speed-viewer-open="true" aria-label="Open speed shift comparison">Expand</button>
          </div>
          <div class="drivers-mini-grid">
            <article class="drivers-mini-card">
              <span>Previous Avg Speed</span>
              <strong>${Utils.escapeHtml(formatNumber(detail.previous_speed_avg, 1))}</strong>
              <small>${Utils.escapeHtml((detail.previous_reel_code || "Previous reel") + " · " + (detail.previous_speed_bucket || "--"))}</small>
            </article>
            <article class="drivers-mini-card">
              <span>Current Avg Speed</span>
              <strong>${Utils.escapeHtml(formatNumber(detail.current_speed_avg, 1))}</strong>
              <small>${Utils.escapeHtml((detail.reel_code || "Current reel") + " · " + (detail.current_speed_bucket || "--"))}</small>
            </article>
            <article class="drivers-mini-card">
              <span>Delta</span>
              <strong>${Utils.escapeHtml(formatDelta(detail.delta_speed, 1))}</strong>
              <small>${Utils.escapeHtml(detail.reason || "Speed shift detected")}</small>
            </article>
          </div>
        </div>
      `;
    }

    function renderMaskRows(title, masks = []) {
      if (!masks.length) {
        return `
          <div class="drivers-detail-compare__col">
            <strong>${Utils.escapeHtml(title)}</strong>
            <div class="drivers-empty placeholder">No masks.</div>
          </div>
        `;
      }
      return `
        <div class="drivers-detail-compare__col">
          <strong>${Utils.escapeHtml(title)}</strong>
          <div class="drivers-detail-mask-list">
            ${masks
              .map(
                (mask, index) => `
                  <article class="drivers-detail-mask-card">
                    <span>${Utils.escapeHtml(mask.xml_id || mask.sensitivitysetid || `Mask ${index + 1}`)}</span>
                    <small>${Utils.escapeHtml(formatTime(mask.timestamp))}</small>
                    <code>${Utils.escapeHtml(formatMaskCoords(mask.coords) || "—")}</code>
                  </article>
                `
              )
              .join("")}
          </div>
        </div>
      `;
    }

    function renderMaskDetail(detail = {}) {
      const coordinateText = Number(detail.coordinate_change_count || 0) > 0
        ? `${formatNumber(detail.coordinate_change_count || 0)} coordinate changes`
        : "no mask geometry change";
      return `
        <div class="drivers-detail-block">
          <div class="drivers-detail-header">
            <div>
              <p class="kpi-section__title">Mask Change</p>
              <small>${Utils.escapeHtml((detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"))}</small>
            </div>
            <button type="button" class="button-secondary drivers-detail-expand-btn" data-mask-viewer-open="true" aria-label="Open mask footprint comparison">Expand</button>
          </div>
          <div class="drivers-detail-metrics">
            <span>${Utils.escapeHtml(`Before ${formatNumber(detail.before_mask_count || 0)} masks`)}</span>
            <span>${Utils.escapeHtml(`After ${formatNumber(detail.after_mask_count || 0)} masks`)}</span>
            <span>${Utils.escapeHtml(coordinateText)}</span>
          </div>
          <div class="drivers-detail-compare">
            ${renderMaskRows("Before", detail.before_masks || [])}
            ${renderMaskRows("After", detail.after_masks || [])}
          </div>
        </div>
      `;
    }

    function renderBstDetail(detail = {}) {
      return `
        <div class="drivers-detail-block">
          <p class="kpi-section__title">BST Coverage</p>
          <small>${Utils.escapeHtml((detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"))}</small>
          <div class="drivers-mini-grid">
            <article class="drivers-mini-card">
              <span>Active</span>
              <strong>${Utils.escapeHtml(`${formatNumber(detail.active_pct, 1)}%`)}</strong>
            </article>
            <article class="drivers-mini-card">
              <span>Inactive</span>
              <strong>${Utils.escapeHtml(`${formatNumber(detail.inactive_pct, 1)}%`)}</strong>
            </article>
            <article class="drivers-mini-card">
              <span>Learn</span>
              <strong>${Utils.escapeHtml(`${formatNumber(detail.learn_pct, 1)}%`)}</strong>
            </article>
          </div>
          <div class="drivers-detail-metrics">
            <span>${Utils.escapeHtml(detail.interpretation || "BST coverage available")}</span>
            <span>${Utils.escapeHtml(`Unknown ${formatNumber(detail.unknown_pct, 1)}%`)}</span>
          </div>
        </div>
      `;
    }

    function baselineLabel(source, count) {
      if (source === "previous_reel") return "Previous reel";
      if (typeof source === "string" && source.startsWith("rolling_avg_")) {
        return `Rolling avg of last ${count || source.split("_").pop()} reels`;
      }
      return "Baseline";
    }

    function renderSensitivityDetail(detail = {}) {
      const changes = detail.changes || [];
      return `
        <div class="drivers-detail-block">
          <p class="kpi-section__title">Sensitivity Change</p>
          <small>${Utils.escapeHtml((detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"))}</small>
          <div class="drivers-detail-sensitivity-list">
            ${changes
              .map(
                (change) => `
                  <article class="drivers-detail-sensitivity-card">
                    <strong>${Utils.escapeHtml(change.label || change.name || "Class")}</strong>
                    <span>${Utils.escapeHtml(`Threshold ${formatNumber(change.previous && change.previous.threshold, 2)} -> ${formatNumber(change.current && change.current.threshold, 2)}`)}</span>
                    <span>${Utils.escapeHtml(`Warn ${formatNumber(change.previous && change.previous.warn, 2)} -> ${formatNumber(change.current && change.current.warn, 2)}`)}</span>
                  </article>
                `
              )
              .join("") || '<div class="drivers-empty placeholder">No threshold values available.</div>'}
          </div>
        </div>
      `;
    }

    function renderSpikeDetail(detail = {}) {
      return `
        <div class="drivers-detail-block">
          <div class="drivers-detail-header">
            <div>
              <p class="kpi-section__title">Defect Spike</p>
              <small>${Utils.escapeHtml((detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"))}</small>
            </div>
            <button type="button" class="button-secondary drivers-detail-expand-btn" data-spike-viewer-open="true" aria-label="Open defect spike comparison">Expand</button>
          </div>
          <div class="drivers-mini-grid">
            <article class="drivers-mini-card">
              <span>Current Reel Rate</span>
              <strong>${Utils.escapeHtml(formatRate(detail.current_rate_per_1000ft))}</strong>
              <small>${Utils.escapeHtml(`${formatNumber(detail.current_defect_count || 0)} defects`)}</small>
            </article>
            <article class="drivers-mini-card">
              <span>Previous Reel Rate</span>
              <strong>${Utils.escapeHtml(formatRate(detail.previous_reel_rate_per_1000ft))}</strong>
              <small>${Utils.escapeHtml(`${formatNumber(detail.previous_reel_count || 0)} defects`)}</small>
            </article>
            <article class="drivers-mini-card">
              <span>Rolling Prior Rate</span>
              <strong>${Utils.escapeHtml(formatRate(detail.rolling_rate_per_1000ft))}</strong>
              <small>${Utils.escapeHtml(`${formatNumber(detail.rolling_reel_count || 0)} reel baseline`)}</small>
            </article>
          </div>
        </div>
      `;
    }

    function renderTimelineDetailForEvent(rowIndex, eventIndex) {
      if (!els.timelineDetail) return;
      const row = timelineRows[rowIndex];
      const event = row && row.events ? row.events[eventIndex] : null;
      if (!row || !event) {
        renderTimelineDetailEmpty();
        return;
      }
      const detail = event.detail || {};
      activeReferenceDetail =
        event.type === "reference_change"
          ? {
              title: event.label || "Reference Change",
              subtitle: (detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"),
              reelCode: detail.reel_code || "Reel",
              images: Array.isArray(detail.reference_images) ? detail.reference_images : [],
            }
          : null;
      activeMaskDetail =
        event.type === "mask_change"
          ? {
              title: event.label || "Mask Change",
              subtitle: (detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"),
              reel: {
                reel_id: `drivers-mask-${detail.reel_id || detail.reel_code || "reel"}`,
                format_width: Number(detail.format_width) || null,
                format_length: Number(detail.format_length) || null,
              },
              referenceImage: latestReferenceImageFromDetail(detail),
              beforeMasks: Array.isArray(detail.before_masks) ? detail.before_masks : [],
              afterMasks: Array.isArray(detail.after_masks) ? detail.after_masks : [],
            }
          : null;
      activeSpeedDetail =
        event.type === "speed_shift"
          ? {
              title: event.label || "Speed Shift",
              subtitle: (detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"),
              currentReelCode: detail.reel_code || "Current reel",
              previousReelCode: detail.previous_reel_code || "Previous reel",
              previousTrend: Array.isArray(detail.previous_speed_trend) ? detail.previous_speed_trend : [],
              currentTrend: Array.isArray(detail.current_speed_trend) ? detail.current_speed_trend : [],
            }
          : null;
      activeSpikeDetail =
        event.type === "defect_spike"
          ? {
              title: event.label || "Defect Spike",
              subtitle: (detail.job || "Unassigned") + " · " + (detail.order || "No order") + " · " + (detail.reel_code || "Reel"),
              currentReelCode: detail.reel_code || "Current reel",
              previousReelCode: detail.previous_reel_code || "Previous reel",
              currentRate: detail.current_rate_per_1000ft,
              currentDefects: detail.current_defect_count,
              currentBstActivePct: detail.current_bst_active_pct,
              currentAvgSize: detail.current_avg_defect_size,
              currentLengthFt: detail.current_length_ft,
              previousRate: detail.previous_reel_rate_per_1000ft,
              previousDefects: detail.previous_reel_count,
              previousBstActivePct: detail.previous_bst_active_pct,
              previousAvgSize: detail.previous_reel_avg_defect_size,
              previousLengthFt: detail.previous_length_ft,
              typeBreakdown: Array.isArray(detail.type_breakdown) ? detail.type_breakdown : [],
              rollingCount: detail.rolling_reel_count,
            }
          : null;
      let body = `
        <div class="drivers-detail-empty">
          <p class="kpi-section__title">${Utils.escapeHtml(event.label || "Event Detail")}</p>
          <small>No additional evidence is attached to this event.</small>
        </div>
      `;
      if (event.type === "reference_change") {
        body = renderReferenceDetail(detail);
      } else if (event.type === "speed_shift") {
        body = renderSpeedDetail(detail);
      } else if (event.type === "mask_change") {
        body = renderMaskDetail(detail);
      } else if (event.type === "sensitivity_change") {
        body = renderSensitivityDetail(detail);
      } else if (event.type === "bst_coverage") {
        body = renderBstDetail(detail);
      } else if (event.type === "defect_spike") {
        body = renderSpikeDetail(detail);
      }
      els.timelineDetail.innerHTML = body;
    }

    function closeReferenceViewer() {
      referenceViewerState = null;
      if (els.referenceViewerModal) {
        els.referenceViewerModal.classList.add("hidden");
      }
      document.body.classList.remove("drivers-reference-viewer-open");
    }

    function renderReferenceViewer() {
      if (!els.referenceViewerModal || !els.referenceViewerGrid || !referenceViewerState) return;
      const images = Array.isArray(referenceViewerState.images) ? referenceViewerState.images : [];
      const count = images.length;
      const currentIndex = Math.max(0, Math.min(referenceViewerState.index || 0, Math.max(0, count - 1)));
      if (els.referenceViewerTitle) {
        els.referenceViewerTitle.textContent = referenceViewerState.title || "Reference Images";
      }
      if (els.referenceViewerSubtitle) {
        const reelLabel = referenceViewerState.reelCode || "Reel";
        els.referenceViewerSubtitle.textContent = `${referenceViewerState.subtitle || reelLabel} · ${count} image${count === 1 ? "" : "s"}`;
      }
      els.referenceViewerGrid.dataset.imageCount = String(count);
      els.referenceViewerGrid.innerHTML = images
        .map((image, index) => {
          const src = image.image_src ? urlForStatic(image.image_src) : "";
          const isActive = index === currentIndex;
          return `
            <article class="drivers-reference-viewer__card${isActive ? " is-active" : ""}">
              <div class="drivers-reference-viewer__frame">
                ${src
                  ? `<img src="${Utils.escapeHtml(src)}" alt="${Utils.escapeHtml(image.filename || `Reference ${image.order_index || index + 1}`)}" loading="lazy" decoding="async">`
                  : `<div class="drivers-empty placeholder">No preview</div>`}
              </div>
              <div class="drivers-reference-viewer__meta">
                <strong>${Utils.escapeHtml(image.filename || `Reference ${image.order_index || index + 1}`)}</strong>
                <span>${Utils.escapeHtml(`Order ${formatNumber(image.order_index || 0)}`)}</span>
                <span>${Utils.escapeHtml(formatTime(image.captured_at))}</span>
              </div>
            </article>
          `;
        })
        .join("");
      if (els.referenceViewerCount) {
        els.referenceViewerCount.textContent = count ? `${currentIndex + 1} of ${count}` : "";
      }
    }

    function openReferenceViewer(index = 0) {
      if (!activeReferenceDetail || !Array.isArray(activeReferenceDetail.images) || !activeReferenceDetail.images.length) return;
      referenceViewerState = {
        title: activeReferenceDetail.title,
        subtitle: activeReferenceDetail.subtitle,
        reelCode: activeReferenceDetail.reelCode,
        images: activeReferenceDetail.images,
        index: Number.isInteger(index) ? index : Number(index) || 0,
      };
      renderReferenceViewer();
      if (els.referenceViewerModal) {
        els.referenceViewerModal.classList.remove("hidden");
      }
      document.body.classList.add("drivers-reference-viewer-open");
    }

    function handleTimelineClick(event) {
      const button = event.target.closest("[data-timeline-row][data-timeline-event]");
      if (!button) return;
      const rowIndex = Number(button.dataset.timelineRow);
      const eventIndex = Number(button.dataset.timelineEvent);
      if (!Number.isInteger(rowIndex) || !Number.isInteger(eventIndex)) return;
      selectedTimelineEventKey = `${rowIndex}:${eventIndex}`;
      renderTimeline(rawTimelineRows);
      renderTimelineDetailForEvent(rowIndex, eventIndex);
    }

    function handleTimelineDetailClick(event) {
      const openButton = event.target.closest("[data-reference-viewer-open]");
      if (openButton) {
        const index = Number(openButton.dataset.referenceViewerIndex);
        openReferenceViewer(Number.isInteger(index) ? index : 0);
        return;
      }
      const maskButton = event.target.closest("[data-mask-viewer-open]");
      if (maskButton) {
        openMaskViewer();
        return;
      }
      const speedButton = event.target.closest("[data-speed-viewer-open]");
      if (speedButton) {
        openSpeedViewer();
        return;
      }
      const spikeButton = event.target.closest("[data-spike-viewer-open]");
      if (spikeButton) {
        openSpikeViewer();
      }
    }

    function renderSpikeSummaryCard(label, detail) {
      return `
        <article class="drivers-spike-viewer__card">
          <span>${Utils.escapeHtml(label)}</span>
          <strong>${Utils.escapeHtml(detail.reelCode || "Reel")}</strong>
          <small>${Utils.escapeHtml(`Rate ${formatRate(detail.ratePer1k)}`)}</small>
          <small>${Utils.escapeHtml(`Defects ${formatNumber(detail.defects || 0)}`)}</small>
          <small>${Utils.escapeHtml(`BST inspection ${formatPercent(detail.bstActivePct, 1)}`)}</small>
          <small>${Utils.escapeHtml(`Avg size ${formatAvgSize(detail.avgSize)}`)}</small>
          <small>${Utils.escapeHtml(`Feet ${formatFeet(detail.lengthFt || 0, 0)}`)}</small>
        </article>
      `;
    }

    function renderSpikeBreakdownTable(rows = [], rollingCount = 0) {
      if (!rows.length) {
        return `<div class="drivers-empty placeholder">No per-type spike detail is available.</div>`;
      }
      return `
        <div class="drivers-table drivers-table--summary">
          <table>
            <thead>
              <tr>
                <th>Defect Type</th>
                <th>Current Count</th>
                <th>Current /1k ft</th>
                <th>Baseline Count</th>
                <th>Baseline /1k ft</th>
                <th>Delta /1k ft</th>
                <th>Avg Size</th>
                <th>Baseline Used</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                    <tr>
                      <td><strong>${Utils.escapeHtml(row.label || row.name || "--")}</strong></td>
                      <td>${Utils.escapeHtml(formatNumber(row.current_count || 0))}</td>
                      <td>${Utils.escapeHtml(formatRate(row.current_rate_per_1000ft))}</td>
                      <td>${Utils.escapeHtml(formatNumber(row.baseline_count || 0, 2))}</td>
                      <td>${Utils.escapeHtml(formatRate(row.baseline_rate_per_1000ft))}</td>
                      <td>${Utils.escapeHtml(formatDelta(row.delta_rate_per_1000ft, 2, "/1k ft"))}</td>
                      <td>${Utils.escapeHtml(formatAvgSize(row.avg_defect_size, row.avg_size_basis))}</td>
                      <td>${Utils.escapeHtml(baselineLabel(row.baseline_source, rollingCount))}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `;
    }

    function openSpikeViewer() {
      if (!activeSpikeDetail || typeof window.openFootprintModalContent !== "function") return;
      const content = document.createElement("div");
      content.className = "drivers-spike-viewer";
      content.innerHTML = `
        <div class="drivers-spike-viewer__summary">
          ${renderSpikeSummaryCard("Previous Reel", {
            reelCode: activeSpikeDetail.previousReelCode,
            ratePer1k: activeSpikeDetail.previousRate,
            defects: activeSpikeDetail.previousDefects,
            bstActivePct: activeSpikeDetail.previousBstActivePct,
            avgSize: activeSpikeDetail.previousAvgSize,
            lengthFt: activeSpikeDetail.previousLengthFt,
          })}
          ${renderSpikeSummaryCard("Current Reel", {
            reelCode: activeSpikeDetail.currentReelCode,
            ratePer1k: activeSpikeDetail.currentRate,
            defects: activeSpikeDetail.currentDefects,
            bstActivePct: activeSpikeDetail.currentBstActivePct,
            avgSize: activeSpikeDetail.currentAvgSize,
            lengthFt: activeSpikeDetail.currentLengthFt,
          })}
        </div>
        <div class="drivers-spike-viewer__table">
          <div class="drivers-subsection__title">Per-Defect-Type Spike Breakdown</div>
          ${renderSpikeBreakdownTable(activeSpikeDetail.typeBreakdown, activeSpikeDetail.rollingCount)}
        </div>
      `;
      window.openFootprintModalContent(content, activeSpikeDetail.title || "Defect Spike");
    }

    function buildSpeedViewerPanel(title, reelCode, suffix) {
      const host = document.createElement("article");
      host.className = "drivers-speed-viewer__panel";
      host.innerHTML = `
        <div class="drivers-speed-viewer__panel-header">
          <div>
            <strong>${Utils.escapeHtml(title)}</strong>
            <small>${Utils.escapeHtml(reelCode || "Reel")}</small>
          </div>
        </div>
        <div class="drivers-speed-viewer__chart" id="drivers-speed-viewer-${suffix}"></div>
      `;
      return {
        host,
        chartId: `drivers-speed-viewer-${suffix}`,
        title,
      };
    }

    function parseSpeedTrend(points = []) {
      return (Array.isArray(points) ? points : [])
        .map((point) => {
          const timestamp = point && point.timestamp ? new Date(point.timestamp) : null;
          const speed = Number(point && point.webspeed);
          if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime()) || !Number.isFinite(speed)) {
            return null;
          }
          return { timestamp, speed };
        })
        .filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    function renderSpeedViewerChart(host, title, points, yRange) {
      if (!host) return;
      if (!points.length) {
        host.innerHTML = "<div class='drivers-empty placeholder'>No speed trend data available.</div>";
        return;
      }
      if (!window.Plotly) {
        host.innerHTML = "<div class='drivers-empty placeholder'>Plotly unavailable.</div>";
        return;
      }
      const x = points.map((point) => point.timestamp);
      const y = points.map((point) => point.speed);
      const trace = {
        x,
        y,
        mode: "lines+markers",
        name: title,
        line: { color: "#16a34a", width: 2.5, shape: "linear" },
        marker: { size: 6, color: "#16a34a" },
        hovertemplate: "Time: %{x}<br>Speed: %{y:.2f}<extra></extra>",
      };
      const layout = {
        title: "",
        autosize: true,
        margin: { t: 16, r: 18, l: 54, b: 76 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        xaxis: {
          title: "Timestamp",
          type: "date",
          tickangle: -30,
          automargin: true,
        },
        yaxis: {
          title: "Speed",
          automargin: true,
          range: yRange,
        },
        showlegend: false,
      };
      window.Plotly.react(host, [trace], layout, { responsive: true, displayModeBar: false });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (window.Plotly && host && host.offsetWidth) {
            window.Plotly.Plots.resize(host);
          }
        });
      });
    }

    function buildSharedSpeedRange(seriesList = []) {
      const values = seriesList.flat().map((point) => point.speed).filter((value) => Number.isFinite(value));
      if (!values.length) return null;
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (min === max) {
        const pad = Math.max(Math.abs(min) * 0.08, 1);
        return [min - pad, max + pad];
      }
      const pad = Math.max((max - min) * 0.08, 0.5);
      return [min - pad, max + pad];
    }

    function openSpeedViewer() {
      if (!activeSpeedDetail || typeof window.openFootprintModalContent !== "function") return;
      const content = document.createElement("div");
      content.className = "drivers-speed-viewer";
      const grid = document.createElement("div");
      grid.className = "drivers-speed-viewer__grid";
      const previous = buildSpeedViewerPanel("Previous Reel Trend", activeSpeedDetail.previousReelCode, "previous");
      const current = buildSpeedViewerPanel("Current Reel Trend", activeSpeedDetail.currentReelCode, "current");
      grid.appendChild(previous.host);
      grid.appendChild(current.host);
      content.appendChild(grid);
      window.openFootprintModalContent(content, activeSpeedDetail.title || "Speed Shift");
      window.requestAnimationFrame(() => {
        const previousPoints = parseSpeedTrend(activeSpeedDetail.previousTrend);
        const currentPoints = parseSpeedTrend(activeSpeedDetail.currentTrend);
        const sharedRange = buildSharedSpeedRange([previousPoints, currentPoints]);
        renderSpeedViewerChart(content.querySelector(`#${previous.chartId}`), previous.title, previousPoints, sharedRange);
        renderSpeedViewerChart(content.querySelector(`#${current.chartId}`), current.title, currentPoints, sharedRange);
      });
    }

    function buildMaskViewerColumn(title, reel, masks, suffix, referenceBackground) {
      const host = document.createElement("div");
      host.className = "defect-footprint";
      const reelId = `drivers-mask-compare-${suffix}`;
      const heatmapId =
        typeof MaskHeatmap === "object" && typeof MaskHeatmap.domId === "function"
          ? MaskHeatmap.domId({ reel_id: reelId })
          : `mask-heatmap-${reelId}`;
      host.innerHTML = `
        <div class="defect-footprint-header">
          <h4>${Utils.escapeHtml(title)}</h4>
          <span class="badge">${Utils.escapeHtml(`${formatNumber((masks || []).length)} mask${(masks || []).length === 1 ? "" : "s"}`)}</span>
        </div>
        <div class="heatmap-wrapper heatmap-empty" id="${Utils.escapeHtml(heatmapId)}">
          <span class="badge">${Utils.escapeHtml((masks || []).length ? "Loading mask footprints…" : "No masks")}</span>
        </div>
      `;
      return {
        host,
        heatmapId,
        title,
        summary: {
          reel: {
            reel_id: reelId,
            format_width: reel && reel.format_width !== undefined ? reel.format_width : null,
            format_length: reel && reel.format_length !== undefined ? reel.format_length : null,
          },
          masks: Array.isArray(masks) ? masks : [],
          referenceBackground: referenceBackground || null,
        },
      };
    }

    function finalizeMaskViewerColumn(content, column, state, error) {
      const container = content.querySelector(`#${column.heatmapId}`);
      if (!container) {
        console.error("[Defect Drivers][Mask Modal] container lookup failed", {
          panel: column.title,
          heatmapId: column.heatmapId,
        });
        return;
      }
      if (state === "error") {
        container.classList.add("heatmap-empty");
        container.innerHTML = "<span class='badge'>Unable to render mask footprints</span>";
        if (error) {
          console.error("[Defect Drivers][Mask Modal] draw failed", {
            panel: column.title,
            heatmapId: column.heatmapId,
            error,
          });
        }
      } else if (state === "empty") {
        container.classList.add("heatmap-empty");
        container.innerHTML = "<span class='badge'>No masks</span>";
      }
    }

    function renderMaskViewerColumn(content, column) {
      const masks = Array.isArray(column.summary && column.summary.masks) ? column.summary.masks : [];
      const masksWithCoords = masks.filter((mask) => mask && mask.coords).length;
      const container = content.querySelector(`#${column.heatmapId}`);
      console.log("[Defect Drivers][Mask Modal] panel render starting", {
        panel: column.title,
        masksCount: masks.length,
        masksWithCoords,
        heatmapId: column.heatmapId,
        containerFound: Boolean(container),
      });
      if (!container) {
        finalizeMaskViewerColumn(content, column, "error", new Error("Missing mask heatmap container"));
        return;
      }
      if (!masks.length) {
        console.log("[Defect Drivers][Mask Modal] no masks for panel", { panel: column.title });
        finalizeMaskViewerColumn(content, column, "empty");
        return;
      }
      try {
        console.log("[Defect Drivers][Mask Modal] draw started", { panel: column.title });
        if (typeof MaskHeatmap !== "object" || typeof MaskHeatmap.attach !== "function") {
          throw new Error("MaskHeatmap renderer unavailable");
        }
        MaskHeatmap.attach(content, column.summary);
        window.setTimeout(() => {
          const current = content.querySelector(`#${column.heatmapId}`);
          const text = current ? String(current.textContent || "").trim() : "";
          if (!current) {
            finalizeMaskViewerColumn(content, column, "error", new Error("Mask heatmap container disappeared"));
            return;
          }
          if (text.includes("Loading mask footprints")) {
            finalizeMaskViewerColumn(content, column, "error", new Error("Renderer did not replace loading state"));
            return;
          }
          console.log("[Defect Drivers][Mask Modal] draw finished", {
            panel: column.title,
            rendered: Boolean(current.querySelector("canvas")),
            text,
          });
        }, 200);
      } catch (error) {
        finalizeMaskViewerColumn(content, column, "error", error);
      }
    }

    function openMaskViewer() {
      if (!activeMaskDetail || typeof window.openFootprintModalContent !== "function") return;
      console.log("[Defect Drivers][Mask Modal] modal opened", {
        beforeMasks: Array.isArray(activeMaskDetail.beforeMasks) ? activeMaskDetail.beforeMasks.length : 0,
        afterMasks: Array.isArray(activeMaskDetail.afterMasks) ? activeMaskDetail.afterMasks.length : 0,
      });
      const content = document.createElement("div");
      content.className = "defect-footprints-inline drivers-mask-footprint-compare";
      const referenceBackground =
        activeMaskDetail.referenceImage && activeMaskDetail.referenceImage.image_src
          ? urlForStatic(activeMaskDetail.referenceImage.image_src)
          : null;
      const before = buildMaskViewerColumn(
        "Before",
        activeMaskDetail.reel,
        activeMaskDetail.beforeMasks,
        "before",
        referenceBackground
      );
      const after = buildMaskViewerColumn(
        "After",
        activeMaskDetail.reel,
        activeMaskDetail.afterMasks,
        "after",
        referenceBackground
      );
      content.appendChild(before.host);
      content.appendChild(after.host);
      window.openFootprintModalContent(content, `${activeMaskDetail.title} · ${activeMaskDetail.subtitle}`);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          renderMaskViewerColumn(content, before);
          renderMaskViewerColumn(content, after);
        });
      });
    }

    function handleDriverFilterClick(event) {
      const button = event.target.closest("[data-driver-filter]");
      if (!button) return;
      const key = button.dataset.driverFilter;
      if (!key) return;
      if (selectedEventFilters.has(key)) {
        selectedEventFilters.delete(key);
      } else {
        selectedEventFilters.add(key);
      }
      selectedTimelineEventKey = "";
      renderDriverFilterBar();
      renderTimeline(rawTimelineRows);
    }

    function renderPanels(data = {}) {
      renderBstSummary(data.bst_active_summary || {});
      renderDriverSummary(data.driver_summary || {});
      renderSensitivity(data || {});
      renderMaskSegments(data || {});
      renderReference(data.reference_stability || {});
      renderSpeed(data.speed_impact || {});
      renderLength(data.length_impact || {});
    }

    const load = Utils.debounce(async () => {
      const requestToken = ++latestRequestToken;
      const filtersState = Filters && typeof Filters.getState === "function" ? Filters.getState() : {};
      const requestKey = `${buildRequestKey(filtersState)}|min=${minReelLengthFilter || 0}`;
      const reuseInflight = inflightKey === requestKey && inflightPromise;
      const shouldBlock = !hasRendered || requestKey !== lastRenderedKey;
      if (shouldBlock && !reuseInflight) {
        LoadingOverlay.show();
      }
      try {
        const extraParams = minReelLengthFilter > 0 ? { min_reel_length: minReelLengthFilter } : {};
        const fetchPromise = reuseInflight || Api.get("defect-drivers", extraParams, filtersState);
        if (!reuseInflight) {
          inflightKey = requestKey;
          inflightPromise = fetchPromise;
          fetchPromise.finally(() => {
            if (inflightPromise === fetchPromise) {
              inflightPromise = null;
              inflightKey = "";
            }
          });
        }
        const data = await fetchPromise;
        if (requestToken !== latestRequestToken) return;
        renderKpis(data.kpis || {});
        renderLegend(data.event_counts || {});
        renderDriverFilterBar();
        if (selectedTimelineEventKey) {
          const [rowIndexRaw, eventIndexRaw] = selectedTimelineEventKey.split(":");
          const rowIndex = Number(rowIndexRaw);
          const eventIndex = Number(eventIndexRaw);
          const hasSelection =
            Number.isInteger(rowIndex) &&
            Number.isInteger(eventIndex) &&
            data.timeline &&
            data.timeline[rowIndex] &&
            data.timeline[rowIndex].events &&
            data.timeline[rowIndex].events[eventIndex];
          if (!hasSelection) {
            selectedTimelineEventKey = "";
          }
        }
        renderTimeline(data.timeline || []);
        if (selectedTimelineEventKey) {
          const [rowIndexRaw, eventIndexRaw] = selectedTimelineEventKey.split(":");
          renderTimelineDetailForEvent(Number(rowIndexRaw), Number(eventIndexRaw));
        } else {
          renderTimelineDetailEmpty();
        }
        renderPanels(data);
        hasRendered = true;
        lastRenderedKey = requestKey;
      } catch (err) {
        console.error("Defect drivers load failed", err);
        [
          els.kpis,
          els.timeline,
          els.bstSummary,
          els.summary,
          els.sensitivity,
          els.mask,
          els.reference,
          els.speed,
          els.length,
          els.anomalies,
        ].forEach((node) => {
          if (node) {
            renderEmpty(node, "Failed to load defect-driver analysis.");
          }
        });
      } finally {
        if (shouldBlock) {
          LoadingOverlay.hide();
        }
      }
    }, FETCH_DEBOUNCE_MS);

    function init() {
      if (initialized) return;
      initialized = true;
      els.kpis = document.getElementById("defectDriversKpis");
      els.legend = document.getElementById("defectDriversLegend");
      els.eventFilters = document.getElementById("defectDriversEventFilters");
      els.timeline = document.getElementById("defectDriversTimeline");
      els.timelineDetail = document.getElementById("defectDriversTimelineDetail");
      els.bstSummary = document.getElementById("defectDriversBstSummary");
      els.summary = document.getElementById("defectDriversSummary");
      els.sensitivity = document.getElementById("defectDriversSensitivity");
      els.mask = document.getElementById("defectDriversMask");
      els.reference = document.getElementById("defectDriversReference");
      els.speed = document.getElementById("defectDriversSpeed");
      els.length = document.getElementById("defectDriversLength");
      els.referenceViewerModal = document.getElementById("driversReferenceViewerModal");
      els.referenceViewerTitle = document.getElementById("driversReferenceViewerTitle");
      els.referenceViewerSubtitle = document.getElementById("driversReferenceViewerSubtitle");
      els.referenceViewerCount = document.getElementById("driversReferenceViewerCount");
      els.referenceViewerGrid = document.getElementById("driversReferenceViewerGrid");
      els.referenceViewerClose = document.getElementById("driversReferenceViewerClose");
      els.referenceViewerDismiss = document.getElementById("driversReferenceViewerDismiss");
      setupMinReelLengthControls();
      if (els.timeline) {
        els.timeline.addEventListener("click", handleTimelineClick);
      }
      if (els.timelineDetail) {
        els.timelineDetail.addEventListener("click", handleTimelineDetailClick);
      }
      if (els.eventFilters) {
        els.eventFilters.addEventListener("click", handleDriverFilterClick);
      }
      if (els.referenceViewerModal) {
        els.referenceViewerModal.addEventListener("click", (event) => {
          if (event.target === els.referenceViewerModal) {
            closeReferenceViewer();
          }
        });
      }
      if (els.referenceViewerClose) {
        els.referenceViewerClose.addEventListener("click", closeReferenceViewer);
      }
      if (els.referenceViewerDismiss) {
        els.referenceViewerDismiss.addEventListener("click", closeReferenceViewer);
      }
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && referenceViewerState) {
          closeReferenceViewer();
        }
      });
      renderDriverFilterBar();
      renderTimelineDetailEmpty();
    }

    function activate() {
      load.flush();
    }

    function onFiltersUpdated() {
      load();
    }

    function deactivate() {}

    return {
      init,
      activate,
      onFiltersUpdated,
      deactivate,
    };
  })();
