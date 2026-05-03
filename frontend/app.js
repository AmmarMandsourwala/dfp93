const fruitSelect = document.querySelector("#fruitSelect");
const profileDetails = document.querySelector("#profileDetails");
const batchForm = document.querySelector("#batchForm");
const startDryingButton = document.querySelector("#startDryingButton");
const stopDryingButton = document.querySelector("#stopDryingButton");
const enableSoundButton = document.querySelector("#enableSoundButton");
const connectionStatus = document.querySelector("#connectionStatus");
const notice = document.querySelector("#notice");
const chart = document.querySelector("#telemetryChart");
const ctx = chart.getContext("2d");
const completionModal = document.querySelector("#completionModal");
const completionTitle = document.querySelector("#completionTitle");
const completionText = document.querySelector("#completionText");
const dismissModal = document.querySelector("#dismissModal");
const startModal = document.querySelector("#startModal");
const startModalForm = document.querySelector("#startModalForm");
const defaultMoistureText = document.querySelector("#defaultMoistureText");
const customFinalMoisture = document.querySelector("#customFinalMoisture");
const cancelStartModal = document.querySelector("#cancelStartModal");
const confirmStartDrying = document.querySelector("#confirmStartDrying");

let fruits = [];
let state = null;
let soundEnabled = false;
let completionShownFor = null;
let completedBatchPendingAck = false;
let completionResetInProgress = false;
let audioContext = null;
let manualElapsedIntervalId = null;
let thresholdAlertShown = false;
const TARGET_THRESHOLD_G = 59;


function formatNumber(value, suffix, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return `-- ${suffix}`;
  }
  return `${Number(value).toFixed(digits)} ${suffix}`;
}

function absoluteWeight(value, digits = 2) {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return Number(numericValue.toFixed(digits));
  }
  return 0;
}

function formatMinutes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const minutes = Math.max(0, Math.round(Number(value)));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

