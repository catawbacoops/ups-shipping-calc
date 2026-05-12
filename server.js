const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Load product catalog
const PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, "products.json"), "utf8"));

const TOKEN = process.env.SQUARE_TOKEN;
const ENV = process.env.SQUARE_ENV || "production";
const BASE =
  ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/pickup-orders", async (req, res) => {
  if (!TOKEN || TOKEN === "YOUR_TOKEN_HERE") {
    return res.status(500).json({ error: "SQUARE_TOKEN not set in .env" });
  }

  try {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      "Square-Version": "2024-04-17",
      "Content-Type": "application/json",
    };

    // Step 1: get locations
    const locRes = await fetch(`${BASE}/v2/locations`, { headers });
    const locData = await locRes.json();
    if (!locRes.ok) {
      return res.status(locRes.status).json({ error: locData.errors?.[0]?.detail || "Location fetch failed" });
    }

    const locationIds = (locData.locations || []).map((l) => l.id);
    if (!locationIds.length) {
      return res.json({ orders: [] });
    }

    // Step 2: search for open pickup orders
    const ordRes = await fetch(`${BASE}/v2/orders/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        location_ids: locationIds,
        query: {
          filter: {
            state_filter: { states: ["OPEN"] },
            fulfillment_filter: { fulfillment_types: ["PICKUP"] },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
        limit: 200,
      }),
    });

    const ordData = await ordRes.json();
    if (!ordRes.ok) {
      return res.status(ordRes.status).json({ error: ordData.errors?.[0]?.detail || "Orders fetch failed" });
    }

    // Only include orders where the pickup fulfillment is PROPOSED (new/pending).
    // PROPOSED = new, RESERVED = ready, PREPARED = prepared, COMPLETED = picked up.
    const filtered = (ordData.orders || []).filter((o) =>
      (o.fulfillments || []).some(
        (f) => f.type === "PICKUP" && f.state === "PROPOSED"
      )
    );

    const orders = filtered.map((o, i) => ({
      index: i + 1,
      id: o.id,
      subtotal: o.net_amounts?.total_money?.amount || o.total_money?.amount || 0,
      createdAt: o.created_at,
    }));

    res.json({ orders, env: ENV });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve product list for the shipping widget
app.get("/api/products", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  if (!q || q.length < 2) return res.json([]);
  const results = PRODUCTS.filter(p => p.name.toLowerCase().includes(q)).slice(0, 50);
  res.json(results);
});

// UPS Ground shipping quote
app.post("/api/shipping-quote", async (req, res) => {
  const { toZip, weightLbs } = req.body;
  const upsClientId = process.env.UPS_CLIENT_ID;
  const upsClientSecret = process.env.UPS_CLIENT_SECRET;
  const fromZip = process.env.SHIP_FROM_ZIP || "17067";

  if (!upsClientId || !upsClientSecret) {
    return res.status(500).json({ error: "UPS credentials not set in .env" });
  }
  if (!toZip || !/^\d{5}$/.test(toZip)) {
    return res.status(400).json({ error: "Invalid zip code" });
  }
  if (!weightLbs || isNaN(weightLbs) || weightLbs <= 0) {
    return res.status(400).json({ error: "Invalid weight" });
  }

  try {
    // Step 1: Get OAuth token from UPS
    const tokenRes = await fetch("https://onlinetools.ups.com/security/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${upsClientId}:${upsClientSecret}`).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(500).json({ error: "UPS auth failed: " + (tokenData.response?.errors?.[0]?.message || JSON.stringify(tokenData)) });
    }

    // Step 2: Call UPS Rating API
    const rateRes = await fetch("https://onlinetools.ups.com/api/rating/v2403/Rate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenData.access_token}`,
        transId: "shipcalc-" + Date.now(),
        transactionSrc: "ShippingWidget",
      },
      body: JSON.stringify({
        RateRequest: {
          Request: { RequestOption: "Shoptimeintransit" },
          Shipment: {
            Shipper: {
              Address: { PostalCode: fromZip, CountryCode: "US" },
            },
            ShipTo: {
              Address: { PostalCode: toZip, CountryCode: "US", ResidentialAddressIndicator: "" },
            },
            ShipFrom: {
              Address: { PostalCode: fromZip, CountryCode: "US" },
            },
            Service: { Code: "03", Description: "UPS Ground" },
            Package: {
              PackagingType: { Code: "02" },
              PackageWeight: {
                UnitOfMeasurement: { Code: "LBS" },
                Weight: String(Math.max(1, Math.ceil(weightLbs))),
              },
            },
          },
        },
      }),
    });

    const rateData = await rateRes.json();
    if (!rateRes.ok) {
      const msg = rateData.response?.errors?.[0]?.message || JSON.stringify(rateData);
      return res.status(500).json({ error: "UPS rate error: " + msg });
    }

    const rated = rateData.RateResponse?.RatedShipment;
    if (!rated) return res.status(500).json({ error: "No rate returned from UPS" });

    const cost = parseFloat(rated.TotalCharges?.MonetaryValue || 0);
    const days = rated.TimeInTransit?.ServiceSummary?.EstimatedArrival?.Arrival?.Date || null;
    const businessDays = rated.GuaranteedDelivery?.BusinessDaysInTransit
      || rated.TimeInTransit?.ServiceSummary?.EstimatedArrival?.BusinessDaysInTransit
      || null;

    res.json({ cost, days, businessDays, weightLbs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Square pickup chart running on port ${PORT}`);
});
