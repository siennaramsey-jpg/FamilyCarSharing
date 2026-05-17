const state = {
  cursor: new Date(),
  selected: new Date(),
  bookings: [],
  defaultKmRate: 1.5
};

const els = {
  telegramStatus: document.querySelector("#telegramStatus"),
  notificationButton: document.querySelector("#notificationButton"),
  alertStack: document.querySelector("#alertStack"),
  monthLabel: document.querySelector("#monthLabel"),
  calendar: document.querySelector("#calendar"),
  selectedDateText: document.querySelector("#selectedDateText"),
  bookingForm: document.querySelector("#bookingForm"),
  bookingMessage: document.querySelector("#bookingMessage"),
  bookingList: document.querySelector("#bookingList"),
  addressSuggestions: document.querySelector("#addressSuggestions"),
  tripEstimate: document.querySelector("#tripEstimate"),
  costForm: document.querySelector("#costForm"),
  costResult: document.querySelector("#costResult"),
  rateHint: document.querySelector("#rateHint")
};

let addressSearchTimer;
let selectedDestination = null;
const STATUS_STORAGE_KEY = "familyCarSharingBookingStatusesV2";
let knownBookingStatuses = readKnownBookingStatuses();

const formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const monthFormatter = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit"
});

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toInputDate(date) {
  return dateKey(date);
}

function startOfCalendar(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const day = first.getDay() || 7;
  first.setDate(first.getDate() - day + 1);
  return first;
}

function bookingsForDay(date) {
  const key = dateKey(date);
  return state.bookings.filter((booking) => dateKey(new Date(booking.startAt)) === key);
}

function setSelectedDate(date) {
  state.selected = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  els.bookingForm.elements.date.value = toInputDate(state.selected);
  els.selectedDateText.textContent = formatter.format(state.selected);
  renderCalendar();
}

function renderCalendar() {
  els.monthLabel.textContent = monthFormatter.format(state.cursor);
  els.calendar.innerHTML = "";

  const start = startOfCalendar(state.cursor);
  const todayKey = dateKey(new Date());
  const selectedKey = dateKey(state.selected);

  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    const key = dateKey(day);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "day",
      day.getMonth() !== state.cursor.getMonth() ? "outside" : "",
      key === todayKey ? "today" : "",
      key === selectedKey ? "selected" : ""
    ]
      .filter(Boolean)
      .join(" ");
    button.innerHTML = `<span class="day-number">${day.getDate()}</span><span class="day-bookings"></span>`;
    button.addEventListener("click", () => setSelectedDate(day));

    const list = button.querySelector(".day-bookings");
    bookingsForDay(day).slice(0, 3).forEach((booking) => {
      const item = document.createElement("span");
      item.className = `mini-booking ${booking.status}`;
      item.textContent = `${new Date(booking.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${booking.driver}`;
      list.appendChild(item);
    });

    els.calendar.appendChild(button);
  }
}

function renderBookings() {
  const upcoming = state.bookings
    .filter((booking) => new Date(booking.endAt) >= new Date(Date.now() - 24 * 60 * 60 * 1000))
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  if (upcoming.length === 0) {
    els.bookingList.innerHTML = `<div class="booking-card"><strong>No bookings yet</strong><p>Your requests will show up here.</p></div>`;
    return;
  }

  els.bookingList.innerHTML = "";
  upcoming.forEach((booking) => {
    const card = document.createElement("article");
    card.className = `booking-card ${booking.status}`;
    const start = timeFormatter.format(new Date(booking.startAt));
    const end = new Date(booking.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    card.innerHTML = `
      <strong>${booking.driver} - ${start} - ${end}</strong>
      <p>${booking.destination || "No destination added"}</p>
      ${booking.note ? `<p>${booking.note}</p>` : ""}
      <span class="badge ${booking.status}">${booking.status}</span>
      ${["pending", "approved"].includes(booking.status) ? `<div class="booking-actions"><button class="cancel-booking" type="button" data-booking-id="${booking.id}">Cancel booking</button></div>` : ""}
    `;
    els.bookingList.appendChild(card);
  });
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  state.defaultKmRate = config.defaultKmRate;
  els.costForm.elements.rate.value = config.defaultKmRate;
  els.rateHint.textContent = `${config.defaultKmRate} DKK/km`;
  els.tripEstimate.querySelector("span").textContent = `Round trip from ${config.homeAddress}`;
  els.telegramStatus.textContent = config.telegramConfigured ? "Telegram ready" : "Telegram setup needed";
  els.telegramStatus.classList.toggle("ready", config.telegramConfigured);
  els.telegramStatus.classList.toggle("warning", !config.telegramConfigured);
}

function hideAddressSuggestions() {
  els.addressSuggestions.hidden = true;
  els.addressSuggestions.innerHTML = "";
}

function renderAddressSuggestions(suggestions) {
  if (suggestions.length === 0) {
    hideAddressSuggestions();
    return;
  }

  els.addressSuggestions.innerHTML = "";
  suggestions.forEach((suggestion) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.textContent = suggestion.label;
    button.addEventListener("click", () => selectDestination(suggestion));
    els.addressSuggestions.appendChild(button);
  });
  els.addressSuggestions.hidden = false;
}