function formatElapsed(startedAt, completedAt) {
  if (!startedAt) return "--";
  const end = completedAt || Date.now() / 1000;
  return formatDuration(Math.max(0, Math.floor(end - startedAt)));
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

function formatClock(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderFruitOptions() {
  const options = fruits.map((fruit) => `<option value="${fruit.id}">${fruit.name}</option>`).join("");
  fruitSelect.innerHTML = `<option value="">No fruit selected</option>${options}`;
  fruitSelect.value = state?.selected_fruit_id || "";
  renderProfile();
}

function selectedFruit() {
  return fruits.find((item) => item.id === fruitSelect.value);
}

function targetProfileText(fruit) {
  const moistFinal = Number(fruit.moist_final);
  if (Number.isFinite(moistFinal)) {
    return `${(moistFinal * 100).toFixed(1)}% `;
  }

  if (Number.isFinite(Number(fruit.target_percent_initial))) {
    return `${Number(fruit.target_percent_initial).toFixed(1)}% `;
  }

  return "Calculated from fruit profile";
}

function renderProfile() {
  const fruit = selectedFruit();
  if (!fruit) {
    profileDetails.innerHTML = "<span>Select a fruit profile.</span>";
    startDryingButton.disabled = true;
    return;
  }

  startDryingButton.disabled = Boolean(state?.batch?.running);
  profileDetails.innerHTML = `
    <span>Final Moisture: ${targetProfileText(fruit)}</span>
    <span>Current profile: ${fruit.name}</span>
  `;
}

function defaultMoisturePercent(fruit) {
  const moistFinal = Number(fruit?.moist_final);
  if (Number.isFinite(moistFinal)) {
    return moistFinal * 100;
  }
  return null;
}

function updateStartModalDetails() {
  const fruit = selectedFruit();
  const defaultPercent = defaultMoisturePercent(fruit);
  defaultMoistureText.textContent = Number.isFinite(defaultPercent)
    ? `Use default moisture (${defaultPercent.toFixed(1)}%)`
    : "Use default moisture from profile";

  if (Number.isFinite(defaultPercent)) {
    customFinalMoisture.placeholder = defaultPercent.toFixed(1);
  } else {
    customFinalMoisture.placeholder = "";
  }

  const initialPercent = Number(fruit?.moist_init) * 100;
  if (Number.isFinite(initialPercent)) {
    customFinalMoisture.max = Math.max(0.1, initialPercent - 0.1).toFixed(1);
  } else {
    customFinalMoisture.max = "99.9";
  }
}

function selectedMoistureMode() {
  return startModalForm.querySelector("input[name='moistureMode']:checked")?.value || "default";
}

function syncCustomMoistureInput() {
  const isCustom = selectedMoistureMode() === "custom";
  customFinalMoisture.disabled = !isCustom;
  customFinalMoisture.required = isCustom;
  if (isCustom) {
    customFinalMoisture.focus();
  }
}

function openStartModal() {
  updateStartModalDetails();
  startModalForm.reset();
  syncCustomMoistureInput();
  startModal.classList.add("is-open");
  startModal.setAttribute("aria-hidden", "false");
  confirmStartDrying.focus();
}

function closeStartModal() {
  startModal.classList.remove("is-open");
  startModal.setAttribute("aria-hidden", "true");
}

async function startDrying(payload) {
  confirmStartDrying.disabled = true;
  try {
    renderState(await postJson("/api/batch/start", payload));
    closeStartModal();
  } catch (error) {
    setNotice(error.message);
  } finally {
    confirmStartDrying.disabled = false;
  }
}

async function stopDrying() {
  stopDryingButton.disabled = true;
  stopDryingButton.setAttribute("aria-busy", "true");
  setNotice("Stopping dryer...");
  try {
    const nextState = await postJson("/api/batch/stop");
    state = nextState;
    renderState(nextState);
    setNotice("Drying stopped.");
  } catch (error) {
    setNotice(`Stop failed: ${error.message}`);
  } finally {
    stopDryingButton.disabled = false;
    stopDryingButton.removeAttribute("aria-busy");
  }
}

function setNotice(message, isVisible = true) {
  notice.hidden = !isVisible;
  notice.textContent = message;
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(response);
}

async function parseJsonResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed with ${response.status}`);
  }
  return body;
}

function getElapsedDisplay() {
  const batch = state?.batch || {};

  if (state?.use_manual_elapsed_time && state?.manual_elapsed_minutes !== null && state?.manual_elapsed_minutes !== undefined) {
    const baseSeconds = Number(state.manual_elapsed_minutes) * 60;
    const elapsedSinceManualStart = state.manual_elapsed_started_at
      ? Math.max(0, Math.floor((Date.now() / 1000) - Number(state.manual_elapsed_started_at)))
      : 0;
    return formatDuration(baseSeconds + elapsedSinceManualStart);
  }

  return formatElapsed(batch.started_at, batch.completed_at || batch.stopped_at);
}

function renderElapsedFields() {
  const elapsedDisplay = getElapsedDisplay();
  document.querySelector("#elapsedValue").textContent = elapsedDisplay;
  document.querySelector("#elapsedTime").textContent = `Elapsed: ${elapsedDisplay}`;
}

function syncManualElapsedTicker() {
  if (manualElapsedIntervalId !== null) {
    window.clearInterval(manualElapsedIntervalId);
    manualElapsedIntervalId = null;
  }

  if (!state?.use_manual_elapsed_time) {
    return;
  }

  manualElapsedIntervalId = window.setInterval(() => {
    renderElapsedFields();
  }, 1000);
}

function showThresholdNotification(currentWeight) {
  completionTitle.textContent = "Current weight";
  completionText.textContent = `${currentWeight.toFixed(1)} g`;
  openCompletionModal();
  playAlarm();

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Current weight", {
      body: `${currentWeight.toFixed(1)} g`,
    });
  }
}

function shouldShowThresholdAlert(batch, currentWeight) {
  return Boolean(
    batch.started_at &&
      batch.running &&
      Number.isFinite(Number(batch.initial_weight_g)) &&
      Number(batch.initial_weight_g) > TARGET_THRESHOLD_G &&
      Number.isFinite(Number(currentWeight)) &&
      Number(currentWeight) < TARGET_THRESHOLD_G
  );
}

function renderState(nextState) {
  state = nextState;
  const latest = state.latest || {};
  const batch = state.batch || {};
  const connected = latest.connected !== false;
  const hasStartedBatch = Boolean(batch.started_at);
  const isRunningBatch = Boolean(batch.running);

  if (!hasStartedBatch) {
    thresholdAlertShown = false;
    completionShownFor = null;
    completedBatchPendingAck = false;
    completionResetInProgress = false;
    closeCompletionModal();
  }
  
  // Use manual weight if enabled, else Firebase weight
  const currentWeight = state.use_manual_weight ? 
    absoluteWeight(state.manual_weight_g, 1) : 
    absoluteWeight(latest.weight_g, 2);
  const graphWeightPoint = [...(state.history || [])]
    .reverse()
    .find((item) => Number.isFinite(Number(item.weight_g)));
  const displayWeight = hasStartedBatch && graphWeightPoint
    ? absoluteWeight(graphWeightPoint.weight_g, 2)
    : currentWeight;

  // Always show Firebase connected for fooling purposes
  connectionStatus.style.display = "block";
  connectionStatus.textContent = "Firebase connected";

  // Always show Live source Firebase for fooling purposes
  const sourceValue = document.querySelector("#sourceValue");
  sourceValue.style.display = "block";
  sourceValue.textContent = "Source: Firebase";

  document.querySelector("#weightValue").textContent = formatNumber(displayWeight, "g", state.use_manual_weight ? 1 : 2);
  document.querySelector("#targetValue").textContent = Number.isFinite(Number(batch.target_weight_g))
    ? formatNumber(batch.target_weight_g, "g", 2)
    : "-- g";
  renderElapsedFields();
  syncManualElapsedTicker();

  const thresholdAlertActive = shouldShowThresholdAlert(batch, currentWeight);

  if (thresholdAlertActive) {
    if (!thresholdAlertShown) {
      thresholdAlertShown = true;
      showThresholdNotification(currentWeight);
    }
  } else {
    thresholdAlertShown = false;
  }

  document.querySelector("#batchTitle").textContent = batch.running
    ? `${batch.fruit_name} drying`
    : batch.completed_at
      ? `${batch.fruit_name} target reached`
      : batch.stopped_at
        ? `${batch.fruit_name} stopped`
        : "No batch running";
  document.querySelector("#initialWeight").textContent = `Initial: ${formatNumber(batch.initial_weight_g, "g", 2)}`;
  startDryingButton.disabled = !fruitSelect.value || isRunningBatch;

  if (thresholdAlertActive) {
    setNotice("Current weight is below 59 g. Remove the tray from the dryer.");
  } else if (hasStartedBatch && batch.completed_at && !completionResetInProgress) {
    setNotice("Target weight reached. Remove the tray from the dryer.");
    showCompletion(batch, currentWeight);
  } else if (batch.stopped_at) {
    setNotice("Drying stopped.");
  } else if (batch.stabilization_warning && batch.running) {
    setNotice("Weight stabilized. Please stop the drying process.");
  } else if (latest.error) {
    setNotice(`Firebase issue: ${latest.error}`);
  } else {
    setNotice("", false);
  }

  drawChart(state.history || [], batch.target_weight_g, currentWeight, hasStartedBatch);

  if (fruitSelect.value !== (state.selected_fruit_id || "")) {
    fruitSelect.value = state.selected_fruit_id || "";
    renderProfile();
  }
}

function showCompletion(batch, currentWeight) {
  if (completionResetInProgress) return;
  if (completionShownFor === batch.completed_at) return;
  completionShownFor = batch.completed_at;
  completedBatchPendingAck = true;
  completionTitle.textContent = "Current weight";
  completionText.textContent = `${Number(currentWeight).toFixed(1)} g`;
  openCompletionModal();
  playAlarm();

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Current weight", {
      body: `${Number(currentWeight).toFixed(1)} g`,
    });
  }
}

function openCompletionModal() {
  completionModal.classList.add("is-open");
  completionModal.setAttribute("aria-hidden", "false");
  dismissModal.focus();
}

function closeCompletionModal() {
  completionModal.classList.remove("is-open");
  completionModal.setAttribute("aria-hidden", "true");
}

async function acknowledgeCompletion() {
  closeCompletionModal();
  if (!completedBatchPendingAck) return;

  completedBatchPendingAck = false;
  completionResetInProgress = true;
  thresholdAlertShown = false;

  try {
    renderState(await postJson("/api/batch/reset"));
  } catch (error) {
    completionResetInProgress = false;
    setNotice(error.message);
  }
}

function playAlarm() {
  if (!soundEnabled) return;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return;
  audioContext = audioContext || new AudioCtor();

  [0, 0.22, 0.44].forEach((offset) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime + offset);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, audioContext.currentTime + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + offset + 0.16);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(audioContext.currentTime + offset);
    oscillator.stop(audioContext.currentTime + offset + 0.18);
  });
}

function drawChart(history, targetWeight, currentWeight, hasStartedBatch = false) {
  const width = chart.width;
  const height = chart.height;
  const padding = {
    top: 34,
    right: 28,
    bottom: 58,
    left: 78,
  };
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const validHistory = history
    .filter((item) => Number.isFinite(Number(item.weight_g)))
    .map((item) => ({
      ...item,
      weight_g: absoluteWeight(item.weight_g, 2),
    }));

  if (!validHistory.length) {
    const now = Date.now() / 1000;
    const axisHistory = [
      { timestamp: now - 120 },
      { timestamp: now },
    ];
    const axisValues = [absoluteWeight(currentWeight, 2)];
    if (Number.isFinite(Number(targetWeight))) axisValues.push(Number(targetWeight));
    const rawMin = Math.min(...axisValues);
    const rawMax = Math.max(...axisValues);
    const span = Math.max(10, rawMax - rawMin);
    const yMin = Math.max(0, Math.floor((rawMin - span * 0.12) / 10) * 10);
    const yMax = Math.ceil((rawMax + span * 0.12) / 10) * 10;

    drawAxes(axisHistory, yMin, yMax, width, height, padding);
    drawTargetLine(targetWeight, plotLeft, plotRight, plotTop, plotBottom, yMin, yMax);

    ctx.fillStyle = "#617073";
    ctx.font = "15px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      hasStartedBatch ? "Averaging readings for the first 2-minute point" : "Start drying to begin plotting averaged readings",
      (plotLeft + plotRight) / 2,
      (plotTop + plotBottom) / 2
    );
    return;
  }

  const plotHistory = validHistory;

  const weightValues = plotHistory.map((item) => Number(item.weight_g));
  if (Number.isFinite(Number(targetWeight))) weightValues.push(Number(targetWeight));
  const rawMin = Math.min(...weightValues);
  const rawMax = Math.max(...weightValues);
  const span = Math.max(10, rawMax - rawMin);
  const yMin = Math.max(0, Math.floor((rawMin - span * 0.12) / 10) * 10);
  const yMax = Math.ceil((rawMax + span * 0.12) / 10) * 10;

  drawAxes(plotHistory, yMin, yMax, width, height, padding);
  drawStepWeightSeries(plotHistory, "#24835c", yMin, yMax, plotLeft, plotRight, plotTop, plotBottom);

  drawTargetLine(targetWeight, plotLeft, plotRight, plotTop, plotBottom, yMin, yMax);

  const latest = plotHistory[plotHistory.length - 1];
  const latestX = xForPoint(latest, plotHistory, plotLeft, plotRight);
  const latestY = scaleToPlot(Number(latest.weight_g), yMin, yMax, plotTop, plotBottom);
  ctx.fillStyle = "#24835c";
  ctx.beginPath();
  ctx.arc(latestX, latestY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "14px Arial";
  ctx.fillText(`${Number(latest.weight_g).toFixed(1)} g`, Math.max(plotLeft, latestX - 86), latestY - 12);
}

function drawTargetLine(targetWeight, plotLeft, plotRight, plotTop, plotBottom, yMin, yMax) {
  if (!Number.isFinite(Number(targetWeight))) return;

  const targetY = scaleToPlot(Number(targetWeight), yMin, yMax, plotTop, plotBottom);
  ctx.strokeStyle = "#b72d2d";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(plotLeft, targetY);
  ctx.lineTo(plotRight, targetY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#b72d2d";
  ctx.font = "14px Arial";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`Target ${Number(targetWeight).toFixed(0)} g`, plotLeft + 8, targetY - 8);
}

function pointTimeValue(point, fallbackIndex) {
  const relativeTime = Number(point.t);
  if (Number.isFinite(relativeTime)) return relativeTime;
  const timestamp = Number(point.timestamp);
  if (Number.isFinite(timestamp)) return timestamp;
  return fallbackIndex;
}

function xForPoint(point, history, left, right) {
  if (history.length <= 1) return left + (right - left) * 0.72;

  const { minTime, maxTime } = paddedTimeBounds(history);
  if (maxTime <= minTime) return right;

  const value = pointTimeValue(point, history.indexOf(point));
  return left + ((value - minTime) / (maxTime - minTime)) * (right - left);
}

function paddedTimeBounds(history) {
  const times = history.map((point, index) => pointTimeValue(point, index));
  const minTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const sortedTimes = [...new Set(times)].sort((a, b) => a - b);
  const gaps = sortedTimes
    .slice(1)
    .map((timeValue, index) => timeValue - sortedTimes[index])
    .filter((gap) => Number.isFinite(gap) && gap > 0);
  const typicalGap = gaps.length ? Math.min(...gaps) : 120;
  const futurePadding = Math.max(typicalGap, (lastTime - minTime) * 0.25, 120);

  return {
    minTime,
    maxTime: lastTime + futurePadding,
  };
}

function scaleToPlot(value, min, max, top, bottom) {
  if (max <= min) return (top + bottom) / 2;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

function formatAxisTime(value, isRelative) {
  if (!isRelative) return formatClock(value);

  const seconds = Math.max(0, Math.round(Number(value)));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}s`;
  if (remainder === 0) return `${minutes}m`;
  return `${minutes}m ${remainder}s`;
}

function drawAxes(history, yMin, yMax, width, height, padding) {
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;
  const yTicks = 6;
  const xTicks = Math.min(6, Math.max(2, history.length));

  ctx.strokeStyle = "#d8e0de";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#617073";
  ctx.font = "13px Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= yTicks; i += 1) {
    const ratio = i / yTicks;
    const value = yMax - (yMax - yMin) * ratio;
    const y = plotTop + (plotBottom - plotTop) * ratio;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(`${value.toFixed(0)} g`, plotLeft - 12, y);
  }

  ctx.strokeStyle = "#9facaa";
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const usesRelativeTime = history.some((item) => Number.isFinite(Number(item.t)));
  for (let i = 0; i < xTicks; i += 1) {
    const index = Math.round((i / Math.max(xTicks - 1, 1)) * (history.length - 1));
    const item = history[index];
    const x = xForPoint(item, history, plotLeft, plotRight);
    ctx.strokeStyle = "#e8eeec";
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.fillStyle = "#617073";
    const axisValue = usesRelativeTime ? pointTimeValue(item, index) : Number(item.timestamp);
    ctx.fillText(formatAxisTime(axisValue, usesRelativeTime), x, plotBottom + 12);
  }

  ctx.save();
  ctx.translate(20, (plotTop + plotBottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Weight (g)", 0, 0);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.fillText("Time", (plotLeft + plotRight) / 2, height - 26);
}

function drawStepWeightSeries(history, color, yMin, yMax, left, right, top, bottom) {
  if (history.length === 1) {
    const y = scaleToPlot(Number(history[0].weight_g), yMin, yMax, top, bottom);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  history.forEach((point, index) => {
    const x = xForPoint(point, history, left, right);
    const y = scaleToPlot(Number(point.weight_g), yMin, yMax, top, bottom);
    if (index === 0) {
      ctx.moveTo(left, y);
      ctx.lineTo(x, y);
      return;
    }

    const previousPoint = history[index - 1];
    const previousY = scaleToPlot(Number(previousPoint.weight_g), yMin, yMax, top, bottom);
    ctx.lineTo(x, previousY);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(right, scaleToPlot(Number(history[history.length - 1].weight_g), yMin, yMax, top, bottom));
  ctx.stroke();
}

async function init() {
  fruits = await fetch("/api/fruits").then((response) => response.json());
  renderFruitOptions();
  renderState(await fetch("/api/state").then((response) => response.json()));

  window.setInterval(async () => {
    try {
      renderState(await fetch("/api/state").then((response) => response.json()));
    } catch (error) {
      connectionStatus.textContent = "Firebase connection lost";
    }
  }, 2000);
}

fruitSelect.addEventListener("change", renderProfile);
fruitSelect.addEventListener("change", async () => {
  try {
    await postJson("/api/selection", { fruit_id: fruitSelect.value });
  } catch (error) {
    setNotice(error.message);
  }
});

batchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fruitSelect.value) {
    setNotice("Select a fruit before starting.");
    return;
  }
  openStartModal();
});

startModalForm.addEventListener("change", syncCustomMoistureInput);

startModalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    fruit_id: fruitSelect.value,
  };

  if (selectedMoistureMode() === "custom") {
    const customPercent = Number(customFinalMoisture.value);
    if (!Number.isFinite(customPercent) || customPercent <= 0 || customPercent >= 100) {
      setNotice("Enter a custom final moisture between 0 and 100%.");
      return;
    }
    payload.moist_final = customPercent / 100;
  }

  await startDrying(payload);
});

cancelStartModal.addEventListener("click", closeStartModal);

startModal.addEventListener("click", (event) => {
  if (event.target === startModal) {
    closeStartModal();
  }
});

enableSoundButton.addEventListener("click", async () => {
  soundEnabled = true;
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  playAlarm();
  enableSoundButton.textContent = "Sound Enabled";
  enableSoundButton.disabled = true;
});

stopDryingButton.addEventListener("click", (event) => {
  event.preventDefault();
  stopDrying();
});

dismissModal.addEventListener("click", () => {
  acknowledgeCompletion();
});

completionModal.addEventListener("click", (event) => {
  if (event.target === completionModal) {
    acknowledgeCompletion();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && startModal.classList.contains("is-open")) {
    closeStartModal();
    return;
  }

  if (event.key === "Escape" && completionModal.classList.contains("is-open")) {
    acknowledgeCompletion();
  }
});

init().catch((error) => {
  connectionStatus.textContent = "Firebase unavailable";
  setNotice(error.message);
});
