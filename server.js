const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "bookings.json");

loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://localhost:${PORT}`)
).replace(/\/$/, "");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_PARENT_CHAT_IDS = (process.env.TELEGRAM_PARENT_CHAT_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const APPROVAL_SECRET = process.env.APPROVAL_SECRET || "dev-secret-change-me";
const DEFAULT_KM_RATE = Number(process.env.DEFAULT_KM_RATE || 1.5);
const HOME_ADDRESS = process.env.HOME_ADDRESS || "Havesvinget 14, 2950 Vedbaek";
const COPENHAGEN_CENTER = { lat: 55.6761, lon: 12.5683 };
const SEARCH_RADIUS_KM = Number(process.env.SEARCH_RADIUS_KM || 85);
let cachedHomeCoordinates = null;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ bookings: [] }, null, 2));
  }
}

function readStore() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function signBooking(id, decision) {
  return crypto
    .createHmac("sha256", APPROVAL_SECRET)
    .update(`${id}:${decision}`)
    .digest("hex")
    .slice(0, 24);
}

function formatBookingMessage(booking) {
  const start = new Date(booking.startAt).toLocaleString("da-DK", {
    dateStyle: "medium",
    timeStyle: "short"
  });
  const end = new Date(booking.endAt).toLocaleString("da-DK", {
    dateStyle: "medium",
    timeStyle: "short"
  });
  const approveUrl = `${PUBLIC_BASE_URL}/api/approve?id=${booking.id}&decision=approved&token=${signBooking(booking.id, "approved")}`;
  const rejectUrl = `${PUBLIC_BASE_URL}/api/approve?id=${booking.id}&decision=rejected&token=${signBooking(booking.id, "rejected")}`;

  return {
    text: [
      "New car booking request",
      "",
      `Driver: ${booking.driver}`,
      `When: ${start} - ${end}`,
      booking.destination ? `Destination: ${booking.destination}` : "",
      booking.note ? `Note: ${booking.note}` : "",
      "",
      `Approve: ${approveUrl}`,
      `Reject: ${rejectUrl}`
    ]
      .filter(Boolean)
      .join("\n"),
    approveUrl,
    rejectUrl
  };
}

function canUseTelegramApprovalButtons() {
  try {
    const url = new URL(PUBLIC_BASE_URL);
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch (error) {
    return false;
  }
}

async function sendTelegramBooking(booking) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_PARENT_CHAT_IDS.length === 0) {
    return { sent: false, reason: "Telegram is not configured" };
  }

  const message = formatBookingMessage(booking);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const useApprovalButtons = canUseTelegramApprovalButtons();
  const results = [];

  for (const chatId of TELEGRAM_PARENT_CHAT_IDS) {
    const body = {
      chat_id: chatId,
      text: useApprovalButtons
        ? message.text
        : `${message.text}\n\nApproval buttons will work after the app is deployed to a public URL. For now, please approve by replying in Telegram.`
    };

    if (useApprovalButtons) {
      body.reply_markup = {
        inline_keyboard: [
          [
            { text: "Approve", url: message.approveUrl },
            { text: "Reject", url: message.rejectUrl }
          ]
        ]
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    results.push({ chatId, ok: response.ok, payload });
  }

  return { sent: results.every((result) => result.ok), approvalButtons: useApprovalButtons, results };
}

function normalizeBooking(input) {
  const driver = String(input.driver || "").trim();
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);

  if (!driver) throw new Error("Choose who is booking the car.");
  if (Number.isNaN(startAt.getTime())) throw new Error("Choose a valid start date and time.");
  if (Number.isNaN(endAt.getTime())) throw new Error("Choose a valid end date and time.");
  if (endAt <= startAt) throw new Error("End time must be after start time.");

  return {
    id: crypto.randomUUID(),
    driver,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    destination: String(input.destination || "").trim(),
    destinationId: String(input.destinationId || "").trim(),
    note: String(input.note || "").trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    telegram: { sent: false }
  };
}