async function searchDestinationAddresses() {
  const value = els.bookingForm.elements.destination.value.trim();
  selectedDestination = null;
  els.bookingForm.elements.destinationId.value = "";
  els.tripEstimate.hidden = true;

  if (value.length < 2) {
    hideAddressSuggestions();
    return;
  }

  const response = await fetch(`/api/addresses?q=${encodeURIComponent(value)}`);
  const payload = await response.json();
  renderAddressSuggestions(payload.suggestions || []);
}

async function selectDestination(suggestion) {
  selectedDestination = suggestion;
  els.bookingForm.elements.destination.value = suggestion.label;
  els.bookingForm.elements.destinationId.value = suggestion.id;
  hideAddressSuggestions();
  await estimateDestinationTrip();
}

async function estimateDestinationTrip() {
  if (!selectedDestination?.id) return;
  els.tripEstimate.hidden = false;
  els.tripEstimate.querySelector("strong").textContent = "Estimating...";

  const response = await fetch("/api/trips/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addressId: selectedDestination.id,
      label: selectedDestination.label,
      rate: els.costForm.elements.rate.value || state.defaultKmRate
    })
  });
  const payload = await response.json();

  if (!response.ok) {
    els.tripEstimate.querySelector("strong").textContent = payload.error || "Could not estimate trip";
    return;
  }

  const suffix = payload.trip.method === "estimated" ? " approx." : "";
  els.tripEstimate.querySelector("strong").textContent =
    `${payload.trip.roundTripKm.toFixed(1)} km - ${payload.trip.cost.toFixed(2)} DKK${suffix}`;
}

function readKnownBookingStatuses() {
  try {
    return JSON.parse(localStorage.getItem(STATUS_STORAGE_KEY)) || {};
  } catch (error) {
    return {};
  }
}

function saveKnownBookingStatuses(statuses) {
  knownBookingStatuses = statuses;
  localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(statuses));
}

function isFinalStatus(status) {
  return status === "approved" || status === "rejected" || status === "cancelled";
}

function detectBookingStatusChanges(bookings) {
  const nextStatuses = {};
  const changes = [];
  const hasHistory = Object.keys(knownBookingStatuses).length > 0;

  bookings.forEach((booking) => {
    nextStatuses[booking.id] = booking.status;
    const previous = knownBookingStatuses[booking.id];
    if (hasHistory && previous === "pending" && (booking.status === "approved" || booking.status === "rejected")) {
      changes.push(booking);
    }
  });

  saveKnownBookingStatuses(nextStatuses);
  changes.forEach(showBookingAlert);
}

function updateNotificationButton() {
  if (!("Notification" in window)) {
    els.notificationButton.textContent = "In-app alerts on";
    els.notificationButton.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    els.notificationButton.textContent = "Alerts on";
    els.notificationButton.disabled = true;
  } else if (Notification.permission === "denied") {
    els.notificationButton.textContent = "Alerts blocked";
    els.notificationButton.disabled = true;
  } else {
    els.notificationButton.textContent = "Enable alerts";
    els.notificationButton.disabled = false;
  }
}

async function requestNotifications() {
  if (!("Notification" in window)) return;
  await Notification.requestPermission();
  updateNotificationButton();
}

function showBookingAlert(booking) {
  const isApproved = booking.status === "approved";
  const title = isApproved ? "Booking approved" : "Booking denied";
  const detail = `${booking.driver}: ${timeFormatter.format(new Date(booking.startAt))}`;

  const alert = document.createElement("div");
  alert.className = `app-alert ${booking.status}`;
  alert.innerHTML = `
    <div>
      <strong>${title}</strong>
      <span>${detail}</span>
    </div>
    <button class="alert-close" type="button" aria-label="Dismiss alert">x</button>
  `;
  alert.querySelector("button").addEventListener("click", () => alert.remove());
  els.alertStack.appendChild(alert);
  window.setTimeout(() => alert.remove(), 15000);

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, {
      body: detail,
      icon: "/icon.svg",
      tag: booking.id
    });
  }
}

