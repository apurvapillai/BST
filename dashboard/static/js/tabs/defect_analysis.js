const DefectAnalysisTab = (() => {
  let initialized = false;
  let requestToken = 0;
  const els = {};

  function init() {
    if (initialized) return;
    initialized = true;
    els.state = document.getElementById("defectAnalysisState");
    els.content = document.getElementById("defectAnalysisContent");
    els.summary = document.getElementById("defectAnalysisSummary");
    els.mix = document.getElementById("defectAnalysisMix");
    els.reels = document.getElementById("defectAnalysisReels");
    els.sensitivity = document.getElementById("defectAnalysisSensitivity");
    els.criteria = document.getElementById("defectAnalysisCriteria");
    els.reelFilterCard = document.getElementById("filterReel")?.closest(".filter-card");
  }

  async function load() {
    const filters = Filters.getState ? Filters.getState() : {};
    if (!String(filters.job || "").trim() && !String(filters.order || "").trim()) {
      showState("Select an Order No. and Job No. in the global filters.");
      return;
    }
    const token = ++requestToken;
    showState("Loading defect details...");
    try {
      const data = await Api.get("defect-details-summary");
      if (token !== requestToken) return;
      render(data || {});
    } catch (err) {
      if (token !== requestToken) return;
      showState(err && err.message ? err.message : "Unable to load defect details.", true);
    }
  }

  function showState(message, error = false) {
    if (els.state) {
      els.state.textContent = message;
      els.state.classList.toggle("is-error", error);
      els.state.classList.remove("hidden");
    }
    els.content?.classList.add("hidden");
  }

  function render(data) {
    const summary = data.summary || {};
    if (els.state) els.state.classList.add("hidden");
    els.content?.classList.remove("hidden");
    if (els.criteria) {
      const criteria = data.criteria || {};
      const minimumFeet = number(criteria.minimumReelFeet ?? 5000);
      const excluded = number(criteria.excludedShortReels ?? 0);
      els.criteria.textContent = `Only reels >= ${minimumFeet} ft (${excluded} short reels excluded). Size uses longest footprint side: Small < ${criteria.smallMaxExclusive ?? 5}, Medium ${criteria.smallMaxExclusive ?? 5}-${criteria.mediumMaxInclusive ?? 15}, Large > ${criteria.mediumMaxInclusive ?? 15}.`;
    }
    renderSummary(summary);
    renderMix(data);
    renderReels(data.reels || []);
    renderSensitivity(data.sensitivity || []);
  }

  function renderSummary(summary) {
    const cards = [
      ["Avg defects / reel", number(summary.averageDefectsPerReel, 2), `${number(summary.totalDefects)} defects across ${number(summary.reelCount)} reels`],
      ["Most common class", summary.mostCommonClass || "--", "Across the complete selected job"],
      ["Reels above average", number(summary.reelsAboveAverage), "More defects than the job average"],
      ["Most common size", summary.mostCommonSize || "--", "Based on magnitude defaults"],
      ["Average feet / defect", feet(summary.averageFeetPerDefect), "Total job footage divided by defects"],
      ["Most common position", summary.mostCommonPosition || "--", "Start, middle, or end third"],
    ];
    els.summary.innerHTML = cards.map(([label, value, note]) => `
      <article class="defect-analysis-kpi">
        <span>${Utils.escapeHtml(label)}</span>
        <strong>${Utils.escapeHtml(value)}</strong>
        <small>${Utils.escapeHtml(note)}</small>
      </article>`).join("");
  }

  function renderMix(data) {
    els.mix.innerHTML = [
      renderDistribution("Defect classes", data.classCounts || {}),
      renderDistribution("Defect sizes", data.sizeCounts || {}),
      renderDistribution("Reel positions", data.positionCounts || {}),
    ].join("");
  }

  function renderDistribution(title, values) {
    const rows = Object.entries(values).sort((a, b) => Number(b[1]) - Number(a[1]));
    const max = Math.max(...rows.map((row) => Number(row[1]) || 0), 1);
    return `<div class="defect-analysis-distribution"><h4>${Utils.escapeHtml(title)}</h4>${rows.length ? rows.map(([label, count]) => `
      <div class="defect-analysis-bar-row">
        <span>${Utils.escapeHtml(label)}</span>
        <div><i style="width:${Math.max((Number(count) / max) * 100, 2)}%"></i></div>
        <strong>${number(count)}</strong>
      </div>`).join("") : '<p class="placeholder">No defect data.</p>'}</div>`;
  }

  function renderReels(reels) {
    if (!reels.length) {
      els.reels.innerHTML = '<div class="placeholder">No reels match these filters.</div>';
      return;
    }
    els.reels.innerHTML = `<table class="defect-analysis-table">
      <thead><tr><th>Reel</th><th>Feet</th><th>Defects</th><th>/1k ft</th><th>Defective length</th><th>Defective %</th><th>Common class</th><th>Position</th></tr></thead>
      <tbody>${reels.map((reel) => `<tr class="${reel.aboveAverage ? "is-above-average" : ""}">
        <td><strong>${Utils.escapeHtml(reel.reelCode || "--")}</strong>${reel.aboveAverage ? '<small>Above average</small>' : ""}</td>
        <td>${feet(reel.feet)}</td><td>${number(reel.defectCount)}</td><td>${number(reel.defectsPer1000Ft, 2)}</td>
        <td>${feet(reel.defectLengthFeet)}</td><td>${percent(reel.defectLengthPct)}</td>
        <td>${Utils.escapeHtml(reel.commonClass || "--")}</td><td>${Utils.escapeHtml(reel.commonPosition || "--")}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  function renderSensitivity(classes) {
    if (!classes.length) {
      els.sensitivity.innerHTML = '<div class="placeholder">No defect classes are available for simulation.</div>';
      return;
    }
    els.sensitivity.innerHTML = classes.map((item, index) => `
      <article class="defect-sensitivity-card" data-sensitivity-card="${index}">
        <div class="defect-sensitivity-card__title"><strong>${Utils.escapeHtml(item.className)}</strong><span>${number(item.total)} recorded defects</span></div>
        <label>Size threshold <output>${number(item.startingThreshold, 2)}</output>
          <input type="range" min="${Number(item.sliderMin) || 0}" max="${Number(item.sliderMax) || 1}" step="${Number(item.sliderStep) || 0.01}" value="${item.startingThreshold ?? 0}" ${item.startingThreshold == null ? "disabled" : ""}>
        </label>
        <div class="defect-sensitivity-results"><span data-detected></span><span data-ignored></span><small data-cutoff></small></div>
      </article>`).join("");
    classes.forEach((item, index) => {
      const card = els.sensitivity.querySelector(`[data-sensitivity-card="${index}"]`);
      const slider = card?.querySelector('input[type="range"]');
      if (!card || !slider) return;
      const update = () => updateSensitivityCard(card, item, Number(slider.value));
      slider.addEventListener("input", update);
      update();
    });
  }

  function updateSensitivityCard(card, item, threshold) {
    const values = Array.isArray(item.defectSizes) ? item.defectSizes.map(Number).filter(Number.isFinite) : [];
    const unavailable = Number(item.missingSize) || 0;
    if (item.startingThreshold == null) {
      card.querySelector("output").textContent = "--";
      card.querySelector("[data-detected]").innerHTML = "<b>--</b> included";
      card.querySelector("[data-ignored]").innerHTML = "<b>--</b> ignored";
      card.querySelector("[data-cutoff]").textContent = "No XML threshold was found for this class.";
      return;
    }
    const included = values.filter((value) => value > threshold).length;
    const ignored = values.filter((value) => value <= threshold).length;
    card.querySelector("output").textContent = number(threshold, 2);
    card.querySelector("[data-detected]").innerHTML = `<b>${number(included)}</b> included`;
    card.querySelector("[data-ignored]").innerHTML = `<b>${number(ignored)}</b> ignored`;
    card.querySelector("[data-cutoff]").textContent = `Rule: defect size > ${number(threshold, 2)}${unavailable ? `; ${number(unavailable)} unavailable` : ""}`;
  }

  function number(value, digits = 0) {
    return value === null || value === undefined || Number.isNaN(Number(value)) ? "--" : Utils.formatNumber(Number(value), digits);
  }

  function feet(value) {
    const formatted = number(value, 0);
    return formatted === "--" ? formatted : `${formatted} ft`;
  }

  function percent(value) {
    const formatted = number(value, 3);
    return formatted === "--" ? formatted : `${formatted}%`;
  }

  function activate() {
    if (els.reelFilterCard) els.reelFilterCard.hidden = true;
    load();
  }
  function onFiltersUpdated() { load(); }
  function deactivate() {
    requestToken += 1;
    if (els.reelFilterCard) els.reelFilterCard.hidden = false;
  }
  return { init, activate, onFiltersUpdated, deactivate };
})();