function calculateTrip(input) {
  const startKm = Number(input.startKm);
  const endKm = Number(input.endKm);
  const rate = Number(input.rate || DEFAULT_KM_RATE);

  if (!Number.isFinite(startKm) || !Number.isFinite(endKm)) {
    throw new Error("Enter both start and end kilometers.");
  }
  if (endKm < startKm) throw new Error("End kilometers must be higher than start kilometers.");
  if (!Number.isFinite(rate) || rate < 0) throw new Error("Enter a valid price per kilometer.");

  const distance = endKm - startKm;
  return {
    startKm,
    endKm,
    rate,
    distance,
    cost: Number((distance * rate).toFixed(2))
  };
}

function getCoordinatesFromAddress(address) {
  const candidates = [
    address?.adgangsadresse?.adgangspunkt?.koordinater,
    address?.adgangspunkt?.koordinater,
    address?.wgs84koordinat,
    address?.koordinater
  ];

  for (const coordinates of candidates) {
    if (!coordinates) continue;
    const lat = Number(coordinates.bredde ?? coordinates.lat ?? coordinates.latitude ?? coordinates[1]);
    const lon = Number(coordinates.længde ?? coordinates.laengde ?? coordinates.lon ?? coordinates.lng ?? coordinates.longitude ?? coordinates[0]);
    if (isWgs84(lat, lon)) return { lat, lon };
  }

  const x = Number(address?.x ?? address?.adgangsadresse?.x);
  const y = Number(address?.y ?? address?.adgangsadresse?.y);
  if (isWgs84(y, x)) return { lat: y, lon: x };
  return null;
}

function isWgs84(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat > 54 && lat < 58.5 && lon > 7 && lon < 16;
}