async function loadBookings() {
  const response = await fetch("/api/bookings");
  const payload = await response.json();
  const bookings = payload.bookings || [];
  detectBookingStatusChanges(bookings);
  state.bookings = bookings;
  renderCalendar();
  renderBookings();
}

async function cancelBooking(id) {
  const booking = state.bookings.find((item) => item.id === id);
  if (!booking) return;
  const ok = window.confirm("Cancel this booking?");
  if (!ok) return;

  const response = await fetch(`/api/bookings/${encodeURIComponent(id)}/cancel`, {
    method: "POST"
  });
  const result = await response.json();

  if (!response.ok) {
    els.bookingMessage.textContent = result.error || "Could not cancel booking.";
    return;
  }

  els.bookingMessage.textContent = result.booking.cancellationTelegram?.sent
    ? "Booking cancelled and your dad was notified."
    : "Booking cancelled.";
  await loadBookings();
}

async function createBooking(event) {
  event.preventDefault();
  els.bookingMessage.textContent = "Sending request...";

  const form = new FormData(els.bookingForm);
  const date = form.get("date");
  const startTime = form.get("startTime");
  const endTime = form.get("endTime");
  const payload = {
    driver: form.get("driver"),
    startAt: new Date(`${date}T${startTime}`).toISOString(),
    endAt: new Date(`${date}T${endTime}`).toISOString(),
    destination: form.get("destination"),
    destinationId: form.get("destinationId"),
    note: form.get("note")
  };

  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    els.bookingMessage.textContent = result.error || "Could not create booking.";
    return;
  }

  if (result.booking.telegram?.sent) {
    els.bookingMessage.textContent = result.booking.telegram.approvalButtons
      ? "Request sent to Telegram for approval."
      : "Request sent to Telegram. Approval buttons need a public website URL.";
  } else {
    els.bookingMessage.textContent =
      result.booking.telegram?.reason || "Request saved, but Telegram could not send it.";
  }
  els.bookingForm.elements.destination.value = "";
  els.bookingForm.elements.destinationId.value = "";
  els.bookingForm.elements.note.value = "";
  selectedDestination = null;
  els.tripEstimate.hidden = true;
  await loadBookings();
}

async function calculateCost(event) {
  event.preventDefault();
  const form = new FormData(els.costForm);
  const response = await fetch("/api/trips/calculate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startKm: form.get("startKm"),
      endKm: form.get("endKm"),
      rate: form.get("rate")
    })
  });
  const result = await response.json();

  if (!response.ok) {
    els.costResult.innerHTML = `<strong>Error</strong><span>${result.error || "Check the numbers"}</span>`;
    return;
  }

  els.costResult.innerHTML = `<strong>${result.trip.distance.toFixed(1)} km</strong><span>${result.trip.cost.toFixed(2)} DKK</span>`;
}

document.querySelector("#prevMonth").addEventListener("click", () => {
  state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1);
  renderCalendar();
});

document.querySelector("#nextMonth").addEventListener("click", () => {
  state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1);
  renderCalendar();
});

document.querySelector("#refreshBookings").addEventListener("click", loadBookings);
els.notificationButton.addEventListener("click", requestNotifications);
els.bookingList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-booking-id]");
  if (button) cancelBooking(button.dataset.bookingId);
});
els.bookingForm.addEventListener("submit", createBooking);
els.bookingForm.elements.destination.addEventListener("input", () => {
  window.clearTimeout(addressSearchTimer);
  addressSearchTimer = window.setTimeout(searchDestinationAddresses, 250);
});
els.costForm.elements.rate.addEventListener("input", () => {
  if (selectedDestination) estimateDestinationTrip();
});
els.costForm.addEventListener("submit", calculateCost);
document.addEventListener("click", (event) => {
  if (!event.target.closest("#addressSuggestions") && event.target !== els.bookingForm.elements.destination) {
    hideAddressSuggestions();
  }
});
els.bookingForm.elements.startTime.value = "09:00";
els.bookingForm.elements.endTime.value = "10:00";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

updateNotificationButton();
setSelectedDate(new Date());
loadConfig().then(loadBookings).catch((error) => {
  els.bookingMessage.textContent = error.message;
});

window.setInterval(loadBookings, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadBookings();
});