function haversineKm(a, b) {
  const earthRadiusKm = 6371;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

async function searchAddresses(query, limit = 8) {
  const queryHints = ["", " København", " København K", " København V", " Frederiksberg", " Hellerup", " Lyngby", " Vedbæk"];
  const seen = new Map();

  for (const suffix of queryHints) {
    const url = new URL("https://api.dataforsyningen.dk/adresser/autocomplete");
    url.searchParams.set("q", `${query}${suffix}`);
    url.searchParams.set("type", "adresse");
    url.searchParams.set("fuzzy", "true");
    url.searchParams.set("per_side", "5");
    const suggestions = await fetchJson(url);

    suggestions.forEach((suggestion) => {
      const id = suggestion.adresse?.id || suggestion.data?.id || "";
      if (!id || seen.has(id)) return;
      seen.set(id, {
        id,
        label: suggestion.tekst,
        address: suggestion.adresse,
        coordinates: getCoordinatesFromAddress(suggestion.adresse)
      });
    });
  }

  const hydrated = await Promise.all(
    [...seen.values()].slice(0, 30).map(async (suggestion) => {
      if (suggestion.coordinates) return suggestion;
      try {
        const address = await getAddressById(suggestion.id);
        return {
          ...suggestion,
          address,
          coordinates: getCoordinatesFromAddress(address)
        };
      } catch (error) {
        return suggestion;
      }
    })
  );

  return hydrated
    .map((suggestion) => {
      const distanceToCopenhagen = suggestion.coordinates
        ? haversineKm(COPENHAGEN_CENTER, suggestion.coordinates)
        : Number.POSITIVE_INFINITY;
      return {
        ...suggestion,
        distanceToCopenhagen
      };
    })
    .filter((suggestion) => suggestion.id && suggestion.label)
    .filter((suggestion) => {
      return suggestion.distanceToCopenhagen <= SEARCH_RADIUS_KM;
    })
    .sort((a, b) => a.distanceToCopenhagen - b.distanceToCopenhagen)
    .slice(0, limit);
}

async function getAddressById(id) {
  const url = new URL(`https://api.dataforsyningen.dk/adresser/${encodeURIComponent(id)}`);
  url.searchParams.set("struktur", "mini");
  return fetchJson(url);
}

async function getHomeCoordinates() {
  if (cachedHomeCoordinates) return cachedHomeCoordinates;
  const [home] = await searchAddresses(HOME_ADDRESS, 1);
  if (!home?.coordinates) throw new Error("Could not find home address coordinates.");
  cachedHomeCoordinates = home.coordinates;
  return cachedHomeCoordinates;
}

async function getRouteKm(from, to) {
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}`);
  url.searchParams.set("overview", "false");
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("steps", "false");
  const payload = await fetchJson(url);
  const meters = payload.routes?.[0]?.distance;
  if (!Number.isFinite(meters)) throw new Error("No route distance returned.");
  return meters / 1000;
}

async function estimateRoundTrip(input) {
  const rate = Number(input.rate || DEFAULT_KM_RATE);
  if (!Number.isFinite(rate) || rate < 0) throw new Error("Enter a valid price per kilometer.");
  if (!input.addressId) throw new Error("Choose a destination from the address suggestions.");

  const [home, destinationAddress] = await Promise.all([
    getHomeCoordinates(),
    getAddressById(String(input.addressId))
  ]);
  const destination = getCoordinatesFromAddress(destinationAddress);
  if (!destination) throw new Error("Could not find destination coordinates.");

  let oneWayKm;
  let method = "driving";
  try {
    oneWayKm = await getRouteKm(home, destination);
  } catch (error) {
    oneWayKm = haversineKm(home, destination) * 1.25;
    method = "estimated";
  }

  const roundTripKm = oneWayKm * 2;
  return {
    from: HOME_ADDRESS,
    to: input.label || destinationAddress.betegnelse || "Selected destination",
    method,
    oneWayKm: Number(oneWayKm.toFixed(1)),
    roundTripKm: Number(roundTripKm.toFixed(1)),
    rate,
    cost: Number((roundTripKm * rate).toFixed(2))
  };
}

function markBooking(id, decision) {
  const store = readStore();
  const booking = store.bookings.find((item) => item.id === id);
  if (!booking) return null;
  booking.status = decision;
  booking.updatedAt = new Date().toISOString();
  writeStore(store);
  return booking;
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, PUBLIC_BASE_URL);
  const safePath = path.normalize(decodeURIComponent(requestUrl.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexError, indexData) => {
        if (indexError) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": contentTypes[".html"] });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_BASE_URL);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        defaultKmRate: DEFAULT_KM_RATE,
        homeAddress: HOME_ADDRESS,
        telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_PARENT_CHAT_IDS.length)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/addresses") {
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length < 2) return sendJson(res, 200, { suggestions: [] });
      return sendJson(res, 200, { suggestions: await searchAddresses(query) });
    }

    if (req.method === "GET" && url.pathname === "/api/bookings") {
      const store = readStore();
      const bookings = store.bookings.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
      return sendJson(res, 200, { bookings });
    }

    if (req.method === "POST" && url.pathname === "/api/bookings") {
      const input = await parseBody(req);
      const booking = normalizeBooking(input);
      const store = readStore();
      store.bookings.push(booking);
      writeStore(store);

      try {
        booking.telegram = await sendTelegramBooking(booking);
      } catch (error) {
        booking.telegram = { sent: false, reason: error.message };
      }

      const updatedStore = readStore();
      const storedBooking = updatedStore.bookings.find((item) => item.id === booking.id);
      if (storedBooking) storedBooking.telegram = booking.telegram;
      writeStore(updatedStore);

      return sendJson(res, 201, { booking });
    }

    if (req.method === "POST" && url.pathname === "/api/trips/calculate") {
      const input = await parseBody(req);
      return sendJson(res, 200, { trip: calculateTrip(input) });
    }

    if (req.method === "POST" && url.pathname === "/api/trips/estimate") {
      const input = await parseBody(req);
      return sendJson(res, 200, { trip: await estimateRoundTrip(input) });
    }

    if (req.method === "GET" && url.pathname === "/api/approve") {
      const id = url.searchParams.get("id") || "";
      const decision = url.searchParams.get("decision") || "";
      const token = url.searchParams.get("token") || "";

      if (!["approved", "rejected"].includes(decision) || token !== signBooking(id, decision)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<h1>Invalid approval link</h1>");
      }

      const booking = markBooking(id, decision);
      if (!booking) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<h1>Booking not found</h1>");
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<h1>Booking ${decision}</h1><p>You can close this page.</p>`);
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Something went wrong" });
  }
});

ensureDataFile();
server.listen(PORT, () => {
  console.log(`Car sharing app running at http://localhost:${PORT}`);
});
